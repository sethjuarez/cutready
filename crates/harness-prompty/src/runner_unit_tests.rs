//! In-crate unit tests for the Prompty runner.
//!
//! These exercise crate-internal logic (budgeting, converters, steering, the
//! delegation guardrails, and the durability/post-commit ports) using in-crate
//! fakes for the injected [`PromptyHost`] / [`DurableRunStore`] seams. Tests that
//! need CutReady's real `AgentStateStore` projections, real app tools, or the
//! real project-reference resolver live app-side in
//! `src-tauri/src/engine/agent/prompty_integration_tests.rs`.

use std::sync::atomic::AtomicBool;

use prompty::model::InvocationUsage;
use tokio::sync::Notify;

use super::*;
use harness_contract::execution::{FunctionCall, ImageUrl};
use harness_contract::tools::ToolDefinition;
use crate::ContextAssetExcerpt;

/// A host that owns no real tools or project references. The delegation and
/// budgeting logic under test never dispatches through it, so its tool surface
/// is empty and its policy predicates are trivial.
struct FakeHost;

impl PromptyHost for FakeHost {
    fn all_tools(
        &self,
        _web_search_enabled: bool,
        _project_workspace_tools_enabled: bool,
        _mutation_tools_enabled: bool,
    ) -> Vec<ToolDefinition> {
        Vec::new()
    }

    fn execute_tool(&self, _call: &ToolCall, _ctx: &ToolExecutionContext) -> ToolOutput {
        ToolOutput::from("unused".to_string())
    }

    fn is_read_only_tool(&self, _name: &str) -> bool {
        false
    }

    fn is_tool_error(&self, result_text: &str) -> bool {
        let trimmed = result_text.trim_start();
        trimmed.starts_with("Error") || trimmed.starts_with("Validation failed")
    }

    fn resolve_project_references(
        &self,
        _project_root: &Path,
        _user_messages: &[String],
    ) -> Vec<ResolvedProjectReference> {
        Vec::new()
    }
}

fn fake_host() -> Arc<dyn PromptyHost> {
    Arc::new(FakeHost)
}

/// A durable store that records only memory-promotion candidates, which is all
/// the post-commit port test asserts against.
#[derive(Default)]
struct RecordingDurableStore {
    promotions: Mutex<Vec<Value>>,
}

impl RecordingDurableStore {
    fn promotion_count(&self) -> usize {
        self.promotions.lock().unwrap().len()
    }
}

impl DurableRunStore for RecordingDurableStore {
    fn append_event(&self, _event: &prompty::EngineEvent) -> Result<(), String> {
        Ok(())
    }

    fn append_events_with_checkpoint(
        &self,
        _events: &[prompty::EngineEvent],
        _checkpoint: &prompty::EngineCheckpoint,
    ) -> Result<(), String> {
        Ok(())
    }

    fn read_context_asset(
        &self,
        _asset_id: &str,
        _offset: usize,
        _limit: usize,
    ) -> Result<ContextAssetExcerpt, String> {
        Ok(ContextAssetExcerpt {
            name: String::new(),
            excerpt: String::new(),
        })
    }

    fn record_native_memory_promotion(&self, candidate: &Value) -> Result<(), String> {
        self.promotions.lock().unwrap().push(candidate.clone());
        Ok(())
    }
}

#[derive(Clone)]
enum ScriptedReply {
    Completion(String),
    ToolCall(ToolCall),
    #[allow(dead_code)]
    Blocking,
}

struct ScriptedModelPort {
    replies: Mutex<VecDeque<ScriptedReply>>,
    requests: Mutex<Vec<Vec<ChatMessage>>>,
    started: Arc<Notify>,
    context_budget_chars: usize,
}

impl ScriptedModelPort {
    fn new(replies: impl IntoIterator<Item = ScriptedReply>) -> Arc<Self> {
        Self::with_budget(replies, 20_000)
    }

    fn with_budget(
        replies: impl IntoIterator<Item = ScriptedReply>,
        context_budget_chars: usize,
    ) -> Arc<Self> {
        Arc::new(Self {
            replies: Mutex::new(replies.into_iter().collect()),
            requests: Mutex::new(Vec::new()),
            started: Arc::new(Notify::new()),
            context_budget_chars,
        })
    }

    fn requests(&self) -> Vec<Vec<ChatMessage>> {
        self.requests.lock().unwrap().clone()
    }
}

