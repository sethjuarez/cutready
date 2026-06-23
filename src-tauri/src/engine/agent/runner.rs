//! Agentic loop — delegates to agentive's `run()` with CutReady-specific
//! tool execution, event mapping, and delegation support.
//!
//! The heavy lifting (streaming, SSE parsing, context trimming, retries) is
//! handled by agentive.  This module wires CutReady's tools, sub-agent
//! delegation, and Tauri event bridge into the agentive runner.

use std::collections::HashMap;
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

/// Maximum tool-call rounds to prevent infinite loops.
const MAX_TOOL_ROUNDS: usize = 10;

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
    project_root: &Path,
    agent_id: &str,
    agent_prompts: &HashMap<String, String>,
    steering: &agentive::Steering,
    vision: &VisionConfig,
    web_access: &WebAccessConfig,
    run_id: Option<String>,
    agent_state: Option<AgentStateStore>,
    emit: impl Fn(AgentEvent) + Send + Sync + 'static,
) -> Result<agentive::RunnerResult, String> {
    let emit = Arc::new(emit);
    run_inner(
        provider,
        provider_name,
        model_name,
        messages,
        project_root,
        agent_id,
        agent_prompts,
        steering,
        0,
        vision,
        web_access,
        run_id,
        agent_state,
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
    project_root: &'a Path,
    agent_id: &'a str,
    agent_prompts: &'a HashMap<String, String>,
    steering: &'a agentive::Steering,
    depth: usize,
    vision: &'a VisionConfig,
    web_access: &'a WebAccessConfig,
    run_id: Option<String>,
    agent_state: Option<AgentStateStore>,
    emit: Arc<dyn Fn(AgentEvent) + Send + Sync + 'static>,
) -> std::pin::Pin<
    Box<dyn std::future::Future<Output = Result<agentive::RunnerResult, String>> + Send + 'a>,
> {
    Box::pin(async move {
        let project_workspace_tools_enabled = agent_id.eq_ignore_ascii_case("writer");
        let tool_defs =
            tools::all_tools(web_access.search_enabled, project_workspace_tools_enabled);
        let tool_count = tool_defs.len();
        let starting_chars = agentive::context::estimate_chars(&messages);

        log::info!(
            "[agent] starting run (depth={}, agent={}, {} messages, chars={}, budget={}chars, tools={}, vision={}, web_search={}, project_workspace_tools={})",
            depth,
            agent_id,
            messages.len(),
            starting_chars,
            provider.context_budget_chars(),
            tool_count,
            vision.enabled,
            web_access.search_enabled,
            project_workspace_tools_enabled
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
                "vision_enabled": vision.enabled,
                "web_search_enabled": web_access.search_enabled,
                "project_workspace_tools_enabled": project_workspace_tools_enabled,
            }),
        );

        // Configure agentive runner
        let config = agentive::RunnerConfig {
            max_iterations: MAX_TOOL_ROUNDS,
            retry_on_400: false,
            auto_trim_context: true,
            sanitize_tool_results: true,
            compaction_provider: Some(provider.clone()),
            reference_resolver: Some(build_reference_resolver(project_root)),
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
        let project_root_str = project_root.to_string_lossy().to_string();
        let agent_prompts_owned = agent_prompts.clone();
        let provider_for_tools = provider.clone();
        let provider_name_for_tools = provider_name.clone();
        let model_name_for_tools = model_name.clone();
        let tools_for_exec = tool_defs.clone();
        let emit_for_tools = emit.clone();
        let vision_enabled = vision.enabled;
        let web_search_enabled = web_access.search_enabled;
        let tool_depth = depth;
        let steering_for_tools = steering.clone();

        let tool_executor = move |tool_call: agentive::ToolCall| -> std::pin::Pin<
            Box<dyn std::future::Future<Output = Result<agentive::ToolOutput, String>> + Send>,
        > {
            let project_root = project_root_str.clone();
            let agent_prompts = agent_prompts_owned.clone();
            let provider = provider_for_tools.clone();
            let provider_name = provider_name_for_tools.clone();
            let model_name = model_name_for_tools.clone();
            let tools = tools_for_exec.clone();
            let emit = emit_for_tools.clone();
            let steering = steering_for_tools.clone();

            if tool_call.function.name == "delegate_to_agent" {
                exec_delegation(
                    provider,
                    provider_name,
                    model_name,
                    &tool_call,
                    &project_root,
                    &agent_prompts,
                    &tools,
                    tool_depth,
                    vision_enabled,
                    web_search_enabled,
                    steering,
                    emit,
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
                    Path::new(&project_root),
                    vision_enabled,
                    project_workspace_tools_enabled,
                );
                Box::pin(std::future::ready(Ok(output)))
            }
        };

        let cancel = agentive::CancellationToken::new();

        let result = agentive::run(
            provider.clone(),
            messages.clone(),
            tool_defs,
            tool_executor,
            config,
            cancel,
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
                let (dropped_count, _) =
                    agentive::context::trim_to_context_window(&mut retry_messages, retry_budget);

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

                let retry_config = agentive::RunnerConfig {
                    max_iterations: MAX_TOOL_ROUNDS,
                    retry_on_400: false,
                    auto_trim_context: true,
                    sanitize_tool_results: true,
                    compaction_provider: Some(provider.clone()),
                    reference_resolver: Some(build_reference_resolver(project_root)),
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

                let project_root_str = project_root.to_string_lossy().to_string();
                let agent_prompts_owned = agent_prompts.clone();
                let provider_for_tools = provider.clone();
                let provider_name_for_tools = provider_name.clone();
                let model_name_for_tools = model_name.clone();
                let web_search_enabled = web_access.search_enabled;
                let tools_for_exec =
                    tools::all_tools(web_search_enabled, project_workspace_tools_enabled);
                let emit_for_tools = emit.clone();
                let vision_enabled = vision.enabled;
                let tool_depth = depth;
                let steering_for_tools = steering.clone();

                let retry_tool_executor = move |tool_call: agentive::ToolCall| -> std::pin::Pin<
                    Box<
                        dyn std::future::Future<Output = Result<agentive::ToolOutput, String>>
                            + Send,
                    >,
                > {
                    let project_root = project_root_str.clone();
                    let agent_prompts = agent_prompts_owned.clone();
                    let provider = provider_for_tools.clone();
                    let provider_name = provider_name_for_tools.clone();
                    let model_name = model_name_for_tools.clone();
                    let tools = tools_for_exec.clone();
                    let emit = emit_for_tools.clone();
                    let steering = steering_for_tools.clone();

                    if tool_call.function.name == "delegate_to_agent" {
                        exec_delegation(
                            provider,
                            provider_name,
                            model_name,
                            &tool_call,
                            &project_root,
                            &agent_prompts,
                            &tools,
                            tool_depth,
                            vision_enabled,
                            web_search_enabled,
                            steering,
                            emit,
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
                            Path::new(&project_root),
                            vision_enabled,
                            project_workspace_tools_enabled,
                        );
                        Box::pin(std::future::ready(Ok(output)))
                    }
                };

                agentive::run(
                    provider,
                    retry_messages,
                    tools::all_tools(web_search_enabled, project_workspace_tools_enabled),
                    retry_tool_executor,
                    retry_config,
                    agentive::CancellationToken::new(),
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
// @reference resolver
// ---------------------------------------------------------------------------

/// Build a `ReferenceResolver` that resolves `@name` patterns against the
/// project's sketches, notes, and storyboards.  The resolver matches by:
///   1. Exact path (e.g., `@intro.sk`, `@docs/plan.md`)
///   2. Title (case-insensitive, e.g., `@Introduction`)
///   3. File stem (e.g., `@intro` matches `intro.sk`)
fn build_reference_resolver(project_root: &Path) -> agentive::ReferenceResolver {
    let root = project_root.to_path_buf();
    Arc::new(move |name: String| {
        let root = root.clone();
        Box::pin(async move { resolve_project_reference(&root, &name) })
            as std::pin::Pin<
                Box<dyn std::future::Future<Output = Option<agentive::ResolvedReference>> + Send>,
            >
    })
}

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
    project_root: &str,
    agent_prompts: &HashMap<String, String>,
    _tools: &[agentive::Tool],
    depth: usize,
    vision_enabled: bool,
    web_search_enabled: bool,
    steering: agentive::Steering,
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
    let project_root = project_root.to_string();
    let agent_prompts = agent_prompts.clone();
    let tools = tools::all_tools_for_agent(web_search_enabled, Some(&agent_id));
    let sub_depth = depth + 1;

    Box::pin(async move {
        let sub_messages = vec![ChatMessage::system(&prompt), ChatMessage::user(&message)];

        emit(AgentEvent::AgentStart {
            agent_id: agent_id.clone(),
            task: message.clone(),
        });

        let config = agentive::RunnerConfig {
            max_iterations: MAX_TOOL_ROUNDS,
            auto_trim_context: true,
            sanitize_tool_results: true,
            reference_resolver: Some(build_reference_resolver(Path::new(&project_root))),
            provider_name: provider_name.clone(),
            model_name: model_name.clone(),
            ..Default::default()
        };

        let project_root_for_tools = project_root.clone();
        let agent_prompts_for_tools = agent_prompts.clone();
        let provider_for_tools = provider.clone();
        let provider_name_for_tools = provider_name.clone();
        let model_name_for_tools = model_name.clone();
        let tools_for_tools = tools.clone();
        let emit_for_tools = emit.clone();
        let steering_for_tools = steering.clone();
        let sub_project_workspace_tools_enabled = agent_id.eq_ignore_ascii_case("writer");

        let sub_tool_executor = move |tool_call: agentive::ToolCall| -> std::pin::Pin<
            Box<dyn std::future::Future<Output = Result<agentive::ToolOutput, String>> + Send>,
        > {
            let project_root = project_root_for_tools.clone();
            let agent_prompts = agent_prompts_for_tools.clone();
            let provider = provider_for_tools.clone();
            let provider_name = provider_name_for_tools.clone();
            let model_name = model_name_for_tools.clone();
            let tools = tools_for_tools.clone();
            let emit = emit_for_tools.clone();
            let steering = steering_for_tools.clone();

            if tool_call.function.name == "delegate_to_agent" {
                exec_delegation(
                    provider,
                    provider_name,
                    model_name,
                    &tool_call,
                    &project_root,
                    &agent_prompts,
                    &tools,
                    sub_depth,
                    vision_enabled,
                    web_search_enabled,
                    steering,
                    emit,
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
                })
            } else {
                let output = tools::execute_tool(
                    &tool_call,
                    Path::new(&project_root),
                    vision_enabled,
                    sub_project_workspace_tools_enabled,
                );
                Box::pin(std::future::ready(Ok(output)))
            }
        };

        let cancel = agentive::CancellationToken::new();
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
            _ => {}
        };

        let result_text = match agentive::run(
            provider,
            sub_messages,
            tools,
            sub_tool_executor,
            config,
            cancel,
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
    use std::sync::atomic::{AtomicUsize, Ordering};
    use tokio::sync::mpsc;

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
        let store = AgentStateStore::for_project(project.path(), run_id.clone()).unwrap();
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
            "writer",
            &HashMap::new(),
            &agentive::Steering::new(),
            0,
            &VisionConfig { enabled: false },
            &WebAccessConfig {
                search_enabled: false,
            },
            Some(run_id.clone()),
            Some(store.clone()),
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
}
