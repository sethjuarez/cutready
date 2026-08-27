//! Agentive agent harness adapter.
//!
//! This module is the *only* place the [`agentive`] crate is wired into the
//! harness seam. Everything `agentive::*` — providers, the run loop, its native
//! message/tool/event types — stays behind this adapter and never leaks past the
//! CutReady-owned boundary types in [`super`].
//!
//! Capability metadata lives here so the registry can advertise agentive
//! honestly (see [`static_capabilities`]). `AVAILABLE` is `true` because this
//! adapter can execute a run end-to-end.

use std::sync::atomic::Ordering;
use std::time::Duration;

use async_trait::async_trait;
use serde::de::DeserializeOwned;
use serde::Serialize;

use crate::engine::agent::execution::{
    AgentEvent, ChatMessage, ContextItem, ToolCall, ToolOutput, Usage,
};
use crate::engine::agent::llm::{LlmConfig, LlmProvider};
use crate::engine::agent::tools::{execute_tool, ToolDefinition};

use super::{
    AgentHarness, AgentRunRequest, AgentRunResult, HarnessCapabilities, HarnessEventEmitter,
};

/// Canonical, stable identifier for the agentive harness.
pub const ID: &str = "agentive";

/// Whether the agentive harness can currently execute a run.
///
/// `true` now that [`AgentiveHarness`] is wired end-to-end (issue #246). The
/// registry uses this to mark the harness selectable in the UI without ever
/// silently downgrading to a different runtime.
pub const AVAILABLE: bool = true;

/// Capability metadata for the agentive runtime.
///
/// Differences from Prompty are represented explicitly rather than by pretending
/// to match it. The agentive path drives CutReady's own path-confined tools and
/// provider abstraction, but it does not participate in CutReady's sub-agent
/// delegation, mid-run steering queue, or durable run-state persistence — those
/// are advertised as unsupported.
pub fn static_capabilities() -> HarnessCapabilities {
    HarnessCapabilities {
        id: ID.to_string(),
        display_name: "Agentive".to_string(),
        streaming: true,
        tool_calls: true,
        vision: true,
        web_search: true,
        delegation: false,
        steering: false,
        cancellation: true,
        durable_state: false,
    }
}

/// Production harness backed by the [`agentive`] agentic loop.
///
/// Stateless: unlike Prompty it carries no host-owned steering queue, so the
/// registry constructs it fresh per resolve.
pub struct AgentiveHarness;

impl AgentiveHarness {
    /// Build an agentive harness.
    pub fn new() -> Self {
        Self
    }
}

