//! GitHub Copilot SDK integration — alternative AI provider.
//!
//! When the user selects "GitHub Copilot" as their provider, this module
//! manages the entire agent runtime via the Copilot SDK. The SDK handles
//! the agent loop, tool dispatch, context compaction, and streaming.
//! CutReady registers its tools and translates SDK events to `AgentEvent`.

use std::path::{Path, PathBuf};
use std::sync::Arc;

use copilot_sdk::{
    Client, CustomAgentConfig, ModelInfo, PermissionRequestResult, SessionConfig,
    SessionEventData, SystemMessageConfig, SystemMessageMode, Tool, ToolHandler, ToolResultObject,
};
use serde_json::{json, Value};

use crate::engine::agent::llm::{FunctionCall, ToolCall};
use crate::engine::agent::runner::AgentEvent;
use crate::engine::agent::tools;
use crate::util::trace;

/// Outcome from translating one SDK event.
#[derive(Debug)]
enum EventAction {
    /// Emit this AgentEvent to the frontend.
    Emit(AgentEvent),
    /// Session is done (idle or error) — stop the loop.
    Break(Option<AgentEvent>),
    /// Event is informational — no action needed.
    Ignore,
}

/// Translate a single SDK event into a CutReady AgentEvent.
///
/// Pure function — testable without a live SDK client.
fn translate_event(data: &SessionEventData) -> EventAction {
    match data {
        SessionEventData::AssistantMessageDelta(delta) => EventAction::Emit(AgentEvent::Delta {
            content: delta.delta_content.clone(),
        }),
        SessionEventData::AssistantMessage(_msg) => {
            // Full message — handled by caller for response aggregation
            EventAction::Ignore
        }
        SessionEventData::AssistantReasoning(r) => EventAction::Emit(AgentEvent::Thinking {
            content: r.content.clone(),
        }),
        SessionEventData::AssistantReasoningDelta(d) => EventAction::Emit(AgentEvent::Thinking {
            content: d.delta_content.clone(),
        }),
        SessionEventData::ToolExecutionStart(tool) => EventAction::Emit(AgentEvent::ToolCall {
            name: tool.tool_name.clone(),
            arguments: tool
                .arguments
                .as_ref()
                .map(|a| serde_json::to_string(a).unwrap_or_else(|_| "{}".into()))
                .unwrap_or_else(|| "{}".into()),
        }),
        SessionEventData::ToolExecutionComplete(tool) => {
            let result_text = tool
                .result
                .as_ref()
                .map(|r| r.content.clone())
                .unwrap_or_default();
            EventAction::Emit(AgentEvent::ToolResult {
                name: tool.tool_call_id.clone(),
                result: result_text,
            })
        }
        SessionEventData::CustomAgentStarted(agent) => {
            EventAction::Emit(AgentEvent::AgentStart {
                agent_id: agent.agent_name.clone(),
                task: String::new(),
            })
        }
        SessionEventData::CustomAgentCompleted(agent) => {
            EventAction::Emit(AgentEvent::AgentDone {
                agent_id: agent.agent_name.clone(),
            })
        }
        SessionEventData::SessionError(err) => EventAction::Break(Some(AgentEvent::Error {
            message: err.message.clone(),
        })),
        SessionEventData::SessionIdle(_) => EventAction::Break(None),
        _ => EventAction::Ignore,
    }
}
#[derive(serde::Serialize, Clone)]
pub struct CopilotModelInfo {
    pub id: String,
    pub name: String,
    pub supports_vision: bool,
    pub supports_reasoning: bool,
    pub billing: Option<String>,
}

impl From<ModelInfo> for CopilotModelInfo {
    fn from(m: ModelInfo) -> Self {
        Self {
            id: m.id.clone(),
            name: m.name.clone(),
            supports_vision: m.capabilities.supports.vision,
            supports_reasoning: m.capabilities.supports.reasoning_effort,
            billing: m.billing.map(|b| format!("{:?}", b)),
        }
    }
}

/// Check whether the `copilot` CLI is available on PATH.
pub fn is_cli_available() -> bool {
    copilot_sdk::find_copilot_cli().is_some()
}

/// Get the path to the `copilot` CLI binary.
pub fn cli_path() -> Option<PathBuf> {
    copilot_sdk::find_copilot_cli()
}

/// List models from the Copilot CLI.
pub async fn list_models() -> Result<Vec<CopilotModelInfo>, String> {
    let client = create_client()?;
    client.start().await.map_err(|e| format!("Failed to start Copilot CLI: {e}"))?;

    let models = client
        .list_models()
        .await
        .map_err(|e| format!("Failed to list models: {e}"))?;

    client.stop().await;
    Ok(models.into_iter().map(CopilotModelInfo::from).collect())
}

