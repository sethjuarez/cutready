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

/// Estimate the character cost of a message slice.
#[cfg(test)]
fn estimate_chars(msgs: &[ChatMessage]) -> usize {
    msgs.iter().map(|m| {
        let content_len = m.content.as_ref().map_or(0, |c| c.char_len());
        let tool_len = m.tool_calls.as_ref().map_or(0, |tc| {
            tc.iter().map(|t| t.function.name.len() + t.function.arguments.len()).sum()
        });
        let tool_id_len = m.tool_call_id.as_ref().map_or(0, |id| id.len());
        content_len + tool_len + tool_id_len + 20
    }).sum()
}

/// Build a compact memory summary from messages that are about to be dropped.
/// Extracts key user requests, assistant decisions, and tool actions without
/// needing an LLM call.
#[cfg(test)]
pub fn summarize_dropped(dropped: &[ChatMessage]) -> String {
    let mut summary_parts: Vec<String> = Vec::new();

    for msg in dropped {
        match msg.role.as_str() {
            "user" => {
                if let Some(text) = msg.text() {
                    let truncated = if text.len() > 200 { &text[..200] } else { text };
                    summary_parts.push(format!("\u{2022} User asked: {truncated}"));
                }
            }
            "assistant" => {
                if let Some(text) = msg.text() {
                    let truncated = if text.len() > 200 { &text[..200] } else { text };
                    summary_parts.push(format!("\u{2022} Assistant: {truncated}"));
                }
                if let Some(tool_calls) = &msg.tool_calls {
                    for tc in tool_calls {
                        summary_parts.push(format!("\u{2022} Called tool: {}", tc.function.name));
                    }
                }
            }
            "tool" => {}
            _ => {}
        }
    }

    if summary_parts.is_empty() {
        return String::new();
    }

    let mut result = String::from("[Earlier conversation summary]\n");
    for part in &summary_parts {
        if result.len() + part.len() > 4000 {
            result.push_str("\n\u{2022} ... (older messages omitted)");
            break;
        }
        result.push_str(part);
        result.push('\n');
    }
    result
}

