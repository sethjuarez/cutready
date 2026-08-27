//! GitHub Copilot SDK agent harness adapter.
//!
//! This module is the *only* place the [`copilot_sdk`] crate is wired into the
//! harness seam. The Copilot runtime is the GitHub Copilot CLI driven as a
//! subprocess over JSON-RPC; all `copilot_sdk::*` types — client, session,
//! events — stay behind this adapter and never leak past the CutReady-owned
//! boundary types in [`super`].
//!
//! Unlike the Prompty and agentive harnesses, the Copilot harness runs
//! Copilot's *own* agent loop with Copilot's *own* tools; it does not drive
//! CutReady's path-confined project tools, sub-agent delegation, mid-run
//! steering queue, or durable run-state persistence. Those differences are
//! advertised explicitly through [`static_capabilities`] rather than silently
//! downgraded, and the CutReady conversation/system prompt/context are handed
//! to the CLI so nothing the host gathered is dropped.
//!
//! Availability tracks whether the `copilot` CLI can be located on the host at
//! enumeration time (see [`is_available`]); the adapter never pretends to run
//! without it.

use std::time::Duration;

use async_trait::async_trait;

use crate::engine::agent::execution::{AgentEvent, ChatMessage, ContextItem, Usage};
use crate::engine::agent::llm::{LlmConfig, LlmProvider};

use super::{
    AgentHarness, AgentRunRequest, AgentRunResult, HarnessCapabilities, HarnessEventEmitter,
};

/// Canonical, stable identifier for the Copilot SDK harness.
pub const ID: &str = "copilot-sdk";

/// Whether the Copilot SDK harness can currently execute a run on this host.
///
/// Unlike the other adapters — whose availability is a compile-time constant —
/// the Copilot harness needs the GitHub Copilot CLI present at run time, so
/// availability is probed rather than assumed. The registry surfaces this to the
/// settings UI so the harness is only offered when it can actually run, instead
/// of being advertised and then failing when selected.
pub fn is_available() -> bool {
    copilot_sdk::find_copilot_cli().is_some()
}

/// Capability metadata for the Copilot SDK runtime.
///
/// The Copilot CLI streams assistant deltas and runs its own tool loop, so
/// `streaming` and `tool_calls` are supported (the tool calls are Copilot's own,
/// not CutReady's path-confined project tools). It does not participate in
/// CutReady's sub-agent delegation, mid-run steering queue, web-search tool, or
/// durable run-state persistence, so those are advertised as unsupported.
pub fn static_capabilities() -> HarnessCapabilities {
    HarnessCapabilities {
        id: ID.to_string(),
        display_name: "GitHub Copilot".to_string(),
        streaming: true,
        tool_calls: true,
        vision: true,
        web_search: false,
        delegation: false,
        steering: false,
        cancellation: true,
        durable_state: false,
    }
}

/// Production harness backed by the GitHub Copilot CLI via [`copilot_sdk`].
///
/// Stateless: the registry constructs it fresh per resolve. Each run spins up a
/// dedicated CLI client/session and tears it down when the run completes.
pub struct CopilotSdkHarness;

impl CopilotSdkHarness {
    /// Build a Copilot SDK harness.
    pub fn new() -> Self {
        Self
    }
}

impl Default for CopilotSdkHarness {
    fn default() -> Self {
        Self::new()
    }
}

#[async_trait]
impl AgentHarness for CopilotSdkHarness {
    fn id(&self) -> &str {
        ID
    }

    fn capabilities(&self) -> HarnessCapabilities {
        static_capabilities()
    }

