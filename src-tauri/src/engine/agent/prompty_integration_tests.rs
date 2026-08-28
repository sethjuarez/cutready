//! App-side integration tests for the `harness-prompty` crate.
//!
//! These exercise the public `harness_prompty::run` seam against CutReady's real
//! host implementation (`AppPromptyHost`), the durable [`AgentStateStore`], the
//! app-owned tool contract, and project-reference resolution — collaborators the
//! crate deliberately does not depend on. Tests that only need crate internals
//! live in-crate under `crates/harness-prompty/src/runner_unit_tests.rs`; this
//! file owns the cases that must reach back into the application.

use std::collections::{HashMap, VecDeque};
use std::path::Path;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex};
use std::time::Duration;

use async_trait::async_trait;
use serde_json::{json, Value};
use tokio::sync::Notify;

use prompty::model::InvocationUsage;
use prompty::{
    CancellationToken, EngineCheckpoint, EngineEvent, EngineEventKind, EngineToolRequest,
    EngineToolResult, Message, ModelInvocationRequest, ModelInvocationResponse, ModelPort,
    ModelStreamChunk, ModelStreamPort, PortError, ToolOutcome, TurnEngineRequest,
};

use harness_contract::execution::{
    AgentEvent, ChatMessage, ContextItem, ContextSource, FunctionCall, RunCancellation, RunResult,
    ToolCall, VisionConfig, WebAccessConfig,
};
use harness_prompty::{
    build_production_model, native_to_prompty_message, prompty_to_native_message, run,
    DurableRunStore, PromptyHost, PromptySteering,
};

use crate::engine::agent::harness::AppPromptyHost;
use crate::engine::agent::llm::{LlmConfig, LlmProvider};
use crate::engine::agent::tools::all_tools;
use crate::engine::agent_state::AgentStateStore;

fn test_host() -> Arc<dyn PromptyHost> {
    Arc::new(AppPromptyHost)
}

fn wrap_durable(store: Option<AgentStateStore>) -> Option<Arc<dyn DurableRunStore>> {
    store.map(|store| Arc::new(store) as Arc<dyn DurableRunStore>)
}

#[test]
fn production_tool_wire_preserves_cutready_nullable_union_schemas() {
    let config = LlmConfig {
        provider: LlmProvider::Openai,
        endpoint: String::new(),
        api_key: "test-key".into(),
        model: "gpt-4o".into(),
        bearer_token: None,
    };
    let production =
        build_production_model(&config, Some(10_000), all_tools(true, true, true)).unwrap();
    let tools = prompty_openai::tools_to_wire(production.port.agent()).unwrap();

    let set_row_visual = tools
        .iter()
        .find(|tool| tool["function"]["name"] == "set_row_visual")
        .unwrap();
    assert_eq!(
        set_row_visual["function"]["parameters"]["properties"]["visual"]["type"],
        json!(["object", "null"])
    );

    let write_storyboard = tools
        .iter()
        .find(|tool| tool["function"]["name"] == "write_storyboard")
        .unwrap();
    let storyboard_items =
        &write_storyboard["function"]["parameters"]["properties"]["items"]["items"];
    assert_eq!(storyboard_items["anyOf"][0]["type"], "object");
    assert_eq!(storyboard_items["anyOf"][1]["type"], "object");
    assert_eq!(
        storyboard_items["anyOf"][1]["required"],
        json!(["sketches", "title", "type"])
    );
}

#[derive(Clone)]
enum ScriptedReply {
    Completion(String),
    ToolCall(ToolCall),
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
                    assistant_messages: vec![native_to_prompty_message(
                        &ChatMessage::assistant(&text),
                    )
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
                Err(PortError::new("Agent run cancelled"))
            }
        }
    }
}

fn test_store(root: &Path, run_id: &str) -> AgentStateStore {
    let store = AgentStateStore::for_project(root, root, run_id).unwrap();
    store
        .insert_run(
            None,
            "scripted",
            "scripted-model",
            json!({"execution_engine": "prompty"}),
        )
        .unwrap();
    store
}

#[allow(clippy::too_many_arguments)]
async fn run_script(
    provider: Arc<ScriptedModelPort>,
    root: &Path,
    run_id: &str,
    messages: Vec<ChatMessage>,
    context_items: Vec<ContextItem>,
    mutation_tools_enabled: bool,
    cancelled: Arc<AtomicBool>,
    events: Arc<Mutex<Vec<AgentEvent>>>,
) -> Result<RunResult, String> {
    let store = test_store(root, run_id);
    run_script_with_state(
        provider,
        root,
        run_id,
        messages,
        context_items,
        mutation_tools_enabled,
        cancelled,
        events,
        Some(store),
    )
    .await
}

