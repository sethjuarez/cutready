//! Agentic loop — delegates to agentive's `run()` with CutReady-specific
//! tool execution, event mapping, and delegation support.
//!
//! The heavy lifting (streaming, SSE parsing, context trimming, retries) is
//! handled by agentive.  This module wires CutReady's tools, sub-agent
//! delegation, and Tauri event bridge into the agentive runner.

use std::collections::HashMap;
use std::path::Path;
use std::sync::Arc;

use crate::engine::agent::llm::ChatMessage;
use crate::engine::agent::{tools};
use crate::engine::project;

/// Maximum tool-call rounds to prevent infinite loops.
const MAX_TOOL_ROUNDS: usize = 10;

/// Maximum delegation depth for sub-agents.
const MAX_DELEGATION_DEPTH: usize = 2;


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

// ---------------------------------------------------------------------------
// Agentic loop — delegates to agentive::run()
// ---------------------------------------------------------------------------

/// Run the agentic loop with streaming and event emission.
pub async fn run(
    provider: Arc<dyn agentive::Provider>,
    messages: Vec<ChatMessage>,
    project_root: &Path,
    agent_prompts: &HashMap<String, String>,
    steering: &agentive::Steering,
    vision: &VisionConfig,
    emit: impl Fn(AgentEvent) + Send + Sync + 'static,
) -> Result<agentive::RunnerResult, String> {
    let emit = Arc::new(emit);
    run_inner(provider, messages, project_root, agent_prompts, steering, 0, vision, emit).await
}

