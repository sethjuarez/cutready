//! Agentic loop — delegates to agentive's `run()` with CutReady-specific
//! tool execution, event mapping, and delegation support.
//!
//! The heavy lifting (streaming, SSE parsing, context trimming, retries) is
//! handled by agentive.  This module wires CutReady's tools, sub-agent
//! delegation, and Tauri event bridge into the agentive runner.

use std::collections::{BTreeSet, HashMap};
use std::path::Path;
use std::sync::{
    atomic::{AtomicBool, Ordering},
    Arc,
};
use std::time::Instant;

use crate::engine::agent::llm::ChatMessage;
use crate::engine::agent::tools;
use crate::engine::agent_state::AgentStateStore;
use crate::engine::project;

/// Default maximum tool-call rounds to prevent infinite loops.
pub const DEFAULT_MAX_TOOL_ROUNDS: usize = 50;
const TOOL_RESULT_MAX_CHARS: usize = 8_000;
const TOOL_RESULT_HEAD_CHARS: usize = 5_000;
const TOOL_RESULT_TAIL_CHARS: usize = 1_500;

/// Maximum delegation depth for sub-agents.
const MAX_DELEGATION_DEPTH: usize = 2;

/// Retry with a smaller request when a provider error strongly suggests the
/// submitted conversation exceeded the model or gateway request limit.
const CONTEXT_FAILURE_RETRY_FRACTION_NUMERATOR: usize = 2;
const CONTEXT_FAILURE_RETRY_FRACTION_DENOMINATOR: usize = 3;

// ---------------------------------------------------------------------------
// Event types
// ---------------------------------------------------------------------------

/// Events emitted during the agent loop.
#[derive(Debug, Clone, serde::Serialize)]
#[serde(tag = "type")]
pub enum AgentEvent {
    /// A text delta streamed from the LLM.
    #[serde(rename = "delta")]
    Delta { content: String },
    /// Signals a new turn — frontend should clear its streaming buffer.
    #[serde(rename = "delta_reset")]
    DeltaReset,
    /// A reasoning/thinking delta streamed from the LLM.
    #[serde(rename = "thinking")]
    Thinking { content: String },
    /// Status update (thinking, calling tools, etc.)
    #[serde(rename = "status")]
    Status { message: String },
    /// A tool is being called.
    #[serde(rename = "tool_call")]
    ToolCall { name: String, arguments: String },
    /// A tool returned a result.
    #[serde(rename = "tool_result")]
    ToolResult { name: String, result: String },
    /// Context was selected for the next provider request. The provider may still
    /// omit the transient pack if its serialized request budget is exhausted.
    #[serde(rename = "context_prepared")]
    ContextPrepared {
        selected_count: usize,
        dropped_count: usize,
        total_bytes: usize,
        budget_bytes: usize,
    },
    /// Packed context survived final request fitting and was sent to the provider.
    #[serde(rename = "context_sent")]
    ContextSent { iteration: usize, attempt: usize },
    /// A sub-agent is starting work.
    #[serde(rename = "agent_start")]
    AgentStart { agent_id: String, task: String },
    /// A sub-agent finished.
    #[serde(rename = "agent_done")]
    AgentDone { agent_id: String },
    /// The agent loop finished.
    #[serde(rename = "done")]
    Done { response: String },
    /// An error occurred.
    #[serde(rename = "error")]
    Error { message: String },
}

/// Configuration for vision/image support in tool execution.
#[derive(Debug, Clone)]
pub struct VisionConfig {
    /// Whether vision is enabled (user setting AND model support).
    pub enabled: bool,
}

#[derive(Debug, Clone)]
pub struct WebAccessConfig {
    pub search_enabled: bool,
}

// ---------------------------------------------------------------------------
// Agentic loop — delegates to agentive::run()
// ---------------------------------------------------------------------------

/// Run the agentic loop with streaming and event emission.
pub async fn run(
    provider: Arc<dyn agentive::Provider>,
    provider_name: Option<String>,
    model_name: Option<String>,
    messages: Vec<ChatMessage>,
    repo_root: &Path,
    project_root: &Path,
    agent_id: &str,
    agent_prompts: &HashMap<String, String>,
    steering: &agentive::Steering,
    vision: &VisionConfig,
    web_access: &WebAccessConfig,
    mutation_tools_enabled: bool,
    max_tool_rounds: usize,
    context_items: Vec<agentive::ContextItem>,
    run_id: Option<String>,
    agent_state: Option<AgentStateStore>,
    cancellation: agentive::CancellationToken,
    emit: impl Fn(AgentEvent) + Send + Sync + 'static,
) -> Result<agentive::RunnerResult, String> {
    let emit = Arc::new(emit);
    run_inner(
        provider,
        provider_name,
        model_name,
        messages,
        repo_root,
        project_root,
        agent_id,
        agent_prompts,
        steering,
        0,
        vision,
        web_access,
        mutation_tools_enabled,
        max_tool_rounds,
        context_items,
        run_id,
        agent_state,
        cancellation,
        emit,
    )
    .await
}

/// Internal runner with depth tracking for sub-agent delegation.
#[allow(clippy::too_many_arguments)]
fn run_inner<'a>(
    provider: Arc<dyn agentive::Provider>,
    provider_name: Option<String>,
    model_name: Option<String>,
    messages: Vec<ChatMessage>,
    repo_root: &'a Path,
    project_root: &'a Path,
    agent_id: &'a str,
    agent_prompts: &'a HashMap<String, String>,
    steering: &'a agentive::Steering,
    depth: usize,
    vision: &'a VisionConfig,
    web_access: &'a WebAccessConfig,
    mutation_tools_enabled: bool,
    max_tool_rounds: usize,
    context_items: Vec<agentive::ContextItem>,
    run_id: Option<String>,
    agent_state: Option<AgentStateStore>,
    cancellation: agentive::CancellationToken,
    emit: Arc<dyn Fn(AgentEvent) + Send + Sync + 'static>,
) -> std::pin::Pin<
    Box<dyn std::future::Future<Output = Result<agentive::RunnerResult, String>> + Send + 'a>,