/// Trim messages to fit within the character budget, preserving context
/// via a compact summary of dropped messages.
#[cfg(test)]
fn trim_to_context_window(messages: &mut Vec<ChatMessage>, max_chars: usize) -> (usize, Vec<ChatMessage>) {
    if estimate_chars(messages) <= max_chars {
        return (0, Vec::new());
    }

    let system_end = messages.iter().position(|m| m.role != "system").unwrap_or(messages.len());
    let system_msgs: Vec<ChatMessage> = messages.drain(..system_end).collect();
    let system_chars = estimate_chars(&system_msgs);
    let budget = max_chars.saturating_sub(system_chars).saturating_sub(5000);

    let mut dropped: Vec<ChatMessage> = Vec::new();
    while estimate_chars(messages) > budget && messages.len() > 2 {
        dropped.push(messages.remove(0));
    }

    let dropped_count = dropped.len();
    let summary = summarize_dropped(&dropped);

    let recent = std::mem::take(messages);
    *messages = system_msgs;
    if !summary.is_empty() {
        messages.push(ChatMessage::user(&summary));
    }
    messages.extend(recent);
    (dropped_count, dropped)
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
    /// Whether to include sketch screenshots (vs notes only).
    #[allow(dead_code)]
    pub include_sketches: bool,
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

        let tool_executor = move |tool_call: agentive::ToolCall| -> std::pin::Pin<Box<dyn std::future::Future<Output = Result<String, String>> + Send>> {
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
                Box::pin(async move { exec_fetch_url(&tc).await })
            } else {
                let result = tools::execute_tool(
                    &tool_call, Path::new(&project_root), vision_enabled,
                );
                // Strip vision image markers (option a — images dropped for now)
                let clean = if let Some(pos) = result.find("\n[VISION_IMAGES]") {
                    result[..pos].to_string()
                } else {
                    result
                };
                Box::pin(std::future::ready(Ok(sanitize_for_api(&clean))))
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
        .await
        .map_err(|e| format!("Agent error: {e}"))?;

        // Clean up the forwarding task
        forward_task.abort();

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
) -> std::pin::Pin<Box<dyn std::future::Future<Output = Result<String, String>> + Send>> {
    if depth >= MAX_DELEGATION_DEPTH {
        return Box::pin(std::future::ready(
            Ok("Error: maximum delegation depth reached — cannot delegate further".into()),
        ));
    }

    let args: serde_json::Value =
        serde_json::from_str(&call.function.arguments).unwrap_or(serde_json::json!({}));

    let agent_id = match args.get("agent_id").and_then(|v| v.as_str()) {
        Some(id) => id.to_string(),
        None => return Box::pin(std::future::ready(Ok("Error: missing 'agent_id' argument".into()))),
    };
    let message = match args.get("message").and_then(|v| v.as_str()) {
        Some(m) => m.to_string(),
        None => return Box::pin(std::future::ready(Ok("Error: missing 'message' argument".into()))),
    };

    let prompt = match agent_prompts.get(&agent_id) {
        Some(p) => p.clone(),
        None => {
            let available = agent_prompts.keys().cloned().collect::<Vec<_>>().join(", ");
            return Box::pin(std::future::ready(
                Ok(format!("Error: unknown agent '{agent_id}'. Available: {available}")),
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

        let sub_tool_executor = move |tool_call: agentive::ToolCall| -> std::pin::Pin<Box<dyn std::future::Future<Output = Result<String, String>> + Send>> {
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
                Box::pin(async move { exec_fetch_url(&tc).await })
            } else {
                let result = tools::execute_tool(
                    &tool_call, Path::new(&project_root), vision_enabled,
                );
                let clean = if let Some(pos) = result.find("\n[VISION_IMAGES]") {
                    result[..pos].to_string()
                } else {
                    result
                };
                Box::pin(std::future::ready(Ok(sanitize_for_api(&clean))))
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

        Ok(result_text)
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
    use crate::engine::agent::llm::{ChatMessage, FunctionCall, MessageContent, ToolCall};

    #[test]
    fn summarize_dropped_empty() {
        assert_eq!(summarize_dropped(&[]), "");
    }

    #[test]
    fn summarize_dropped_user_and_assistant() {
        let msgs = vec![
            ChatMessage::user("What files exist?"),
            ChatMessage {
                role: "assistant".into(),
                content: Some(MessageContent::Text("Here are the files.".into())),
                tool_calls: Some(vec![ToolCall {
                    id: "c1".into(),
                    call_type: "function".into(),
                    function: FunctionCall {
                        name: "list_files".into(),
                        arguments: "{}".into(),
                    },
                }]),
                tool_call_id: None,
            },
            ChatMessage::tool_result("c1", "file1.txt\nfile2.txt"),
        ];
        let summary = summarize_dropped(&msgs);
        assert!(summary.contains("User asked: What files exist?"));
        assert!(summary.contains("Assistant: Here are the files."));
        assert!(summary.contains("Called tool: list_files"));
        assert!(!summary.contains("file1.txt"));
    }

    #[test]
    fn summarize_dropped_truncates_long_messages() {
        let long_msg = "x".repeat(500);
        let msgs = vec![ChatMessage::user(&long_msg)];
        let summary = summarize_dropped(&msgs);
        assert!(summary.len() < 300);
    }

    #[test]
    fn summarize_dropped_caps_at_4000_chars() {
        let msgs: Vec<ChatMessage> = (0..100)
            .map(|i| ChatMessage::user(&format!("Message number {} with some content here", i)))
            .collect();
        let summary = summarize_dropped(&msgs);
        assert!(summary.len() <= 4100);
        assert!(summary.contains("older messages omitted"));
    }

    #[test]
    fn trim_to_context_window_no_trim_needed() {
        let mut msgs = vec![
            ChatMessage::system("You are helpful"),
            ChatMessage::user("Hello"),
        ];
        let (dropped, dropped_msgs) = trim_to_context_window(&mut msgs, 100_000);
        assert_eq!(dropped, 0);
        assert!(dropped_msgs.is_empty());
        assert_eq!(msgs.len(), 2);
    }

    #[test]
    fn trim_to_context_window_drops_oldest() {
        let mut msgs = vec![
            ChatMessage::system("You are an AI assistant that helps users"),
            ChatMessage::user(&"A".repeat(500)),
            ChatMessage::user(&"B".repeat(500)),
            ChatMessage::user("recent question"),
        ];
        let (dropped, dropped_msgs) = trim_to_context_window(&mut msgs, 700);
        assert!(dropped > 0);
        assert!(!dropped_msgs.is_empty());
        assert_eq!(msgs[0].role, "system");
        assert!(msgs.iter().any(|m| {
            m.text().map_or(false, |t| t.contains("[Earlier conversation summary]"))
        }));
    }

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
}
