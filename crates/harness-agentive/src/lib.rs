//! Agentive agent harness adapter.
//!
//! This module is the *only* place the [`agentive`] crate is wired into the
//! harness seam. Everything `agentive::*` — providers, the run loop, its native
//! message/tool/event types — stays behind this adapter and never leaks past the
//! CutReady-owned boundary types in [`harness_contract`].
//!
//! Capability metadata lives here so the registry can advertise agentive
//! honestly (see [`static_capabilities`]). `AVAILABLE` is `true` because this
//! adapter can execute a run end-to-end.

use std::sync::atomic::Ordering;
use std::sync::{Arc, Mutex};
use std::collections::{HashMap, VecDeque};
use std::time::Duration;

use async_trait::async_trait;
use serde::de::DeserializeOwned;
use serde::Serialize;

use harness_contract::execution::{
    AgentEvent, ChatMessage, ContextItem, ToolCall, ToolExecutionStatus, ToolOutput, Usage,
};
use harness_contract::llm::{LlmConfig, LlmProvider};
use harness_contract::tools::{HostToolExecutor, ToolDefinition, ToolExecutionContext};

use harness_contract::{
    AgentHarness, AgentRunRequest, AgentRunResult, HarnessCapabilities, HarnessContract,
    HarnessEventEmitter, Ownership,
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

/// Ownership contract for the agentive runtime.
///
/// Like Prompty, the agentive loop is host-driven: CutReady supplies the model
/// provider, the personas, and the tool contract, and owns run state. It
/// provisions none of them itself, so every concern is [`Ownership::Requires`].
/// (Durable state is advertised unsupported via capabilities, but the host is
/// still the party that would own it — the harness never provides its own.)
pub fn static_contract() -> HarnessContract {
    HarnessContract {
        provider: Ownership::Requires,
        personas: Ownership::Requires,
        tools: Ownership::Requires,
        memory: Ownership::Requires,
    }
}

/// Production harness backed by the [`agentive`] agentic loop.
///
/// Stateless: unlike Prompty it carries no host-owned steering queue, so the
/// registry constructs it fresh per resolve.
/// Carries the host-owned [`HostToolExecutor`]: agentive drives the run loop but
/// tool execution (path-confined project tools, web fetch, visuals, ...) stays
/// on the CutReady side of the seam, injected rather than imported so this crate
/// never depends on the app.
pub struct AgentiveHarness {
    tool_executor: Arc<dyn HostToolExecutor>,
}

impl AgentiveHarness {
    /// Build an agentive harness with the host's injected tool executor.
    pub fn new(tool_executor: Arc<dyn HostToolExecutor>) -> Self {
        Self { tool_executor }
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

    fn contract(&self) -> HarnessContract {
        static_contract()
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

        // Tool executor. Tool execution is CutReady-owned and path-confined; the
        // adapter only bridges agentive's tool-call type in and its tool-output
        // type out. The concrete executor is injected by the host so path
        // confinement and tool policy never move into agentive, and this crate
        // never depends on the app.
        let vision_enabled = config.vision.enabled;
        // Mirror the host command: project workspace tools are only offered to
        // the writer persona, and only when mutations are permitted.
        let project_workspace_tools_enabled =
            agent_id.eq_ignore_ascii_case("writer") && mutation_tools_enabled;
        let exec_ctx = ToolExecutionContext {
            repo_root: repo_root.clone(),
            project_root: project_root.clone(),
            vision_enabled,
            project_workspace_tools_enabled,
            mutation_tools_enabled,
        };
        let host_executor = self.tool_executor.clone();
        // agentive's `RunnerEvent::ToolResult` carries no execution outcome, so the
        // host records each explicit status keyed by tool_call_id here and the event
        // mapper reads it back. Each call reserves a slot in a per-id queue *before*
        // its first await and fills that slot on completion. agentive polls parallel
        // tool futures in argument order and emits their `ToolResult` events in that
        // same order, while guaranteeing every parallel executor finishes before any
        // event is emitted. Reserving in argument order and consuming front-first
        // therefore correlates by request order, so two parallel calls that share a
        // model-supplied tool_call_id keep their own outcomes even when they complete
        // out of order (spawn_blocking makes completion order nondeterministic). An
        // empty slot or missing entry maps to failure, so guardrail denials and
        // status-less outputs never inherit a blanket success.
        let tool_status: Arc<Mutex<HashMap<String, VecDeque<Option<ToolExecutionStatus>>>>> =
            Arc::new(Mutex::new(HashMap::new()));
        let executor_status = tool_status.clone();
        let tool_executor = move |call: agentive::ToolCall| {
            let ctx = exec_ctx.clone();
            let host_executor = host_executor.clone();
            let executor_status = executor_status.clone();
            async move {
                let call_id = call.id.clone();
                // Reserve this call's request-order slot before any await.
                let slot_index = executor_status.lock().ok().map(|mut map| {
                    let slots = map.entry(call_id.clone()).or_default();
                    slots.push_back(None);
                    slots.len() - 1
                });
                let host_call: ToolCall = match reserialize(&call) {
                    Ok(call) => call,
                    Err(error) => {
                        // Leave the reserved slot empty; the mapper resolves it to failure.
                        return Ok(agentive::ToolOutput::from(format!(
                            "Error decoding tool call: {error}"
                        )));
                    }
                };
                // The host executor is synchronous and may touch the filesystem,
                // so run it off the async runtime.
                let output = tokio::task::spawn_blocking(move || {
                    host_executor.execute(&host_call, &ctx)
                })
                .await;
                match output {
                    Ok(output) => {
                        // Fill our reserved slot with the explicit outcome, if any.
                        // A status-less output leaves the slot empty so the mapper
                        // falls back to failure rather than a blanket success.
                        if let (Some(index), Some(status)) = (slot_index, output.status()) {
                            if let Ok(mut map) = executor_status.lock() {
                                if let Some(slot) =
                                    map.get_mut(&call_id).and_then(|slots| slots.get_mut(index))
                                {
                                    *slot = Some(status);
                                }
                            }
                        }
                        Ok(to_agentive_tool_output(&output))
                    }
                    Err(join_error) => Ok(agentive::ToolOutput::from(format!(
                        "Tool execution failed: {join_error}"
                    ))),
                }
            }
        };

        // Forward runner events through the host emitter, mapping agentive's
        // native event enum onto CutReady's stable frontend event shape.
        let emit_events = emit.clone();
        let event_status = tool_status.clone();
        let on_event = move |event: agentive::RunnerEvent| {
            if let Some(mapped) = map_runner_event(event, &event_status) {
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
            if llm.endpoint.trim_end_matches('/').is_empty() {
                return Err(
                    "Azure/Foundry providers require an endpoint for the agentive harness."
                        .to_string(),
                );
            }
            // A Foundry project endpoint (`https://<res>.services.ai.azure.com/api/projects/<p>`)
            // is NOT a valid inference host: agentive would otherwise POST to
            // `.../services.ai.azure.com/openai/deployments/...`, which rejects the
            // Entra token with a 401 even though the token is valid. Rewrite it to the
            // OpenAI v1 surface on the `.openai.azure.com` host, mirroring the prompty
            // harness. AzureOpenai endpoints already target the correct host, so they
            // keep agentive's default deployment-path behavior.
            let endpoint = match llm.provider {
                LlmProvider::MicrosoftFoundry => foundry_openai_v1_chat_url(&llm.endpoint)?,
                _ => llm.endpoint.trim_end_matches('/').to_string(),
            };
            // Prefer an Entra bearer token when present (Foundry/Azure with
            // Entra); fall back to the classic api-key header otherwise. agentive
            // would auto-pick api-key for azure.com endpoints, which is wrong for
            // Entra, so the auth strategy is always chosen explicitly here.
            let auth = match llm.bearer_token.as_deref().filter(|token| !token.is_empty()) {
                Some(token) => agentive::AuthStrategy::Bearer(token.to_string()),
                None => agentive::AuthStrategy::ApiKey(llm.api_key.clone()),
            };
            Ok(agentive::build_provider_with_auth(&endpoint, auth, model))
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

/// Rewrite a Microsoft Foundry endpoint into a fully-qualified OpenAI v1
/// chat-completions URL that agentive will POST to verbatim.
///
/// A Foundry connection is stored as a project endpoint like
/// `https://<res>.services.ai.azure.com/api/projects/<project>`. That host does
/// not serve the classic `/openai/deployments/{model}/chat/completions` route,
/// so agentive's default join yields a 401 even with a valid Entra token. The
/// inference surface lives on the `.openai.azure.com` host under `/openai/v1`,
/// matching the prompty harness (`harness-prompty::foundry_openai_v1_endpoint`).
/// The returned URL already contains `/chat/completions`, so agentive uses it
/// as-is rather than appending a deployment path.
fn foundry_openai_v1_chat_url(raw: &str) -> Result<String, String> {
    let endpoint = raw.trim_end_matches('/');
    let base = endpoint
        .split_once("/api/projects")
        .map(|(base, _)| base)
        .unwrap_or(endpoint);
    let base = base.replace(".services.ai.azure.com", ".openai.azure.com");
    if base.is_empty() {
        return Err("Foundry providers require a resource endpoint for the agentive harness.".into());
    }
    Ok(format!("{base}/openai/v1/chat/completions"))
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
fn map_runner_event(
    event: agentive::RunnerEvent,
    tool_status: &Arc<Mutex<HashMap<String, VecDeque<Option<ToolExecutionStatus>>>>>,
) -> Option<AgentEvent> {
    use agentive::RunnerEvent as Runner;
    match event {
        Runner::Token { token } => Some(AgentEvent::Delta { content: token }),
        Runner::Thinking { token } => Some(AgentEvent::Thinking { content: token }),
        Runner::Status { message } => Some(AgentEvent::Status { message }),
        Runner::ToolCallStart {
            name, arguments, ..
        } => Some(AgentEvent::ToolCall { name, arguments }),
        Runner::ToolResult {
            name,
            result,
            tool_call_id,
            ..
        } => {
            // The host reserved one request-order slot per call keyed by tool_call_id.
            // Pop the front slot as we consume it so a reused or parallel tool_call_id
            // cannot inherit a stale outcome, and drop the key once its queue drains.
            // A missing entry, a drained queue, or an unfilled slot (None) means no
            // explicit status was recorded (e.g. a guardrail denial), which is a failure.
            let status = tool_status
                .lock()
                .ok()
                .and_then(|mut map| {
                    let queued = map.get_mut(&tool_call_id).and_then(VecDeque::pop_front);
                    if map.get(&tool_call_id).is_some_and(VecDeque::is_empty) {
                        map.remove(&tool_call_id);
                    }
                    queued.flatten()
                })
                .unwrap_or(ToolExecutionStatus::Failure);
            Some(AgentEvent::ToolResult {
                name,
                result,
                status,
            })
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

#[cfg(test)]
mod tests {
    use super::*;
    use harness_contract::execution::FunctionCall;
    use std::path::PathBuf;
    use std::sync::Mutex;

    /// Records the exact call and context it receives so a test can prove the
    /// injected executor is both retained and driven with unchanged arguments.
    #[derive(Default)]
    struct RecordingExecutor {
        seen: Mutex<Option<(String, PathBuf, bool)>>,
    }

    impl HostToolExecutor for RecordingExecutor {
        fn execute(&self, call: &ToolCall, ctx: &ToolExecutionContext) -> ToolOutput {
            *self.seen.lock().unwrap() = Some((
                call.function.name.clone(),
                ctx.project_root.clone(),
                ctx.mutation_tools_enabled,
            ));
            ToolOutput::Text(format!("ran {}", call.function.name))
        }
    }

    #[test]
    fn new_injects_and_routes_through_the_host_tool_executor() {
        let executor = Arc::new(RecordingExecutor::default());
        let harness = AgentiveHarness::new(executor.clone());

        let call = ToolCall {
            id: "call-1".into(),
            call_type: "function".into(),
            function: FunctionCall {
                name: "demo_tool".into(),
                arguments: "{}".into(),
            },
        };
        let ctx = ToolExecutionContext {
            repo_root: PathBuf::from("/repo"),
            project_root: PathBuf::from("/repo/project"),
            vision_enabled: false,
            project_workspace_tools_enabled: true,
            mutation_tools_enabled: true,
        };

        let output = harness.tool_executor.execute(&call, &ctx);

        let seen = executor.seen.lock().unwrap().clone();
        assert_eq!(
            seen,
            Some(("demo_tool".to_string(), PathBuf::from("/repo/project"), true)),
            "the injected executor must receive the call and context unchanged"
        );
        match output {
            ToolOutput::Text(text) => assert_eq!(text, "ran demo_tool"),
            other => panic!("unexpected tool output: {other:?}"),
        }
    }

    #[test]
    fn tool_result_status_is_resolved_from_the_recorded_outcome() {
        // The adapter records each explicit outcome by tool_call_id; the event
        // mapper must surface exactly that on AgentEvent::ToolResult.
        let status_map: Arc<Mutex<HashMap<String, VecDeque<Option<ToolExecutionStatus>>>>> =
            Arc::new(Mutex::new(HashMap::new()));
        status_map
            .lock()
            .unwrap()
            .insert("call-ok".to_string(), VecDeque::from([Some(ToolExecutionStatus::Success)]));
        status_map
            .lock()
            .unwrap()
            .insert("call-bad".to_string(), VecDeque::from([Some(ToolExecutionStatus::Failure)]));

        let ok = map_runner_event(
            agentive::RunnerEvent::ToolResult {
                run_id: "run".into(),
                name: "write_note".into(),
                result: "Wrote note".into(),
                tool_call_id: "call-ok".into(),
                elapsed_ms: 1,
                iteration: 0,
            },
            &status_map,
        );
        assert!(matches!(
            ok,
            Some(AgentEvent::ToolResult {
                status: ToolExecutionStatus::Success,
                ..
            })
        ));

        let bad = map_runner_event(
            agentive::RunnerEvent::ToolResult {
                run_id: "run".into(),
                name: "write_note".into(),
                result: "Sketch not found".into(),
                tool_call_id: "call-bad".into(),
                elapsed_ms: 1,
                iteration: 0,
            },
            &status_map,
        );
        assert!(matches!(
            bad,
            Some(AgentEvent::ToolResult {
                status: ToolExecutionStatus::Failure,
                ..
            })
        ));

        // A tool_call_id the executor never recorded (e.g. a guardrail denial that
        // never reached the host) resolves to failure, never a false success.
        let denied = map_runner_event(
            agentive::RunnerEvent::ToolResult {
                run_id: "run".into(),
                name: "write_note".into(),
                result: "Tool denied by guardrail".into(),
                tool_call_id: "never-ran".into(),
                elapsed_ms: 0,
                iteration: 0,
            },
            &status_map,
        );
        assert!(matches!(
            denied,
            Some(AgentEvent::ToolResult {
                status: ToolExecutionStatus::Failure,
                ..
            })
        ));
    }

    #[test]
    fn recorded_outcome_is_consumed_once_so_a_reused_id_cannot_inherit_it() {
        // The mapper pops one queued entry and drops the key once drained. A second
        // ToolResult carrying the same tool_call_id (reuse across calls) must not
        // inherit the prior success — it resolves to failure like any unrecorded call.
        let status_map: Arc<Mutex<HashMap<String, VecDeque<Option<ToolExecutionStatus>>>>> =
            Arc::new(Mutex::new(HashMap::new()));
        status_map
            .lock()
            .unwrap()
            .insert("call-1".to_string(), VecDeque::from([Some(ToolExecutionStatus::Success)]));

        let make_event = || agentive::RunnerEvent::ToolResult {
            run_id: "run".into(),
            name: "write_note".into(),
            result: "Wrote note".into(),
            tool_call_id: "call-1".into(),
            elapsed_ms: 1,
            iteration: 0,
        };

        let first = map_runner_event(make_event(), &status_map);
        assert!(matches!(
            first,
            Some(AgentEvent::ToolResult {
                status: ToolExecutionStatus::Success,
                ..
            })
        ));
        assert!(
            status_map.lock().unwrap().is_empty(),
            "reading an outcome must consume it and drop the drained key"
        );

        let second = map_runner_event(make_event(), &status_map);
        assert!(matches!(
            second,
            Some(AgentEvent::ToolResult {
                status: ToolExecutionStatus::Failure,
                ..
            })
        ));
    }

    #[test]
    fn parallel_calls_sharing_an_id_are_correlated_by_request_order_not_completion() {
        // Two concurrent executions can share a model-supplied tool_call_id. Each
        // reserves a request-order slot before running, then fills it on completion.
        // Even when they finish out of order, the two result events (which agentive
        // emits in request order) each pop the front slot and recover their own
        // outcome — no overwrite, no completion-order dependence.
        let status_map: Arc<Mutex<HashMap<String, VecDeque<Option<ToolExecutionStatus>>>>> =
            Arc::new(Mutex::new(HashMap::new()));

        // Reserve two slots in request order: call #0 then call #1 (both unfilled).
        status_map
            .lock()
            .unwrap()
            .insert("dup".to_string(), VecDeque::from([None, None]));
        {
            // Completion order is reversed: call #1 finishes first (Failure), then
            // call #0 (Success). Each fills its own reserved slot by index.
            let mut map = status_map.lock().unwrap();
            let slots = map.get_mut("dup").unwrap();
            slots[1] = Some(ToolExecutionStatus::Failure);
            slots[0] = Some(ToolExecutionStatus::Success);
        }

        let make_event = || agentive::RunnerEvent::ToolResult {
            run_id: "run".into(),
            name: "write_note".into(),
            result: "result".into(),
            tool_call_id: "dup".into(),
            elapsed_ms: 1,
            iteration: 0,
        };

        // First event (request order call #0) pops the front slot → Success.
        let first = map_runner_event(make_event(), &status_map);
        assert!(matches!(
            first,
            Some(AgentEvent::ToolResult {
                status: ToolExecutionStatus::Success,
                ..
            })
        ));
        // Second event (call #1) pops the next slot → Failure, and the drained key
        // is dropped.
        let second = map_runner_event(make_event(), &status_map);
        assert!(matches!(
            second,
            Some(AgentEvent::ToolResult {
                status: ToolExecutionStatus::Failure,
                ..
            })
        ));
        assert!(status_map.lock().unwrap().is_empty());

        // A third event with the same id has no recorded outcome left → failure.
        let third = map_runner_event(make_event(), &status_map);
        assert!(matches!(
            third,
            Some(AgentEvent::ToolResult {
                status: ToolExecutionStatus::Failure,
                ..
            })
        ));
    }

    #[test]
    fn reserved_but_unfilled_slot_resolves_to_failure() {
        // A slot reserved before execution but never filled — e.g. a status-less
        // host output, a decode failure, or a spawn_blocking join error — must
        // resolve to failure, never a blanket success.
        let status_map: Arc<Mutex<HashMap<String, VecDeque<Option<ToolExecutionStatus>>>>> =
            Arc::new(Mutex::new(HashMap::new()));
        status_map
            .lock()
            .unwrap()
            .insert("call-1".to_string(), VecDeque::from([None]));

        let mapped = map_runner_event(
            agentive::RunnerEvent::ToolResult {
                run_id: "run".into(),
                name: "write_note".into(),
                result: "no explicit status".into(),
                tool_call_id: "call-1".into(),
                elapsed_ms: 1,
                iteration: 0,
            },
            &status_map,
        );
        assert!(matches!(
            mapped,
            Some(AgentEvent::ToolResult {
                status: ToolExecutionStatus::Failure,
                ..
            })
        ));
        assert!(
            status_map.lock().unwrap().is_empty(),
            "consuming the unfilled slot must still drop the drained key"
        );
    }


    #[test]
    fn foundry_project_endpoint_rewrites_to_openai_v1_host() {
        let url = foundry_openai_v1_chat_url(
            "https://seth-foundry-dev.services.ai.azure.com/api/projects/dev-models",
        )
        .expect("foundry endpoint should rewrite");
        assert_eq!(
            url,
            "https://seth-foundry-dev.openai.azure.com/openai/v1/chat/completions",
            "Foundry inference must target the .openai.azure.com host, not .services.ai.azure.com"
        );
    }

    #[test]
    fn foundry_endpoint_without_project_path_still_rewrites_host() {
        let url = foundry_openai_v1_chat_url("https://res.services.ai.azure.com/")
            .expect("host-only endpoint should rewrite");
        assert_eq!(url, "https://res.openai.azure.com/openai/v1/chat/completions");
    }

    #[test]
    fn foundry_url_is_fully_qualified_so_agentive_uses_it_verbatim() {
        // agentive treats an endpoint containing "/chat/completions" as a
        // complete URL; the rewrite must therefore include that suffix.
        let url = foundry_openai_v1_chat_url(
            "https://x.services.ai.azure.com/api/projects/p",
        )
        .unwrap();
        assert!(url.contains("/chat/completions"));
        assert!(!url.contains("/api/projects"));
        assert!(!url.contains(".services.ai.azure.com"));
    }

    #[test]
    fn foundry_empty_endpoint_is_rejected() {
        assert!(foundry_openai_v1_chat_url("").is_err());
        assert!(foundry_openai_v1_chat_url("/").is_err());
    }
}

/// Emit an `Error` event and return the same message as the run failure.
fn fail(emit: &HarnessEventEmitter, message: String) -> Result<AgentRunResult, String> {
    (*emit)(AgentEvent::Error {
        message: message.clone(),
    });
    Err(message)
}