#[allow(clippy::too_many_arguments)]
async fn run_script_with_state(
    provider: Arc<ScriptedModelPort>,
    root: &Path,
    run_id: &str,
    messages: Vec<ChatMessage>,
    context_items: Vec<ContextItem>,
    mutation_tools_enabled: bool,
    cancelled: Arc<AtomicBool>,
    events: Arc<Mutex<Vec<AgentEvent>>>,
    agent_state: Option<AgentStateStore>,
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
        test_host(),
        wrap_durable(agent_state),
        RunCancellation::from_shared(cancelled),
        move |event| events.lock().unwrap().push(event),
    )
    .await
}

/// Run a turn with explicit `agent_id` + sub-agent prompt registry so delegation is live.
async fn run_delegating(
    provider: Arc<ScriptedModelPort>,
    root: &Path,
    run_id: &str,
    agent_id: &str,
    agent_prompts: HashMap<String, String>,
    messages: Vec<ChatMessage>,
    cancelled: Arc<AtomicBool>,
    events: Arc<Mutex<Vec<AgentEvent>>>,
) -> Result<RunResult, String> {
    let store = test_store(root, run_id);
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
        agent_id,
        &agent_prompts,
        PromptySteering::new(),
        &VisionConfig { enabled: true },
        &WebAccessConfig {
            search_enabled: false,
        },
        false,
        5,
        Vec::new(),
        Some(run_id.into()),
        test_host(),
        wrap_durable(Some(store)),
        RunCancellation::from_shared(cancelled),
        move |event| events.lock().unwrap().push(event),
    )
    .await
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

#[tokio::test]
async fn delegate_to_agent_runs_nested_child_and_persists_run_identity() {
    let project = tempfile::tempdir().unwrap();
    // Global reply order across BOTH the parent and the nested child engine (they share
    // the same scripted model): parent delegates, child completes, parent finalises.
    let provider = ScriptedModelPort::new([
        ScriptedReply::ToolCall(delegate_call("writer", "Draft the intro sketch")),
        ScriptedReply::Completion("Intro sketch drafted.".into()),
        ScriptedReply::Completion("Delegated to writer and finished.".into()),
    ]);
    let events = Arc::new(Mutex::new(Vec::new()));
    let prompts = HashMap::from([(
        "writer".to_string(),
        "You are the CutReady writer.".to_string(),
    )]);

    let result = run_delegating(
        provider.clone(),
        project.path(),
        "prompty-deleg",
        "planner",
        prompts,
        vec![ChatMessage::user("Hand this to the writer.")],
        Arc::new(AtomicBool::new(false)),
        events.clone(),
    )
    .await
    .unwrap();

    // Parent's final answer is returned; the child's answer is folded into the tool result.
    assert_eq!(result.response, "Delegated to writer and finished.");

    // The child engine received exactly [system(prompt), user(message)].
    let requests = provider.requests();
    assert_eq!(requests.len(), 3, "parent x2 + child x1 model invocations");
    let child_request = &requests[1];
    assert_eq!(child_request.len(), 2);
    assert_eq!(child_request[0].role, "system");
    assert_eq!(
        child_request[0].text(),
        Some("You are the CutReady writer.")
    );
    assert_eq!(child_request[1].role, "user");
    assert_eq!(child_request[1].text(), Some("Draft the intro sketch"));

    // Delegation surfaced AgentStart/AgentDone for the sub-agent, and exactly ONE
    // top-level Done (the child's completion must not emit a second Done to the host).
    let events = events.lock().unwrap();
    assert!(events.iter().any(|event| matches!(
        event,
        AgentEvent::AgentStart { agent_id, task }
            if agent_id == "writer" && task == "Draft the intro sketch"
    )));
    assert!(events.iter().any(
        |event| matches!(event, AgentEvent::AgentDone { agent_id } if agent_id == "writer")
    ));
    let done_count = events
        .iter()
        .filter(|event| matches!(event, AgentEvent::Done { .. }))
        .count();
    assert_eq!(done_count, 1, "only the top-level turn signals Done");
    let done_response = events
        .iter()
        .find_map(|event| match event {
            AgentEvent::Done { response } => Some(response.clone()),
            _ => None,
        })
        .unwrap();
    assert_eq!(done_response, "Delegated to writer and finished.");
    drop(events);

    // Durable run identity: the whole delegation tree shares one journal (session =
    // parent run_id), child events carry runId/parentRunId/delegationDepth in camelCase.
    let detail =
        AgentStateStore::get_run_detail(project.path(), project.path(), "prompty-deleg")
            .unwrap()
            .unwrap();
    let child_events = detail
        .trajectory_events
        .iter()
        .filter(|event| {
            event.event.get("parentRunId").and_then(Value::as_str) == Some("prompty-deleg")
        })
        .collect::<Vec<_>>();
    assert!(
        !child_events.is_empty(),
        "child turn must persist events under the shared run journal"
    );
    let mut child_run_ids = std::collections::HashSet::new();
    for event in &child_events {
        assert_eq!(event.event["delegationDepth"].as_i64(), Some(1));
        let child_run_id = event.event["runId"].as_str().unwrap();
        assert_ne!(child_run_id, "prompty-deleg");
        child_run_ids.insert(child_run_id.to_string());
        // Canonical camelCase only — never the twin-era snake_case spellings.
        assert!(event.event.get("parent_run_id").is_none());
        assert!(event.event.get("delegation_depth").is_none());
        assert_eq!(event.event["sessionId"].as_str(), Some("prompty-deleg"));
    }
    assert_eq!(child_run_ids.len(), 1, "one child run in this tree");

    // Parent events keep runId = the run, omit parentRunId, and omit delegationDepth (0).
    let parent_events = detail
        .trajectory_events
        .iter()
        .filter(|event| event.event.get("parentRunId").is_none())
        .collect::<Vec<_>>();
    assert!(!parent_events.is_empty());
    for event in &parent_events {
        assert_eq!(event.event["runId"].as_str(), Some("prompty-deleg"));
        assert!(event.event.get("delegationDepth").is_none());
    }
}