#[async_trait]
impl ModelPort for ScriptedModelPort {
    async fn invoke(
        &self,
        request: &ModelInvocationRequest,
        cancellation: &CancellationToken,
        stream: &dyn ModelStreamPort,
    ) -> Result<ModelInvocationResponse, PortError> {
        self.requests.lock().unwrap().push(
            request
                .context
                .messages
                .iter()
                .map(prompty_to_native_message)
                .collect::<Result<Vec<_>, _>>()
                .map_err(PortError::configuration)?,
        );
        self.started.notify_one();
        let reply = self
            .replies
            .lock()
            .unwrap()
            .pop_front()
            .ok_or_else(|| PortError::new("No scripted reply"))?;
        match reply {
            ScriptedReply::Completion(text) => {
                for token in text.split_inclusive(' ') {
                    stream.emit(ModelStreamChunk::Text(token.to_string())).await;
                }
                Ok(ModelInvocationResponse {
                    output: Some(Value::String(text.clone())),
                    assistant_messages: vec![native_to_prompty_message(&ChatMessage::assistant(
                        &text,
                    ))
                    .map_err(PortError::configuration)?],
                    tool_requests: Vec::new(),
                    next_context_state: None,
                    usage: Some(InvocationUsage {
                        input_tokens: 3,
                        output_tokens: 2,
                        total_tokens: 5,
                    }),
                    metadata: json!({"transport": "native-script"}),
                })
            }
            ScriptedReply::ToolCall(tool_call) => {
                stream
                    .emit(ModelStreamChunk::Provider(json!({
                        "type": "tool_call",
                        "name": tool_call.function.name,
                        "arguments": tool_call.function.arguments,
                    })))
                    .await;
                let assistant = ChatMessage::assistant_with_tool_calls(vec![tool_call.clone()]);
                Ok(ModelInvocationResponse {
                    output: None,
                    assistant_messages: vec![native_to_prompty_message(&assistant)
                        .map_err(PortError::configuration)?],
                    tool_requests: vec![EngineToolRequest {
                        id: tool_call.id,
                        name: tool_call.function.name,
                        arguments: Some(
                            serde_json::from_str(&tool_call.function.arguments).unwrap_or_else(
                                |_| Value::String(tool_call.function.arguments.clone()),
                            ),
                        ),
                        metadata: json!({
                            "arguments_json": tool_call.function.arguments,
                            "call_type": tool_call.call_type,
                        }),
                    }],
                    next_context_state: None,
                    usage: Some(InvocationUsage {
                        input_tokens: 4,
                        output_tokens: 1,
                        total_tokens: 5,
                    }),
                    metadata: json!({"transport": "native-script"}),
                })
            }
            ScriptedReply::Blocking => {
                while !cancellation.is_cancelled() {
                    tokio::time::sleep(Duration::from_millis(10)).await;
                }
                Err(PortError::new(CANCELLED_ERROR))
            }
        }
    }
}

fn delegate_call(agent_id: &str, message: &str) -> ToolCall {
    ToolCall {
        id: format!("call-delegate-{agent_id}"),
        call_type: "function".into(),
        function: FunctionCall {
            name: "delegate_to_agent".into(),
            arguments: json!({ "agent_id": agent_id, "message": message }).to_string(),
        },
    }
}

/// Drive a scripted turn through the public [`run`] entry with in-crate fakes for
/// the host and no durable store.
#[allow(clippy::too_many_arguments)]
async fn run_script_in_crate(
    provider: Arc<ScriptedModelPort>,
    root: &Path,
    run_id: &str,
    messages: Vec<ChatMessage>,
    context_items: Vec<ContextItem>,
    mutation_tools_enabled: bool,
    cancelled: Arc<AtomicBool>,
    events: Arc<Mutex<Vec<AgentEvent>>>,
) -> Result<RunResult, String> {
    let context_budget_chars = provider.context_budget_chars;
    let model: Arc<dyn ModelPort> = provider;
    run(
        model,
        "scripted".into(),
        "scripted-model".into(),
        context_budget_chars,
        messages,
        root,
        root,
        "planner",
        &HashMap::new(),
        PromptySteering::new(),
        &VisionConfig { enabled: true },
        &WebAccessConfig {
            search_enabled: false,
        },
        mutation_tools_enabled,
        5,
        context_items,
        Some(run_id.into()),
        fake_host(),
        None,
        RunCancellation::from_shared(cancelled),
        move |event| events.lock().unwrap().push(event),
    )
    .await
}