/// Internal runner with depth tracking for sub-agent delegation.
#[allow(clippy::too_many_arguments)]
fn run_inner<'a>(
    provider: Arc<dyn agentive::Provider>,
    messages: Vec<ChatMessage>,
    project_root: &'a Path,
    agent_prompts: &'a HashMap<String, String>,
    steering: &'a agentive::Steering,
    depth: usize,
    vision: &'a VisionConfig,
    emit: Arc<dyn Fn(AgentEvent) + Send + Sync + 'static>,
) -> std::pin::Pin<Box<dyn std::future::Future<Output = Result<agentive::RunnerResult, String>> + Send + 'a>> {
    Box::pin(async move {
        let tool_defs = tools::all_tools();

        log::info!(
            "[agent] starting run (depth={}, {} messages, budget={}chars)",
            depth, messages.len(), provider.context_budget_chars()
        );
        crate::util::trace::emit("agent_start", "agent", serde_json::json!({
            "depth": depth,
            "messages": messages.len(),
            "budget_chars": provider.context_budget_chars(),
        }));

        // Configure agentive runner
        let config = agentive::RunnerConfig {
            max_iterations: MAX_TOOL_ROUNDS,
            auto_trim_context: true,
            sanitize_tool_results: true,
            reference_resolver: Some(build_reference_resolver(project_root)),
            ..Default::default()
        };

        // Build on_event callback: map RunnerEvent → AgentEvent
        let last_iteration = Arc::new(std::sync::atomic::AtomicUsize::new(usize::MAX));
        let emit_events = emit.clone();
        let last_iter = last_iteration.clone();
        let on_event = move |event: agentive::RunnerEvent| {
            match event {
                agentive::RunnerEvent::Token { token } => {
                    emit_events(AgentEvent::Delta { content: token });
                }
                agentive::RunnerEvent::Thinking { token } => {
                    emit_events(AgentEvent::Thinking { content: token });
                }
                agentive::RunnerEvent::Status { message } => {
                    emit_events(AgentEvent::Status { message });
                }
                agentive::RunnerEvent::ToolCallStart { name, arguments, iteration, .. } => {
                    let prev = last_iter.swap(iteration, std::sync::atomic::Ordering::Relaxed);
                    if prev != iteration && prev != usize::MAX {
                        emit_events(AgentEvent::DeltaReset);
                    }
                    emit_events(AgentEvent::ToolCall { name, arguments });
                }
                agentive::RunnerEvent::ToolResult { name, result, .. } => {
                    emit_events(AgentEvent::ToolResult { name, result });
                }
                agentive::RunnerEvent::Done { response, .. } => {
                    emit_events(AgentEvent::Done { response });
                }
                agentive::RunnerEvent::Error { message } => {
                    emit_events(AgentEvent::Error { message });
                }
                _ => {} // Usage, MessagesUpdated — no CutReady equivalent
            }
        };

        // Build async tool executor
        let project_root_str = project_root.to_string_lossy().to_string();
        let agent_prompts_owned = agent_prompts.clone();
        let provider_for_tools = provider.clone();
        let tools_for_exec = tool_defs.clone();
        let emit_for_tools = emit.clone();
        let vision_enabled = vision.enabled;
        let tool_depth = depth;

        let tool_executor = move |tool_call: agentive::ToolCall| -> std::pin::Pin<Box<dyn std::future::Future<Output = Result<agentive::ToolOutput, String>> + Send>> {
            let project_root = project_root_str.clone();
            let agent_prompts = agent_prompts_owned.clone();
            let provider = provider_for_tools.clone();
            let tools = tools_for_exec.clone();
            let emit = emit_for_tools.clone();

            if tool_call.function.name == "delegate_to_agent" {
                exec_delegation(
                    provider, &tool_call, &project_root, &agent_prompts,
                    &tools, tool_depth, vision_enabled, emit,
                )
            } else if tool_call.function.name == "fetch_url" {
                let tc = tool_call;
                Box::pin(async move {
                    let args = agentive::parse_tool_args(&tc.function.arguments).unwrap_or(serde_json::json!({}));
                    let url = args.get("url").and_then(|v| v.as_str()).unwrap_or("");
                    agentive::web::fetch_and_clean(url).await
                        .map(agentive::ToolOutput::from)
                })
            } else {
                let output = tools::execute_tool(
                    &tool_call, Path::new(&project_root), vision_enabled,
                );
                Box::pin(std::future::ready(Ok(output)))
            }
        };

        let cancel = agentive::CancellationToken::new();

        let result = agentive::run(
            provider,
            messages,
            tool_defs,
            tool_executor,
            config,
            cancel,
            steering.clone(),
            agentive::Guardrails::default(),
            on_event,
        )
        .await;

        let result = result.map_err(|e| format!("Agent error: {e}"))?;

        crate::util::trace::emit("agent_done", "agent", serde_json::json!({
            "rounds": result.total_usage.total_tokens,
            "response_chars": result.response.len(),
            "total_messages": result.messages.len(),
        }));

        Ok(result)
    })
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
        Box::pin(async move {
            resolve_project_reference(&root, &name)
        }) as std::pin::Pin<Box<dyn std::future::Future<Output = Option<agentive::ResolvedReference>> + Send>>
    })
}

/// Try to resolve a reference name against project files.
fn resolve_project_reference(root: &std::path::Path, name: &str) -> Option<agentive::ResolvedReference> {
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
                if let Ok(data) = std::fs::read_to_string(&abs) {
                    return Some(agentive::ResolvedReference {
                        name: sb.title.clone(),
                        content: data,
                        content_type: "application/json".to_string(),
                    });
                }
            }
        }
    }

    None
}