> {
    Box::pin(async move {
        let project_workspace_tools_enabled = agent_id.eq_ignore_ascii_case("writer");
        let tool_defs = tools::all_tools(
            web_access.search_enabled,
            project_workspace_tools_enabled && mutation_tools_enabled,
            mutation_tools_enabled,
        );
        let tool_count = tool_defs.len();
        let packed_context_items =
            build_context_items(project_root, &messages, context_items.clone());
        let context_packing = context_packing_for(&packed_context_items);
        let starting_chars = agentive::context::estimate_chars(&messages);

        log::info!(
            "[agent] starting run (depth={}, agent={}, {} messages, chars={}, budget={}chars, tools={}, context_items={}, vision={}, web_search={}, project_workspace_tools={}, mutation_tools={})",
            depth,
            agent_id,
            messages.len(),
            starting_chars,
            provider.context_budget_chars(),
            tool_count,
            packed_context_items.len(),
            vision.enabled,
            web_access.search_enabled,
            project_workspace_tools_enabled && mutation_tools_enabled,
            mutation_tools_enabled
        );
        crate::util::trace::emit(
            "agent_start",
            "agent",
            serde_json::json!({
                "depth": depth,
                "messages": messages.len(),
                "chars": starting_chars,
                "budget_chars": provider.context_budget_chars(),
                "tools": tool_count,
                "max_tool_rounds": max_tool_rounds,
                "context_items": packed_context_items.len(),
                "vision_enabled": vision.enabled,
                "web_search_enabled": web_access.search_enabled,
                "project_workspace_tools_enabled": project_workspace_tools_enabled && mutation_tools_enabled,
                "mutation_tools_enabled": mutation_tools_enabled,
            }),
        );

        // Configure agentive runner
        let config = agentive::RunnerConfig {
            max_iterations: max_tool_rounds,
            retry_on_400: false,
            auto_trim_context: true,
            sanitize_tool_results: true,
            tool_result_budget: Some(tool_result_budget()),
            // Automatic request compaction must not add a second, blocking model
            // call. Intentional AI handoff summaries remain a separate UX action.
            compaction_provider: None,
            context_items: packed_context_items.clone(),
            context_packing,
            run_id: run_id.clone(),
            provider_name: provider_name.clone(),
            model_name: model_name.clone(),
            trajectory_sink: agent_state
                .clone()
                .map(|store| Arc::new(store) as Arc<dyn agentive::TrajectorySink>),
            memory_promotion_hook: agent_state
                .clone()
                .map(|store| Arc::new(store) as Arc<dyn agentive::MemoryPromotionHook>),
            ..Default::default()
        };

        // Build on_event callback: map RunnerEvent → AgentEvent
        let last_iteration = Arc::new(std::sync::atomic::AtomicUsize::new(usize::MAX));
        let emit_events = emit.clone();
        let last_iter = last_iteration.clone();
        let run_started = Instant::now();
        let saw_first_token = Arc::new(AtomicBool::new(false));
        let saw_first_thinking = Arc::new(AtomicBool::new(false));
        let saw_first_tool = Arc::new(AtomicBool::new(false));
        let first_token_flag = saw_first_token.clone();
        let first_thinking_flag = saw_first_thinking.clone();
        let first_tool_flag = saw_first_tool.clone();
        let on_event = move |event: agentive::RunnerEvent| {
            match event {
                agentive::RunnerEvent::Token { token } => {
                    if !first_token_flag.swap(true, Ordering::Relaxed) {
                        let elapsed_ms = run_started.elapsed().as_millis();
                        log::info!("[agent] first token after {}ms", elapsed_ms);
                        crate::util::trace::emit(
                            "agent_first_token",
                            "agent",
                            serde_json::json!({ "elapsed_ms": elapsed_ms }),
                        );
                    }
                    emit_events(AgentEvent::Delta { content: token });
                }
                agentive::RunnerEvent::Thinking { token } => {
                    if !first_thinking_flag.swap(true, Ordering::Relaxed) {
                        let elapsed_ms = run_started.elapsed().as_millis();
                        log::info!("[agent] first thinking token after {}ms", elapsed_ms);
                        crate::util::trace::emit(
                            "agent_first_thinking",
                            "agent",
                            serde_json::json!({ "elapsed_ms": elapsed_ms }),
                        );
                    }
                    emit_events(AgentEvent::Thinking { content: token });
                }
                agentive::RunnerEvent::Status { message } => {
                    crate::util::trace::emit(
                        "agent_status",
                        "agent",
                        serde_json::json!({
                            "elapsed_ms": run_started.elapsed().as_millis(),
                            "message": message,
                        }),
                    );
                    emit_events(AgentEvent::Status { message });
                }
                agentive::RunnerEvent::ToolCallStart {
                    name,
                    arguments,
                    iteration,
                    ..
                } => {
                    let prev = last_iter.swap(iteration, std::sync::atomic::Ordering::Relaxed);
                    if prev != iteration && prev != usize::MAX {
                        emit_events(AgentEvent::DeltaReset);
                    }
                    let elapsed_ms = run_started.elapsed().as_millis();
                    if !first_tool_flag.swap(true, Ordering::Relaxed) {
                        log::info!("[agent] first tool call ({}) after {}ms", name, elapsed_ms);
                    }
                    crate::util::trace::emit(
                        "agent_tool_call_start",
                        "agent",
                        serde_json::json!({
                            "elapsed_ms": elapsed_ms,
                            "name": name,
                            "iteration": iteration,
                            "args_chars": arguments.len(),
                        }),
                    );
                    emit_events(AgentEvent::ToolCall { name, arguments });
                }
                agentive::RunnerEvent::ToolResult {
                    name,
                    result,
                    elapsed_ms,
                    iteration,
                    ..
                } => {
                    crate::util::trace::emit(
                        "agent_tool_result",
                        "agent",
                        serde_json::json!({
                            "elapsed_ms": run_started.elapsed().as_millis(),
                            "name": name,
                            "iteration": iteration,
                            "tool_elapsed_ms": elapsed_ms,
                            "result_chars": result.len(),
                        }),
                    );
                    emit_events(AgentEvent::ToolResult { name, result });
                }
                agentive::RunnerEvent::Usage { usage, .. } => {
                    crate::util::trace::emit(
                        "agent_usage",
                        "agent",
                        serde_json::json!({
                            "elapsed_ms": run_started.elapsed().as_millis(),
                            "prompt_tokens": usage.prompt_tokens,
                            "completion_tokens": usage.completion_tokens,
                            "total_tokens": usage.total_tokens,
                        }),
                    );
                }
                agentive::RunnerEvent::ResourceTouched { .. }
                | agentive::RunnerEvent::VerificationRecorded { .. }
                | agentive::RunnerEvent::MemoryPromotionSuggested { .. }
                | agentive::RunnerEvent::MemoryPromotionCompleted { .. } => {}
                agentive::RunnerEvent::ContextPacked {
                    iteration,
                    selected_count,
                    dropped_count,
                    total_bytes,
                    budget_bytes,
                    ..
                } => {
                    crate::util::trace::emit(
                        "agent_context_packed",
                        "agent",
                        serde_json::json!({
                            "elapsed_ms": run_started.elapsed().as_millis(),
                            "iteration": iteration,
                            "selected_count": selected_count,
                            "dropped_count": dropped_count,
                            "total_bytes": total_bytes,
                            "budget_bytes": budget_bytes,
                        }),
                    );
                    emit_events(AgentEvent::ContextPrepared {
                        selected_count,
                        dropped_count,
                        total_bytes,
                        budget_bytes,
                    });
                }
                agentive::RunnerEvent::ContextPackSent {
                    iteration, attempt, ..
                } => {
                    crate::util::trace::emit(
                        "agent_context_sent",
                        "agent",
                        serde_json::json!({
                            "elapsed_ms": run_started.elapsed().as_millis(),
                            "iteration": iteration,
                            "attempt": attempt,
                        }),
                    );
                    emit_events(AgentEvent::ContextSent { iteration, attempt });
                }
                agentive::RunnerEvent::Done { response, .. } => {
                    emit_events(AgentEvent::Done { response });
                }
                agentive::RunnerEvent::Error { message, .. } => {
                    emit_events(AgentEvent::Error { message });
                }
                _ => {} // Usage, MessagesUpdated — no CutReady equivalent
            }
        };

        // Build async tool executor
        let repo_root_str = repo_root.to_string_lossy().to_string();
        let project_root_str = project_root.to_string_lossy().to_string();
        let agent_prompts_owned = agent_prompts.clone();
        let provider_for_tools = provider.clone();
        let provider_name_for_tools = provider_name.clone();
        let model_name_for_tools = model_name.clone();
        let tools_for_exec = tool_defs.clone();
        let emit_for_tools = emit.clone();
        let vision_enabled = vision.enabled;
        let web_search_enabled = web_access.search_enabled;
        let mutation_tools_enabled_for_tools = mutation_tools_enabled;
        let tool_depth = depth;
        let steering_for_tools = steering.clone();
        let context_items_for_tools = packed_context_items.clone();
        let agent_state_for_tools = agent_state.clone();
        let cancellation_for_tools = cancellation.clone();

        let tool_executor = move |tool_call: agentive::ToolCall| -> std::pin::Pin<
            Box<dyn std::future::Future<Output = Result<agentive::ToolOutput, String>> + Send>,
        > {
            let repo_root = repo_root_str.clone();
            let project_root = project_root_str.clone();
            let agent_prompts = agent_prompts_owned.clone();
            let provider = provider_for_tools.clone();
            let provider_name = provider_name_for_tools.clone();
            let model_name = model_name_for_tools.clone();
            let tools = tools_for_exec.clone();
            let emit = emit_for_tools.clone();
            let steering = steering_for_tools.clone();
            let context_items = context_items_for_tools.clone();
            let context_store = agent_state_for_tools.clone();
            let cancellation = cancellation_for_tools.clone();

            if tool_call.function.name == "delegate_to_agent" {
                exec_delegation(
                    provider,
                    provider_name,
                    model_name,
                    &tool_call,
                    &repo_root,
                    &project_root,
                    &agent_prompts,
                    &tools,
                    tool_depth,
                    vision_enabled,
                    web_search_enabled,
                    mutation_tools_enabled_for_tools,
                    max_tool_rounds,
                    context_items,
                    context_store,
                    steering,
                    cancellation,
                    emit,
                )
            } else if tool_call.function.name == "read_context_asset" {
                let tc = tool_call;
                Box::pin(async move { read_context_asset_output(context_store.as_ref(), &tc) })
            } else if tool_call.function.name == "fetch_url" {
                let tc = tool_call;
                Box::pin(async move {
                    let args = agentive::parse_tool_args(&tc.function.arguments)
                        .unwrap_or(serde_json::json!({}));
                    let url = args.get("url").and_then(|v| v.as_str()).unwrap_or("");
                    agentive::web::fetch_and_clean(url)
                        .await
                        .map(agentive::ToolOutput::from)
                        .map(|output| tools::decorate_tool_output(&tc.function.name, &args, output))
                })
            } else if tool_call.function.name == "search_web" {
                let tc = tool_call;
                Box::pin(async move {
                    let args = agentive::parse_tool_args(&tc.function.arguments)
                        .unwrap_or(serde_json::json!({}));
                    tools::exec_search_web(&args)
                        .await
                        .map(agentive::ToolOutput::from)
                        .map(|output| tools::decorate_tool_output(&tc.function.name, &args, output))
                })
            } else {
                let output = tools::execute_tool(
                    &tool_call,
                    Path::new(&repo_root),
                    Path::new(&project_root),
                    vision_enabled,
                    project_workspace_tools_enabled,
                    mutation_tools_enabled_for_tools,
                );
                Box::pin(std::future::ready(Ok(output)))
            }
        };

        let result = agentive::run(
            provider.clone(),
            messages.clone(),
            tool_defs,
            tool_executor,
            config,
            cancellation.clone(),
            steering.clone(),
            agentive::Guardrails::default(),
            &on_event,
        )
        .await;

        let result = match result {
            Ok(result) => result,
            Err(err)
                if is_probable_context_failure(
                    &err,
                    starting_chars,
                    provider.context_budget_chars(),
                ) =>
            {
                emit(AgentEvent::Status {
                    message: "Context limit likely hit; compacting conversation before retry…"
                        .into(),
                });
                log::warn!(
                    "[agent] provider error looked like context overflow; retrying after forced compaction: {}",
                    err
                );

                let mut retry_messages = messages;
                let retry_budget =
                    forced_retry_budget(starting_chars, provider.context_budget_chars());
                let dropped_count = trim_history_to_budget(&mut retry_messages, retry_budget);
                if dropped_count == 0 {
                    emit(AgentEvent::Error {
                        message: friendly_context_error(&err),
                    });
                    return Err(format!("Agent error: {}", friendly_context_error(&err)));
                }

                emit(AgentEvent::Status {
                    message: format!(
                        "Compacted context — summarized {dropped_count} earlier messages"
                    ),
                });
                let retry_context_items = build_context_items(
                    project_root,
                    &retry_messages,
                    packed_context_items.clone(),
                );
                let retry_context_packing = context_packing_for(&retry_context_items);

                let retry_config = agentive::RunnerConfig {
                    max_iterations: max_tool_rounds,
                    retry_on_400: false,
                    auto_trim_context: true,
                    sanitize_tool_results: true,
                    tool_result_budget: Some(tool_result_budget()),
                    compaction_provider: None,
                    context_items: retry_context_items.clone(),
                    context_packing: retry_context_packing,
                    run_id: run_id.clone(),
                    provider_name: provider_name.clone(),
                    model_name: model_name.clone(),
                    trajectory_sink: agent_state
                        .clone()
                        .map(|store| Arc::new(store) as Arc<dyn agentive::TrajectorySink>),
                    memory_promotion_hook: agent_state
                        .clone()
                        .map(|store| Arc::new(store) as Arc<dyn agentive::MemoryPromotionHook>),
                    ..Default::default()
                };

                let repo_root_str = repo_root.to_string_lossy().to_string();
                let project_root_str = project_root.to_string_lossy().to_string();
                let agent_prompts_owned = agent_prompts.clone();
                let provider_for_tools = provider.clone();
                let provider_name_for_tools = provider_name.clone();
                let model_name_for_tools = model_name.clone();
                let web_search_enabled = web_access.search_enabled;
                let tools_for_exec = tools::all_tools(
                    web_search_enabled,
                    project_workspace_tools_enabled && mutation_tools_enabled,
                    mutation_tools_enabled,
                );
                let emit_for_tools = emit.clone();
                let vision_enabled = vision.enabled;
                let tool_depth = depth;
                let steering_for_tools = steering.clone();
                let context_items_for_tools = retry_context_items.clone();
                let agent_state_for_tools = agent_state.clone();
                let cancellation_for_tools = cancellation.clone();

                let retry_tool_executor = move |tool_call: agentive::ToolCall| -> std::pin::Pin<
                    Box<
                        dyn std::future::Future<Output = Result<agentive::ToolOutput, String>>
                            + Send,
                    >,
                > {
                    let repo_root = repo_root_str.clone();
                    let project_root = project_root_str.clone();
                    let agent_prompts = agent_prompts_owned.clone();
                    let provider = provider_for_tools.clone();
                    let provider_name = provider_name_for_tools.clone();
                    let model_name = model_name_for_tools.clone();
                    let tools = tools_for_exec.clone();
                    let emit = emit_for_tools.clone();
                    let steering = steering_for_tools.clone();
                    let context_items = context_items_for_tools.clone();
                    let context_store = agent_state_for_tools.clone();
                    let cancellation = cancellation_for_tools.clone();

                    if tool_call.function.name == "delegate_to_agent" {
                        exec_delegation(
                            provider,
                            provider_name,
                            model_name,
                            &tool_call,
                            &repo_root,
                            &project_root,
                            &agent_prompts,
                            &tools,
                            tool_depth,
                            vision_enabled,
                            web_search_enabled,
                            mutation_tools_enabled,
                            max_tool_rounds,
                            context_items,
                            context_store,
                            steering,
                            cancellation,
                            emit,
                        )
                    } else if tool_call.function.name == "read_context_asset" {
                        let tc = tool_call;
                        Box::pin(
                            async move { read_context_asset_output(context_store.as_ref(), &tc) },
                        )
                    } else if tool_call.function.name == "fetch_url" {
                        let tc = tool_call;
                        Box::pin(async move {
                            let args = agentive::parse_tool_args(&tc.function.arguments)
                                .unwrap_or(serde_json::json!({}));
                            let url = args.get("url").and_then(|v| v.as_str()).unwrap_or("");
                            agentive::web::fetch_and_clean(url)
                                .await
                                .map(agentive::ToolOutput::from)
                                .map(|output| {
                                    tools::decorate_tool_output(&tc.function.name, &args, output)
                                })
                        })
                    } else if tool_call.function.name == "search_web" {
                        let tc = tool_call;
                        Box::pin(async move {
                            let args = agentive::parse_tool_args(&tc.function.arguments)
                                .unwrap_or(serde_json::json!({}));
                            tools::exec_search_web(&args)
                                .await
                                .map(agentive::ToolOutput::from)
                                .map(|output| {
                                    tools::decorate_tool_output(&tc.function.name, &args, output)
                                })
                        })
                    } else {
                        let output = tools::execute_tool(
                            &tool_call,
                            Path::new(&repo_root),
                            Path::new(&project_root),
                            vision_enabled,
                            project_workspace_tools_enabled && mutation_tools_enabled,
                            mutation_tools_enabled,
                        );
                        Box::pin(std::future::ready(Ok(output)))
                    }
                };

                agentive::run(
                    provider,
                    retry_messages,
                    tools::all_tools(
                        web_search_enabled,
                        project_workspace_tools_enabled && mutation_tools_enabled,
                        mutation_tools_enabled,
                    ),
                    retry_tool_executor,
                    retry_config,
                    cancellation,
                    steering.clone(),
                    agentive::Guardrails::default(),
                    &on_event,
                )
                .await
                .map_err(|retry_err| {
                    let message = friendly_context_error(&retry_err);
                    emit(AgentEvent::Error {
                        message: message.clone(),
                    });
                    format!("Agent error: {message}")
                })?
            }
            Err(err) => {
                let message = format!("Agent error: {err}");
                emit(AgentEvent::Error {
                    message: message.clone(),
                });
                return Err(message);
            }
        };

        crate::util::trace::emit(
            "agent_done",
            "agent",
            serde_json::json!({
                "rounds": result.total_usage.total_tokens,
                "response_chars": result.response.len(),
                "total_messages": result.messages.len(),
            }),
        );

        Ok(result)
    })
}