    async fn run(
        &self,
        request: AgentRunRequest,
        emit: HarnessEventEmitter,
    ) -> Result<AgentRunResult, String> {
        let AgentRunRequest {
            config,
            messages,
            repo_root: _repo_root,
            project_root,
            agent_id,
            agent_prompts,
            // The Copilot CLI runs its own tool loop with its own tools, so
            // CutReady's tool contract and mutation policy are not bridged here
            // (advertised via `tool_calls: true` for Copilot's own tools and
            // `delegation: false`). Path confinement stays with the CLI's cwd.
            mutation_tools_enabled: _mutation_tools_enabled,
            tools: _tools,
            context_items,
            run_id: _run_id,
            // Durable run-state persistence is not a Copilot-harness capability
            // (advertised as `durable_state: false`), so the store is not used.
            agent_state: _agent_state,
            cancellation,
        } = request;

        if !is_available() {
            return fail(
                &emit,
                "GitHub Copilot CLI was not found on this system. Install the Copilot CLI \
                 (or set COPILOT_CLI_PATH) to use the Copilot harness."
                    .to_string(),
            );
        }

        // Build and start the CLI client. `use_stdio` drives the CLI over stdio
        // (no local socket); `allow_all_tools` keeps the run non-interactive so a
        // headless harness never blocks on a permission prompt.
        let client = match copilot_sdk::Client::builder()
            .use_stdio(true)
            .cwd(&project_root)
            .allow_all_tools(true)
            .build()
        {
            Ok(client) => client,
            Err(error) => return fail(&emit, format!("Failed to build Copilot client: {error}")),
        };

        if let Err(error) = client.start().await {
            return fail(&emit, format!("Failed to start Copilot CLI: {error}"));
        }

        // Compose the system message: the agent persona prompt plus any
        // preselected context items, folded in so nothing the host gathered is
        // silently dropped. `Replace` mode makes the CutReady persona the
        // authoritative system prompt for the turn.
        let system_content = compose_system_message(&agent_id, &agent_prompts, &context_items);
        let system_message = system_content.map(|content| copilot_sdk::SystemMessageConfig {
            mode: Some(copilot_sdk::SystemMessageMode::Replace),
            content: Some(content),
        });

        let model = config.llm.model.trim().to_string();
        let session_config = copilot_sdk::SessionConfig {
            model: (!model.is_empty()).then(|| model.clone()),
            system_message,
            provider: build_provider_config(&config.llm),
            streaming: true,
            working_directory: project_root.to_str().map(str::to_string),
            // Non-interactive: don't round-trip permission decisions to the SDK.
            request_permission: Some(false),
            ..Default::default()
        };

        let session = match client.create_session(session_config).await {
            Ok(session) => session,
            Err(error) => {
                let _ = client.stop().await;
                return fail(&emit, format!("Failed to create Copilot session: {error}"));
            }
        };

        // Subscribe before sending so no assistant events are missed.
        let mut events = session.subscribe();

        // Flatten the CutReady conversation into a single prompt. The CLI keeps
        // its own session history, but CutReady creates a fresh session per run,
        // so prior turns are rendered into the prompt to preserve context.
        let prompt = flatten_conversation(&messages);
        if let Err(error) = session.send(prompt).await {
            let _ = client.stop().await;
            return fail(&emit, format!("Failed to send prompt to Copilot: {error}"));
        }

        let mut response = String::new();
        let mut usage = Usage::default();
        let mut cancelled = false;
        let mut run_error: Option<String> = None;
        // Map tool_call_id -> tool_name from start events so completion events
        // (which carry only the id) can be labeled with a meaningful name.
        let mut tool_names: std::collections::HashMap<String, String> =
            std::collections::HashMap::new();

        loop {
            if cancellation.is_cancelled() {
                let _ = session.abort().await;
                cancelled = true;
                break;
            }
            // Poll with a bounded timeout so cancellation is observed promptly
            // even while the model is quiet between events.
            match tokio::time::timeout(Duration::from_millis(200), events.recv()).await {
                // Timed out waiting for the next event: loop to re-check cancel.
                Err(_elapsed) => continue,
                // The broadcast channel closed (CLI went away): stop reading.
                Ok(Err(_closed)) => break,
                Ok(Ok(event)) => {
                    use copilot_sdk::SessionEventData as Data;
                    match event.data {
                        Data::AssistantMessageDelta(delta) => {
                            response.push_str(&delta.delta_content);
                            (*emit)(AgentEvent::Delta {
                                content: delta.delta_content,
                            });
                        }
                        Data::AssistantMessage(message) => {
                            // Authoritative full message. If streaming produced
                            // nothing (non-streaming turn), surface it as a delta
                            // so the UI still shows the response.
                            if response.is_empty() && !message.content.is_empty() {
                                (*emit)(AgentEvent::Delta {
                                    content: message.content.clone(),
                                });
                            }
                            response = message.content;
                        }
                        Data::AssistantReasoningDelta(delta) => {
                            (*emit)(AgentEvent::Thinking {
                                content: delta.delta_content,
                            });
                        }
                        Data::ToolExecutionStart(tool) => {
                            let arguments = tool
                                .arguments
                                .as_ref()
                                .map(|value| value.to_string())
                                .unwrap_or_default();
                            tool_names.insert(tool.tool_call_id.clone(), tool.tool_name.clone());
                            (*emit)(AgentEvent::ToolCall {
                                name: tool.tool_name,
                                arguments,
                            });
                        }
                        Data::ToolExecutionComplete(tool) => {
                            let result = if tool.success {
                                tool.result
                                    .map(|content| content.content)
                                    .unwrap_or_default()
                            } else {
                                tool.error
                                    .map(|error| error.message)
                                    .unwrap_or_else(|| "Tool execution failed.".to_string())
                            };
                            let name = tool_names
                                .remove(&tool.tool_call_id)
                                .unwrap_or_else(|| tool.tool_call_id.clone());
                            (*emit)(AgentEvent::ToolResult { name, result });
                        }
                        Data::AssistantUsage(reported) => {
                            usage = to_host_usage(&reported);
                        }
                        Data::SessionError(error) => {
                            run_error = Some(format!("Copilot session error: {}", error.message));
                            break;
                        }
                        Data::SessionIdle(_) => break,
                        // Turn boundaries, info, compaction, hooks, and other
                        // lifecycle events have no CutReady frontend
                        // representation and are ignored.
                        _ => {}
                    }
                }
            }
        }

        // Tear the CLI down regardless of outcome.
        let _ = session.destroy().await;
        let _ = client.stop().await;

        if cancelled || cancellation.is_cancelled() {
            // The host command normalizes the cancelled outcome; don't emit an
            // Error/Done event for a user-cancelled run.
            return Err("Agent run cancelled by user.".to_string());
        }

        if let Some(message) = run_error {
            (*emit)(AgentEvent::Error {
                message: message.clone(),
            });
            return Err(message);
        }

        // Append the assistant turn to the conversation the host handed us so the
        // returned history matches the other harnesses' contract.
        let mut history = messages;
        history.push(ChatMessage::assistant(&response));

        (*emit)(AgentEvent::Done {
            response: response.clone(),
        });

        Ok(AgentRunResult {
            messages: history,
            response,
            usage,
        })
    }
}