#[test]
fn tool_result_under_budget_is_passed_through_verbatim() {
    let text = "a".repeat(TOOL_RESULT_MAX_CHARS);
    assert_eq!(budget_tool_result_for_model(&text), text);
}

#[test]
fn oversized_tool_result_is_head_tail_truncated_within_budget() {
    let head = "H".repeat(TOOL_RESULT_HEAD_CHARS);
    let middle = "M".repeat(10_000);
    let tail = "T".repeat(TOOL_RESULT_TAIL_CHARS);
    let text = format!("{head}{middle}{tail}");

    let budgeted = budget_tool_result_for_model(&text);

    // Original exceeded the cap; the budgeted form is materially smaller.
    assert!(text.chars().count() > TOOL_RESULT_MAX_CHARS);
    assert!(budgeted.chars().count() < text.chars().count());
    // Head and tail are preserved; the middle is elided.
    assert!(budgeted.starts_with(&head));
    assert!(budgeted.ends_with(&tail));
    assert!(budgeted.contains("characters omitted"));
    assert!(!budgeted.contains(&"M".repeat(10_000)));
}

#[tokio::test]
async fn post_commit_flushes_buffered_memory_promotions_into_host_store() {
    let store = Arc::new(RecordingDurableStore::default());
    let durable: Option<Arc<dyn DurableRunStore>> = Some(store.clone());
    assert_eq!(store.promotion_count(), 0);

    let buffer: Arc<Mutex<Vec<Value>>> = Arc::new(Mutex::new(vec![
        json!({ "content": "User prefers concise narration", "category": "core" }),
        json!({ "content": "Project uses FFV1 lossless capture" }),
    ]));
    let events: Arc<Mutex<Vec<AgentEvent>>> = Arc::new(Mutex::new(Vec::new()));
    let events_for_emit = events.clone();
    let port = CutReadyPostCommitPort {
        durable: durable.clone(),
        memory_promotions: buffer.clone(),
        emit: Arc::new(move |event| events_for_emit.lock().unwrap().push(event)),
    };

    let commit = TurnCommit {
        session_id: "run-memory-promotion".into(),
        turn_id: "run-memory-promotion:turn".into(),
        status: TurnStatus::Success,
        output: None,
        messages: Vec::new(),
        iterations: 1,
        last_sequence: 1,
        context_state: InvocationContextState {
            portability: prompty::ContextPortability::Portable,
            delegated_state: Vec::new(),
        },
        model_reconciliation: None,
    };
    port.after_commit("effect", &commit, &CancellationToken::new())
        .await
        .unwrap();

    // Both candidates persisted, buffer drained, and a host status event emitted.
    assert_eq!(store.promotion_count(), 2);
    assert!(buffer.lock().unwrap().is_empty());
    assert!(events
        .lock()
        .unwrap()
        .iter()
        .any(|event| matches!(event, AgentEvent::Status { message } if message.contains("memory suggestion"))));

    // A second commit with an empty buffer is a no-op (no duplicate persistence).
    port.after_commit("effect", &commit, &CancellationToken::new())
        .await
        .unwrap();
    assert_eq!(store.promotion_count(), 2);
}

#[tokio::test]
async fn delegation_depth_cap_blocks_further_delegation() {
    // A parent already at the maximum delegation depth cannot delegate again. The check
    // returns before any child engine spins up, so a dummy model is never invoked.
    let model: Arc<dyn ModelPort> = ScriptedModelPort::new([]);
    let ctx = DelegationContext {
        model,
        provider_name: "scripted".into(),
        model_name: "scripted-model".into(),
        context_budget_chars: 20_000,
        repo_root: PathBuf::from("."),
        project_root: PathBuf::from("."),
        agent_prompts: Arc::new(HashMap::from([(
            "writer".to_string(),
            "You are the CutReady writer.".to_string(),
        )])),
        vision: VisionConfig { enabled: false },
        web_access: WebAccessConfig {
            search_enabled: false,
        },
        mutation_tools_enabled: false,
        max_tool_rounds: 5,
        context_items: Vec::new(),
        host: fake_host(),
        durable: None,
        cancellation: RunCancellation::from_shared(Arc::new(AtomicBool::new(false))),
        emit: Arc::new(|_| {}),
        session_id: "session".into(),
        parent_run_id: "parent".into(),
        depth: MAX_DELEGATION_DEPTH,
    };

    let output = run_delegated_agent(&ctx, &delegate_call("writer", "Go deeper")).await;
    assert!(output.text().contains("maximum delegation depth"));
}