#[async_trait]
impl AgentHarness for AgentiveHarness {
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
            repo_root,
            project_root,
            agent_id,
            agent_prompts,
            mutation_tools_enabled,
            tools,
            context_items,
            run_id,
            // Durable run-state persistence is a Prompty-only capability today
            // (advertised as `durable_state: false`), so the agentive adapter
            // deliberately does not consume the store.
            agent_state: _agent_state,
            cancellation,
        } = request;

        let model = config.llm.model.trim().to_string();
        if model.is_empty() {
            return fail(&emit, "Agentive harness requires a model to be configured.".to_string());
        }

        let provider = match build_agentive_provider(&config.llm, &model) {
            Ok(provider) => provider,
            Err(error) => return fail(&emit, error),
        };

        // Compose the message list agentive will run against. agentive does not
        // do CutReady's persona routing, so the harness injects the agent's
        // system prompt explicitly, followed by any preselected context items
        // (folded into a system block so they are never silently dropped), then
        // the sanitized conversation the host handed us.
        let mut agentive_messages: Vec<agentive::ChatMessage> = Vec::new();
        if let Some(system) = agent_prompts
            .get(&agent_id)
            .map(|prompt| prompt.trim())
            .filter(|prompt| !prompt.is_empty())
        {
            agentive_messages.push(agentive::ChatMessage::system(system));
        }
        if let Some(context_block) = context_items_to_system_prompt(&context_items) {
            agentive_messages.push(agentive::ChatMessage::system(&context_block));
        }
        match to_agentive_messages(&messages) {
            Ok(mut converted) => agentive_messages.append(&mut converted),
            Err(error) => return fail(&emit, error),
        }

        let agentive_tools = match to_agentive_tools(&tools) {
            Ok(converted) => converted,
            Err(error) => return fail(&emit, error),
        };

        // Tool executor. `execute_tool` is CutReady-owned and path-confined; the
        // adapter only bridges agentive's tool-call type in and its tool-output
        // type out. It stays on the CutReady side of the seam so path
        // confinement and tool policy never move into agentive.
        let vision_enabled = config.vision.enabled;
        // Mirror the host command: project workspace tools are only offered to
        // the writer persona, and only when mutations are permitted.
        let project_workspace_tools_enabled =
            agent_id.eq_ignore_ascii_case("writer") && mutation_tools_enabled;
        let executor_repo = repo_root.clone();
        let executor_project = project_root.clone();
        let tool_executor = move |call: agentive::ToolCall| {
            let repo = executor_repo.clone();
            let project = executor_project.clone();
            async move {
                let host_call: ToolCall = match reserialize(&call) {
                    Ok(call) => call,
                    Err(error) => {
                        return Ok(agentive::ToolOutput::from(format!(
                            "Error decoding tool call: {error}"
                        )));
                    }
                };
                // `execute_tool` is synchronous and may touch the filesystem, so
                // run it off the async runtime.
                let output = tokio::task::spawn_blocking(move || {
                    execute_tool(
                        &host_call,
                        &repo,
                        &project,
                        vision_enabled,
                        project_workspace_tools_enabled,
                        mutation_tools_enabled,
                    )
                })
                .await;
                match output {
                    Ok(output) => Ok(to_agentive_tool_output(&output)),
                    Err(join_error) => Ok(agentive::ToolOutput::from(format!(
                        "Tool execution failed: {join_error}"
                    ))),
                }
            }
        };

        // Forward runner events through the host emitter, mapping agentive's
        // native event enum onto CutReady's stable frontend event shape.
        let emit_events = emit.clone();
        let on_event = move |event: agentive::RunnerEvent| {
            if let Some(mapped) = map_runner_event(event) {
                (*emit_events)(mapped);
            }
        };

        let runner_config = agentive::RunnerConfig {
            max_iterations: config.max_tool_rounds,
            run_id: Some(run_id),
            ..agentive::RunnerConfig::default()
        };

        // Cancellation bridge. agentive's `CancellationToken` wraps a private
        // `Arc<AtomicBool>` with no shared-flag constructor, so it cannot adopt
        // CutReady's cancellation flag directly. A short-lived bounded task
        // observes the host flag and forwards a stop; it is aborted as soon as
        // the run returns, so it never lingers as a polling timer.
        let cancel_token = agentive::CancellationToken::new();
        let bridge_token = cancel_token.clone();
        let host_flag = cancellation.shared_flag();
        let cancel_bridge = tokio::spawn(async move {
            loop {
                if host_flag.load(Ordering::Acquire) {
                    bridge_token.cancel();
                    break;
                }
                tokio::time::sleep(Duration::from_millis(150)).await;
            }
        });

        let outcome = agentive::run(
            provider,
            agentive_messages,
            agentive_tools,
            tool_executor,
            runner_config,
            cancel_token,
            agentive::Steering::new(),
            agentive::Guardrails::default(),
            on_event,
        )
        .await;

        cancel_bridge.abort();

        match outcome {
            Ok(result) => {
                let host_messages = match to_host_messages(&result.messages) {
                    Ok(messages) => messages,
                    Err(error) => return fail(&emit, error),
                };
                let response = result.response;
                // Mirror Prompty: the harness owns Done/Error emission. Suppress
                // Done on cancellation so a cancelled run does not look complete.
                if !cancellation.is_cancelled() {
                    (*emit)(AgentEvent::Done {
                        response: response.clone(),
                    });
                }
                Ok(AgentRunResult {
                    messages: host_messages,
                    response,
                    usage: to_host_usage(&result.total_usage),
                })
            }
            Err(error) => {
                // On cancellation, return without emitting an Error event; the
                // host command normalizes the outcome to its cancelled message.
                if cancellation.is_cancelled() {
                    return Err("Agent run cancelled by user.".to_string());
                }
                let message = format!("Agentive run failed: {error}");
                (*emit)(AgentEvent::Error {
                    message: message.clone(),
                });
                Err(message)
            }
        }
    }
}

impl Default for AgentiveHarness {
    fn default() -> Self {
        Self::new()
    }
}

// ---------------------------------------------------------------------------
// Provider construction
// ---------------------------------------------------------------------------

/// Translate CutReady's provider config into an agentive [`Provider`].
///
/// This is the only place CutReady's [`LlmProvider`] variants map onto
/// agentive's provider/auth model.
fn build_agentive_provider(
    llm: &LlmConfig,
    model: &str,
) -> Result<std::sync::Arc<dyn agentive::Provider>, String> {
    match llm.provider {
        LlmProvider::Openai => {
            let endpoint = openai_endpoint(&llm.endpoint);
            Ok(agentive::build_provider(&endpoint, &llm.api_key, model))
        }
        LlmProvider::Anthropic => Ok(std::sync::Arc::new(
            agentive::AnthropicProvider::new(&llm.api_key, model)
                .with_context_budget(agentive::default_context_budget(model)),
        )),
        LlmProvider::AzureOpenai | LlmProvider::MicrosoftFoundry => {
            let endpoint = llm.endpoint.trim_end_matches('/');
            if endpoint.is_empty() {
                return Err(
                    "Azure/Foundry providers require an endpoint for the agentive harness."
                        .to_string(),
                );
            }
            // Prefer an Entra bearer token when present (Foundry/Azure with
            // Entra); fall back to the classic api-key header otherwise. agentive
            // would auto-pick api-key for azure.com endpoints, which is wrong for
            // Entra, so the auth strategy is always chosen explicitly here.
            let auth = match llm.bearer_token.as_deref().filter(|token| !token.is_empty()) {
                Some(token) => agentive::AuthStrategy::Bearer(token.to_string()),
                None => agentive::AuthStrategy::ApiKey(llm.api_key.clone()),
            };
            Ok(agentive::build_provider_with_auth(endpoint, auth, model))
        }
    }
}

