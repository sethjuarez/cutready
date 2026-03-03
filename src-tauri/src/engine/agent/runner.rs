//! Agentic loop — runs multi-turn LLM calls with tool execution.
//!
//! Flow: send messages → if LLM returns tool_calls → execute tools →
//! append results → re-call LLM → repeat until text response or limit.

use std::collections::HashMap;
use std::path::Path;
use std::sync::{Arc, Mutex};

use crate::engine::agent::llm::{ChatMessage, LlmClient};
use crate::engine::agent::{tools, web};

/// Maximum tool-call rounds to prevent infinite loops.
const MAX_TOOL_ROUNDS: usize = 10;

/// Maximum depth for sub-agent delegation.
const MAX_DELEGATION_DEPTH: usize = 2;

/// Result of running the agentic loop.
pub struct AgentResult {
    /// The full conversation including tool calls and results.
    pub messages: Vec<ChatMessage>,
    /// The final assistant text response.
    pub response: String,
}

/// Run the agentic loop: send messages with tools, execute any tool calls,
/// and repeat until the LLM responds with text (no tool calls).
pub async fn run(
    client: &LlmClient,
    messages: Vec<ChatMessage>,
    project_root: &Path,
    agent_prompts: &HashMap<String, String>,
    pending: &Arc<Mutex<Vec<String>>>,
) -> Result<AgentResult, String> {
    run_with_depth(client, messages, project_root, agent_prompts, pending, 0).await
}

/// Internal runner with depth tracking for sub-agent delegation.
fn run_with_depth<'a>(
    client: &'a LlmClient,
    mut messages: Vec<ChatMessage>,
    project_root: &'a Path,
    agent_prompts: &'a HashMap<String, String>,
    pending: &'a Arc<Mutex<Vec<String>>>,
    depth: usize,
) -> std::pin::Pin<Box<dyn std::future::Future<Output = Result<AgentResult, String>> + Send + 'a>> {
    Box::pin(async move {
        let tool_defs = tools::all_tools();

        for _round in 0..MAX_TOOL_ROUNDS {
            // Drain any pending user messages before calling the LLM
            {
                let mut queue = pending.lock().unwrap();
                for msg in queue.drain(..) {
                    messages.push(ChatMessage::user(&msg));
                }
            }

            let resp = client.chat(&messages, Some(&tool_defs)).await?;

            let choice = resp
                .choices
                .into_iter()
                .next()
                .ok_or("No response from model")?;

            let msg = choice.message;

            // If no tool calls, we're done — return the text
            if msg.tool_calls.is_none() || msg.tool_calls.as_ref().is_some_and(|tc| tc.is_empty()) {
                let response = msg.content.clone().unwrap_or_default();
                messages.push(msg);
                return Ok(AgentResult { messages, response });
            }

            // Process tool calls
            let tool_calls = msg.tool_calls.clone().unwrap();
            messages.push(msg);

            for call in &tool_calls {
                let result = if call.function.name == "delegate_to_agent" {
                    exec_delegation(client, call, project_root, agent_prompts, pending, depth).await
                } else if call.function.name == "fetch_url" {
                    exec_fetch_url(call).await
                } else {
                    tools::execute_tool(call, project_root)
                };
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

    match run_with_depth(client, sub_messages, project_root, agent_prompts, pending, depth + 1).await {
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