fn forced_retry_budget(estimated_chars: usize, provider_budget: usize) -> usize {
    let reduced_provider_budget = provider_budget * CONTEXT_FAILURE_RETRY_FRACTION_NUMERATOR
        / CONTEXT_FAILURE_RETRY_FRACTION_DENOMINATOR;
    let reduced_current = estimated_chars * CONTEXT_FAILURE_RETRY_FRACTION_NUMERATOR
        / CONTEXT_FAILURE_RETRY_FRACTION_DENOMINATOR;
    reduced_provider_budget.min(reduced_current).max(1)
}

fn is_probable_context_failure(
    err: &agentive::AgentError,
    estimated_chars: usize,
    provider_budget: usize,
) -> bool {
    match err {
        agentive::AgentError::Api { status: 413, .. } => true,
        agentive::AgentError::Api {
            status: 400,
            message,
        } => is_context_error_text(message) || estimated_chars > provider_budget * 4 / 5,
        agentive::AgentError::Stream(message) => {
            is_context_error_text(message)
                || (message.contains("API error (400)")
                    && estimated_chars > provider_budget * 4 / 5)
        }
        _ => false,
    }
}

fn is_context_error_text(message: &str) -> bool {
    let msg = message.to_ascii_lowercase();
    let positive = [
        "context length",
        "maximum context",
        "context window",
        "token limit",
        "too many tokens",
        "request too large",
        "payload too large",
        "maximum request size",
        "input is too long",
        "context_length_exceeded",
        "exceeds the model",
    ];
    let negative = [
        "unauthorized",
        "forbidden",
        "permission",
        "deployment not found",
        "invalid model",
        "unsupported parameter",
        "invalid tool",
        "invalid schema",
        "api version",
        "content filter",
        "rate limit",
    ];
    positive.iter().any(|needle| msg.contains(needle))
        && !negative.iter().any(|needle| msg.contains(needle))
}