#[tokio::test]
async fn delegation_missing_arguments_is_a_tool_error() {
    let model: Arc<dyn ModelPort> = ScriptedModelPort::new([]);
    let ctx = DelegationContext {
        model,
        provider_name: "scripted".into(),
        model_name: "scripted-model".into(),
        context_budget_chars: 20_000,
        repo_root: PathBuf::from("."),
        project_root: PathBuf::from("."),
        agent_prompts: Arc::new(HashMap::from([(
            "writer".to_string(),
            "You are the CutReady writer.".to_string(),
        )])),
        vision: VisionConfig { enabled: false },
        web_access: WebAccessConfig {
            search_enabled: false,
        },
        mutation_tools_enabled: false,
        max_tool_rounds: 5,
        context_items: Vec::new(),
        host: fake_host(),
        durable: None,
        cancellation: RunCancellation::from_shared(Arc::new(AtomicBool::new(false))),
        emit: Arc::new(|_| {}),
        session_id: "session".into(),
        parent_run_id: "parent".into(),
        depth: 0,
    };

    let missing_message = ToolCall {
        id: "call".into(),
        call_type: "function".into(),
        function: FunctionCall {
            name: "delegate_to_agent".into(),
            arguments: json!({ "agent_id": "writer" }).to_string(),
        },
    };
    let output = run_delegated_agent(&ctx, &missing_message).await;
    assert!(output.text().contains("requires a 'message' argument"));
}

#[tokio::test]
async fn delegation_propagates_parent_cancellation_to_child() {
    // The child shares the parent's cancellation flag. Pre-cancelling it means the child
    // engine is cancelled and the delegation surfaces the cancellation as a tool error,
    // never a silent committed success.
    let cancelled = Arc::new(AtomicBool::new(true));
    let model: Arc<dyn ModelPort> =
        ScriptedModelPort::new([ScriptedReply::Completion("should never run".into())]);
    let ctx = DelegationContext {
        model,
        provider_name: "scripted".into(),
        model_name: "scripted-model".into(),
        context_budget_chars: 20_000,
        repo_root: PathBuf::from("."),
        project_root: PathBuf::from("."),
        agent_prompts: Arc::new(HashMap::from([(
            "writer".to_string(),
            "You are the CutReady writer.".to_string(),
        )])),
        vision: VisionConfig { enabled: false },
        web_access: WebAccessConfig {
            search_enabled: false,
        },
        mutation_tools_enabled: false,
        max_tool_rounds: 5,
        context_items: Vec::new(),
        host: fake_host(),
        durable: None,
        cancellation: RunCancellation::from_shared(cancelled),
        emit: Arc::new(|_| {}),
        session_id: "session".into(),
        parent_run_id: "parent".into(),
        depth: 0,
    };

    let output = run_delegated_agent(&ctx, &delegate_call("writer", "Draft it")).await;
    assert!(output.text().contains(CANCELLED_ERROR));
}

#[tokio::test]
async fn no_tools_streaming_completion_preserves_history_and_usage() {
    let project = tempfile::tempdir().unwrap();
    let provider =
        ScriptedModelPort::new([ScriptedReply::Completion("A concise planner answer".into())]);
    let events = Arc::new(Mutex::new(Vec::new()));

    let result = run_script_in_crate(
        provider,
        project.path(),
        "prompty-stream",
        vec![
            ChatMessage::system("You are the CutReady planner."),
            ChatMessage::user("Plan this demo."),
        ],
        Vec::new(),
        false,
        Arc::new(AtomicBool::new(false)),
        events.clone(),
    )
    .await
    .unwrap();

    assert_eq!(result.response, "A concise planner answer");
    assert_eq!(result.messages.len(), 3);
    assert_eq!(result.messages[2].role, "assistant");
    assert_eq!(result.total_usage.total_tokens, 5);
    assert!(events
        .lock()
        .unwrap()
        .iter()
        .any(|event| matches!(event, AgentEvent::Delta { content } if !content.is_empty())));
    assert!(events
        .lock()
        .unwrap()
        .iter()
        .any(|event| matches!(event, AgentEvent::Done { .. })));
}