#[tokio::test]
async fn delegate_to_unknown_agent_is_a_recoverable_tool_error() {
    let project = tempfile::tempdir().unwrap();
    // The unknown-agent check fails BEFORE any child engine spins up, so the parent
    // only invokes the model twice (delegate call, then a completion after the error).
    let provider = ScriptedModelPort::new([
        ScriptedReply::ToolCall(delegate_call("designer", "Make a visual")),
        ScriptedReply::Completion("Handled it myself.".into()),
    ]);
    let events = Arc::new(Mutex::new(Vec::new()));
    let prompts = HashMap::from([(
        "writer".to_string(),
        "You are the CutReady writer.".to_string(),
    )]);

    let result = run_delegating(
        provider.clone(),
        project.path(),
        "prompty-unknown",
        "planner",
        prompts,
        vec![ChatMessage::user("Delegate to designer.")],
        Arc::new(AtomicBool::new(false)),
        events.clone(),
    )
    .await
    .unwrap();

    // The turn still commits Success; the delegation failure is a model-visible tool error.
    assert_eq!(result.response, "Handled it myself.");
    assert_eq!(provider.requests().len(), 2, "no child engine was spawned");
    let events = events.lock().unwrap();
    // No AgentStart for an unknown agent (we bail before emitting it).
    assert!(!events
        .iter()
        .any(|event| matches!(event, AgentEvent::AgentStart { .. })));
    let tool_result = events
        .iter()
        .find_map(|event| match event {
            AgentEvent::ToolResult { name, result } if name == "delegate_to_agent" => {
                Some(result.clone())
            }
            _ => None,
        })
        .unwrap();
    assert!(tool_result.contains("unknown agent 'designer'"));
    assert!(tool_result.contains("writer"));
}

#[tokio::test]
async fn unavailable_agent_state_uses_noop_durability_and_completes() {
    let project = tempfile::tempdir().unwrap();
    let provider =
        ScriptedModelPort::new([ScriptedReply::Completion("Available without state.".into())]);
    let events = Arc::new(Mutex::new(Vec::new()));

    let result = run_script_with_state(
        provider,
        project.path(),
        "prompty-no-state",
        vec![ChatMessage::user("Continue without persisted state.")],
        Vec::new(),
        false,
        Arc::new(AtomicBool::new(false)),
        events.clone(),
        None,
    )
    .await
    .unwrap();

    assert_eq!(result.response, "Available without state.");
    assert_eq!(
        result
            .messages
            .iter()
            .map(|message| message.role.as_str())
            .collect::<Vec<_>>(),
        ["user", "assistant"]
    );
    assert!(events
        .lock()
        .unwrap()
        .iter()
        .any(|event| matches!(event, AgentEvent::Delta { content } if !content.is_empty())));
    assert!(events
        .lock()
        .unwrap()
        .iter()
        .any(|event| matches!(event, AgentEvent::Done { response } if response == "Available without state.")));
    assert!(events.lock().unwrap().iter().any(|event| matches!(
        event,
        AgentEvent::Status { message }
            if message == "Agent run state unavailable; continuing without durable checkpoints"
    )));
    assert!(
        !AgentStateStore::database_path_for_project(project.path(), project.path()).exists()
    );
}