fn friendly_context_error(err: &agentive::AgentError) -> String {
    if is_context_error_text(&err.to_string()) {
        "The chat is too large for the selected model even after compaction. Start a new chat or remove large pasted content, images, or tool results before retrying.".into()
    } else {
        format!("The model rejected the request after compaction: {err}")
    }
}

// ---------------------------------------------------------------------------
// @reference context
// ---------------------------------------------------------------------------

/// Try to resolve a reference name against project files.
fn resolve_project_reference(
    root: &std::path::Path,
    name: &str,
) -> Option<agentive::ResolvedReference> {
    // Try sketches
    if let Ok(sketches) = project::scan_sketches(root) {
        for s in &sketches {
            if matches_ref(name, &s.path, &s.title) {
                let abs = root.join(&s.path);
                if let Ok(sketch) = project::read_sketch(&abs) {
                    let content = format_sketch_for_ref(&sketch);
                    return Some(agentive::ResolvedReference {
                        name: s.title.clone(),
                        content,
                        content_type: "application/json".to_string(),
                    });
                }
            }
        }
    }

    // Try notes
    if let Ok(notes) = project::scan_notes(root) {
        for n in &notes {
            if matches_ref(name, &n.path, &n.title) {
                let abs = root.join(&n.path);
                if let Ok(content) = project::read_note(&abs) {
                    return Some(agentive::ResolvedReference {
                        name: n.title.clone(),
                        content,
                        content_type: "text/markdown".to_string(),
                    });
                }
            }
        }
    }

    // Try storyboards
    if let Ok(storyboards) = project::scan_storyboards(root) {
        for sb in &storyboards {
            if matches_ref(name, &sb.path, &sb.title) {
                let abs = root.join(&sb.path);
                if let Ok(storyboard) = project::read_storyboard(&abs) {
                    return Some(agentive::ResolvedReference {
                        name: sb.title.clone(),
                        content: super::tools::format_storyboard_for_agent(root, &storyboard),
                        content_type: "text/markdown".to_string(),
                    });
                }
            }
        }
    }

    None
}

fn build_context_items(
    project_root: &Path,
    messages: &[ChatMessage],
    mut explicit_items: Vec<agentive::ContextItem>,
) -> Vec<agentive::ContextItem> {
    let mut seen = explicit_items
        .iter()
        .map(|item| item.id.clone())
        .collect::<BTreeSet<_>>();

    for reference in extract_project_reference_names(messages) {
        let normalized = normalize_ref_name(&reference);
        let id = format!("project-reference:{normalized}");
        if seen.contains(&id) {
            continue;
        }
        if let Some(resolved) = resolve_project_reference(project_root, &reference) {
            let item = agentive::ContextItem::new(
                id.clone(),
                agentive::ContextSource::File,
                resolved.name,
                format!("Project reference @{reference}"),
            )
            .with_kind(agentive::ContextKind::ReferenceDoc)
            .with_priority(100)
            .with_content(resolved.content, resolved.content_type)
            .with_metadata("reference", reference);
            explicit_items.push(item);
            seen.insert(id);
        }
    }

    explicit_items
}

fn context_packing_for(
    context_items: &[agentive::ContextItem],
) -> Option<agentive::ContextPackingConfig> {
    if context_items.is_empty() {
        return None;
    }

    let mut config = agentive::ContextPackingConfig::default();
    config.total_budget_bytes = 12_000;
    config.default_kind_budget_bytes = 6_000;
    config.default_kind_max_items = 4;
    config.max_item_preview_bytes = 4_000;
    config.kind_budgets = vec![
        agentive::ContextKindBudget::new(agentive::ContextKind::ReferenceDoc, 8_000, 4),
        agentive::ContextKindBudget::new(agentive::ContextKind::FileExcerpt, 6_000, 3),
        agentive::ContextKindBudget::new(agentive::ContextKind::WebExcerpt, 6_000, 3),
        agentive::ContextKindBudget::new(agentive::ContextKind::ToolObservation, 3_000, 3),
        agentive::ContextKindBudget::new(agentive::ContextKind::MemoryFact, 2_000, 6),
        agentive::ContextKindBudget::new(agentive::ContextKind::ErrorTrace, 2_000, 3),
    ];
    Some(config)
}