#[tokio::test]
async fn mutation_request_is_denied_as_model_visible_tool_result() {
    let project = tempfile::tempdir().unwrap();
    let provider = ScriptedModelPort::new([
        ScriptedReply::ToolCall(ToolCall {
            id: "call-write".into(),
            call_type: "function".into(),
            function: FunctionCall {
                name: "write_note".into(),
                arguments: r#"{"path":"draft.md","content":"no"}"#.into(),
            },
        }),
        ScriptedReply::Completion("I could not write without permission.".into()),
    ]);

    run_script_in_crate(
        provider.clone(),
        project.path(),
        "prompty-deny",
        vec![ChatMessage::user("Write a note.")],
        Vec::new(),
        false,
        Arc::new(AtomicBool::new(false)),
        Arc::new(Mutex::new(Vec::new())),
    )
    .await
    .unwrap();

    assert!(!project.path().join("draft.md").exists());
    let requests = provider.requests();
    let denial = requests[1]
        .iter()
        .find(|message| message.role == "tool")
        .and_then(ChatMessage::text)
        .unwrap();
    assert!(denial.contains("disabled by the current AI mutation guard"));
}

#[tokio::test]
async fn new_messages_survive_host_policy_history_trimming() {
    let project = tempfile::tempdir().unwrap();
    let provider = ScriptedModelPort::with_budget(
        [ScriptedReply::Completion("Trim-safe answer.".into())],
        500,
    );
    let mut messages = vec![ChatMessage::system("You are the planner.")];
    for index in 0..12 {
        messages.push(ChatMessage::user(&format!(
            "Old request {index}: {}",
            "x".repeat(120)
        )));
        messages.push(ChatMessage::assistant(&format!(
            "Old answer {index}: {}",
            "y".repeat(120)
        )));
    }
    messages.push(ChatMessage::user("Current request."));

    let result = run_script_in_crate(
        provider,
        project.path(),
        "prompty-trim-new-messages",
        messages,
        Vec::new(),
        false,
        Arc::new(AtomicBool::new(false)),
        Arc::new(Mutex::new(Vec::new())),
    )
    .await
    .unwrap();

    assert!(result
        .new_messages
        .iter()
        .any(|message| message.text() == Some("Trim-safe answer.")));
}

#[test]
fn multimodal_and_tool_metadata_round_trip_without_losing_ids() {
    let message = ChatMessage {
        role: "assistant".into(),
        content: Some(MessageContent::Parts(vec![
            ContentPart::Text {
                text: "Look".into(),
            },
            ContentPart::ImageUrl {
                image_url: ImageUrl {
                    url: "data:image/png;base64,abc".into(),
                    detail: Some("high".into()),
                },
            },
        ])),
        tool_calls: Some(vec![ToolCall {
            id: "call-1".into(),
            call_type: "function".into(),
            function: FunctionCall {
                name: "read_sketch".into(),
                arguments: r#"{"path":"intro.sk"}"#.into(),
            },
        }]),
        tool_call_id: None,
    };

    let round_trip =
        prompty_to_native_message(&native_to_prompty_message(&message).unwrap()).unwrap();
    assert_eq!(round_trip.role, "assistant");
    assert_eq!(round_trip.tool_calls.as_ref().unwrap()[0].id, "call-1");
    match round_trip.content.unwrap() {
        MessageContent::Parts(parts) => {
            assert_eq!(parts.len(), 2);
            assert!(matches!(
                &parts[1],
                ContentPart::ImageUrl { image_url }
                    if image_url.url == "data:image/png;base64,abc"
                        && image_url.detail.as_deref() == Some("high")
            ));
        }
        _ => panic!("expected multimodal parts"),
    }
}

#[test]
fn prompty_steering_tracks_active_runner_and_drains_messages() {
    let steering = PromptySteering::new();
    assert!(!steering.is_active());
    {
        let first = steering.subscribe();
        let second = steering.subscribe();
        assert!(steering.is_active());
        assert!(steering.send("Focus on reliability."));
        assert_eq!(first.drain(), vec!["Focus on reliability."]);
        assert_eq!(second.drain(), vec!["Focus on reliability."]);
    }
    assert!(!steering.is_active());
    assert!(!steering.send("No active run."));
}