/// Result from a Copilot SDK chat session.
pub struct CopilotChatResult {
    pub response: String,
}

/// Run an agentic chat through the Copilot SDK.
///
/// The SDK manages the agent loop — we register CutReady's tools and
/// translate SDK events into `AgentEvent` for the frontend.
pub async fn chat(
    model: &str,
    system_prompt: &str,
    user_message: &str,
    agent_prompts: &std::collections::HashMap<String, String>,
    project_root: &Path,
    vision_enabled: bool,
    emit: impl Fn(AgentEvent) + Send + Sync + 'static,
) -> Result<CopilotChatResult, String> {
    let client = create_client()?;
    client
        .start()
        .await
        .map_err(|e| format!("Failed to start Copilot CLI: {e}"))?;

    // Build custom agents from CutReady's agent prompts
    let custom_agents: Vec<CustomAgentConfig> = agent_prompts
        .iter()
        .filter(|(id, _)| *id != "system") // Skip the main system prompt
        .map(|(id, prompt)| CustomAgentConfig {
            name: id.clone(),
            prompt: prompt.clone(),
            display_name: Some(format_agent_name(id)),
            description: Some(format!("CutReady {} agent", id)),
            tools: None, // All tools available
            mcp_servers: None,
            infer: Some(true), // SDK auto-delegates based on description
        })
        .collect();

    // Build CutReady tool definitions for the SDK
    let sdk_tools = build_sdk_tools();

    let session_config = SessionConfig {
        model: Some(model.to_string()),
        streaming: true,
        system_message: Some(SystemMessageConfig {
            mode: Some(SystemMessageMode::Replace),
            content: Some(system_prompt.to_string()),
        }),
        custom_agents: if custom_agents.is_empty() {
            None
        } else {
            Some(custom_agents)
        },
        tools: sdk_tools,
        working_directory: Some(project_root.to_string_lossy().to_string()),
        infinite_sessions: Some(copilot_sdk::InfiniteSessionConfig::enabled()),
        ..Default::default()
    };

    let session = client
        .create_session(session_config)
        .await
        .map_err(|e| format!("Failed to create session: {e}"))?;

    // Register tool handlers — bridge SDK tool calls to our existing execute_tool
    register_tool_handlers(&session, project_root, vision_enabled).await;

    // Subscribe to events
    let mut events = session.subscribe();

    // Send the user message
    emit(AgentEvent::Status {
        message: "Thinking…".into(),
    });

    session
        .send(user_message)
        .await
        .map_err(|e| format!("Failed to send message: {e}"))?;

    // Collect the response by processing SDK events
    let mut full_response = String::new();
    let mut delta_count: u32 = 0;
    let mut current_message_id: Option<String> = None;

    loop {
        match events.recv().await {
            Ok(event) => {
                // Trace every event for diagnostics
                trace::emit("copilot_event", "copilot", json!({
                    "type": event.event_type,
                    "summary": match &event.data {
                        SessionEventData::AssistantMessageDelta(d) => {
                            format!("msg_id={} len={}", d.message_id, d.delta_content.len())
                        }
                        SessionEventData::AssistantMessage(m) => {
                            format!("msg_id={} len={}", m.message_id, m.content.len())
                        }
                        SessionEventData::ToolExecutionStart(t) => {
                            format!("tool={}", t.tool_name)
                        }
                        SessionEventData::ToolExecutionComplete(t) => {
                            format!("tool_call_id={}", t.tool_call_id)
                        }
                        _ => String::new(),
                    },
                }));

                // Accumulate full response from deltas, tracking message_id
                if let SessionEventData::AssistantMessageDelta(delta) = &event.data {
                    // If message_id changes, the previous turn's text is superseded —
                    // reset to avoid interleaving deltas from different turns.
                    if current_message_id.as_deref() != Some(&delta.message_id) {
                        if current_message_id.is_some() {
                            trace::emit("copilot_msg_reset", "copilot", json!({
                                "old_msg_id": current_message_id,
                                "new_msg_id": delta.message_id,
                                "discarded_len": full_response.len(),
                            }));
                        }
                        full_response.clear();
                        current_message_id = Some(delta.message_id.clone());
                        delta_count = 0;
                    }
                    full_response.push_str(&delta.delta_content);
                    delta_count += 1;
                }
                // Complete message is authoritative — but only replace if it has
                // content. Empty AssistantMessage events are tool-call turns where the
                // model produced no text (only tool invocations).
                if let SessionEventData::AssistantMessage(msg) = &event.data {
                    trace::emit("copilot_msg_complete", "copilot", json!({
                        "msg_id": msg.message_id,
                        "content_len": msg.content.len(),
                        "delta_accumulated_len": full_response.len(),
                        "delta_count": delta_count,
                        "match": full_response.len() == msg.content.len(),
                    }));
                    if !msg.content.is_empty() {
                        full_response = msg.content.clone();
                        delta_count = 0;
                    }
                }

                match translate_event(&event.data) {
                    EventAction::Emit(agent_event) => emit(agent_event),
                    EventAction::Break(Some(agent_event)) => {
                        emit(agent_event);
                        break;
                    }
                    EventAction::Break(None) => break,
                    EventAction::Ignore => {}
                }
            }
            Err(tokio::sync::broadcast::error::RecvError::Lagged(n)) => {
                trace::emit("copilot_lagged", "copilot", json!({ "skipped": n }));
                log::warn!("[copilot] broadcast lagged, skipped {n} events");
                // Continue receiving — don't break on lag
            }
            Err(_) => break,
        }
    }

    emit(AgentEvent::Done {
        response: full_response.clone(),
    });

    client.stop().await;

    Ok(CopilotChatResult {
        response: full_response,
    })
}