// ---------------------------------------------------------------------------
// Prompt / system-message composition
// ---------------------------------------------------------------------------

/// Compose the CLI system message from the agent persona prompt and any
/// preselected context items. Returns `None` when there is nothing to send.
fn compose_system_message(
    agent_id: &str,
    agent_prompts: &std::collections::HashMap<String, String>,
    context_items: &[ContextItem],
) -> Option<String> {
    let mut blocks: Vec<String> = Vec::new();
    if let Some(system) = agent_prompts
        .get(agent_id)
        .map(|prompt| prompt.trim())
        .filter(|prompt| !prompt.is_empty())
    {
        blocks.push(system.to_string());
    }
    if let Some(context) = context_items_to_block(context_items) {
        blocks.push(context);
    }
    (!blocks.is_empty()).then(|| blocks.join("\n\n"))
}

/// Fold preselected context items into a single text block so nothing the host
/// gathered is silently dropped.
fn context_items_to_block(items: &[ContextItem]) -> Option<String> {
    if items.is_empty() {
        return None;
    }
    let mut block = String::from("Relevant context gathered for this task. Use it when helpful.\n");
    let mut wrote_any = false;
    for item in items {
        let body = item
            .content
            .as_deref()
            .map(str::trim)
            .filter(|content| !content.is_empty())
            .unwrap_or_else(|| item.description.trim());
        if body.is_empty() && item.name.trim().is_empty() {
            continue;
        }
        wrote_any = true;
        block.push_str("\n## ");
        block.push_str(item.name.trim());
        block.push('\n');
        if !body.is_empty() {
            block.push_str(body);
            block.push('\n');
        }
    }
    wrote_any.then_some(block)
}

