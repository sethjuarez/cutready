//! Agentic loop — delegates to agentive's `run()` with CutReady-specific
//! tool execution, event mapping, and delegation support.
//!
//! The heavy lifting (streaming, SSE parsing, context trimming, retries) is
//! handled by agentive.  This module wires CutReady's tools, sub-agent
//! delegation, and Tauri event bridge into the agentive runner.

use std::collections::HashMap;
use std::path::Path;
use std::sync::{Arc, Mutex};

use crate::engine::agent::llm::ChatMessage;
use crate::engine::agent::{tools, web};

/// Maximum tool-call rounds to prevent infinite loops.
const MAX_TOOL_ROUNDS: usize = 10;

/// Maximum delegation depth for sub-agents.
const MAX_DELEGATION_DEPTH: usize = 2;

/// Strip control characters (except \n, \r, \t) and null bytes from tool
/// results before sending them to the API. Invalid characters can cause
/// JSON parse errors on the server side.
fn sanitize_for_api(s: &str) -> String {
    // First strip inline base64 data URIs that bloat the body without adding
    // LLM-readable value (the LLM can't interpret raw base64 image data).
    let stripped = strip_inline_base64(s);
    stripped.chars()
        .filter(|c| !c.is_control() || matches!(c, '\n' | '\r' | '\t'))
        .collect()
}

/// Replace inline `data:image/...;base64,...` URIs with a short placeholder.
/// These can appear in markdown notes (pasted screenshots) and bloat the body
/// by hundreds of KB without providing any value to the LLM (it can't decode
/// raw base64 — images must be sent as separate content parts).
fn strip_inline_base64(s: &str) -> String {
    let mut result = String::with_capacity(s.len());
    let mut remaining = s;
    while let Some(start) = remaining.find("data:image/") {
        result.push_str(&remaining[..start]);
        let after = &remaining[start..];
        if let Some(b64_start) = after.find(";base64,") {
            let data_start = b64_start + 8;
            let data_end = after[data_start..].find(|c: char| {
                !c.is_ascii_alphanumeric() && c != '+' && c != '/' && c != '='
            }).unwrap_or(after.len() - data_start);
            let total_b64_len = data_end;
            if total_b64_len > 100 {
                result.push_str("[base64 image removed]");
            } else {
                result.push_str(&after[..data_start + data_end]);
            }
            remaining = &after[data_start + data_end..];
        } else {
            result.push_str("data:image/");
            remaining = &after[11..];
        }
    }
    result.push_str(remaining);
    result
}

/// Parse a raw tool result into a `ToolOutput`, extracting any `[VISION_IMAGES]`
/// section into image content parts.  The text portion is sanitized for the API.
fn parse_tool_output(raw: &str) -> agentive::ToolOutput {
    use crate::engine::agent::llm::ContentPart;

    if let Some(marker_pos) = raw.find("\n[VISION_IMAGES]") {
        let text = sanitize_for_api(&raw[..marker_pos]);
        let images_section = &raw[marker_pos + "\n[VISION_IMAGES]".len()..];
        let images: Vec<ContentPart> = images_section
            .lines()
            .filter_map(|line| serde_json::from_str::<ContentPart>(line).ok())
            .collect();
        if images.is_empty() {
            agentive::ToolOutput::Text(text)
        } else {
            agentive::ToolOutput::with_images(text, images)
        }
    } else {
        agentive::ToolOutput::Text(sanitize_for_api(raw))
    }
}


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

/// Result of running the agentic loop.
pub struct AgentResult {
    /// The full conversation including tool calls and results.
    pub messages: Vec<ChatMessage>,
    /// The final assistant text response.
    pub response: String,
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
    pending: &Arc<Mutex<Vec<String>>>,
    vision: &VisionConfig,
    emit: impl Fn(AgentEvent) + Send + Sync + 'static,
) -> Result<AgentResult, String> {
    let emit = Arc::new(emit);
    run_inner(provider, messages, project_root, agent_prompts, pending, 0, vision, emit).await
}