#[tokio::test]
async fn tool_round_reuses_cutready_executor_and_preserves_call_id() {
    let project = tempfile::tempdir().unwrap();
    std::fs::write(project.path().join("planning-notes.md"), "demo").unwrap();
    let provider = ScriptedModelPort::new([
        ScriptedReply::ToolCall(ToolCall {
            id: "call-list".into(),
            call_type: "function".into(),
            function: FunctionCall {
                name: "list_project_files".into(),
                arguments: "{}".into(),
            },
        }),
        ScriptedReply::Completion("The project contains planning notes.".into()),
    ]);
    let events = Arc::new(Mutex::new(Vec::new()));

    let result = run_script(
        provider.clone(),
        project.path(),
        "prompty-tool",
        vec![ChatMessage::user("Inspect the project.")],
        Vec::new(),
        false,
        Arc::new(AtomicBool::new(false)),
        events.clone(),
    )
    .await
    .unwrap();

    assert_eq!(result.response, "The project contains planning notes.");
    assert_eq!(
        result
            .messages
            .iter()
            .map(|message| message.role.as_str())
            .collect::<Vec<_>>(),
        ["user", "assistant", "tool", "assistant"]
    );
    let committed_tool_call = result.messages[1]
        .tool_calls
        .as_ref()
        .and_then(|calls| calls.first())
        .unwrap();
    assert_eq!(committed_tool_call.id, "call-list");
    assert_eq!(committed_tool_call.function.name, "list_project_files");
    assert_eq!(committed_tool_call.function.arguments, "{}");
    assert_eq!(
        result.messages[2].tool_call_id.as_deref(),
        Some("call-list")
    );
    assert!(result.messages[2]
        .text()
        .unwrap()
        .contains("planning-notes.md"));
    assert_eq!(
        result.messages[3].text(),
        Some("The project contains planning notes.")
    );

    let requests = provider.requests();
    assert_eq!(requests.len(), 2);
    let tool_result = requests[1]
        .iter()
        .find(|message| message.role == "tool")
        .unwrap();
    assert_eq!(tool_result.tool_call_id.as_deref(), Some("call-list"));
    assert!(tool_result.text().unwrap().contains("planning-notes.md"));

    let events = events.lock().unwrap();
    let tool_events = events
        .iter()
        .enumerate()
        .filter_map(|(index, event)| match event {
            AgentEvent::ToolCall { name, arguments } => {
                Some((index, "call", name.as_str(), arguments.as_str()))
            }
            AgentEvent::ToolResult { name, result } => {
                Some((index, "result", name.as_str(), result.as_str()))
            }
            _ => None,
        })
        .collect::<Vec<_>>();
    assert_eq!(tool_events.len(), 2);
    assert_eq!(
        tool_events[0],
        (tool_events[0].0, "call", "list_project_files", "{}")
    );
    assert_eq!(tool_events[1].1, "result");
    assert_eq!(tool_events[1].2, "list_project_files");
    assert!(tool_events[1].3.contains("planning-notes.md"));
    assert!(tool_events[0].0 < tool_events[1].0);
    drop(events);

    let detail =
        AgentStateStore::get_run_detail(project.path(), project.path(), "prompty-tool")
            .unwrap()
            .unwrap();
    let event_types = detail
        .trajectory_events
        .iter()
        .map(|event| event.event_type.as_str())
        .collect::<Vec<_>>();
    let model_completions = event_types
        .iter()
        .enumerate()
        .filter_map(|(index, event_type)| {
            (*event_type == "model_invocation_completed").then_some(index)
        })
        .collect::<Vec<_>>();
    assert_eq!(model_completions.len(), 2);
    let tool_started = event_types
        .iter()
        .position(|event_type| *event_type == "tool_execution_started")
        .unwrap();
    let tool_completed = event_types
        .iter()
        .position(|event_type| *event_type == "tool_execution_completed")
        .unwrap();
    let tool_result_committed = event_types
        .iter()
        .position(|event_type| *event_type == "tool_result_committed")
        .unwrap();
    let conversation_updated = event_types
        .iter()
        .position(|event_type| *event_type == "conversation_updated")
        .unwrap();
    let turn_committed = event_types
        .iter()
        .position(|event_type| *event_type == "turn_committed")
        .unwrap();
    assert!(
        model_completions[0] < tool_started
            && tool_started < tool_completed
            && tool_completed < tool_result_committed
            && tool_result_committed < conversation_updated
            && conversation_updated < model_completions[1]
            && model_completions[1] < turn_committed
    );
    assert_eq!(
        detail.trajectory_events[turn_committed].event["payload"]["status"],
        "success"
    );

    let checkpoint_events = detail
        .trajectory_events
        .iter()
        .filter(|event| event.event_type == "checkpoint_created")
        .collect::<Vec<_>>();
    assert!(!checkpoint_events.is_empty());
    for checkpoint_event in checkpoint_events {
        let checkpoint_id = checkpoint_event.event["payload"]["checkpointId"]
            .as_str()
            .unwrap();
        let included_through = checkpoint_event.event["payload"]["includedThroughSequence"]
            .as_u64()
            .unwrap();
        let sequence = checkpoint_event.event["sequence"].as_u64().unwrap();
        assert_eq!(sequence, included_through + 1);
        let checkpoint = detail
            .checkpoints
            .iter()
            .find(|checkpoint| checkpoint.id == checkpoint_id)
            .unwrap();
        assert_eq!(
            checkpoint.checkpoint["lastSequence"].as_u64(),
            Some(included_through)
        );
    }
}

