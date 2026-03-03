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
    ChatMessage, FunctionCall, LlmClient, StreamToolCall, ToolCall,
};
use crate::engine::agent::{tools, web};

/// Maximum tool-call rounds to prevent infinite loops.
const MAX_TOOL_ROUNDS: usize = 10;

/// Maximum depth for sub-agent delegation.
const MAX_DELEGATION_DEPTH: usize = 2;

/// Events emitted during the agent loop.
#[derive(Debug, Clone, serde::Serialize)]
#[serde(tag = "type")]
pub enum AgentEvent {
    /// A text delta streamed from the LLM.
    #[serde(rename = "delta")]
    Delta { content: String },
    /// Status update (thinking, calling tools, etc.)
    #[serde(rename = "status")]
    Status { message: String },
    /// A tool is being called.
    #[serde(rename = "tool_call")]
    ToolCall { name: String, arguments: String },
    /// A tool returned a result.
    #[serde(rename = "tool_result")]
    ToolResult { name: String, result: String },
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

/// Run the agentic loop with streaming and event emission.
pub async fn run(
    client: &LlmClient,
    messages: Vec<ChatMessage>,
    project_root: &Path,
    agent_prompts: &HashMap<String, String>,
    pending: &Arc<Mutex<Vec<String>>>,
    emit: impl Fn(AgentEvent) + Send + Sync + 'static,
) -> Result<AgentResult, String> {
    let emit = Arc::new(emit);
    run_with_depth(client, messages, project_root, agent_prompts, pending, 0, emit).await
}

/// Internal runner with depth tracking for sub-agent delegation.
fn run_with_depth<'a>(
    client: &'a LlmClient,
    mut messages: Vec<ChatMessage>,
    project_root: &'a Path,
    agent_prompts: &'a HashMap<String, String>,
    pending: &'a Arc<Mutex<Vec<String>>>,
    depth: usize,
    emit: Arc<dyn Fn(AgentEvent) + Send + Sync + 'static>,
) -> std::pin::Pin<Box<dyn std::future::Future<Output = Result<AgentResult, String>> + Send + 'a>> {
    Box::pin(async move {
        let tool_defs = tools::all_tools();

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

            // Use streaming to get real-time text output
            let stream_result = client
                .chat_stream(&messages, Some(&tool_defs))
                .await;

            let mut stream = match stream_result {
                Ok(s) => s,
                Err(e) => {
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

            // Build the assistant message
            let assistant_msg = ChatMessage {
                role: "assistant".into(),
                content: if content_acc.is_empty() {
                    None
                } else {
                    Some(content_acc.clone())
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
                        emit.clone(),
                    )
                    .await
                } else if call.function.name == "fetch_url" {
                    exec_fetch_url(call).await
                } else {
                    tools::execute_tool(call, project_root)
                };

                emit(AgentEvent::ToolResult {
                    name: call.function.name.clone(),
                    result: result.clone(),
                });
                messages.push(ChatMessage::tool_result(&call.id, &result));
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

    match run_with_depth(client, sub_messages, project_root, agent_prompts, pending, depth + 1, emit).await {
        Ok(result) => format!("[Agent '{}' responded:]\n\n{}", agent_id, result.response),
        Err(e) => format!("Error from agent '{}': {}", agent_id, e),
    }
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