/// Normalize an OpenAI endpoint so agentive's `{endpoint}/chat/completions`
/// join targets the `/v1` route. CutReady stores the bare host
/// (`https://api.openai.com`); agentive does not add `/v1` itself.
fn openai_endpoint(raw: &str) -> String {
    let trimmed = raw.trim_end_matches('/');
    let base = if trimmed.is_empty() {
        "https://api.openai.com"
    } else {
        trimmed
    };
    if base.contains("/chat/completions") || base.ends_with("/v1") || base.contains("/v1/") {
        base.to_string()
    } else {
        format!("{base}/v1")
    }
}

// ---------------------------------------------------------------------------
// Type conversions across the seam
// ---------------------------------------------------------------------------

/// Round-trip a value through JSON to convert between the serde-identical host
/// and agentive representations of the same wire shape.
fn reserialize<T, U>(value: &T) -> Result<U, String>
where
    T: Serialize,
    U: DeserializeOwned,
{
    let json = serde_json::to_value(value).map_err(|error| error.to_string())?;
    serde_json::from_value(json).map_err(|error| error.to_string())
}

fn to_agentive_messages(messages: &[ChatMessage]) -> Result<Vec<agentive::ChatMessage>, String> {
    messages
        .iter()
        .map(|message| {
            reserialize(message)
                .map_err(|error| format!("Failed to convert message for agentive: {error}"))
        })
        .collect()
}

fn to_host_messages(messages: &[agentive::ChatMessage]) -> Result<Vec<ChatMessage>, String> {
    messages
        .iter()
        .map(|message| {
            reserialize(message)
                .map_err(|error| format!("Failed to convert agentive message: {error}"))
        })
        .collect()
}

fn to_agentive_tools(tools: &[ToolDefinition]) -> Result<Vec<agentive::Tool>, String> {
    tools
        .iter()
        .map(|tool| {
            reserialize(tool).map_err(|error| format!("Failed to convert tool for agentive: {error}"))
        })
        .collect()
}

/// Convert a CutReady tool output into agentive's, preserving image parts so the
/// runner can inject them as a follow-up multimodal message.
fn to_agentive_tool_output(output: &ToolOutput) -> agentive::ToolOutput {
    let text = output.text().to_string();
    match output.images() {
        Some(images) if !images.is_empty() => {
            let converted: Vec<agentive::ContentPart> =
                images.iter().filter_map(|part| reserialize(part).ok()).collect();
            if converted.is_empty() {
                agentive::ToolOutput::from(text)
            } else {
                agentive::ToolOutput::with_images(text, converted)
            }
        }
        _ => agentive::ToolOutput::from(text),
    }
}

fn to_host_usage(usage: &agentive::Usage) -> Usage {
    Usage {
        prompt_tokens: usage.prompt_tokens,
        completion_tokens: usage.completion_tokens,
        total_tokens: usage.total_tokens,
    }
}

/// Map agentive's runner event onto CutReady's stable frontend event shape.
///
/// Only the events that have a place in CutReady's DTO are forwarded. Runner
/// `Done`/`Error` are intentionally dropped here: the harness emits those itself
/// from `run()`'s returned result so completion is signaled exactly once.
/// Telemetry-only events (usage, model-call timing, context packing, delegation
/// metadata, ...) have no frontend representation and are ignored.
fn map_runner_event(event: agentive::RunnerEvent) -> Option<AgentEvent> {
    use agentive::RunnerEvent as Runner;
    match event {
        Runner::Token { token } => Some(AgentEvent::Delta { content: token }),
        Runner::Thinking { token } => Some(AgentEvent::Thinking { content: token }),
        Runner::Status { message } => Some(AgentEvent::Status { message }),
        Runner::ToolCallStart {
            name, arguments, ..
        } => Some(AgentEvent::ToolCall { name, arguments }),
        Runner::ToolResult { name, result, .. } => {
            Some(AgentEvent::ToolResult { name, result })
        }
        _ => None,
    }
}

/// Fold preselected context items into a single system block so nothing the host
/// gathered is silently dropped. agentive's typed context-packing pipeline is
/// not wired here; representing the items inline keeps the run honest instead.
fn context_items_to_system_prompt(items: &[ContextItem]) -> Option<String> {
    if items.is_empty() {
        return None;
    }
    let mut block = String::from(
        "Relevant context gathered for this task. Use it when helpful.\n",
    );
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

/// Emit an `Error` event and return the same message as the run failure.
fn fail(emit: &HarnessEventEmitter, message: String) -> Result<AgentRunResult, String> {
    (*emit)(AgentEvent::Error {
        message: message.clone(),
    });
    Err(message)
}