/// Flatten the CutReady conversation into a single prompt string.
///
/// System messages are handled separately (via the CLI system message), so only
/// user/assistant/tool turns are rendered. A single trailing user turn is sent
/// verbatim; multi-turn history is labeled so the CLI can follow the exchange.
fn flatten_conversation(messages: &[ChatMessage]) -> String {
    let turns: Vec<&ChatMessage> = messages
        .iter()
        .filter(|message| message.role != "system")
        .collect();

    // Common case: a single user turn — send it verbatim.
    if let [only] = turns.as_slice() {
        if only.role == "user" {
            return only.text().unwrap_or_default().to_string();
        }
    }

    let mut rendered = String::new();
    for message in turns {
        let text = message.text().unwrap_or_default().trim();
        if text.is_empty() {
            continue;
        }
        let label = match message.role.as_str() {
            "user" => "User",
            "assistant" => "Assistant",
            "tool" => "Tool result",
            other => other,
        };
        rendered.push_str(label);
        rendered.push_str(":\n");
        rendered.push_str(text);
        rendered.push_str("\n\n");
    }
    rendered.trim_end().to_string()
}

// ---------------------------------------------------------------------------
// Provider construction
// ---------------------------------------------------------------------------

/// Translate CutReady's provider config into a Copilot BYOK provider config.
///
/// Returns `None` when no API key or bearer token is configured, in which case
/// the CLI falls back to the signed-in user's Copilot entitlement.
fn build_provider_config(llm: &LlmConfig) -> Option<copilot_sdk::ProviderConfig> {
    let api_key = non_empty(&llm.api_key);
    let bearer_token = llm.bearer_token.as_deref().and_then(non_empty);
    if api_key.is_none() && bearer_token.is_none() {
        return None;
    }

    match llm.provider {
        LlmProvider::Openai => Some(copilot_sdk::ProviderConfig {
            base_url: openai_base_url(&llm.endpoint),
            provider_type: Some("openai".to_string()),
            wire_api: Some("openai".to_string()),
            api_key,
            bearer_token: None,
            azure: None,
        }),
        LlmProvider::Anthropic => Some(copilot_sdk::ProviderConfig {
            base_url: non_empty(&llm.endpoint)
                .unwrap_or_else(|| "https://api.anthropic.com".to_string()),
            provider_type: Some("anthropic".to_string()),
            wire_api: Some("anthropic".to_string()),
            api_key,
            bearer_token: None,
            azure: None,
        }),
        LlmProvider::AzureOpenai | LlmProvider::MicrosoftFoundry => {
            let base_url = non_empty(&llm.endpoint)?;
            Some(copilot_sdk::ProviderConfig {
                base_url,
                provider_type: Some("azure".to_string()),
                wire_api: Some("openai".to_string()),
                // Prefer an Entra bearer token when present; fall back to the
                // classic api-key header otherwise.
                api_key: if bearer_token.is_some() { None } else { api_key },
                bearer_token,
                azure: Some(copilot_sdk::AzureOptions { api_version: None }),
            })
        }
    }
}

/// Normalize an OpenAI endpoint to a `/v1` base URL. CutReady stores the bare
/// host (`https://api.openai.com`); the Copilot BYOK config expects the full
/// base URL including `/v1`.
fn openai_base_url(raw: &str) -> String {
    let trimmed = raw.trim_end_matches('/');
    let base = if trimmed.is_empty() {
        "https://api.openai.com"
    } else {
        trimmed
    };
    if base.ends_with("/v1") || base.contains("/v1/") {
        base.to_string()
    } else {
        format!("{base}/v1")
    }
}

fn non_empty(value: &str) -> Option<String> {
    let trimmed = value.trim();
    (!trimmed.is_empty()).then(|| trimmed.to_string())
}

fn to_host_usage(reported: &copilot_sdk::AssistantUsageData) -> Usage {
    let prompt_tokens = reported.input_tokens.unwrap_or(0.0).max(0.0) as u32;
    let completion_tokens = reported.output_tokens.unwrap_or(0.0).max(0.0) as u32;
    Usage {
        prompt_tokens,
        completion_tokens,
        total_tokens: prompt_tokens + completion_tokens,
    }
}

/// Emit an `Error` event and return the same message as the run failure.
fn fail(emit: &HarnessEventEmitter, message: String) -> Result<AgentRunResult, String> {
    (*emit)(AgentEvent::Error {
        message: message.clone(),
    });
    Err(message)
}