/// Check if a user-typed reference name matches a project file by path, title, or stem.
fn matches_ref(name: &str, path: &str, title: &str) -> bool {
    let name_lower = name.to_lowercase();
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
    call: &agentive::ToolCall,
    project_root: &str,
    agent_prompts: &HashMap<String, String>,
    tools: &[agentive::Tool],
    depth: usize,
    vision_enabled: bool,
    emit: Arc<dyn Fn(AgentEvent) + Send + Sync + 'static>,
) -> std::pin::Pin<Box<dyn std::future::Future<Output = Result<agentive::ToolOutput, String>> + Send>> {
    if depth >= MAX_DELEGATION_DEPTH {
        return Box::pin(std::future::ready(
            Ok(agentive::ToolOutput::from("Error: maximum delegation depth reached — cannot delegate further")),
        ));
    }

    let args: serde_json::Value =
        agentive::parse_tool_args(&call.function.arguments).unwrap_or(serde_json::json!({}));

    let agent_id = match args.get("agent_id").and_then(|v| v.as_str()) {
        Some(id) => id.to_string(),
        None => return Box::pin(std::future::ready(Ok(agentive::ToolOutput::from("Error: missing 'agent_id' argument")))),
    };
    let message = match args.get("message").and_then(|v| v.as_str()) {
        Some(m) => m.to_string(),
        None => return Box::pin(std::future::ready(Ok(agentive::ToolOutput::from("Error: missing 'message' argument")))),
    };

    let prompt = match agent_prompts.get(&agent_id) {
        Some(p) => p.clone(),
        None => {
            let available = agent_prompts.keys().cloned().collect::<Vec<_>>().join(", ");
            return Box::pin(std::future::ready(
                Ok(agentive::ToolOutput::from(format!("Error: unknown agent '{agent_id}'. Available: {available}"))),
            ));
        }
    };

    // Own everything needed by the async block
    let project_root = project_root.to_string();
    let agent_prompts = agent_prompts.clone();
    let tools = tools.to_vec();
    let sub_depth = depth + 1;

    Box::pin(async move {
        let sub_messages = vec![
            ChatMessage::system(&prompt),
            ChatMessage::user(&message),
        ];

        emit(AgentEvent::AgentStart {
            agent_id: agent_id.clone(),
            task: message.clone(),
        });

        let config = agentive::RunnerConfig {
            max_iterations: MAX_TOOL_ROUNDS,
            auto_trim_context: true,
            sanitize_tool_results: true,
            ..Default::default()
        };

        let project_root_for_tools = project_root.clone();
        let agent_prompts_for_tools = agent_prompts.clone();
        let provider_for_tools = provider.clone();
        let tools_for_tools = tools.clone();
        let emit_for_tools = emit.clone();

        let sub_tool_executor = move |tool_call: agentive::ToolCall| -> std::pin::Pin<Box<dyn std::future::Future<Output = Result<agentive::ToolOutput, String>> + Send>> {
            let project_root = project_root_for_tools.clone();
            let agent_prompts = agent_prompts_for_tools.clone();
            let provider = provider_for_tools.clone();
            let tools = tools_for_tools.clone();
            let emit = emit_for_tools.clone();

            if tool_call.function.name == "delegate_to_agent" {
                exec_delegation(
                    provider, &tool_call, &project_root, &agent_prompts,
                    &tools, sub_depth, vision_enabled, emit,
                )
            } else if tool_call.function.name == "fetch_url" {
                let tc = tool_call;
                Box::pin(async move {
                    let args = agentive::parse_tool_args(&tc.function.arguments).unwrap_or(serde_json::json!({}));
                    let url = args.get("url").and_then(|v| v.as_str()).unwrap_or("");
                    agentive::web::fetch_and_clean(url).await
                        .map(agentive::ToolOutput::from)
                })
            } else {
                let output = tools::execute_tool(
                    &tool_call, Path::new(&project_root), vision_enabled,
                );
                Box::pin(std::future::ready(Ok(output)))
            }
        };

        let cancel = agentive::CancellationToken::new();
        let sub_emit = emit.clone();
        let sub_on_event = move |event: agentive::RunnerEvent| {
            match event {
                agentive::RunnerEvent::Token { token } => {
                    sub_emit(AgentEvent::Delta { content: token });
                }
                agentive::RunnerEvent::Thinking { token } => {
                    sub_emit(AgentEvent::Thinking { content: token });
                }
                agentive::RunnerEvent::ToolCallStart { name, arguments, .. } => {
                    sub_emit(AgentEvent::ToolCall { name, arguments });
                }
                agentive::RunnerEvent::ToolResult { name, result, .. } => {
                    sub_emit(AgentEvent::ToolResult { name, result });
                }
                _ => {}
            }
        };

        let result_text = match agentive::run(
            provider,
            sub_messages,
            tools,
            sub_tool_executor,
            config,
            cancel,
            agentive::Steering::default(),
            agentive::Guardrails::default(),
            sub_on_event,
        ).await {
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
    fn matches_ref_no_match() {
        assert!(!matches_ref("setup", "intro.sk", "Introduction"));
    }
}