/// Internal runner with depth tracking for sub-agent delegation.
fn run_inner<'a>(
    provider: Arc<dyn agentive::Provider>,
    messages: Vec<ChatMessage>,
    project_root: &'a Path,
    agent_prompts: &'a HashMap<String, String>,
    pending: &'a Arc<Mutex<Vec<String>>>,
    depth: usize,
    vision: &'a VisionConfig,
    emit: Arc<dyn Fn(AgentEvent) + Send + Sync + 'static>,
) -> std::pin::Pin<Box<dyn std::future::Future<Output = Result<AgentResult, String>> + Send + 'a>> {
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
            ..Default::default()
        };

        // Bridge CutReady's pending messages queue to agentive's Steering
        let steering = agentive::Steering::new();
        let steering_fwd = steering.clone();
        let pending_fwd = pending.clone();
        let forward_task = tokio::spawn(async move {
            loop {
                tokio::time::sleep(std::time::Duration::from_millis(100)).await;
                let mut queue = match pending_fwd.lock() {
                    Ok(q) => q,
                    Err(_) => break,
                };
                for msg in queue.drain(..) {
                    steering_fwd.send(&msg);
                }
            }
        });

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
                    exec_fetch_url(&tc).await.map(agentive::ToolOutput::from)
                })
            } else {
                let result = tools::execute_tool(
                    &tool_call, Path::new(&project_root), vision_enabled,
                );
                let output = parse_tool_output(&result);
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
            steering,
            agentive::Guardrails::default(),
            on_event,
        )
        .await;

        // Always clean up the forwarding task
        forward_task.abort();

        let result = result.map_err(|e| format!("Agent error: {e}"))?;

        crate::util::trace::emit("agent_done", "agent", serde_json::json!({
            "rounds": result.total_usage.total_tokens,
            "response_chars": result.response.len(),
            "total_messages": result.messages.len(),
        }));

        Ok(AgentResult {
            messages: result.messages,
            response: result.response,
        })
    })
}

// ---------------------------------------------------------------------------
// Tool helpers
// ---------------------------------------------------------------------------

/// Execute a delegate_to_agent tool call by spawning a sub-agent loop.
/// Returns a boxed future to allow recursive async through agentive::run().
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
        serde_json::from_str(&call.function.arguments).unwrap_or(serde_json::json!({}));

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
                    exec_fetch_url(&tc).await.map(agentive::ToolOutput::from)
                })
            } else {
                let result = tools::execute_tool(
                    &tool_call, Path::new(&project_root), vision_enabled,
                );
                let output = parse_tool_output(&result);
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

/// Execute a fetch_url tool call.
async fn exec_fetch_url(call: &agentive::ToolCall) -> Result<String, String> {
    let args: serde_json::Value =
        serde_json::from_str(&call.function.arguments).unwrap_or(serde_json::json!({}));

    let url = match args.get("url").and_then(|v| v.as_str()) {
        Some(u) => u,
        None => return Ok("Error: missing 'url' argument".into()),
    };

    match web::fetch_and_clean(url).await {
        Ok(content) => Ok(content),
        Err(e) => Ok(format!("Error fetching URL: {e}")),
    }
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn strip_inline_base64_replaces_large_data_uris() {
        let input = r#"Some text before data:image/png;base64,AAAA/BBBB+CCCC== and after"#;
        let result = strip_inline_base64(input);
        assert!(result.contains("data:image/png;base64,"));

        let big_b64 = "A".repeat(200);
        let input = format!(r#"before data:image/png;base64,{big_b64}" after"#);
        let result = strip_inline_base64(&input);
        assert!(result.contains("[base64 image removed]"));
        assert!(!result.contains(&big_b64));
    }

    #[test]
    fn strip_inline_base64_preserves_non_image_data() {
        let input = "No images here, just plain text";
        assert_eq!(strip_inline_base64(input), input);
    }

    #[test]
    fn strip_inline_base64_handles_multiple_images() {
        let big = "B".repeat(200);
        let input = format!(
            r#"![](data:image/png;base64,{big}) text ![](data:image/jpeg;base64,{big})"#
        );
        let result = strip_inline_base64(&input);
        let count = result.matches("[base64 image removed]").count();
        assert_eq!(count, 2, "should replace both large images");
    }

    #[test]
    fn sanitize_for_api_strips_base64_and_control_chars() {
        let big = "C".repeat(300);
        let input = format!("Note: data:image/png;base64,{big}) \x01hidden");
        let result = sanitize_for_api(&input);
        assert!(result.contains("[base64 image removed]"));
        assert!(!result.contains(&big));
    }

    #[test]
    fn parse_tool_output_text_only() {
        let output = parse_tool_output("Hello world");
        assert!(matches!(output, agentive::ToolOutput::Text(_)));
        assert_eq!(output.text(), "Hello world");
    }

    #[test]
    fn parse_tool_output_with_images() {
        let image_json = r#"{"type":"image_url","image_url":{"url":"data:image/png;base64,abc"}}"#;
        let raw = format!("Sketch: Login Page\n[VISION_IMAGES]{image_json}");
        let output = parse_tool_output(&raw);
        assert_eq!(output.text(), "Sketch: Login Page");
        assert!(output.images().is_some());
        assert_eq!(output.images().unwrap().len(), 1);
    }

    #[test]
    fn parse_tool_output_bad_image_json_falls_back() {
        let raw = "Some text\n[VISION_IMAGES]not-valid-json";
        let output = parse_tool_output(raw);
        // Bad JSON lines are skipped, resulting in no images → text-only
        assert!(matches!(output, agentive::ToolOutput::Text(_)));
        assert_eq!(output.text(), "Some text");
    }
}
