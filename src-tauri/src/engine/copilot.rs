//! GitHub Copilot SDK integration — alternative AI provider.
//!
//! When the user selects "GitHub Copilot" as their provider, this module
//! manages the entire agent runtime via the Copilot SDK. The SDK handles
//! the agent loop, tool dispatch, context compaction, and streaming.
//! CutReady registers its tools and translates SDK events to `AgentEvent`.

use std::path::{Path, PathBuf};
use std::sync::Arc;

use copilot_sdk::{
    Client, CustomAgentConfig, ModelInfo, SessionConfig, SessionEventData, SystemMessageConfig,
    SystemMessageMode, Tool, ToolHandler, ToolResultObject,
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
    let mut builder = Client::builder().use_stdio(true);

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
async fn register_tool_handlers(
    session: &copilot_sdk::Session,
    project_root: &Path,
    vision_enabled: bool,
) {
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