fn tool_result_budget() -> agentive::ToolResultBudget {
    agentive::ToolResultBudget {
        max_chars: TOOL_RESULT_MAX_CHARS,
        head_chars: TOOL_RESULT_HEAD_CHARS,
        tail_chars: TOOL_RESULT_TAIL_CHARS,
    }
}

fn trim_history_to_budget(messages: &mut Vec<ChatMessage>, max_chars: usize) -> usize {
    if agentive::context::estimate_chars(messages) <= max_chars {
        return 0;
    }

    let prefix_end = messages
        .iter()
        .position(|message| !matches!(message.role.as_str(), "system" | "developer"))
        .unwrap_or(messages.len());
    let prefix = messages.drain(..prefix_end).collect::<Vec<_>>();
    let budget = max_chars
        .saturating_sub(agentive::context::estimate_chars(&prefix))
        .saturating_sub(5_000);
    let mut dropped = Vec::new();

    while agentive::context::estimate_chars(messages) > budget && messages.len() > 2 {
        let group = take_oldest_message_group(messages);
        if group.is_empty() {
            break;
        }
        dropped.extend(group);
    }

    let summary = agentive::context::summarize_dropped(&dropped);
    let remaining = std::mem::take(messages);
    *messages = prefix;
    if !summary.is_empty() {
        messages.push(ChatMessage::user(&summary));
    }
    messages.extend(remaining);
    dropped.len()
}

fn take_oldest_message_group(messages: &mut Vec<ChatMessage>) -> Vec<ChatMessage> {
    if messages.is_empty() {
        return Vec::new();
    }

    let mut dropped = vec![messages.remove(0)];
    if dropped[0].role == "user" {
        while messages.first().is_some_and(|message| {
            !matches!(message.role.as_str(), "user" | "system" | "developer")
        }) {
            dropped.push(messages.remove(0));
        }
    } else if dropped[0].role == "assistant" {
        let call_ids = dropped[0]
            .tool_calls
            .as_ref()
            .into_iter()
            .flatten()
            .map(|call| call.id.clone())
            .collect::<BTreeSet<String>>();
        while !call_ids.is_empty()
            && messages.first().is_some_and(|message| {
                message.role == "tool"
                    && message
                        .tool_call_id
                        .as_deref()
                        .is_some_and(|id| call_ids.contains(id))
            })
        {
            dropped.push(messages.remove(0));
        }
    }
    while messages.first().is_some_and(|message| {
        message.role == "user"
            && message
                .text()
                .is_some_and(|text| text.starts_with("[Images from the tool result above"))
    }) {
        dropped.push(messages.remove(0));
    }
    dropped
}

fn read_context_asset_output(
    store: Option<&AgentStateStore>,
    tool_call: &agentive::ToolCall,
) -> Result<agentive::ToolOutput, String> {
    let store =
        store.ok_or_else(|| "No local context store is available for this run".to_string())?;
    let args = agentive::parse_tool_args(&tool_call.function.arguments)
        .unwrap_or_else(|_| serde_json::json!({}));
    let asset_id = args
        .get("asset_id")
        .and_then(|value| value.as_str())
        .ok_or_else(|| "read_context_asset requires an asset_id".to_string())?;
    let offset = args
        .get("offset")
        .and_then(|value| value.as_u64())
        .unwrap_or(0) as usize;
    let limit = args
        .get("limit")
        .and_then(|value| value.as_u64())
        .unwrap_or(6_000) as usize;
    let excerpt = store.read_context_asset(asset_id, offset, limit)?;
    Ok(agentive::ToolOutput::from(format!(
        "[Stored context: {} | {} chars | offset {}]\n{}",
        excerpt.asset.name,
        excerpt.excerpt.len(),
        offset,
        excerpt.excerpt
    )))
}

fn extract_project_reference_names(messages: &[ChatMessage]) -> Vec<String> {
    let mut refs = Vec::new();
    let mut seen = BTreeSet::new();
    for message in messages {
        if message.role != "user" {
            continue;
        }
        if let Some(text) = message.text() {
            for reference in extract_project_reference_names_from_text(text) {
                if seen.insert(reference.clone()) {
                    refs.push(reference);
                }
            }
        }
    }
    refs
}

fn extract_project_reference_names_from_text(text: &str) -> Vec<String> {
    let mut refs = Vec::new();
    let bytes = text.as_bytes();
    let mut index = 0usize;
    while index < bytes.len() {
        if bytes[index] != b'@' {
            index += 1;
            continue;
        }

        if index > 0 {
            let prev = bytes[index - 1] as char;
            if prev.is_ascii_alphanumeric() || prev == '_' {
                index += 1;
                continue;
            }
        }

        let start = index + 1;
        if start >= bytes.len() {
            break;
        }

        let (raw, next_index) = if bytes[start] == b'"' || bytes[start] == b'\'' {
            let quote = bytes[start];
            let content_start = start + 1;
            let mut end = content_start;
            while end < bytes.len() && bytes[end] != quote {
                end += 1;
            }
            (&text[content_start..end], end.saturating_add(1))
        } else {
            let mut end = start;
            while end < bytes.len() {
                let ch = bytes[end] as char;
                if ch.is_whitespace() || matches!(ch, ',' | ';' | ')' | ']' | '}') {
                    break;
                }
                end += 1;
            }
            (&text[start..end], end)
        };

        let reference = raw
            .trim()
            .trim_matches(|ch: char| matches!(ch, '.' | ':' | ',' | ';' | ')' | ']' | '}'))
            .to_string();
        let normalized = normalize_ref_name(&reference);
        if !reference.is_empty()
            && !normalized.starts_with("http://")
            && !normalized.starts_with("https://")
            && !normalized.starts_with("web:http://")
            && !normalized.starts_with("web:https://")
        {
            refs.push(reference);
        }
        index = next_index.max(index + 1);
    }
    refs
}

/// Check if a user-typed reference name matches a project file by path, title, or stem.
fn matches_ref(name: &str, path: &str, title: &str) -> bool {
    let name_lower = normalize_ref_name(name);
    // Exact path match
    if path.to_lowercase() == name_lower {
        return true;
    }
    // Title match (case-insensitive)
    if title.to_lowercase() == name_lower {
        return true;
    }
    // File stem match (e.g., "intro" matches "intro.sk")
    if let Some(stem) = std::path::Path::new(path).file_stem() {
        if stem.to_string_lossy().to_lowercase() == name_lower {
            return true;
        }
    }
    false
}

fn normalize_ref_name(name: &str) -> String {
    let trimmed = name.trim().trim_matches('"').trim_matches('\'');
    let without_type = trimmed
        .strip_prefix("sketch:")
        .or_else(|| trimmed.strip_prefix("note:"))
        .or_else(|| trimmed.strip_prefix("storyboard:"))
        .unwrap_or(trimmed);
    without_type
        .trim()
        .trim_matches('"')
        .trim_matches('\'')
        .to_lowercase()
}

/// Format a sketch as readable text for reference injection.
fn format_sketch_for_ref(sketch: &crate::models::sketch::Sketch) -> String {
    let mut out = format!("# {}\n\n", sketch.title);
    if let Some(desc) = sketch.description.as_str() {
        if !desc.is_empty() {
            out.push_str(&format!("{desc}\n\n"));
        }
    }
    for (i, row) in sketch.rows.iter().enumerate() {
        out.push_str(&format!(
            "## Row {} [{}]\n**Narrative:** {}\n**Actions:** {}\n\n",
            i, row.time, row.narrative, row.demo_actions
        ));
    }
    out
}

// ---------------------------------------------------------------------------
// Tool helpers
// ---------------------------------------------------------------------------