#[tokio::test]
async fn cancellation_stops_native_model_port() {
    let project = tempfile::tempdir().unwrap();
    let provider = ScriptedModelPort::new([ScriptedReply::Blocking]);
    let started = provider.started.clone();
    let cancelled = Arc::new(AtomicBool::new(false));
    let cancel_for_task = cancelled.clone();
    let root = project.path().to_path_buf();
    let events = Arc::new(Mutex::new(Vec::new()));
    let events_for_task = events.clone();
    let task = tokio::spawn(async move {
        run_script(
            provider,
            &root,
            "prompty-cancel",
            vec![ChatMessage::user("Wait.")],
            Vec::new(),
            false,
            cancel_for_task,
            events_for_task,
        )
        .await
    });
    started.notified().await;
    cancelled.store(true, Ordering::SeqCst);

    let error = task.await.unwrap().unwrap_err();
    assert_eq!(error, "Agent run cancelled");
    let detail =
        AgentStateStore::get_run_detail(project.path(), project.path(), "prompty-cancel")
            .unwrap()
            .unwrap();
    assert!(detail
        .trajectory_events
        .iter()
        .any(|event| event.event_type == "turn_cancelled"));
    assert!(!events
        .lock()
        .unwrap()
        .iter()
        .any(|event| matches!(event, AgentEvent::Error { .. })));
}

#[tokio::test]
async fn context_items_are_injected_and_audited() {
    let project = tempfile::tempdir().unwrap();
    let provider =
        ScriptedModelPort::new([ScriptedReply::Completion("Used the brief.".into())]);
    let context = ContextItem::new(
        "brief",
        ContextSource::User,
        "Demo brief",
        "User-selected context",
    )
    .with_content("Launch with the reliability story.", "text/plain")
    .with_priority(50);

    run_script(
        provider.clone(),
        project.path(),
        "prompty-context",
        vec![
            ChatMessage::system("You are the CutReady planner."),
            ChatMessage::user("Draft the opening."),
        ],
        vec![context],
        false,
        Arc::new(AtomicBool::new(false)),
        Arc::new(Mutex::new(Vec::new())),
    )
    .await
    .unwrap();

    let request = provider.requests().into_iter().next().unwrap();
    assert_eq!(request[0].role, "system");
    assert_eq!(request[0].text(), Some("You are the CutReady planner."));
    let context_index = request
        .iter()
        .position(|message| {
            message
                .text()
                .is_some_and(|text| text.contains("<context_pack>"))
        })
        .unwrap();
    let request_index = request
        .iter()
        .rposition(|message| message.text() == Some("Draft the opening."))
        .unwrap();
    assert!(context_index < request_index);
    assert_eq!(request[context_index].role, "user");
    assert!(request.iter().any(|message| {
        message
            .text()
            .is_some_and(|text| text.contains("Launch with the reliability story."))
    }));
    let detail =
        AgentStateStore::get_run_detail(project.path(), project.path(), "prompty-context")
            .unwrap()
            .unwrap();
    let prepared = detail
        .trajectory_events
        .iter()
        .find(|event| event.event_type == "context_prepared")
        .unwrap();
    assert_eq!(
        prepared.event["payload"]["decisions"][0]["candidateId"],
        "brief"
    );
    assert_eq!(
        prepared.event["payload"]["decisions"][0]["disposition"],
        "included"
    );
}

#[tokio::test]
async fn project_reference_is_resolved_without_explicit_context_items() {
    let project = tempfile::tempdir().unwrap();
    std::fs::write(
        project.path().join("planning-notes.md"),
        "# Planning Notes\n\nUse the reliability story.",
    )
    .unwrap();
    let provider =
        ScriptedModelPort::new([ScriptedReply::Completion("Used the project note.".into())]);

    run_script(
        provider.clone(),
        project.path(),
        "prompty-project-reference",
        vec![ChatMessage::user(
            "Use @planning-notes as context for the opening.",
        )],
        Vec::new(),
        false,
        Arc::new(AtomicBool::new(false)),
        Arc::new(Mutex::new(Vec::new())),
    )
    .await
    .unwrap();

    let request = provider.requests().into_iter().next().unwrap();
    let packed_context = request
        .iter()
        .find_map(|message| {
            message
                .text()
                .filter(|text| text.contains("<context_pack>"))
        })
        .unwrap();
    assert!(packed_context.contains("Planning Notes"));
    assert!(packed_context.contains("Use the reliability story."));
    assert!(packed_context.contains("project-reference:planning-notes"));
}