/// Non-streaming single-turn chat (for ✨ sparkle operations).
pub async fn chat_simple(
    model: &str,
    system_prompt: &str,
    user_message: &str,
) -> Result<String, String> {
    let client = create_client()?;
    client
        .start()
        .await
        .map_err(|e| format!("Failed to start Copilot CLI: {e}"))?;

    let session_config = SessionConfig {
        model: Some(model.to_string()),
        system_message: Some(SystemMessageConfig {
            mode: Some(SystemMessageMode::Replace),
            content: Some(system_prompt.to_string()),
        }),
        ..Default::default()
    };

    let session = client
        .create_session(session_config)
        .await
        .map_err(|e| format!("Failed to create session: {e}"))?;

    let response = session
        .send_and_collect(user_message, None)
        .await
        .map_err(|e| format!("Chat failed: {e}"))?;

    client.stop().await;
    Ok(response)
}

// ---------------------------------------------------------------------------
// Internal helpers
// ---------------------------------------------------------------------------

/// Create a Copilot SDK client using stdio transport.
fn create_client() -> Result<Client, String> {
    let mut builder = Client::builder().use_stdio(true).allow_all_tools(true);

    // If copilot CLI is at a known path, use it explicitly
    if let Some(path) = cli_path() {
        builder = builder.cli_path(path);
    }

    builder.build().map_err(|e| format!("Failed to create Copilot client: {e}"))
}

/// Convert CutReady tool definitions to SDK Tool objects.
fn build_sdk_tools() -> Vec<Tool> {
    tools::all_tools()
        .into_iter()
        .filter(|t| t.function.name != "delegate_to_agent") // SDK handles delegation natively
        .map(|t| {
            Tool::new(&t.function.name)
                .description(&t.function.description)
                .schema(t.function.parameters.clone())
        })
        .collect()
}

/// Register tool handlers that bridge SDK tool invocations to our execute_tool.
/// Also registers a permission handler that auto-approves all tool calls
/// (CutReady's tools are safe — no shell commands, no file deletion).
async fn register_tool_handlers(
    session: &copilot_sdk::Session,
    project_root: &Path,
    vision_enabled: bool,
) {
    // Auto-approve all permission requests (our tools are sandboxed)
    session
        .register_permission_handler(|_req| PermissionRequestResult::approved())
        .await;

    for tool_def in tools::all_tools() {
        if tool_def.function.name == "delegate_to_agent" {
            continue; // SDK handles delegation via custom agents
        }

        let root = project_root.to_path_buf();
        let vision = vision_enabled;
        let tool_name = tool_def.function.name.clone();

        let handler: ToolHandler = Arc::new(move |name: &str, args: &Value| {
            let call = ToolCall {
                id: format!("sdk-{}", name),
                call_type: "function".into(),
                function: FunctionCall {
                    name: tool_name.clone(),
                    arguments: serde_json::to_string(args).unwrap_or_else(|_| "{}".into()),
                },
            };
            let result = tools::execute_tool(&call, &root, vision);
            ToolResultObject {
                text_result_for_llm: result,
                binary_results_for_llm: None,
                result_type: "success".into(),
                error: None,
                session_log: None,
                tool_telemetry: None,
            }
        });

        let sdk_tool = Tool::new(&tool_def.function.name)
            .description(&tool_def.function.description)
            .schema(tool_def.function.parameters.clone());

        session.register_tool_with_handler(sdk_tool, Some(handler)).await;
    }
}

