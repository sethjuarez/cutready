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
/// needing an LLM call.
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

/// Trim messages to fit within the character budget, preserving context
/// via a compact summary of dropped messages.
///
/// Strategy:
/// 1. Keep system messages at the front
/// 2. If over budget, extract the oldest non-system messages
/// 3. Summarize them into a single "memory" user message
/// 4. Insert the summary after system messages, before recent conversation
fn trim_to_context_window(messages: &mut Vec<ChatMessage>, max_chars: usize) {
    if estimate_chars(messages) <= max_chars {
        return;
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

    // Build summary of what was dropped
    let summary = summarize_dropped(&dropped);

    // Reassemble: system + summary + recent conversation
    let recent = std::mem::take(messages);
    *messages = system_msgs;
    if !summary.is_empty() {
        messages.push(ChatMessage::user(&summary));
    }
    messages.extend(recent);
}

/// Events emitted during the agent loop.
#[derive(Debug, Clone, serde::Serialize)]
#[serde(tag = "type")]
pub enum AgentEvent {
    /// A text delta streamed from the LLM.
    #[serde(rename = "delta")]
    Delta { content: String },
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
            trim_to_context_window(&mut messages, budget);
            if messages.len() < pre_len {
                log::debug!("[agent] trimmed {} → {} messages (budget={})", pre_len, messages.len(), budget);
            }

            // Use streaming to get real-time text output
            let stream_result = client
                .chat_stream(&messages, Some(&tool_defs))
                .await;

            let mut stream = match stream_result {
                Ok(s) => s,
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

            // If no tool calls, we're done
            if !has_tool_calls || finish_reason.as_deref() == Some("stop") {
                messages.push(assistant_msg);
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
                log::info!("[agent] tool call: {}({})", call.function.name, &call.function.arguments[..call.function.arguments.len().min(200)]);
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
                messages.push(ChatMessage::tool_result(&call.id, &clean_result));

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
