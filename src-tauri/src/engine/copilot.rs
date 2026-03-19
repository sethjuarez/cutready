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
use serde_json::Value;

use crate::engine::agent::llm::{FunctionCall, ToolCall};
use crate::engine::agent::runner::AgentEvent;
use crate::engine::agent::tools;

/// A serializable model info returned to the frontend.
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

    loop {
        match events.recv().await {
            Ok(event) => match &event.data {
                SessionEventData::AssistantMessageDelta(delta) => {
                    full_response.push_str(&delta.delta_content);
                    emit(AgentEvent::Delta {
                        content: delta.delta_content.clone(),
                    });
                }
                SessionEventData::AssistantMessage(msg) => {
                    if full_response.is_empty() {
                        full_response = msg.content.clone();
                    }
                }
                SessionEventData::AssistantReasoning(r) => {
                    emit(AgentEvent::Thinking {
                        content: r.content.clone(),
                    });
                }
                SessionEventData::AssistantReasoningDelta(d) => {
                    emit(AgentEvent::Thinking {
                        content: d.delta_content.clone(),
                    });
                }
                SessionEventData::ToolExecutionStart(tool) => {
                    emit(AgentEvent::ToolCall {
                        name: tool.tool_name.clone(),
                        arguments: tool
                            .arguments
                            .as_ref()
                            .map(|a| serde_json::to_string(a).unwrap_or_else(|_| "{}".into()))
                            .unwrap_or_else(|| "{}".into()),
                    });
                }
                SessionEventData::ToolExecutionComplete(tool) => {
                    let result_text = tool
                        .result
                        .as_ref()
                        .map(|r| r.content.clone())
                        .unwrap_or_default();
                    emit(AgentEvent::ToolResult {
                        name: tool.tool_call_id.clone(),
                        result: result_text,
                    });
                }
                SessionEventData::CustomAgentStarted(agent) => {
                    emit(AgentEvent::AgentStart {
                        agent_id: agent.agent_name.clone(),
                        task: String::new(),
                    });
                }
                SessionEventData::CustomAgentCompleted(agent) => {
                    emit(AgentEvent::AgentDone {
                        agent_id: agent.agent_name.clone(),
                    });
                }
                SessionEventData::SessionError(err) => {
                    emit(AgentEvent::Error {
                        message: err.message.clone(),
                    });
                    break;
                }
                SessionEventData::SessionIdle(_) => {
                    break;
                }
                _ => {
                    // Ignore other events (usage, turn start/end, etc.)
                }
            },
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
}