/// Format an agent ID (e.g., "planner") into a display name (e.g., "Planner").
fn format_agent_name(id: &str) -> String {
    let mut chars = id.chars();
    match chars.next() {
        None => String::new(),
        Some(c) => c.to_uppercase().to_string() + chars.as_str(),
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use copilot_sdk::{ModelBilling, ModelCapabilities, ModelSupports};

    // -----------------------------------------------------------------------
    // Unit tests — always run, no external dependencies
    // -----------------------------------------------------------------------

    #[test]
    fn format_agent_name_capitalizes_first_letter() {
        assert_eq!(format_agent_name("planner"), "Planner");
        assert_eq!(format_agent_name("writer"), "Writer");
        assert_eq!(format_agent_name("editor"), "Editor");
    }

    #[test]
    fn format_agent_name_handles_edge_cases() {
        assert_eq!(format_agent_name(""), "");
        assert_eq!(format_agent_name("a"), "A");
        assert_eq!(format_agent_name("A"), "A");
        assert_eq!(format_agent_name("already-Capitalized"), "Already-Capitalized");
    }

    #[test]
    fn build_sdk_tools_excludes_delegate_to_agent() {
        let sdk_tools = build_sdk_tools();
        let names: Vec<&str> = sdk_tools.iter().map(|t| t.name.as_str()).collect();
        assert!(
            !names.contains(&"delegate_to_agent"),
            "delegate_to_agent should be excluded — SDK handles delegation natively"
        );
    }

    #[test]
    fn build_sdk_tools_count_matches_all_tools_minus_delegate() {
        let all = tools::all_tools();
        let has_delegate = all.iter().any(|t| t.function.name == "delegate_to_agent");
        let expected = if has_delegate { all.len() - 1 } else { all.len() };
        let sdk_tools = build_sdk_tools();
        assert_eq!(
            sdk_tools.len(),
            expected,
            "SDK tools should include all CutReady tools except delegate_to_agent"
        );
    }

    #[test]
    fn build_sdk_tools_contains_core_tools() {
        let sdk_tools = build_sdk_tools();
        let names: Vec<&str> = sdk_tools.iter().map(|t| t.name.as_str()).collect();

        // Spot-check a few essential tools
        assert!(names.contains(&"read_sketch"), "Should have read_sketch");
        assert!(names.contains(&"set_planning_rows"), "Should have set_planning_rows");
        assert!(names.contains(&"list_project_files"), "Should have list_project_files");
    }

    #[test]
    fn build_sdk_tools_have_descriptions() {
        let sdk_tools = build_sdk_tools();
        for tool in &sdk_tools {
            assert!(
                !tool.description.is_empty(),
                "Tool '{}' should have a non-empty description",
                tool.name
            );
        }
    }

    fn make_test_model(vision: bool, reasoning: bool, billing: Option<f64>) -> ModelInfo {
        ModelInfo {
            id: "test-model".into(),
            name: "Test Model".into(),
            capabilities: ModelCapabilities {
                supports: ModelSupports {
                    vision,
                    reasoning_effort: reasoning,
                },
                ..Default::default()
            },
            policy: None,
            billing: billing.map(|m| ModelBilling { multiplier: m }),
            supported_reasoning_efforts: None,
            default_reasoning_effort: None,
        }
    }

    #[test]
    fn copilot_model_info_from_basic() {
        let model = make_test_model(false, false, None);
        let info = CopilotModelInfo::from(model);
        assert_eq!(info.id, "test-model");
        assert_eq!(info.name, "Test Model");
        assert!(!info.supports_vision);
        assert!(!info.supports_reasoning);
        assert!(info.billing.is_none());
    }

    #[test]
    fn copilot_model_info_from_with_vision_and_reasoning() {
        let model = make_test_model(true, true, None);
        let info = CopilotModelInfo::from(model);
        assert!(info.supports_vision);
        assert!(info.supports_reasoning);
    }

    #[test]
    fn copilot_model_info_from_preserves_billing() {
        let model = make_test_model(false, false, Some(2.0));
        let info = CopilotModelInfo::from(model);
        assert!(info.billing.is_some(), "Billing should be preserved");
    }

    #[test]
    fn copilot_model_info_serializes() {
        let model = make_test_model(true, false, Some(1.5));
        let info = CopilotModelInfo::from(model);
        let json = serde_json::to_value(&info).expect("Should serialize");
        assert_eq!(json["id"], "test-model");
        assert_eq!(json["supports_vision"], true);
        assert_eq!(json["supports_reasoning"], false);
    }

    // -----------------------------------------------------------------------
    // Integration tests — require `copilot` CLI installed + `gh auth login`
    //
    // Run locally with: cargo test -p cutready -- --ignored
    // Skipped in CI (no CLI or auth available).
    // -----------------------------------------------------------------------

    #[test]
    #[ignore]
    fn cli_is_available() {
        assert!(
            is_cli_available(),
            "copilot CLI should be on PATH (install via `gh extension install github/gh-copilot`)"
        );
    }

    #[test]
    #[ignore]
    fn cli_path_returns_existing_binary() {
        let path = cli_path().expect("CLI should be found");
        assert!(path.exists(), "CLI binary should exist at {}", path.display());
    }

    #[test]
    #[ignore]
    fn create_client_succeeds() {
        // Verify we can construct a Client without errors
        let _client = create_client().expect("Should create client");
    }

    #[tokio::test]
    #[ignore]
    async fn list_models_returns_nonempty() {
        let models = list_models().await.expect("list_models should succeed");
        assert!(!models.is_empty(), "Should return at least one model");

        // Every model should have an id and name
        for m in &models {
            assert!(!m.id.is_empty(), "Model id should not be empty");
            assert!(!m.name.is_empty(), "Model name should not be empty");
        }

        // Print for manual inspection
        eprintln!("Found {} models:", models.len());
        for m in &models {
            eprintln!(
                "  {} ({}) vision={} reasoning={}",
                m.name, m.id, m.supports_vision, m.supports_reasoning
            );
        }
    }

    #[tokio::test]
    #[ignore]
    async fn chat_simple_returns_response() {
        let response = chat_simple(
            "gpt-4o-mini",
            "You are a test assistant. Reply with exactly 'PONG'.",
            "PING",
        )
        .await
        .expect("chat_simple should succeed");

        assert!(!response.is_empty(), "Response should not be empty");
        eprintln!("chat_simple response: {response}");
    }

    #[tokio::test(flavor = "multi_thread", worker_threads = 2)]
    #[ignore]
    async fn chat_with_tools_exercises_full_loop() {
        use std::sync::{Arc, Mutex};
        use tempfile::TempDir;

        // Create a temp project with a sketch file
        let tmp = TempDir::new().unwrap();
        let root = tmp.path();
        std::fs::write(
            root.join("demo.sk"),
            r#"{"title":"Integration Test Sketch","description":"A test sketch","rows":[]}"#,
        )
        .unwrap();

        eprintln!("[test] Creating client...");
        let client = create_client().expect("create_client");

        eprintln!("[test] Starting client...");
        client.start().await.expect("client.start()");

        eprintln!("[test] Building tools...");
        let sdk_tools = build_sdk_tools();
        eprintln!("[test] Registered {} tool definitions", sdk_tools.len());

        let session_config = SessionConfig {
            model: Some("gpt-4.1".to_string()),
            streaming: true,
            system_message: Some(SystemMessageConfig {
                mode: Some(SystemMessageMode::Replace),
                content: Some(
                    "You are a test assistant. You have tools available. \
                     When asked to list files, call list_project_files and report what you find."
                        .to_string(),
                ),
            }),
            tools: sdk_tools,
            working_directory: Some(root.to_string_lossy().to_string()),
            ..Default::default()
        };

        eprintln!("[test] Creating session...");
        let session = client.create_session(session_config).await.expect("create_session");

        eprintln!("[test] Registering tool handlers + permission handler...");
        register_tool_handlers(&session, root, false).await;

        eprintln!("[test] Subscribing to events...");
        let mut events = session.subscribe();

        eprintln!("[test] Sending message...");
        session
            .send("List the files in this project using the list_project_files tool.")
            .await
            .expect("session.send");
        eprintln!("[test] Message sent, entering event loop...");

        // Collect events with tracing
        let collected: Arc<Mutex<Vec<String>>> = Arc::new(Mutex::new(Vec::new()));
        let mut full_response = String::new();

        // Add a timeout to prevent infinite hang
        let timeout = tokio::time::Duration::from_secs(60);
        let start = tokio::time::Instant::now();

        loop {
            if start.elapsed() > timeout {
                eprintln!("[test] TIMEOUT after 60s");
                break;
            }

            match tokio::time::timeout(tokio::time::Duration::from_secs(10), events.recv()).await {
                Ok(Ok(event)) => {
                    let tag = format!("{:?}", std::mem::discriminant(&event.data));
                    let readable = match &event.data {
                        SessionEventData::AssistantMessageDelta(d) => {
                            full_response.push_str(&d.delta_content);
                            format!("Delta({}b)", d.delta_content.len())
                        }
                        SessionEventData::AssistantMessage(m) => {
                            if full_response.is_empty() {
                                full_response = m.content.clone();
                            }
                            format!("AssistantMessage({}b)", m.content.len())
                        }
                        SessionEventData::ToolExecutionStart(t) => {
                            format!("ToolCall({})", t.tool_name)
                        }
                        SessionEventData::ToolExecutionComplete(t) => {
                            format!(
                                "ToolResult({})",
                                t.result.as_ref().map(|r| r.content.len()).unwrap_or(0)
                            )
                        }
                        SessionEventData::SessionError(e) => {
                            format!("ERROR: {}", e.message)
                        }
                        SessionEventData::SessionIdle(_) => "SessionIdle".to_string(),
                        _ => tag,
                    };
                    eprintln!("[test] Event: {readable}");
                    collected.lock().unwrap().push(readable);

                    if matches!(
                        event.data,
                        SessionEventData::SessionIdle(_) | SessionEventData::SessionError(_)
                    ) {
                        break;
                    }
                }
                Ok(Err(_)) => {
                    eprintln!("[test] Channel closed");
                    break;
                }
                Err(_) => {
                    eprintln!("[test] No event for 10s, still waiting...");
                }
            }
        }

        eprintln!("[test] Stopping client...");
        client.stop().await;

        let collected = collected.lock().unwrap();
        eprintln!("[test] Total events: {}", collected.len());
        eprintln!(
            "[test] Response (first 300): {}",
            &full_response[..full_response.len().min(300)]
        );

        // Verify the full loop
        let has_tool_call = collected
            .iter()
            .any(|e| e.contains("ToolCall(list_project_files)"));
        assert!(
            has_tool_call,
            "Should have emitted a ToolCall for list_project_files. Events: {collected:?}"
        );

        let has_tool_result = collected.iter().any(|e| e.starts_with("ToolResult"));
        assert!(
            has_tool_result,
            "Should have emitted a ToolResult after tool execution. Events: {collected:?}"
        );

        assert!(
            full_response.contains("demo.sk")
                || full_response.to_lowercase().contains("sketch")
                || full_response.to_lowercase().contains("demo"),
            "Response should reference the demo.sk file. Got: {}",
            &full_response[..full_response.len().min(300)]
        );
    }

    // -----------------------------------------------------------------------
    // Error path tests — event translation edge cases (no CLI needed)
    // -----------------------------------------------------------------------

    use copilot_sdk::{
        AssistantMessageDeltaData, AssistantMessageData, AssistantReasoningData,
        AssistantReasoningDeltaData, AssistantUsageData, CustomAgentCompletedData,
        CustomAgentStartedData, SessionErrorData, SessionIdleData, ToolExecutionCompleteData,
        ToolExecutionStartData, ToolResultContent,
    };

    #[test]
    fn translate_delta_emits_delta() {
        let data = SessionEventData::AssistantMessageDelta(AssistantMessageDeltaData {
            message_id: "m1".into(),
            delta_content: "hello".into(),
            total_response_size_bytes: None,
            parent_tool_call_id: None,
        });
        match translate_event(&data) {
            EventAction::Emit(AgentEvent::Delta { content }) => {
                assert_eq!(content, "hello");
            }
            other => panic!("Expected Emit(Delta), got {other:?}"),
        }
    }

    #[test]
    fn translate_empty_delta() {
        let data = SessionEventData::AssistantMessageDelta(AssistantMessageDeltaData {
            message_id: "m2".into(),
            delta_content: String::new(),
            total_response_size_bytes: None,
            parent_tool_call_id: None,
        });
        match translate_event(&data) {
            EventAction::Emit(AgentEvent::Delta { content }) => {
                assert_eq!(content, "");
            }
            other => panic!("Expected Emit(Delta) with empty content, got {other:?}"),
        }
    }

    #[test]
    fn translate_assistant_message_is_ignored() {
        let data = SessionEventData::AssistantMessage(AssistantMessageData {
            message_id: "m1".into(),
            content: "full message".into(),
            chunk_content: None,
            total_response_size_bytes: None,
            tool_requests: None,
            parent_tool_call_id: None,
        });
        assert!(matches!(translate_event(&data), EventAction::Ignore));
    }

    #[test]
    fn translate_reasoning_emits_thinking() {
        let data = SessionEventData::AssistantReasoning(AssistantReasoningData {
            reasoning_id: "r1".into(),
            content: "let me think...".into(),
            chunk_content: None,
        });
        match translate_event(&data) {
            EventAction::Emit(AgentEvent::Thinking { content }) => {
                assert_eq!(content, "let me think...");
            }
            other => panic!("Expected Emit(Thinking), got {other:?}"),
        }
    }

    #[test]
    fn translate_reasoning_delta_emits_thinking() {
        let data = SessionEventData::AssistantReasoningDelta(AssistantReasoningDeltaData {
            reasoning_id: "r1".into(),
            delta_content: "step 2...".into(),
        });
        match translate_event(&data) {
            EventAction::Emit(AgentEvent::Thinking { content }) => {
                assert_eq!(content, "step 2...");
            }
            other => panic!("Expected Emit(Thinking), got {other:?}"),
        }
    }

    #[test]
    fn translate_tool_start_with_args() {
        let data = SessionEventData::ToolExecutionStart(ToolExecutionStartData {
            tool_call_id: "tc1".into(),
            tool_name: "read_sketch".into(),
            arguments: Some(serde_json::json!({"path": "demo.sk"})),
            parent_tool_call_id: None,
        });
        match translate_event(&data) {
            EventAction::Emit(AgentEvent::ToolCall { name, arguments }) => {
                assert_eq!(name, "read_sketch");
                assert!(arguments.contains("demo.sk"));
            }
            other => panic!("Expected Emit(ToolCall), got {other:?}"),
        }
    }

    #[test]
    fn translate_tool_start_without_args() {
        let data = SessionEventData::ToolExecutionStart(ToolExecutionStartData {
            tool_call_id: "tc2".into(),
            tool_name: "list_project_files".into(),
            arguments: None,
            parent_tool_call_id: None,
        });
        match translate_event(&data) {
            EventAction::Emit(AgentEvent::ToolCall { name, arguments }) => {
                assert_eq!(name, "list_project_files");
                assert_eq!(arguments, "{}");
            }
            other => panic!("Expected Emit(ToolCall), got {other:?}"),
        }
    }

    #[test]
    fn translate_tool_complete_with_result() {
        let data = SessionEventData::ToolExecutionComplete(ToolExecutionCompleteData {
            tool_call_id: "tc1".into(),
            success: true,
            is_user_requested: None,
            result: Some(ToolResultContent {
                content: "file contents here".into(),
            }),
            error: None,
            tool_telemetry: None,
            parent_tool_call_id: None,
            mcp_server_name: None,
            mcp_tool_name: None,
        });
        match translate_event(&data) {
            EventAction::Emit(AgentEvent::ToolResult { name, result }) => {
                assert_eq!(name, "tc1");
                assert_eq!(result, "file contents here");
            }
            other => panic!("Expected Emit(ToolResult), got {other:?}"),
        }
    }

    #[test]
    fn translate_tool_complete_without_result() {
        let data = SessionEventData::ToolExecutionComplete(ToolExecutionCompleteData {
            tool_call_id: "tc-fail".into(),
            success: false,
            is_user_requested: None,
            result: None,
            error: None,
            tool_telemetry: None,
            parent_tool_call_id: None,
            mcp_server_name: None,
            mcp_tool_name: None,
        });
        match translate_event(&data) {
            EventAction::Emit(AgentEvent::ToolResult { name, result }) => {
                assert_eq!(name, "tc-fail");
                assert_eq!(result, "", "Missing result should produce empty string");
            }
            other => panic!("Expected Emit(ToolResult), got {other:?}"),
        }
    }

    #[test]
    fn translate_session_error_breaks_with_error() {
        let data = SessionEventData::SessionError(SessionErrorData {
            error_type: "rate_limit".into(),
            message: "Rate limit exceeded".into(),
            stack: None,
            code: Some(429.0),
            provider_call_id: None,
        });
        match translate_event(&data) {
            EventAction::Break(Some(AgentEvent::Error { message })) => {
                assert_eq!(message, "Rate limit exceeded");
            }
            other => panic!("Expected Break(Error), got {other:?}"),
        }
    }

    #[test]
    fn translate_session_idle_breaks_cleanly() {
        let data = SessionEventData::SessionIdle(SessionIdleData {});
        assert!(matches!(translate_event(&data), EventAction::Break(None)));
    }

    #[test]
    fn translate_custom_agent_started() {
        let data = SessionEventData::CustomAgentStarted(CustomAgentStartedData {
            tool_call_id: "tc-agent".into(),
            agent_name: "planner".into(),
            agent_display_name: "Planner".into(),
            agent_description: "Plans things".into(),
        });
        match translate_event(&data) {
            EventAction::Emit(AgentEvent::AgentStart { agent_id, task }) => {
                assert_eq!(agent_id, "planner");
                assert_eq!(task, "");
            }
            other => panic!("Expected Emit(AgentStart), got {other:?}"),
        }
    }

    #[test]
    fn translate_custom_agent_completed() {
        let data = SessionEventData::CustomAgentCompleted(CustomAgentCompletedData {
            tool_call_id: "tc-agent".into(),
            agent_name: "writer".into(),
        });
        match translate_event(&data) {
            EventAction::Emit(AgentEvent::AgentDone { agent_id }) => {
                assert_eq!(agent_id, "writer");
            }
            other => panic!("Expected Emit(AgentDone), got {other:?}"),
        }
    }

    #[test]
    fn translate_unknown_event_is_ignored() {
        let data = SessionEventData::Unknown(serde_json::json!({"some": "random data"}));
        assert!(matches!(translate_event(&data), EventAction::Ignore));
    }

    #[test]
    fn translate_usage_event_is_ignored() {
        let data = SessionEventData::AssistantUsage(AssistantUsageData::default());
        assert!(matches!(translate_event(&data), EventAction::Ignore));
    }

    // -----------------------------------------------------------------------
    // Tool handler resilience tests (no CLI needed)
    // -----------------------------------------------------------------------

    #[test]
    fn tool_handler_with_empty_args() {
        let root = std::env::temp_dir();
        let handler: ToolHandler = Arc::new(move |name: &str, args: &Value| {
            let call = ToolCall {
                id: format!("sdk-{}", name),
                call_type: "function".into(),
                function: FunctionCall {
                    name: name.to_string(),
                    arguments: serde_json::to_string(args).unwrap_or_else(|_| "{}".into()),
                },
            };
            let result = tools::execute_tool(&call, &root, false);
            ToolResultObject {
                text_result_for_llm: result,
                binary_results_for_llm: None,
                result_type: "success".into(),
                error: None,
                session_log: None,
                tool_telemetry: None,
            }
        });

        // Call with empty object — list_project_files doesn't need args
        let result = handler("list_project_files", &serde_json::json!({}));
        assert!(!result.text_result_for_llm.is_empty(), "Should return something even with empty args");
    }

    #[test]
    fn tool_handler_with_null_args() {
        let root = std::env::temp_dir();
        let handler: ToolHandler = Arc::new(move |name: &str, args: &Value| {
            let call = ToolCall {
                id: format!("sdk-{}", name),
                call_type: "function".into(),
                function: FunctionCall {
                    name: name.to_string(),
                    arguments: serde_json::to_string(args).unwrap_or_else(|_| "{}".into()),
                },
            };
            let result = tools::execute_tool(&call, &root, false);
            ToolResultObject {
                text_result_for_llm: result,
                binary_results_for_llm: None,
                result_type: "success".into(),
                error: None,
                session_log: None,
                tool_telemetry: None,
            }
        });

        // Call with null — should not panic
        let result = handler("list_project_files", &Value::Null);
        assert!(!result.text_result_for_llm.is_empty());
    }

    #[test]
    fn tool_handler_with_unknown_tool() {
        let root = std::env::temp_dir();
        let handler: ToolHandler = Arc::new(move |name: &str, args: &Value| {
            let call = ToolCall {
                id: format!("sdk-{}", name),
                call_type: "function".into(),
                function: FunctionCall {
                    name: name.to_string(),
                    arguments: serde_json::to_string(args).unwrap_or_else(|_| "{}".into()),
                },
            };
            let result = tools::execute_tool(&call, &root, false);
            ToolResultObject {
                text_result_for_llm: result,
                binary_results_for_llm: None,
                result_type: "success".into(),
                error: None,
                session_log: None,
                tool_telemetry: None,
            }
        });

        // Unknown tool — should not panic, returns error message
        let result = handler("nonexistent_tool_xyz", &serde_json::json!({}));
        assert!(
            !result.text_result_for_llm.is_empty(),
            "Unknown tool should return a message, not panic"
        );
    }

    #[test]
    fn tool_handler_with_malformed_json_args() {
        let root = std::env::temp_dir();
        let handler: ToolHandler = Arc::new(move |name: &str, args: &Value| {
            let call = ToolCall {
                id: format!("sdk-{}", name),
                call_type: "function".into(),
                function: FunctionCall {
                    name: name.to_string(),
                    arguments: serde_json::to_string(args).unwrap_or_else(|_| "{}".into()),
                },
            };
            let result = tools::execute_tool(&call, &root, false);
            ToolResultObject {
                text_result_for_llm: result,
                binary_results_for_llm: None,
                result_type: "success".into(),
                error: None,
                session_log: None,
                tool_telemetry: None,
            }
        });

        // Completely wrong arg shape — should not panic
        let result = handler("read_sketch", &serde_json::json!([1, 2, 3]));
        assert!(!result.text_result_for_llm.is_empty());
    }

    // -----------------------------------------------------------------------
    // Client creation edge case tests (no CLI needed)
    // -----------------------------------------------------------------------

    #[test]
    fn build_sdk_tools_all_have_schemas() {
        let sdk_tools = build_sdk_tools();
        for tool in &sdk_tools {
            assert!(
                !tool.parameters_schema.is_null(),
                "Tool '{}' should have a JSON schema for parameters",
                tool.name
            );
        }
    }

    #[test]
    fn copilot_model_info_from_empty_name() {
        let model = ModelInfo {
            id: "".into(),
            name: "".into(),
            capabilities: ModelCapabilities {
                supports: ModelSupports {
                    vision: false,
                    reasoning_effort: false,
                },
                ..Default::default()
            },
            policy: None,
            billing: None,
            supported_reasoning_efforts: None,
            default_reasoning_effort: None,
        };
        let info = CopilotModelInfo::from(model);
        assert_eq!(info.id, "");
        assert_eq!(info.name, "");
    }
}
