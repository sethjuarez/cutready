//! Agentic loop — runs multi-turn LLM calls with tool execution.
//!
//! Flow: send messages → stream LLM response → if tool_calls → execute tools →
//! append results → re-call LLM → repeat until text response or limit.
//! Emits events via callback so the frontend can show real-time progress.

use std::collections::HashMap;
use std::path::Path;
use std::sync::{Arc, Mutex};

use futures_util::StreamExt;

use crate::engine::agent::llm::{
    ChatMessage, ContentPart, FunctionCall, LlmClient, MessageContent, StreamToolCall, ToolCall,
};
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
        // Find the base64 prefix and then the end of the base64 data
        if let Some(b64_start) = after.find(";base64,") {
            let data_start = b64_start + 8; // skip ";base64,"
            // Base64 data continues until a non-base64 char (quote, paren, space, <, etc.)
            let data_end = after[data_start..].find(|c: char| {
                !c.is_ascii_alphanumeric() && c != '+' && c != '/' && c != '='
            }).unwrap_or(after.len() - data_start);
            let total_b64_len = data_end;
            if total_b64_len > 100 {
                // Large base64 — replace with placeholder
                result.push_str("[base64 image removed]");
            } else {
                // Small data URI (icon, etc.) — keep it
                result.push_str(&after[..data_start + data_end]);
            }
            remaining = &after[data_start + data_end..];
        } else {
            // "data:image/" without ";base64," — just keep it
            result.push_str("data:image/");
            remaining = &after[11..]; // skip "data:image/"
        }
    }
    result.push_str(remaining);
    result
}


/// Estimate the character cost of a message slice.
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
/// needing an LLM call. Used as a fast fallback when LLM compaction is
/// unavailable or fails.
pub fn summarize_dropped(dropped: &[ChatMessage]) -> String {
    let mut summary_parts: Vec<String> = Vec::new();

    for msg in dropped {
        match msg.role.as_str() {
            "user" => {
                if let Some(text) = msg.text() {
                    let truncated = if text.len() > 200 { &text[..200] } else { text };
                    summary_parts.push(format!("• User asked: {truncated}"));
                }
            }
            "assistant" => {
                if let Some(text) = msg.text() {
                    let truncated = if text.len() > 200 { &text[..200] } else { text };
                    summary_parts.push(format!("• Assistant: {truncated}"));
                }
                if let Some(tool_calls) = &msg.tool_calls {
                    for tc in tool_calls {
                        summary_parts.push(format!("• Called tool: {}", tc.function.name));
                    }
                }
            }
            "tool" => {
                // Skip tool results — they're verbose and the tool call name is enough
            }
            _ => {}
        }
    }

    if summary_parts.is_empty() {
        return String::new();
    }

    // Cap the summary itself at ~4000 chars
    let mut result = String::from("[Earlier conversation summary]\n");
    for part in &summary_parts {
        if result.len() + part.len() > 4000 {
            result.push_str("\n• ... (older messages omitted)");
            break;
        }
        result.push_str(part);
        result.push('\n');
    }
    result
}

