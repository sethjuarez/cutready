//! Agentic loop — runs multi-turn LLM calls with tool execution.
//!
//! Flow: send messages → if LLM returns tool_calls → execute tools →
//! append results → re-call LLM → repeat until text response or limit.

use std::path::Path;

use crate::engine::agent::llm::{ChatMessage, LlmClient};
use crate::engine::agent::tools;

/// Maximum tool-call rounds to prevent infinite loops.
const MAX_TOOL_ROUNDS: usize = 10;

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
    mut messages: Vec<ChatMessage>,
    project_root: &Path,
) -> Result<AgentResult, String> {
    let tool_defs = tools::all_tools();

    for _round in 0..MAX_TOOL_ROUNDS {
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
            let result = tools::execute_tool(call, project_root);
            messages.push(ChatMessage::tool_result(&call.id, &result));
        }
    }

    Err("Agent reached maximum tool-call rounds without a final response".into())
}