/// Execute a delegate_to_agent tool call by spawning a sub-agent loop.
/// Returns a boxed future to allow recursive async through agentive::run().
#[allow(clippy::too_many_arguments)]
fn exec_delegation(
    provider: Arc<dyn agentive::Provider>,
    provider_name: Option<String>,
    model_name: Option<String>,
    call: &agentive::ToolCall,
    repo_root: &str,
    project_root: &str,
    agent_prompts: &HashMap<String, String>,
    _tools: &[agentive::Tool],
    depth: usize,
    vision_enabled: bool,
    web_search_enabled: bool,
    mutation_tools_enabled: bool,
    max_tool_rounds: usize,
    context_items: Vec<agentive::ContextItem>,
    agent_state: Option<AgentStateStore>,
    steering: agentive::Steering,
    cancellation: agentive::CancellationToken,
    emit: Arc<dyn Fn(AgentEvent) + Send + Sync + 'static>,
) -> std::pin::Pin<Box<dyn std::future::Future<Output = Result<agentive::ToolOutput, String>> + Send>>
{
    if depth >= MAX_DELEGATION_DEPTH {
        return Box::pin(std::future::ready(Ok(agentive::ToolOutput::from(
            "Error: maximum delegation depth reached — cannot delegate further",
        ))));
    }

    let args: serde_json::Value =
        agentive::parse_tool_args(&call.function.arguments).unwrap_or(serde_json::json!({}));

    let agent_id = match args.get("agent_id").and_then(|v| v.as_str()) {
        Some(id) => id.to_string(),
        None => {
            return Box::pin(std::future::ready(Ok(agentive::ToolOutput::from(
                "Error: missing 'agent_id' argument",
            ))))
        }
    };
    let message = match args.get("message").and_then(|v| v.as_str()) {
        Some(m) => m.to_string(),
        None => {
            return Box::pin(std::future::ready(Ok(agentive::ToolOutput::from(
                "Error: missing 'message' argument",
            ))))
        }
    };

    let prompt = match agent_prompts.get(&agent_id) {
        Some(p) => p.clone(),
        None => {
            let available = agent_prompts.keys().cloned().collect::<Vec<_>>().join(", ");
            return Box::pin(std::future::ready(Ok(agentive::ToolOutput::from(format!(
                "Error: unknown agent '{agent_id}'. Available: {available}"
            )))));
        }
    };

    // Own everything needed by the async block
    let repo_root = repo_root.to_string();
    let project_root = project_root.to_string();
    let agent_prompts = agent_prompts.clone();
    let tools = tools::all_tools(
        web_search_enabled,
        agent_id.eq_ignore_ascii_case("writer") && mutation_tools_enabled,
        mutation_tools_enabled,
    );
    let sub_depth = depth + 1;

    Box::pin(async move {
        let sub_messages = vec![ChatMessage::system(&prompt), ChatMessage::user(&message)];
        let sub_context_items =
            build_context_items(Path::new(&project_root), &sub_messages, context_items);
        let sub_context_packing = context_packing_for(&sub_context_items);

        emit(AgentEvent::AgentStart {
            agent_id: agent_id.clone(),
            task: message.clone(),
        });

        let config = agentive::RunnerConfig {
            max_iterations: max_tool_rounds,
            auto_trim_context: true,
            sanitize_tool_results: true,
            tool_result_budget: Some(tool_result_budget()),
            context_items: sub_context_items.clone(),
            context_packing: sub_context_packing,
            provider_name: provider_name.clone(),
            model_name: model_name.clone(),
            trajectory_sink: agent_state
                .clone()
                .map(|store| Arc::new(store) as Arc<dyn agentive::TrajectorySink>),
            ..Default::default()
        };

        let project_root_for_tools = project_root.clone();
        let repo_root_for_tools = repo_root.clone();
        let agent_prompts_for_tools = agent_prompts.clone();
        let provider_for_tools = provider.clone();
        let provider_name_for_tools = provider_name.clone();
        let model_name_for_tools = model_name.clone();
        let tools_for_tools = tools.clone();
        let emit_for_tools = emit.clone();
        let steering_for_tools = steering.clone();
        let context_items_for_tools = sub_context_items.clone();
        let agent_state_for_tools = agent_state.clone();
        let cancellation_for_tools = cancellation.clone();
        let sub_project_workspace_tools_enabled =
            agent_id.eq_ignore_ascii_case("writer") && mutation_tools_enabled;

        let sub_tool_executor = move |tool_call: agentive::ToolCall| -> std::pin::Pin<
            Box<dyn std::future::Future<Output = Result<agentive::ToolOutput, String>> + Send>,
        > {
            let repo_root = repo_root_for_tools.clone();
            let project_root = project_root_for_tools.clone();
            let agent_prompts = agent_prompts_for_tools.clone();
            let provider = provider_for_tools.clone();
            let provider_name = provider_name_for_tools.clone();
            let model_name = model_name_for_tools.clone();
            let tools = tools_for_tools.clone();
            let emit = emit_for_tools.clone();
            let steering = steering_for_tools.clone();
            let context_items = context_items_for_tools.clone();
            let context_store = agent_state_for_tools.clone();
            let cancellation = cancellation_for_tools.clone();

            if tool_call.function.name == "delegate_to_agent" {
                exec_delegation(
                    provider,
                    provider_name,
                    model_name,
                    &tool_call,
                    &repo_root,
                    &project_root,
                    &agent_prompts,
                    &tools,
                    sub_depth,
                    vision_enabled,
                    web_search_enabled,
                    mutation_tools_enabled,
                    max_tool_rounds,
                    context_items,
                    context_store,
                    steering,
                    cancellation,
                    emit,
                )
            } else if tool_call.function.name == "read_context_asset" {
                let tc = tool_call;
                Box::pin(async move { read_context_asset_output(context_store.as_ref(), &tc) })
            } else if tool_call.function.name == "fetch_url" {
                let tc = tool_call;
                Box::pin(async move {
                    let args = agentive::parse_tool_args(&tc.function.arguments)
                        .unwrap_or(serde_json::json!({}));
                    let url = args.get("url").and_then(|v| v.as_str()).unwrap_or("");
                    agentive::web::fetch_and_clean(url)
                        .await
                        .map(agentive::ToolOutput::from)
                })
            } else {
                let output = tools::execute_tool(
                    &tool_call,
                    Path::new(&repo_root),
                    Path::new(&project_root),
                    vision_enabled,
                    sub_project_workspace_tools_enabled,
                    mutation_tools_enabled,
                );
                Box::pin(std::future::ready(Ok(output)))
            }
        };

        let sub_emit = emit.clone();
        let sub_on_event = move |event: agentive::RunnerEvent| match event {
            agentive::RunnerEvent::Token { token } => {
                sub_emit(AgentEvent::Delta { content: token });
            }
            agentive::RunnerEvent::Thinking { token } => {
                sub_emit(AgentEvent::Thinking { content: token });
            }
            agentive::RunnerEvent::ToolCallStart {
                name, arguments, ..
            } => {
                sub_emit(AgentEvent::ToolCall { name, arguments });
            }
            agentive::RunnerEvent::ToolResult { name, result, .. } => {
                sub_emit(AgentEvent::ToolResult { name, result });
            }
            agentive::RunnerEvent::ContextPacked {
                selected_count,
                dropped_count,
                total_bytes,
                budget_bytes,
                ..
            } => {
                sub_emit(AgentEvent::ContextPrepared {
                    selected_count,
                    dropped_count,
                    total_bytes,
                    budget_bytes,
                });
            }
            agentive::RunnerEvent::ContextPackSent {
                iteration, attempt, ..
            } => {
                sub_emit(AgentEvent::ContextSent { iteration, attempt });
            }
            _ => {}
        };

        let result_text = match agentive::run(
            provider,
            sub_messages,
            tools,
            sub_tool_executor,
            config,
            cancellation,
            steering,
            agentive::Guardrails::default(),
            sub_on_event,
        )
        .await
        {
            Ok(result) => format!("[Agent '{}' responded:]\n\n{}", agent_id, result.response),
            Err(e) => format!("Error from agent '{}': {}", agent_id, e),
        };

        emit(AgentEvent::AgentDone {
            agent_id: agent_id.clone(),
        });

        Ok(agentive::ToolOutput::from(result_text))
    })
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

#[cfg(test)]
mod tests {
    use super::*;
    use async_trait::async_trait;
    use rusqlite::Connection;
    use std::fs;
    use std::sync::atomic::{AtomicUsize, Ordering};
    use std::time::Duration;
    use tokio::sync::{mpsc, Notify};

    struct HarnessProvider {
        calls: AtomicUsize,
        budget_chars: usize,
    }

    impl HarnessProvider {
        fn new(budget_chars: usize) -> Self {
            Self {
                calls: AtomicUsize::new(0),
                budget_chars,
            }
        }
    }

    #[async_trait]
    impl agentive::Provider for HarnessProvider {
        async fn chat(
            &self,
            request: agentive::ChatRequest,
            tx: mpsc::Sender<agentive::ChatEvent>,
            _cancel: &agentive::CancellationToken,
        ) -> Result<(), agentive::AgentError> {
            let _call_index = self.calls.fetch_add(1, Ordering::SeqCst);
            let is_compaction_request = request.tools.as_ref().is_none_or(Vec::is_empty);
            let has_tool_result = request
                .messages
                .iter()
                .any(|message| message.role == "tool");
            let message = if is_compaction_request {
                ChatMessage::assistant("Earlier context summarized for the tiny harness budget.")
            } else if has_tool_result {
                ChatMessage::assistant("Created the checkpoint integration note.")
            } else {
                ChatMessage::assistant_with_tool_calls(vec![agentive::ToolCall {
                    id: "call-write-note".into(),
                    call_type: "function".into(),
                    function: agentive::FunctionCall {
                        name: "write_note".into(),
                        arguments: serde_json::json!({
                            "path": "harness-ci.md",
                            "content": "# Harness CI\nCheckpoint and compaction persistence are wired through AgentStateStore."
                        })
                        .to_string(),
                    },
                }])
            };

            tx.send(agentive::ChatEvent::Done {
                response: agentive::ChatResponse {
                    message,
                    usage: Some(agentive::Usage {
                        prompt_tokens: 10,
                        completion_tokens: 5,
                        total_tokens: 15,
                    }),
                },
            })
            .await
            .map_err(|err| agentive::AgentError::Stream(err.to_string()))?;

            Ok(())
        }

        fn name(&self) -> &str {
            "harness-test"
        }

        fn model(&self) -> Option<&str> {
            Some("tiny-harness")
        }

        fn context_budget_chars(&self) -> usize {
            self.budget_chars
        }
    }

    struct BlockingProvider {
        started: Arc<Notify>,
        cancellation_observed: Arc<Notify>,
    }

    #[async_trait]
    impl agentive::Provider for BlockingProvider {
        async fn chat(
            &self,
            _request: agentive::ChatRequest,
            _tx: mpsc::Sender<agentive::ChatEvent>,
            cancel: &agentive::CancellationToken,
        ) -> Result<(), agentive::AgentError> {
            self.started.notify_one();
            while !cancel.is_cancelled() {
                tokio::time::sleep(Duration::from_millis(5)).await;
            }
            self.cancellation_observed.notify_one();
            Ok(())
        }

        fn name(&self) -> &str {
            "blocking-harness"
        }

        fn model(&self) -> Option<&str> {
            Some("blocking-harness")
        }

        fn context_budget_chars(&self) -> usize {
            3_000
        }
    }

    fn event_count(db_path: &Path, run_id: &str, event_type: &str) -> usize {
        let conn = Connection::open(db_path).unwrap();
        conn.query_row(
            "SELECT COUNT(*) FROM trajectory_events WHERE run_id = ?1 AND event_type = ?2",
            rusqlite::params![run_id, event_type],
            |row| row.get::<_, usize>(0),
        )
        .unwrap()
    }

    #[test]
    fn matches_ref_exact_path() {
        assert!(matches_ref("intro.sk", "intro.sk", "Introduction"));
    }

    #[test]
    fn extracts_project_references_without_web_tags() {
        let refs = extract_project_reference_names_from_text(
            "Use @intro.sk and @\"Planning Notes\" with [Web: https://example.com] later.",
        );

        assert_eq!(refs, vec!["intro.sk", "Planning Notes"]);
    }

    #[test]
    fn build_context_items_resolves_project_reference_files() {
        let project = tempfile::tempdir().unwrap();
        fs::write(
            project.path().join("planning-notes.md"),
            "# Planning Notes\n\nUse this as reference.",
        )
        .unwrap();
        let messages = vec![ChatMessage::user("Use @planning-notes as context.")];

        let items = build_context_items(project.path(), &messages, Vec::new());

        assert_eq!(items.len(), 1);
        assert_eq!(items[0].id, "project-reference:planning-notes");
        assert_eq!(items[0].kind, agentive::ContextKind::ReferenceDoc);
        assert_eq!(items[0].source, agentive::ContextSource::File);
        assert_eq!(items[0].content_type.as_deref(), Some("text/markdown"));
    }

    #[test]
    fn build_context_items_preserves_resolved_references_across_retries() {
        let project = tempfile::tempdir().unwrap();
        fs::write(
            project.path().join("planning-notes.md"),
            "# Planning Notes\n\nUse this as reference.",
        )
        .unwrap();
        let initial_messages = vec![ChatMessage::user("Use @planning-notes as context.")];
        let initial_items = build_context_items(project.path(), &initial_messages, Vec::new());
        let retry_messages = vec![ChatMessage::user("Continue with the current request.")];

        let retry_items = build_context_items(project.path(), &retry_messages, initial_items);

        assert_eq!(retry_items.len(), 1);
        assert_eq!(retry_items[0].id, "project-reference:planning-notes");
    }

    #[test]
    fn history_trim_keeps_tool_results_with_their_tool_call() {
        let tool_call = agentive::ToolCall {
            id: "call-update".into(),
            call_type: "function".into(),
            function: agentive::FunctionCall {
                name: "update_planning_row".into(),
                arguments: "{}".into(),
            },
        };
        let earlier_request = format!("Earlier request {}", "x".repeat(10_000));
        let current_request = format!("Current request {}", "y".repeat(10_000));
        let mut messages = vec![
            ChatMessage::system("System instructions"),
            ChatMessage::user(&earlier_request),
            ChatMessage::assistant_with_tool_calls(vec![tool_call]),
            ChatMessage::tool_result("call-update", "updated"),
            ChatMessage::user("[Images from the tool result above.]\n<image omitted>"),
            ChatMessage::user(&current_request),
        ];

        let dropped = trim_history_to_budget(&mut messages, 8_000);

        assert!(dropped >= 4);
        assert!(messages.iter().all(|message| message.role != "tool"));
        assert!(messages.iter().all(|message| {
            message
                .text()
                .is_none_or(|text| !text.starts_with("[Images from the tool result above"))
        }));
        assert!(messages
            .last()
            .and_then(ChatMessage::text)
            .is_some_and(|text| text.starts_with("Current request")));
    }

    #[test]
    fn matches_ref_title_case_insensitive() {
        assert!(matches_ref("introduction", "intro.sk", "Introduction"));
    }

    #[test]
    fn matches_ref_file_stem() {
        assert!(matches_ref("intro", "intro.sk", "Introduction"));
    }

    #[test]
    fn matches_ref_typed_storyboard_path() {
        assert!(matches_ref(
            "storyboard:storyboards/full-demo.sb",
            "storyboards/full-demo.sb",
            "Full Demo Flow"
        ));
    }

    #[test]
    fn matches_ref_quoted_title() {
        assert!(matches_ref(
            "\"Full Demo Flow\"",
            "storyboards/full-demo.sb",
            "Full Demo Flow"
        ));
    }

    #[test]
    fn matches_ref_no_match() {
        assert!(!matches_ref("setup", "intro.sk", "Introduction"));
    }

    #[test]
    fn context_error_classifier_accepts_known_context_400() {
        let err = agentive::AgentError::Api {
            status: 400,
            message: "context_length_exceeded: too many tokens".into(),
        };

        assert!(is_probable_context_failure(&err, 1_000, 100_000));
    }

    #[test]
    fn context_error_classifier_accepts_oversized_generic_400() {
        let err = agentive::AgentError::Api {
            status: 400,
            message: "<h2>Bad Request</h2>".into(),
        };

        assert!(is_probable_context_failure(&err, 90_000, 100_000));
    }

    #[test]
    fn context_error_classifier_accepts_payload_413() {
        let err = agentive::AgentError::Api {
            status: 413,
            message: "Payload Too Large".into(),
        };

        assert!(is_probable_context_failure(&err, 1_000, 100_000));
    }

    #[test]
    fn context_error_classifier_accepts_stream_context_error() {
        let err =
            agentive::AgentError::Stream("API error (400): maximum context length exceeded".into());

        assert!(is_probable_context_failure(&err, 1_000, 100_000));
    }

    #[test]
    fn context_error_classifier_rejects_non_context_400() {
        let err = agentive::AgentError::Api {
            status: 400,
            message: "invalid tool schema".into(),
        };

        assert!(!is_probable_context_failure(&err, 1_000, 100_000));
    }

    #[test]
    fn context_error_classifier_rejects_small_generic_400() {
        let err = agentive::AgentError::Api {
            status: 400,
            message: "<h2>Bad Request</h2>".into(),
        };

        assert!(!is_probable_context_failure(&err, 10_000, 100_000));
    }

    #[test]
    fn context_error_classifier_rejects_auth_even_with_context_words() {
        let err = agentive::AgentError::Api {
            status: 400,
            message: "Unauthorized request exceeded the context allowed by your permission".into(),
        };

        assert!(!is_probable_context_failure(&err, 1_000, 100_000));
    }

    #[test]
    fn forced_retry_budget_is_smaller_than_current_request() {
        let budget = forced_retry_budget(90_000, 100_000);

        assert!(budget < 90_000);
        assert_eq!(budget, 60_000);
    }

    #[test]
    fn forced_retry_budget_uses_smaller_of_provider_and_request_budget() {
        assert_eq!(forced_retry_budget(300_000, 90_000), 60_000);
        assert_eq!(forced_retry_budget(90_000, 300_000), 60_000);
    }

    #[test]
    fn forced_retry_budget_drives_actual_message_trimming() {
        let mut messages = vec![ChatMessage::system("system prompt")];
        for i in 0..10 {
            messages.push(ChatMessage::user(&format!(
                "request {i} {}",
                "x".repeat(2_000)
            )));
            messages.push(ChatMessage::assistant(&format!(
                "response {i} {}",
                "y".repeat(2_000)
            )));
        }
        let before = agentive::context::estimate_chars(&messages);
        let retry_budget = forced_retry_budget(before, before + 10_000);

        let (dropped, _) = agentive::context::trim_to_context_window(&mut messages, retry_budget);
        let after = agentive::context::estimate_chars(&messages);

        assert!(dropped > 0);
        assert!(after <= retry_budget);
        assert!(messages.iter().any(|m| {
            m.text()
                .is_some_and(|text| text.starts_with("[Earlier conversation summary]"))
        }));
    }

    #[tokio::test]
    async fn cutready_runner_persists_trajectory_to_agent_state_store() {
        let project = tempfile::tempdir().unwrap();
        let run_id = "cutready-runner-checkpoint-test".to_string();
        let store =
            AgentStateStore::for_project(project.path(), project.path(), run_id.clone()).unwrap();
        store
            .insert_run(
                None,
                "harness-test",
                "tiny-harness",
                serde_json::json!({"source":"runner-test"}),
            )
            .unwrap();
        let provider = Arc::new(HarnessProvider::new(3_000));
        let messages = vec![
            ChatMessage::system(&"Retained setup context. ".repeat(180)),
            ChatMessage::user("Create the harness CI note."),
        ];

        let result = run_inner(
            provider,
            Some("harness-test".into()),
            Some("tiny-harness".into()),
            messages,
            project.path(),
            project.path(),
            "writer",
            &HashMap::new(),
            &agentive::Steering::new(),
            0,
            &VisionConfig { enabled: false },
            &WebAccessConfig {
                search_enabled: false,
            },
            true,
            DEFAULT_MAX_TOOL_ROUNDS,
            Vec::new(),
            Some(run_id.clone()),
            Some(store.clone()),
            agentive::CancellationToken::new(),
            Arc::new(|_| {}),
        )
        .await
        .unwrap();

        assert_eq!(result.response, "Created the checkpoint integration note.");
        assert!(project.path().join("harness-ci.md").exists());

        assert_eq!(event_count(store.db_path(), &run_id, "turn_started"), 1);
        assert!(event_count(store.db_path(), &run_id, "model_call_started") >= 1);
        assert!(event_count(store.db_path(), &run_id, "model_call_completed") >= 1);
        assert_eq!(
            event_count(store.db_path(), &run_id, "tool_call_started"),
            1
        );
        assert_eq!(
            event_count(store.db_path(), &run_id, "tool_call_completed"),
            1
        );
        assert_eq!(event_count(store.db_path(), &run_id, "resource_touched"), 1);
        assert_eq!(
            event_count(store.db_path(), &run_id, "verification_recorded"),
            1
        );
        assert_eq!(event_count(store.db_path(), &run_id, "turn_completed"), 1);
    }

    #[tokio::test]
    async fn runner_passes_cancellation_to_blocking_provider() {
        let project = tempfile::tempdir().unwrap();
        let provider = Arc::new(BlockingProvider {
            started: Arc::new(Notify::new()),
            cancellation_observed: Arc::new(Notify::new()),
        });
        let started = provider.started.clone();
        let cancellation_observed = provider.cancellation_observed.clone();
        let provider_started = started.notified();
        let provider_cancelled = cancellation_observed.notified();
        let cancellation = agentive::CancellationToken::new();
        let prompts = HashMap::new();
        let steering = agentive::Steering::new();
        let run = run(
            provider,
            Some("blocking-harness".into()),
            Some("blocking-harness".into()),
            vec![ChatMessage::user("Wait for cancellation.")],
            project.path(),
            project.path(),
            "planner",
            &prompts,
            &steering,
            &VisionConfig { enabled: false },
            &WebAccessConfig {
                search_enabled: false,
            },
            false,
            DEFAULT_MAX_TOOL_ROUNDS,
            Vec::new(),
            None,
            None,
            cancellation.clone(),
            |_| {},
        );
        tokio::pin!(run);

        let started = tokio::select! {
            result = tokio::time::timeout(Duration::from_secs(1), provider_started) => result,
            result = &mut run => panic!("runner ended before provider started: {result:?}"),
        };
        started.expect("provider chat should start");
        cancellation.cancel();

        tokio::time::timeout(Duration::from_secs(1), provider_cancelled)
            .await
            .expect("provider chat should observe cancellation");
        assert!(
            tokio::time::timeout(Duration::from_secs(1), &mut run)
                .await
                .is_ok(),
            "runner should finish after cancellation"
        );
    }
}