/// Use the LLM to produce a richer summary of dropped messages.
/// Falls back to `summarize_dropped()` if the LLM call fails.
pub async fn summarize_dropped_with_llm(
    dropped: &[ChatMessage],
    client: &crate::engine::agent::llm::LlmClient,
) -> String {
    // Build a condensed representation of dropped messages for the LLM
    let mut context = String::with_capacity(8000);
    for msg in dropped {
        let role = &msg.role;
        match role.as_str() {
            "user" => {
                if let Some(text) = msg.text() {
                    let t = if text.len() > 500 { &text[..500] } else { text };
                    context.push_str(&format!("[User]: {t}\n"));
                }
            }
            "assistant" => {
                if let Some(text) = msg.text() {
                    let t = if text.len() > 500 { &text[..500] } else { text };
                    context.push_str(&format!("[Assistant]: {t}\n"));
                }
                if let Some(tool_calls) = &msg.tool_calls {
                    for tc in tool_calls {
                        let args_preview = if tc.function.arguments.len() > 200 {
                            &tc.function.arguments[..200]
                        } else {
                            &tc.function.arguments
                        };
                        context.push_str(&format!(
                            "[Tool Call]: {}({})\n",
                            tc.function.name, args_preview
                        ));
                    }
                }
            }
            "tool" => {
                if let (Some(text), Some(_call_id)) = (msg.text(), &msg.tool_call_id) {
                    let t = if text.len() > 300 { &text[..300] } else { text };
                    context.push_str(&format!("[Tool Result]: {t}\n"));
                }
            }
            _ => {}
        }
        // Keep context under ~6000 chars to stay cheap
        if context.len() > 6000 {
            context.push_str("... (older messages omitted)\n");
            break;
        }
    }

    if context.is_empty() {
        return String::new();
    }

    let prompt = format!(
        "Summarize this earlier conversation into a concise memory note (max 1000 chars). \
         Preserve: key decisions made, files read or modified, tool actions taken, and any \
         important context the assistant will need to continue the conversation. \
         Use bullet points. Do NOT include greetings or meta-commentary.\n\n{context}"
    );

    let messages = vec![
        ChatMessage::system(
            "You are a conversation summarizer. Produce concise, factual summaries."
        ),
        ChatMessage::user(&prompt),
    ];

    match tokio::time::timeout(
        std::time::Duration::from_secs(15),
        client.chat(&messages, None),
    )
    .await
    {
        Ok(Ok(resp)) => {
            if let Some(text) = resp.choices.first().and_then(|c| c.message.text()) {
                log::info!(
                    "[agent] LLM compaction: {} dropped msgs → {}char summary",
                    dropped.len(),
                    text.len()
                );
                format!("[Earlier conversation summary — LLM-condensed]\n{text}")
            } else {
                log::warn!("[agent] LLM compaction returned empty, falling back");
                summarize_dropped(dropped)
            }
        }
        Ok(Err(e)) => {
            log::warn!("[agent] LLM compaction failed ({}), falling back", e);
            summarize_dropped(dropped)
        }
        Err(_) => {
            log::warn!("[agent] LLM compaction timed out (15s), falling back");
            summarize_dropped(dropped)
        }
    }
}

/// Trim messages to fit within the character budget, preserving context
/// via a compact summary of dropped messages.
///
/// Strategy:
/// 1. Keep system messages at the front
/// 2. If over budget, extract the oldest non-system messages
/// 3. Summarize them into a single "memory" user message (fast string fallback)
/// 4. Insert the summary after system messages, before recent conversation
///
/// Returns `(dropped_count, dropped_messages)`. The dropped messages are
/// returned so the caller can optionally upgrade the summary via LLM.
fn trim_to_context_window(messages: &mut Vec<ChatMessage>, max_chars: usize) -> (usize, Vec<ChatMessage>) {
    if estimate_chars(messages) <= max_chars {
        return (0, Vec::new());
    }

    // Split into system prefix and conversation
    let system_end = messages.iter().position(|m| m.role != "system").unwrap_or(messages.len());
    let system_msgs: Vec<ChatMessage> = messages.drain(..system_end).collect();
    let system_chars = estimate_chars(&system_msgs);
    // Reserve space for the summary message (~4k chars max)
    let budget = max_chars.saturating_sub(system_chars).saturating_sub(5000);

    // Collect messages to drop from the front
    let mut dropped: Vec<ChatMessage> = Vec::new();
    while estimate_chars(messages) > budget && messages.len() > 2 {
        dropped.push(messages.remove(0));
    }

    let dropped_count = dropped.len();

    // Build fast string summary as initial placeholder
    let summary = summarize_dropped(&dropped);

    // Reassemble: system + summary + recent conversation
    let recent = std::mem::take(messages);
    *messages = system_msgs;
    if !summary.is_empty() {
        messages.push(ChatMessage::user(&summary));
    }
    messages.extend(recent);
    (dropped_count, dropped)
}

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