#[tokio::test]
async fn canonical_events_and_checkpoints_persist_as_json() {
    let project = tempfile::tempdir().unwrap();
    let provider = ScriptedModelPort::new([ScriptedReply::Completion("Done.".into())]);

    run_script(
        provider,
        project.path(),
        "prompty-durable",
        vec![ChatMessage::user("Finish.")],
        Vec::new(),
        false,
        Arc::new(AtomicBool::new(false)),
        Arc::new(Mutex::new(Vec::new())),
    )
    .await
    .unwrap();

    let detail =
        AgentStateStore::get_run_detail(project.path(), project.path(), "prompty-durable")
            .unwrap()
            .unwrap();
    assert!(detail
        .trajectory_events
        .iter()
        .any(|event| event.event_type == "model_invocation_completed"));
    assert!(detail
        .trajectory_events
        .iter()
        .any(|event| event.event_type == "turn_committed"));
    assert!(!detail.checkpoints.is_empty());

    // Durable payloads use the canonical camelCase projection emitted by the
    // generated turn-engine types, not Rust snake_case field names.
    let checkpoint = &detail.checkpoints.last().unwrap().checkpoint;
    assert_eq!(checkpoint["sessionId"], "prompty-durable");

    // Run identity round-trips through the checkpoint and every event as a
    // non-empty camelCase `runId`. A top-level run has no parent and depth 0,
    // so the canonical projection omits `parentRunId` / `delegationDepth`.
    let run_id = checkpoint["runId"]
        .as_str()
        .expect("checkpoint carries a runId");
    assert!(!run_id.is_empty());
    assert!(checkpoint.get("parentRunId").is_none());
    assert!(checkpoint.get("delegationDepth").is_none());
    for record in &detail.trajectory_events {
        assert_eq!(
            record.event["runId"]
                .as_str()
                .expect("event carries a runId"),
            run_id,
            "every persisted event shares the top-level run identity"
        );
        assert!(record.event.get("parentRunId").is_none());
        assert!(record.event.get("delegationDepth").is_none());
    }

    // A delegated child run must round-trip all three identity fields in
    // camelCase through CutReady's durability store: runId, parentRunId, and a
    // non-zero delegationDepth.
    let store = AgentStateStore::for_project(project.path(), project.path(), "prompty-durable")
        .unwrap();
    let delegated_event = EngineEvent {
        sequence: 999,
        id: "delegated-event-1".into(),
        timestamp: "2026-07-24T00:00:00Z".into(),
        session_id: "prompty-durable".into(),
        turn_id: "prompty-durable:child-turn".into(),
        run_id: "child-run".into(),
        parent_run_id: Some("parent-run".into()),
        delegation_depth: 1,
        invocation_id: Some("child-invocation".into()),
        iteration: Some(0),
        kind: EngineEventKind::Turn_started,
        payload: None,
    };
    store.append_prompty_event(&delegated_event).unwrap();

    let persisted =
        AgentStateStore::get_run_detail(project.path(), project.path(), "prompty-durable")
            .unwrap()
            .unwrap()
            .trajectory_events
            .into_iter()
            .find(|record| record.event_id.as_deref() == Some("delegated-event-1"))
            .expect("delegated event persisted")
            .event;
    assert_eq!(persisted["runId"], "child-run");
    assert_eq!(persisted["parentRunId"], "parent-run");
    assert_eq!(persisted["delegationDepth"], 1);

    // Resume round-trip: a committed checkpoint promotes into the generated
    // ResumeContext, persists as canonical camelCase durable state, and
    // round-trips back to the typed record without fabricating any duplicate
    // committed model/tool effect.
    use prompty::ResumeContext;
    let committed_before = detail
        .trajectory_events
        .iter()
        .filter(|record| record.event_type == "turn_committed")
        .count();
    assert_eq!(
        committed_before, 1,
        "the scripted turn commits exactly once"
    );

    let committed_checkpoint: EngineCheckpoint =
        serde_json::from_value(detail.checkpoints.last().unwrap().checkpoint.clone())
            .expect("committed checkpoint deserializes into the generated EngineCheckpoint");
    let journal_tail = committed_checkpoint.last_sequence + 3;
    let resume = ResumeContext::resuming(committed_checkpoint.clone(), 8, 5)
        .with_last_journal_sequence(journal_tail);
    store.save_resume_context(&resume).unwrap();

    let resumed_detail =
        AgentStateStore::get_run_detail(project.path(), project.path(), "prompty-durable")
            .unwrap()
            .unwrap();
    // Persisting resume state must not add a new committed turn.
    assert_eq!(
        resumed_detail
            .trajectory_events
            .iter()
            .filter(|record| record.event_type == "turn_committed")
            .count(),
        committed_before,
        "round-tripping resume state adds no duplicate committed effect"
    );

    let record = resumed_detail
        .resume_contexts
        .last()
        .expect("resume context persisted");
    assert_eq!(record.checkpoint_id, committed_checkpoint.id);
    let stored = &record.context;
    // Canonical camelCase durable keys, not Rust snake_case.
    assert_eq!(stored["maxIterations"], 8);
    assert_eq!(stored["maxModelAttempts"], 5);
    assert_eq!(stored["lastJournalSequence"], journal_tail);
    assert!(stored.get("max_iterations").is_none());
    assert!(stored.get("last_journal_sequence").is_none());
    // The embedded checkpoint keeps the committed run identity in camelCase.
    assert_eq!(stored["checkpoint"]["sessionId"], "prompty-durable");
    assert_eq!(
        stored["checkpoint"]["runId"]
            .as_str()
            .expect("nested runId"),
        run_id
    );

    // Round-trips back to the typed generated record.
    let restored: ResumeContext =
        serde_json::from_value(stored.clone()).expect("resume state round-trips to the type");
    assert_eq!(restored.max_iterations, 8);
    assert_eq!(restored.max_model_attempts, 5);
    assert_eq!(restored.last_journal_sequence, journal_tail);
    assert_eq!(restored.checkpoint.id, committed_checkpoint.id);
    assert_eq!(restored.resume_sequence(), journal_tail);

    // A zero journal tail is omitted per the conditional-emit discipline.
    let resume_zero = ResumeContext::resuming(committed_checkpoint.clone(), 8, 5);
    store.save_resume_context(&resume_zero).unwrap();
    let zero_detail =
        AgentStateStore::get_run_detail(project.path(), project.path(), "prompty-durable")
            .unwrap()
            .unwrap();
    let zero_ctx = &zero_detail
        .resume_contexts
        .last()
        .expect("zero-tail resume context persisted")
        .context;
    assert!(
        zero_ctx.get("lastJournalSequence").is_none(),
        "a zero journal tail is omitted from the canonical projection"
    );
}