#[test]
fn tool_output_text_is_sanitized_before_model_continuation() {
    let inline_image = "A".repeat(200);
    let output = ToolOutput::from(format!(
        "before\u{0} data:image/png;base64,{inline_image} after"
    ));

    assert_eq!(
        tool_output_text_for_model(&output),
        "before [base64 image removed] after"
    );
}

#[test]
fn prompty_history_trimming_keeps_responses_multi_call_exchange_atomic() {
    let assistant = |id: &str| {
        ChatMessage::assistant_with_tool_calls(vec![ToolCall {
            id: id.into(),
            call_type: "function".into(),
            function: FunctionCall {
                name: "inspect".into(),
                arguments: "{}".into(),
            },
        }])
    };
    let mut messages = vec![
        assistant("call-1"),
        assistant("call-2"),
        ChatMessage::tool_result("call-1", "first"),
        ChatMessage::tool_result("call-2", "second"),
        ChatMessage {
            role: "user".into(),
            content: Some(MessageContent::Parts(vec![
                ContentPart::Text {
                    text: "Images returned by tool 'inspect':".into(),
                },
                ContentPart::ImageUrl {
                    image_url: ImageUrl {
                        url: "data:image/png;base64,abc".into(),
                        detail: None,
                    },
                },
            ])),
            tool_calls: None,
            tool_call_id: None,
        },
        ChatMessage::user("next turn"),
    ];

    let dropped = take_oldest_native_message_group(&mut messages);

    assert_eq!(
        dropped
            .iter()
            .map(|message| message.role.as_str())
            .collect::<Vec<_>>(),
        ["assistant", "assistant", "tool", "tool", "user"]
    );
    assert_eq!(messages.len(), 1);
    assert_eq!(messages[0].text(), Some("next turn"));
}

#[tokio::test]
async fn prompty_host_event_callback_panics_cannot_change_committed_result() {
    let project = tempfile::tempdir().unwrap();
    let provider = ScriptedModelPort::new([ScriptedReply::Completion("durably complete".into())]);
    let model: Arc<dyn ModelPort> = provider;

    let result = run(
        model,
        "scripted".into(),
        "scripted-model".into(),
        20_000,
        vec![ChatMessage::user("Complete despite callback failure.")],
        project.path(),
        project.path(),
        "planner",
        &HashMap::new(),
        PromptySteering::new(),
        &VisionConfig { enabled: true },
        &WebAccessConfig {
            search_enabled: false,
        },
        false,
        3,
        Vec::new(),
        Some("prompty-callback-panic".into()),
        fake_host(),
        None,
        RunCancellation::new(),
        |_event| panic!("injected host callback panic"),
    )
    .await
    .unwrap();

    assert_eq!(result.response, "durably complete");
    assert_eq!(result.messages.last().unwrap().role, "assistant");
}

#[tokio::test]
async fn prompty_host_maps_visible_tool_result_only_after_commit_event() {
    let visible = Arc::new(Mutex::new(Vec::new()));
    let visible_for_emit = visible.clone();
    let durability = CutReadyDurabilityPort {
        durable: None,
        emit: Arc::new(move |event| visible_for_emit.lock().unwrap().push(event)),
    };
    let event = |sequence, kind| EngineEvent {
        sequence,
        id: format!("event-{sequence}"),
        timestamp: "2026-07-22T00:00:00Z".into(),
        session_id: "session".into(),
        turn_id: "turn".into(),
        run_id: "run".into(),
        parent_run_id: None,
        delegation_depth: 0,
        invocation_id: Some("invocation".into()),
        iteration: Some(0),
        kind,
        payload: Some(json!({
            "toolResult": {
                "request_id": "call-1",
                "name": "inspect",
                "outcome": "success",
                "output": "visible only when committed",
                "error_kind": null,
                "metadata": {},
            },
        })),
    };

    durability
        .append(&event(1, EngineEventKind::Tool_execution_completed))
        .await
        .unwrap();
    assert!(visible.lock().unwrap().is_empty());
    durability
        .append(&event(2, EngineEventKind::Tool_result_committed))
        .await
        .unwrap();

    let visible = visible.lock().unwrap();
    assert!(matches!(
        visible.as_slice(),
        [AgentEvent::ToolResult { name, result }]
            if name == "inspect" && result == "visible only when committed"
    ));
}