/// Run the agentic loop with streaming and event emission.
pub async fn run(
    client: &LlmClient,
    messages: Vec<ChatMessage>,
    project_root: &Path,
    agent_prompts: &HashMap<String, String>,
    pending: &Arc<Mutex<Vec<String>>>,
    vision: &VisionConfig,
    emit: impl Fn(AgentEvent) + Send + Sync + 'static,
) -> Result<AgentResult, String> {
    let emit = Arc::new(emit);
    run_with_depth(client, messages, project_root, agent_prompts, pending, 0, vision, emit).await
}

/// Internal runner with depth tracking for sub-agent delegation.
fn run_with_depth<'a>(
    client: &'a LlmClient,
    mut messages: Vec<ChatMessage>,
    project_root: &'a Path,
    agent_prompts: &'a HashMap<String, String>,
    pending: &'a Arc<Mutex<Vec<String>>>,
    depth: usize,
    vision: &'a VisionConfig,
    emit: Arc<dyn Fn(AgentEvent) + Send + Sync + 'static>,
) -> std::pin::Pin<Box<dyn std::future::Future<Output = Result<AgentResult, String>> + Send + 'a>> {
    Box::pin(async move {
        let tool_defs = tools::all_tools();
        log::info!("[agent] starting run (depth={}, {} messages, budget={}chars)", depth, messages.len(), client.context_char_budget());
        crate::util::trace::emit("agent_start", "agent", serde_json::json!({
            "depth": depth,
            "messages": messages.len(),
            "budget_chars": client.context_char_budget(),
        }));

        for round in 0..MAX_TOOL_ROUNDS {
            // Drain any pending user messages before calling the LLM
            {
                let mut queue = pending.lock().unwrap();
                for msg in queue.drain(..) {
                    messages.push(ChatMessage::user(&msg));
                }
            }

            emit(AgentEvent::Status {
                message: if round == 0 {
                    "Thinking…".into()
                } else {
                    format!("Thinking… (round {})", round + 1)
                },
            });

            // Trim conversation to fit within model's context window
            let budget = client.context_char_budget();
            let pre_len = messages.len();
            let (dropped_count, dropped_msgs) = trim_to_context_window(&mut messages, budget);
            if dropped_count > 0 {
                log::debug!("[agent] trimmed {} → {} messages (budget={})", pre_len, messages.len(), budget);
                emit(AgentEvent::Status {
                    message: format!("Compacting context — summarizing {} earlier messages…", dropped_count),
                });

                // Upgrade the fast string summary with an LLM-powered one.
                // The string summary is already in messages as the first
                // non-system user message. Replace it if LLM succeeds.
                let llm_summary = summarize_dropped_with_llm(&dropped_msgs, client).await;
                if llm_summary.contains("LLM-condensed") {
                    // Find and replace the placeholder summary
                    if let Some(pos) = messages.iter().position(|m| {
                        m.role == "user" && m.text().map_or(false, |t| t.starts_with("[Earlier conversation summary]"))
                    }) {
                        messages[pos] = ChatMessage::user(&llm_summary);
                    }
                }

                emit(AgentEvent::Status {
                    message: format!("Compacted context — summarized {} earlier messages", dropped_count),
                });
            }

            // Use streaming to get real-time text output
            let stream_result = client
                .chat_stream(&messages, Some(&tool_defs))
                .await;

            let mut stream = match stream_result {
                Ok(s) => s,
                Err(ref e) if e.contains("400") => {
                    log::warn!("[agent] 400 error, retrying once: {}", e);
                    crate::util::trace::emit("agent_retry", "agent", serde_json::json!({
                        "round": round,
                        "error_preview": crate::util::trace::truncate(e, 300),
                    }));
                    emit(AgentEvent::Status { message: "Retrying request…".into() });
                    match client.chat_stream(&messages, Some(&tool_defs)).await {
                        Ok(s) => s,
                        Err(e2) => {
                            log::error!("[agent] retry also failed: {}", e2);
                            emit(AgentEvent::Error { message: e2.clone() });
                            return Err(e2);
                        }
                    }
                }
                Err(e) => {
                    log::error!("[agent] stream error round {}: {}", round, e);
                    emit(AgentEvent::Error { message: e.clone() });
                    return Err(e);
                }
            };

            // Accumulate the full response from stream chunks
            let mut content_acc = String::new();
            let mut tool_calls_acc: Vec<StreamToolCall> = Vec::new();
            let mut finish_reason: Option<String> = None;

            while let Some(batch_result) = stream.next().await {
                let chunks = match batch_result {
                    Ok(c) => c,
                    Err(e) => {
                        // Stream errors are often transient; log and break
                        emit(AgentEvent::Error { message: e.clone() });
                        return Err(e);
                    }
                };

                for chunk in chunks {
                    for choice in &chunk.choices {
                        if let Some(text) = choice.delta.reasoning_content.as_deref() {
                            emit(AgentEvent::Thinking {
                                content: text.to_string(),
                            });
                        }
                        if let Some(text) = choice.delta.content.as_deref() {
                            content_acc.push_str(text);
                            emit(AgentEvent::Delta {
                                content: text.to_string(),
                            });
                        }
                        if let Some(tcs) = choice.delta.tool_calls.as_ref() {
                            for tc in tcs {
                                // Grow or merge into accumulated tool calls by index
                                while tool_calls_acc.len() <= tc.index {
                                    tool_calls_acc.push(StreamToolCall {
                                        index: tool_calls_acc.len(),
                                        id: None,
                                        call_type: None,
                                        function: None,
                                    });
                                }
                                let acc = &mut tool_calls_acc[tc.index];
                                if tc.id.is_some() {
                                    acc.id = tc.id.clone();
                                }
                                if tc.call_type.is_some() {
                                    acc.call_type = tc.call_type.clone();
                                }
                                if let Some(ref f) = tc.function {
                                    let af = acc.function.get_or_insert(
                                        crate::engine::agent::llm::StreamFunctionCall {
                                            name: None,
                                            arguments: None,
                                        },
                                    );
                                    if f.name.is_some() {
                                        af.name = f.name.clone();
                                    }
                                    if let Some(ref args) = f.arguments {
                                        af.arguments
                                            .get_or_insert_with(String::new)
                                            .push_str(args);
                                    }
                                }
                            }
                        }
                        if choice.finish_reason.is_some() {
                            finish_reason = choice.finish_reason.clone();
                        }
                    }
                }
            }

            // Check if body-size compaction happened during the LLM call
            let body_compacted = client.last_compaction_dropped.load(std::sync::atomic::Ordering::Relaxed);
            if body_compacted > 0 {
                emit(AgentEvent::Status {
                    message: format!("Compacting context — summarized {} earlier messages", body_compacted),
                });
            }

            // Convert accumulated stream tool calls into proper ToolCall objects
            let tool_calls: Vec<ToolCall> = tool_calls_acc
                .into_iter()
                .filter_map(|stc| {
                    let f = stc.function?;
                    Some(ToolCall {
                        id: stc.id.unwrap_or_default(),
                        call_type: stc.call_type.unwrap_or_else(|| "function".into()),
                        function: FunctionCall {
                            name: f.name.unwrap_or_default(),
                            arguments: f.arguments.unwrap_or_default(),
                        },
                    })
                })
                .collect();

            let has_tool_calls = !tool_calls.is_empty();
            log::debug!("[agent] round {} complete: {}chars content, {} tool calls, finish={:?}", round, content_acc.len(), tool_calls.len(), finish_reason);
            crate::util::trace::emit("agent_round", "agent", serde_json::json!({
                "round": round,
                "content_chars": content_acc.len(),
                "tool_calls": tool_calls.iter().map(|tc| &tc.function.name).collect::<Vec<_>>(),
                "finish": finish_reason,
            }));

            // Build the assistant message
            let assistant_msg = ChatMessage {
                role: "assistant".into(),
                content: if content_acc.is_empty() {
                    None
                } else {
                    Some(MessageContent::Text(content_acc.clone()))
                },
                tool_calls: if has_tool_calls {
                    Some(tool_calls.clone())
                } else {
                    None
                },
                tool_call_id: None,
            };

            // If no tool calls, we're done.
            // Note: Responses API always returns finish_reason="stop" even with tool calls,
            // so we only check finish_reason when there are NO tool calls.
            if !has_tool_calls {
                messages.push(assistant_msg);
                crate::util::trace::emit("agent_done", "agent", serde_json::json!({
                    "rounds": round + 1,
                    "response_chars": content_acc.len(),
                    "total_messages": messages.len(),
                }));
                emit(AgentEvent::Done {
                    response: content_acc.clone(),
                });
                return Ok(AgentResult {
                    messages,
                    response: content_acc,
                });
            }

            // Process tool calls
            messages.push(assistant_msg);
            emit(AgentEvent::Status {
                message: format!("Running {} tool call(s)…", tool_calls.len()),
            });

            for call in &tool_calls {
                let args_preview = crate::util::trace::truncate(&call.function.arguments, 200);
                log::info!("[agent] tool call: {}({})", call.function.name, args_preview);
                crate::util::trace::emit("tool_call", "agent", serde_json::json!({
                    "name": call.function.name,
                    "args_preview": args_preview,
                }));
                emit(AgentEvent::ToolCall {
                    name: call.function.name.clone(),
                    arguments: call.function.arguments.clone(),
                });

                let result = if call.function.name == "delegate_to_agent" {
                    exec_delegation(
                        client,
                        call,
                        project_root,
                        agent_prompts,
                        pending,
                        depth,
                        vision,
                        emit.clone(),
                    )
                    .await
                } else if call.function.name == "fetch_url" {
                    exec_fetch_url(call).await
                } else {
                    tools::execute_tool(call, project_root, vision.enabled)
                };

                // Check for embedded vision images in the tool result
                let (clean_result, vision_parts) = if let Some(marker_pos) = result.find("\n[VISION_IMAGES]") {
                    let text = result[..marker_pos].to_string();
                    let images_section = &result[marker_pos + "\n[VISION_IMAGES]".len()..];
                    let parts: Vec<ContentPart> = images_section.lines()
                        .filter_map(|line| serde_json::from_str::<ContentPart>(line).ok())
                        .collect();
                    (text, parts)
                } else {
                    (result.clone(), Vec::new())
                };

                emit(AgentEvent::ToolResult {
                    name: call.function.name.clone(),
                    result: clean_result.clone(),
                });
                crate::util::trace::emit("tool_result", "agent", serde_json::json!({
                    "name": call.function.name,
                    "result_len": clean_result.len(),
                    "result_preview": crate::util::trace::truncate(&clean_result, 300),
                    "has_images": !vision_parts.is_empty(),
                }));
                messages.push(ChatMessage::tool_result(&call.id, &sanitize_for_api(&clean_result)));

                // If tool returned images, inject as a user message with vision content
                if !vision_parts.is_empty() {
                    log::info!("[agent] injecting {} images from tool result", vision_parts.len());
                    messages.push(ChatMessage::user_with_images(
                        "[Images from the tool result above — analyze these along with the text.]",
                        vision_parts,
                    ));
                }
            }
        }

        Err("Agent reached maximum tool-call rounds without a final response".into())
    })
}