/// A reconciliation-required checkpoint must survive CutReady's durable round-trip
/// (canonical camelCase, including the indeterminate tool effect) and promote into a
/// generated `ResumeContext` that the engine's `from_resume_after_reconciliation`
/// bridge accepts. This proves the CutReady half of the resume-trigger composition:
/// the host persists and reconstructs a valid resume record, while the engine's own
/// suite (`resume_via_generated_resume_context_avoids_duplicate_effects`) owns the
/// no-duplicate-effect execution guarantee.
#[tokio::test]
async fn reconciliation_required_checkpoint_round_trips_into_a_resumable_context() {
    use prompty::ResumeContext;

    let project = tempfile::tempdir().unwrap();
    let run_id = "prompty-recon";
    let provider = ScriptedModelPort::new([ScriptedReply::Completion("Done.".into())]);
    run_script(
        provider,
        project.path(),
        run_id,
        vec![ChatMessage::user("Finish.")],
        Vec::new(),
        false,
        Arc::new(AtomicBool::new(false)),
        Arc::new(Mutex::new(Vec::new())),
    )
    .await
    .unwrap();

    let store = AgentStateStore::for_project(project.path(), project.path(), run_id).unwrap();
    let detail = AgentStateStore::get_run_detail(project.path(), project.path(), run_id)
        .unwrap()
        .unwrap();
    let committed: EngineCheckpoint =
        serde_json::from_value(detail.checkpoints.last().unwrap().checkpoint.clone())
            .expect("committed checkpoint deserializes");

    // Shape a reconciliation-required checkpoint from the genuine committed one: it
    // carries an indeterminate tool effect the host must resolve before resuming.
    const REQUEST_ID: &str = "recon-call-1";
    let mut recon = committed.clone();
    recon.id = "checkpoint-recon".into();
    recon.reconciliation_required = true;
    recon.model_reconciliation = None;
    recon.completed_tool_results = vec![EngineToolResult {
        request_id: REQUEST_ID.into(),
        name: "capture_screenshot".into(),
        outcome: ToolOutcome::Indeterminate,
        output: None,
        error_kind: Some("indeterminate".into()),
        metadata: Value::Null,
    }];
    recon.messages.push(Message::tool_result(
        REQUEST_ID,
        "awaiting host confirmation",
    ));

    let recon_event = EngineEvent {
        sequence: recon.last_sequence + 1,
        id: "recon-event-1".into(),
        timestamp: "2026-07-25T00:00:00Z".into(),
        session_id: run_id.into(),
        turn_id: recon.turn_id.clone(),
        run_id: recon.run_id.clone(),
        parent_run_id: recon.parent_run_id.clone(),
        delegation_depth: recon.delegation_depth,
        invocation_id: recon.active_invocation_id.clone(),
        iteration: Some(recon.iteration),
        kind: EngineEventKind::Turn_reconciliation_required,
        payload: None,
    };
    store
        .append_prompty_events_with_checkpoint(&[recon_event], &recon)
        .unwrap();

    // Durable round-trip: the reconciliation state persists as canonical camelCase,
    // not Rust snake_case, and the indeterminate tool effect survives verbatim.
    let persisted = AgentStateStore::get_run_detail(project.path(), project.path(), run_id)
        .unwrap()
        .unwrap();
    let stored_cp = persisted
        .checkpoints
        .iter()
        .find(|record| record.checkpoint["id"] == "checkpoint-recon")
        .expect("reconciliation checkpoint persisted")
        .checkpoint
        .clone();
    assert_eq!(stored_cp["reconciliationRequired"], true);
    // The generated projection stores completed results object-keyed by tool name
    // (default SaveContext collection_format), each element in canonical camelCase.
    let stored_result = &stored_cp["completedToolResults"]["capture_screenshot"];
    assert_eq!(stored_result["requestId"], REQUEST_ID);
    assert_eq!(stored_result["outcome"], "indeterminate");
    assert!(stored_cp.get("completed_tool_results").is_none());
    assert!(stored_cp.get("reconciliation_required").is_none());

    let restored_cp: EngineCheckpoint = serde_json::from_value(stored_cp)
        .expect("reconciliation checkpoint round-trips into the generated type");
    assert!(restored_cp.reconciliation_required);
    assert_eq!(
        restored_cp.completed_tool_results[0].outcome,
        ToolOutcome::Indeterminate
    );
    assert!(restored_cp.model_reconciliation.is_none());

    // Promote into the generated ResumeContext and round-trip through CutReady's store.
    let journal_tail = restored_cp.last_sequence + 2;
    let resume = ResumeContext::resuming(restored_cp.clone(), 8, 5)
        .with_last_journal_sequence(journal_tail);
    store.save_resume_context(&resume).unwrap();
    let resume_detail = AgentStateStore::get_run_detail(project.path(), project.path(), run_id)
        .unwrap()
        .unwrap();
    let restored_resume: ResumeContext = serde_json::from_value(
        resume_detail
            .resume_contexts
            .last()
            .expect("resume context persisted")
            .context
            .clone(),
    )
    .expect("resume context round-trips to the type");
    assert!(restored_resume.checkpoint.reconciliation_required);

    // The persisted + round-tripped record is a valid resume input: resolving the
    // indeterminate effect with a determinate result clears reconciliation, records
    // the resolution, threads the durable model-attempt budget, and preserves run
    // identity independently.
    let resolved = EngineToolResult {
        request_id: REQUEST_ID.into(),
        name: "capture_screenshot".into(),
        outcome: ToolOutcome::Success,
        output: Some(json!({ "captured": true })),
        error_kind: None,
        metadata: Value::Null,
    };
    let request =
        TurnEngineRequest::from_resume_after_reconciliation(&restored_resume, resolved.clone())
            .expect("resolved reconciliation builds a resumable request");
    assert!(!request.reconciliation_required);
    assert_eq!(request.reconciliation_resolution, Some(resolved.clone()));
    assert_eq!(request.session_id, run_id);
    assert_eq!(request.run_id, committed.run_id);
    assert_eq!(request.parent_run_id, committed.parent_run_id);
    assert_eq!(request.delegation_depth, committed.delegation_depth);
    assert_eq!(request.max_model_attempts, 5);
    assert_eq!(request.initial_sequence, journal_tail as u64);

    // Guard: an unresolved (still-indeterminate) result is rejected, so a host can
    // never resume a reconciliation checkpoint without actually resolving the effect.
    let still_indeterminate = EngineToolResult {
        outcome: ToolOutcome::Indeterminate,
        ..resolved.clone()
    };
    assert!(TurnEngineRequest::from_resume_after_reconciliation(
        &restored_resume,
        still_indeterminate,
    )
    .is_err());

    // Guard: a tool-reconciliation checkpoint cannot be resumed through the model
    // reconciliation bridge.
    assert!(TurnEngineRequest::from_resume_after_model_reconciliation(
        &restored_resume,
        ModelInvocationResponse::new(),
    )
    .is_err());
}

#[test]
fn validation_failures_use_the_shared_tool_error_semantics() {
    assert!(crate::engine::agent::tools::is_tool_error(
        "Validation failed: narration timing is invalid"
    ));
}