/// Execute a delegate_to_agent tool call by spawning a sub-agent loop.
async fn exec_delegation(
    client: &LlmClient,
    call: &crate::engine::agent::llm::ToolCall,
    project_root: &Path,
    agent_prompts: &HashMap<String, String>,
    pending: &Arc<Mutex<Vec<String>>>,
    depth: usize,
    vision: &VisionConfig,
    emit: Arc<dyn Fn(AgentEvent) + Send + Sync + 'static>,
) -> String {
    if depth >= MAX_DELEGATION_DEPTH {
        return "Error: maximum delegation depth reached — cannot delegate further".into();
    }

    let args: serde_json::Value =
        serde_json::from_str(&call.function.arguments).unwrap_or(serde_json::json!({}));

    let agent_id = match args.get("agent_id").and_then(|v| v.as_str()) {
        Some(id) => id,
        None => return "Error: missing 'agent_id' argument".into(),
    };
    let message = match args.get("message").and_then(|v| v.as_str()) {
        Some(m) => m,
        None => return "Error: missing 'message' argument".into(),
    };

    let prompt = match agent_prompts.get(agent_id) {
        Some(p) => p.clone(),
        None => return format!("Error: unknown agent '{agent_id}'. Available: {}", 
            agent_prompts.keys().cloned().collect::<Vec<_>>().join(", ")),
    };

    // Build sub-agent conversation
    let sub_messages = vec![
        ChatMessage::system(&prompt),
        ChatMessage::user(message),
    ];

    emit(AgentEvent::AgentStart {
        agent_id: agent_id.to_string(),
        task: message.to_string(),
    });

    let result = match run_with_depth(client, sub_messages, project_root, agent_prompts, pending, depth + 1, vision, emit.clone()).await {
        Ok(result) => format!("[Agent '{}' responded:]\n\n{}", agent_id, result.response),
        Err(e) => format!("Error from agent '{}': {}", agent_id, e),
    };

    emit(AgentEvent::AgentDone {
        agent_id: agent_id.to_string(),
    });

    result
}

/// Execute a fetch_url tool call.
async fn exec_fetch_url(call: &crate::engine::agent::llm::ToolCall) -> String {
    let args: serde_json::Value =
        serde_json::from_str(&call.function.arguments).unwrap_or(serde_json::json!({}));

    let url = match args.get("url").and_then(|v| v.as_str()) {
        Some(u) => u,
        None => return "Error: missing 'url' argument".into(),
    };

    match web::fetch_and_clean(url).await {
        Ok(content) => content,
        Err(e) => format!("Error fetching URL: {e}"),
    }
}

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
        // Tool results should be skipped
        assert!(!summary.contains("file1.txt"));
    }

    #[test]
    fn summarize_dropped_truncates_long_messages() {
        let long_msg = "x".repeat(500);
        let msgs = vec![ChatMessage::user(&long_msg)];
        let summary = summarize_dropped(&msgs);
        // Should be truncated to 200 chars
        assert!(summary.len() < 300);
    }

    #[test]
    fn summarize_dropped_caps_at_4000_chars() {
        let msgs: Vec<ChatMessage> = (0..100)
            .map(|i| ChatMessage::user(&format!("Message number {} with some content here", i)))
            .collect();
        let summary = summarize_dropped(&msgs);
        assert!(summary.len() <= 4100); // 4000 + marker
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
        // Budget smaller than total but bigger than system + 1 message
        let (dropped, dropped_msgs) = trim_to_context_window(&mut msgs, 700);
        assert!(dropped > 0);
        assert!(!dropped_msgs.is_empty());
        // System message should be preserved
        assert_eq!(msgs[0].role, "system");
        // Should have a summary message
        assert!(msgs.iter().any(|m| {
            m.text().map_or(false, |t| t.contains("[Earlier conversation summary]"))
        }));
    }

    #[test]
    fn strip_inline_base64_replaces_large_data_uris() {
        let input = r#"Some text before data:image/png;base64,AAAA/BBBB+CCCC== and after"#;
        let result = strip_inline_base64(input);
        // 20 chars of base64 is small enough to keep
        assert!(result.contains("data:image/png;base64,"));

        // Large base64 (>100 chars) should be replaced
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
        assert!(!result.contains('\x01'));
    }
}
