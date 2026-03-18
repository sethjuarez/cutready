//! LLM client for Azure OpenAI and OpenAI-compatible APIs.
//!
//! Supports chat completions with function calling, streaming via SSE,
//! and an agentic tool loop that executes tool calls and feeds results back.

use std::fmt::Write as _;
use futures_util::StreamExt;
use reqwest::header::{HeaderMap, HeaderValue, AUTHORIZATION, CONTENT_TYPE};
use serde::{Deserialize, Serialize};

// ---------------------------------------------------------------------------
// Provider configuration
// ---------------------------------------------------------------------------

/// Which LLM provider to use.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "snake_case")]
pub enum LlmProvider {
    AzureOpenai,
    Openai,
}

/// Full configuration for an LLM provider.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct LlmConfig {
    pub provider: LlmProvider,
    /// For Azure: `https://<resource>.openai.azure.com`
    /// For OpenAI: `https://api.openai.com` (or omit — defaults applied)
    pub endpoint: String,
    /// API key (used when auth_mode is "api_key").
    pub api_key: String,
    /// Deployment / model name (e.g. "gpt-4o", "gpt-4.1").
    pub model: String,
    /// Optional bearer token (used when auth_mode is "azure_oauth").
    #[serde(default)]
    pub bearer_token: Option<String>,
}

// ---------------------------------------------------------------------------
// Chat message types (OpenAI-compatible, with multimodal support)
// ---------------------------------------------------------------------------

/// A single content part in a multimodal message.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(tag = "type")]
pub enum ContentPart {
    #[serde(rename = "text")]
    Text { text: String },
    #[serde(rename = "image_url")]
    ImageUrl { image_url: ImageUrlData },
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ImageUrlData {
    /// Either a URL or a `data:image/png;base64,...` data URI.
    pub url: String,
    /// "low" (512px, 85 tokens) or "high" (full res). Default "low" for cost.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub detail: Option<String>,
}

/// Message content that can be either a plain string or a multimodal array.
/// Serializes as a plain JSON string for text-only (backward compat) or
/// as an array of content parts for multimodal messages.
#[derive(Debug, Clone)]
pub enum MessageContent {
    Text(String),
    Parts(Vec<ContentPart>),
}

impl MessageContent {
    /// Get the text content (ignoring images).
    pub fn text(&self) -> &str {
        match self {
            MessageContent::Text(s) => s,
            MessageContent::Parts(parts) => {
                for p in parts {
                    if let ContentPart::Text { text } = p {
                        return text;
                    }
                }
                ""
            }
        }
    }

    /// Estimated character length (text only, images counted as fixed overhead).
    pub fn char_len(&self) -> usize {
        match self {
            MessageContent::Text(s) => s.len(),
            MessageContent::Parts(parts) => parts.iter().map(|p| match p {
                ContentPart::Text { text } => text.len(),
                ContentPart::ImageUrl { .. } => 200, // ~85 tokens at low detail
            }).sum(),
        }
    }
}

impl Serialize for MessageContent {
    fn serialize<S: serde::Serializer>(&self, serializer: S) -> Result<S::Ok, S::Error> {
        match self {
            MessageContent::Text(s) => serializer.serialize_str(s),
            MessageContent::Parts(parts) => parts.serialize(serializer),
        }
    }
}

impl<'de> Deserialize<'de> for MessageContent {
    fn deserialize<D: serde::Deserializer<'de>>(deserializer: D) -> Result<Self, D::Error> {
        let value = serde_json::Value::deserialize(deserializer)?;
        match value {
            serde_json::Value::String(s) => Ok(MessageContent::Text(s)),
            serde_json::Value::Array(_) => {
                let parts: Vec<ContentPart> = serde_json::from_value(value)
                    .map_err(serde::de::Error::custom)?;
                Ok(MessageContent::Parts(parts))
            }
            _ => Err(serde::de::Error::custom("content must be a string or array")),
        }
    }
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ChatMessage {
    pub role: String,
    /// Content is serialized as `null` (not omitted) when None. The OpenAI API
    /// requires `"content": null` on assistant messages that have tool_calls.
    pub content: Option<MessageContent>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub tool_calls: Option<Vec<ToolCall>>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub tool_call_id: Option<String>,
}

impl ChatMessage {
    pub fn system(content: &str) -> Self {
        Self {
            role: "system".into(),
            content: Some(MessageContent::Text(content.into())),
            tool_calls: None,
            tool_call_id: None,
        }
    }
    pub fn user(content: &str) -> Self {
        Self {
            role: "user".into(),
            content: Some(MessageContent::Text(content.into())),
            tool_calls: None,
            tool_call_id: None,
        }
    }
    pub fn user_with_images(text: &str, parts: Vec<ContentPart>) -> Self {
        let mut all_parts = vec![ContentPart::Text { text: text.into() }];
        all_parts.extend(parts);
        Self {
            role: "user".into(),
            content: Some(MessageContent::Parts(all_parts)),
            tool_calls: None,
            tool_call_id: None,
        }
    }
    pub fn tool_result(tool_call_id: &str, content: &str) -> Self {
        Self {
            role: "tool".into(),
            content: Some(MessageContent::Text(content.into())),
            tool_calls: None,
            tool_call_id: Some(tool_call_id.into()),
        }
    }
    /// Get text content as a string reference (convenience).
    pub fn text(&self) -> Option<&str> {
        self.content.as_ref().map(|c| c.text())
    }

    /// Strip control characters (except \n, \r, \t) and lone surrogates from all
    /// text in this message: content text, content parts text, and tool call
    /// arguments. This prevents JSON parse errors on the server side.
    pub fn sanitize(&mut self) {
        fn clean(s: &str) -> String {
            s.chars()
                .filter(|c| !c.is_control() || matches!(c, '\n' | '\r' | '\t'))
                .collect()
        }
        if let Some(content) = &mut self.content {
            match content {
                MessageContent::Text(t) => *t = clean(t),
                MessageContent::Parts(parts) => {
                    for p in parts {
                        if let ContentPart::Text { text } = p {
                            *text = clean(text);
                        }
                    }
                }
            }
        }
        if let Some(tool_calls) = &mut self.tool_calls {
            for tc in tool_calls {
                tc.function.arguments = clean(&tc.function.arguments);
            }
        }
    }
}

// ---------------------------------------------------------------------------
// Tool / function calling types
// ---------------------------------------------------------------------------

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ToolDefinition {
    #[serde(rename = "type")]
    pub tool_type: String,
    pub function: FunctionDefinition,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct FunctionDefinition {
    pub name: String,
    pub description: String,
    pub parameters: serde_json::Value,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ToolCall {
    pub id: String,
    #[serde(rename = "type")]
    pub call_type: String,
    pub function: FunctionCall,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct FunctionCall {
    pub name: String,
    pub arguments: String,
}

// ---------------------------------------------------------------------------
// API request / response types
// ---------------------------------------------------------------------------

#[derive(Debug, Serialize)]
struct ChatCompletionRequest {
    #[serde(skip_serializing_if = "Option::is_none")]
    model: Option<String>,
    messages: Vec<ChatMessage>,
    #[serde(skip_serializing_if = "Option::is_none")]
    tools: Option<Vec<ToolDefinition>>,
    #[serde(skip_serializing_if = "Option::is_none")]
    stream: Option<bool>,
}

#[derive(Debug, Deserialize)]
pub struct ChatCompletionResponse {
    pub choices: Vec<Choice>,
}

#[derive(Debug, Deserialize)]
pub struct Choice {
    pub message: ChatMessage,
    #[allow(dead_code)]
    pub finish_reason: Option<String>,
}

/// A single SSE chunk from a streaming response.
#[derive(Debug, Deserialize)]
pub struct StreamChunk {
    pub choices: Vec<StreamChoice>,
}

#[derive(Debug, Deserialize)]
pub struct StreamChoice {
    pub delta: StreamDelta,
    pub finish_reason: Option<String>,
}

#[derive(Debug, Deserialize)]
pub struct StreamDelta {
    #[allow(dead_code)]
    pub role: Option<String>,
    pub content: Option<String>,
    pub reasoning_content: Option<String>,
    pub tool_calls: Option<Vec<StreamToolCall>>,
}

#[derive(Debug, Deserialize)]
pub struct StreamToolCall {
    pub index: usize,
    pub id: Option<String>,
    #[serde(rename = "type")]
    pub call_type: Option<String>,
    pub function: Option<StreamFunctionCall>,
}

#[derive(Debug, Deserialize)]
pub struct StreamFunctionCall {
    pub name: Option<String>,
    pub arguments: Option<String>,
}

// ---------------------------------------------------------------------------
// Responses API types (for codex/pro models that don't support Chat Completions)
// ---------------------------------------------------------------------------

/// Request body for the Responses API.
#[derive(Debug, Serialize)]
struct ResponsesApiRequest {
    model: String,
    input: Vec<serde_json::Value>,
    #[serde(skip_serializing_if = "Option::is_none")]
    tools: Option<Vec<ResponsesApiToolDef>>,
    #[serde(skip_serializing_if = "Option::is_none")]
    stream: Option<bool>,
}

/// Flattened tool definition for the Responses API (no `function` wrapper).
#[derive(Debug, Clone, Serialize)]
struct ResponsesApiToolDef {
    #[serde(rename = "type")]
    tool_type: String,
    name: String,
    description: String,
    parameters: serde_json::Value,
}

/// Non-streaming response from the Responses API.
#[derive(Debug, Deserialize)]
struct ResponsesApiResponse {
    output: Vec<serde_json::Value>,
}

/// Mutable state for Responses API streaming — tracks function call indices.
#[derive(Default)]
struct ResponsesStreamState {
    /// Maps Responses API output_index → Chat Completions tool_call index
    output_to_tc: std::collections::HashMap<usize, usize>,
    next_tc_idx: usize,
}

// ---------------------------------------------------------------------------
// Model listing types
// ---------------------------------------------------------------------------

#[derive(Debug, Deserialize)]
pub struct ModelsResponse {
    pub data: Vec<ModelInfo>,
}

/// Foundry deployments response.
#[derive(Debug, Deserialize)]
struct FoundryModelsResponse {
    value: Vec<FoundryModelEntry>,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct FoundryModelEntry {
    name: String,
    #[serde(default)]
    model_name: Option<String>,
    #[serde(default)]
    capabilities: Option<std::collections::HashMap<String, String>>,
}

/// Azure OpenAI deployments response (standard AOAI resources).
#[derive(Debug, Deserialize)]
struct AzureDeploymentsResponse {
    #[serde(default)]
    data: Vec<AzureDeploymentEntry>,
}

#[derive(Debug, Deserialize)]
struct AzureDeploymentEntry {
    id: String,
    #[serde(default)]
    model: Option<String>,
}

/// Foundry project-level deployments response.
#[derive(Debug, Deserialize)]
struct FoundryProjectDeploymentsResponse {
    #[serde(default)]
    value: Vec<FoundryProjectDeployment>,
}

#[derive(Debug, Deserialize)]
struct FoundryProjectDeployment {
    name: String,
    #[serde(default)]
    properties: Option<FoundryDeploymentProperties>,
}

#[derive(Debug, Deserialize)]
struct FoundryDeploymentProperties {
    #[serde(default)]
    model: Option<FoundryDeploymentModel>,
}

#[derive(Debug, Deserialize)]
struct FoundryDeploymentModel {
    name: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ModelInfo {
    pub id: String,
    #[serde(default)]
    pub created: Option<u64>,
    #[serde(default)]
    pub owned_by: Option<String>,
    /// Capability flags from the deployment (e.g., "chat_completion", "embeddings").
    #[serde(default)]
    pub capabilities: Option<std::collections::HashMap<String, String>>,
    /// Max context window in tokens (if reported by the API).
    #[serde(default, alias = "context_window", alias = "max_model_tokens")]
    pub context_length: Option<usize>,
}

// ---------------------------------------------------------------------------
// LLM Client
// ---------------------------------------------------------------------------

pub struct LlmClient {
    config: LlmConfig,
    http: reqwest::Client,
    /// API-reported context window (tokens) for the selected model.
    /// Set after listing models if the deployment reports it.
    reported_context_length: std::sync::Mutex<Option<usize>>,
    /// Number of messages dropped during the most recent body-size compaction.
    /// Reset to 0 before each chat_stream call; checked by the runner after.
    pub last_compaction_dropped: std::sync::atomic::AtomicUsize,
}

impl LlmClient {
    pub fn new(config: LlmConfig) -> Self {
        // Disable connection pooling — Azure gateways can return cryptic
        // errors when reusing connections after SSE streams.
        // connect_timeout: fail fast if the endpoint is unreachable.
        // read_timeout: if no data arrives for 120s, assume the stream stalled.
        //   This resets on each received chunk, so long-running streams are fine.
        let http = reqwest::Client::builder()
            .pool_max_idle_per_host(0)
            .connect_timeout(std::time::Duration::from_secs(30))
            .read_timeout(std::time::Duration::from_secs(120))
            .build()
            .unwrap_or_else(|_| reqwest::Client::new());
        Self {
            config,
            http,
            reported_context_length: std::sync::Mutex::new(None),
            last_compaction_dropped: std::sync::atomic::AtomicUsize::new(0),
        }
    }

    /// Record the API-reported context window for the selected model.
    pub fn set_reported_context_length(&self, tokens: usize) {
        *self.reported_context_length.lock().unwrap() = Some(tokens);
    }

    /// Whether the model supports vision (image) inputs.
    pub fn supports_vision(&self) -> bool {
        let model = self.config.model.to_lowercase();
        // GPT-4o, GPT-4.1, GPT-5.x all support vision
        model.contains("gpt-4o")
            || model.contains("gpt-4.1")
            || model.contains("gpt-5")
            // GPT-4-turbo with vision
            || model.contains("gpt-4-turbo")
            || model.contains("gpt-4-vision")
            // Claude 3.5+ and Claude 4 support vision
            || model.contains("claude-3-5") || model.contains("claude-3.5")
            || model.contains("claude-4")
            // Gemini supports vision
            || model.contains("gemini")
            // o-series reasoning models with vision
            || model.starts_with("o1") || model.starts_with("o3") || model.starts_with("o4")
    }

    /// Return a conservative character budget for the model's context window.
    /// Prefers API-reported context length if available, otherwise uses model
    /// name heuristics. ~4 chars/token as a rough proxy (no tokenizer dependency).
    pub fn context_char_budget(&self) -> usize {
        // If the API told us the exact context window, use it
        if let Some(reported) = *self.reported_context_length.lock().unwrap() {
            let usable = reported * 3 / 4;
            return usable * 4;
        }

        let model = self.config.model.to_lowercase();

        // Map well-known model families to their context windows (in tokens),
        // then convert to a char budget at ~75% utilization (leave room for output).
        let token_limit: usize = if model.contains("gpt-4o") || model.contains("gpt-4.1") || model.contains("gpt-5") {
            128_000
        } else if model.contains("gpt-4-turbo") || model.contains("gpt-4-1106") || model.contains("gpt-4-0125") {
            128_000
        } else if model.contains("gpt-35-turbo-16k") || model.contains("gpt-3.5-turbo-16k") {
            16_384
        } else if model.contains("gpt-35") || model.contains("gpt-3.5") {
            4_096
        } else if model.contains("gpt-4") {
            8_192
        } else if model.contains("claude-3-5") || model.contains("claude-3.5") || model.contains("claude-4") {
            200_000
        } else if model.contains("claude") {
            100_000
        } else if model.starts_with("o1") || model.starts_with("o3") || model.starts_with("o4") {
            128_000
        } else if model.contains("gemini") {
            128_000
        } else if model.contains("deepseek") {
            64_000
        } else if model.contains("phi-4") || model.contains("phi-3") {
            16_000
        } else if model.contains("mistral-large") || model.contains("mistral-medium") {
            32_000
        } else if model.contains("mistral") {
            8_000
        } else {
            // Conservative default for unknown models
            32_000
        };

        // Use 75% of context for input, leave 25% for output
        // ~4 chars per token as a rough approximation
        let usable_tokens = token_limit * 3 / 4;
        usable_tokens * 4
    }

    /// Detect whether the endpoint is Azure AI Foundry (`.services.ai.azure.com`).
    fn is_foundry(&self) -> bool {
        self.config.endpoint.contains(".services.ai.azure.com")
    }

    /// Extract the Foundry host base, stripping any /api/projects/... suffix.
    fn foundry_base(&self) -> String {
        let base = self.config.endpoint.trim_end_matches('/');
        if let Some(idx) = base.find("/api/projects") {
            base[..idx].to_string()
        } else {
            base.to_string()
        }
    }

    /// Extract byte offset from a 400 error response and log the surrounding
    /// body context for debugging. Looks for patterns like `('body', 81960)` in
    /// Pydantic-style errors.
    fn log_body_context_at_error(body: &str, error_text: &str) {
        // Parse byte offset from Pydantic error: ('body', 81960) or ("body", 81960)
        let offset = error_text
            .find("body")
            .and_then(|pos| {
                // skip past 'body' + quote + comma + space(s)
                let rest = &error_text[pos + 4..];
                let rest = rest.trim_start_matches(|c: char| c == '\'' || c == '"' || c == ',' || c == ' ' || c == ')');
                // Now rest should start with the number
                let num_end = rest.find(|c: char| !c.is_ascii_digit()).unwrap_or(rest.len());
                if num_end > 0 {
                    rest[..num_end].parse::<usize>().ok()
                } else {
                    None
                }
            });

        if let Some(offset) = offset {
            let start = offset.saturating_sub(200);
            let end = (offset + 200).min(body.len());
            // Find safe char boundaries
            let safe_start = (start..=offset).rev()
                .find(|&i| body.is_char_boundary(i))
                .unwrap_or(0);
            let safe_end = (end..=body.len())
                .find(|&i| body.is_char_boundary(i))
                .unwrap_or(body.len());
            log::error!(
                "[llm] 400 body context at byte {} (body len {}):\n<<<\n{}\n>>>",
                offset,
                body.len(),
                &body[safe_start..safe_end]
            );

            // Write the full body to a temp file for post-mortem analysis
            let tmp = std::env::temp_dir().join("cutready-400-body.json");
            if let Ok(()) = std::fs::write(&tmp, body) {
                log::error!("[llm] full request body saved to: {}", tmp.display());
            }
        }
    }

    /// Whether the model requires the Responses API instead of Chat Completions.
    /// Codex and Pro model variants are Responses API only.
    pub fn needs_responses_api(&self) -> bool {
        let model = self.config.model.to_lowercase();
        model.contains("codex")
            || (model.contains("gpt-5") && model.ends_with("-pro"))
    }

    /// Build the Responses API URL.
    fn responses_url(&self) -> String {
        match self.config.provider {
            LlmProvider::AzureOpenai => {
                let base = if self.is_foundry() {
                    self.foundry_base()
                } else {
                    self.config.endpoint.trim_end_matches('/').to_string()
                };
                format!("{}/openai/v1/responses", base)
            }
            LlmProvider::Openai => {
                let base = if self.config.endpoint.is_empty() {
                    "https://api.openai.com".to_string()
                } else {
                    self.config.endpoint.trim_end_matches('/').to_string()
                };
                format!("{}/v1/responses", base)
            }
        }
    }

    /// Convert ChatMessage array to Responses API `input` format.
    fn messages_to_responses_input(messages: &[ChatMessage]) -> Vec<serde_json::Value> {
        let mut input = Vec::new();
        for msg in messages {
            match msg.role.as_str() {
                "system" => {
                    if let Some(content) = &msg.content {
                        input.push(serde_json::json!({
                            "role": "developer",
                            "content": content.text()
                        }));
                    }
                }
                "user" => {
                    if let Some(content) = &msg.content {
                        match content {
                            MessageContent::Text(text) => {
                                input.push(serde_json::json!({
                                    "role": "user",
                                    "content": text
                                }));
                            }
                            MessageContent::Parts(parts) => {
                                let api_parts: Vec<serde_json::Value> = parts
                                    .iter()
                                    .map(|p| match p {
                                        ContentPart::Text { text } => serde_json::json!({
                                            "type": "input_text",
                                            "text": text
                                        }),
                                        ContentPart::ImageUrl { image_url } => {
                                            let mut obj = serde_json::json!({
                                                "type": "input_image",
                                                "image_url": image_url.url
                                            });
                                            if let Some(detail) = &image_url.detail {
                                                obj["detail"] =
                                                    serde_json::Value::String(detail.clone());
                                            }
                                            obj
                                        }
                                    })
                                    .collect();
                                input.push(serde_json::json!({
                                    "role": "user",
                                    "content": api_parts
                                }));
                            }
                        }
                    }
                }
                "assistant" => {
                    if let Some(tool_calls) = &msg.tool_calls {
                        // Emit text content before tool calls
                        if let Some(content) = &msg.content {
                            let text = content.text();
                            if !text.is_empty() {
                                input.push(serde_json::json!({
                                    "type": "message",
                                    "role": "assistant",
                                    "content": [{"type": "output_text", "text": text}]
                                }));
                            }
                        }
                        // Each tool call becomes a separate function_call item
                        for tc in tool_calls {
                            input.push(serde_json::json!({
                                "type": "function_call",
                                "call_id": tc.id,
                                "name": tc.function.name,
                                "arguments": tc.function.arguments
                            }));
                        }
                    } else if let Some(content) = &msg.content {
                        input.push(serde_json::json!({
                            "type": "message",
                            "role": "assistant",
                            "content": [{"type": "output_text", "text": content.text()}]
                        }));
                    }
                }
                "tool" => {
                    if let (Some(call_id), Some(content)) =
                        (&msg.tool_call_id, &msg.content)
                    {
                        input.push(serde_json::json!({
                            "type": "function_call_output",
                            "call_id": call_id,
                            "output": content.text()
                        }));
                    }
                }
                _ => {
                    if let Some(content) = &msg.content {
                        input.push(serde_json::json!({
                            "role": msg.role,
                            "content": content.text()
                        }));
                    }
                }
            }
        }
        input
    }

    /// Convert ToolDefinition array to Responses API flattened format.
    fn tools_to_responses_format(
        tools: Option<&[ToolDefinition]>,
    ) -> Option<Vec<ResponsesApiToolDef>> {
        tools.map(|t| {
            t.iter()
                .map(|td| ResponsesApiToolDef {
                    tool_type: "function".to_string(),
                    name: td.function.name.clone(),
                    description: td.function.description.clone(),
                    parameters: td.function.parameters.clone(),
                })
                .collect()
        })
    }

    /// Convert Responses API output to a ChatCompletionResponse.
    fn responses_output_to_chat_response(
        output: &[serde_json::Value],
    ) -> ChatCompletionResponse {
        let mut content_parts: Vec<String> = Vec::new();
        let mut tool_calls: Vec<ToolCall> = Vec::new();

        for item in output {
            match item.get("type").and_then(|t| t.as_str()) {
                Some("message") => {
                    if let Some(arr) = item.get("content").and_then(|c| c.as_array()) {
                        for part in arr {
                            if part.get("type").and_then(|t| t.as_str())
                                == Some("output_text")
                            {
                                if let Some(text) =
                                    part.get("text").and_then(|t| t.as_str())
                                {
                                    content_parts.push(text.to_string());
                                }
                            }
                        }
                    }
                }
                Some("function_call") => {
                    let call_id = item
                        .get("call_id")
                        .and_then(|v| v.as_str())
                        .unwrap_or("")
                        .to_string();
                    let name = item
                        .get("name")
                        .and_then(|v| v.as_str())
                        .unwrap_or("")
                        .to_string();
                    let arguments = item
                        .get("arguments")
                        .and_then(|v| v.as_str())
                        .unwrap_or("{}")
                        .to_string();
                    tool_calls.push(ToolCall {
                        id: call_id,
                        call_type: "function".to_string(),
                        function: FunctionCall { name, arguments },
                    });
                }
                _ => {}
            }
        }

        let content = if content_parts.is_empty() {
            None
        } else {
            Some(MessageContent::Text(content_parts.join("")))
        };

        let has_calls = !tool_calls.is_empty();
        ChatCompletionResponse {
            choices: vec![Choice {
                message: ChatMessage {
                    role: "assistant".into(),
                    content,
                    tool_calls: if has_calls {
                        Some(tool_calls)
                    } else {
                        None
                    },
                    tool_call_id: None,
                },
                finish_reason: Some(if has_calls { "tool_calls" } else { "stop" }.into()),
            }],
        }
    }

    /// Parse a single Responses API SSE event into StreamChunk(s).
    fn parse_responses_sse_event(
        val: &serde_json::Value,
        state: &mut ResponsesStreamState,
    ) -> Vec<StreamChunk> {
        let event_type = match val.get("type").and_then(|t| t.as_str()) {
            Some(t) => t,
            None => return vec![],
        };

        match event_type {
            "response.output_text.delta" => {
                if let Some(delta) = val.get("delta").and_then(|d| d.as_str()) {
                    vec![StreamChunk {
                        choices: vec![StreamChoice {
                            delta: StreamDelta {
                                role: None,
                                content: Some(delta.to_string()),
                                reasoning_content: None,
                                tool_calls: None,
                            },
                            finish_reason: None,
                        }],
                    }]
                } else {
                    vec![]
                }
            }
            "response.output_item.added" => {
                if let Some(item) = val.get("item") {
                    if item.get("type").and_then(|t| t.as_str())
                        == Some("function_call")
                    {
                        let output_index = val
                            .get("output_index")
                            .and_then(|v| v.as_u64())
                            .unwrap_or(0) as usize;
                        let tc_idx = state.next_tc_idx;
                        state.output_to_tc.insert(output_index, tc_idx);
                        state.next_tc_idx += 1;

                        let call_id = item
                            .get("call_id")
                            .and_then(|v| v.as_str())
                            .unwrap_or("")
                            .to_string();
                        let name = item
                            .get("name")
                            .and_then(|v| v.as_str())
                            .unwrap_or("")
                            .to_string();

                        return vec![StreamChunk {
                            choices: vec![StreamChoice {
                                delta: StreamDelta {
                                    role: None,
                                    content: None,
                                    reasoning_content: None,
                                    tool_calls: Some(vec![StreamToolCall {
                                        index: tc_idx,
                                        id: Some(call_id),
                                        call_type: Some("function".to_string()),
                                        function: Some(StreamFunctionCall {
                                            name: Some(name),
                                            arguments: None,
                                        }),
                                    }]),
                                },
                                finish_reason: None,
                            }],
                        }];
                    }
                }
                vec![]
            }
            "response.function_call_arguments.delta" => {
                let output_index = val
                    .get("output_index")
                    .and_then(|v| v.as_u64())
                    .unwrap_or(0) as usize;
                let tc_idx = state
                    .output_to_tc
                    .get(&output_index)
                    .copied()
                    .unwrap_or(0);

                if let Some(delta) = val.get("delta").and_then(|d| d.as_str()) {
                    vec![StreamChunk {
                        choices: vec![StreamChoice {
                            delta: StreamDelta {
                                role: None,
                                content: None,
                                reasoning_content: None,
                                tool_calls: Some(vec![StreamToolCall {
                                    index: tc_idx,
                                    id: None,
                                    call_type: None,
                                    function: Some(StreamFunctionCall {
                                        name: None,
                                        arguments: Some(delta.to_string()),
                                    }),
                                }]),
                            },
                            finish_reason: None,
                        }],
                    }]
                } else {
                    vec![]
                }
            }
            "response.completed" => {
                vec![StreamChunk {
                    choices: vec![StreamChoice {
                        delta: StreamDelta {
                            role: None,
                            content: None,
                            reasoning_content: None,
                            tool_calls: None,
                        },
                        finish_reason: Some("stop".to_string()),
                    }],
                }]
            }
            _ => vec![],
        }
    }

    /// Build the chat completions URL based on provider.
    fn chat_url(&self) -> String {
        match self.config.provider {
            LlmProvider::AzureOpenai => {
                if self.is_foundry() {
                    // Foundry: use OpenAI-compatible path on the host base
                    let base = self.foundry_base();
                    format!(
                        "{}/openai/deployments/{}/chat/completions?api-version=2024-10-21",
                        base, self.config.model
                    )
                } else {
                    let base = self.config.endpoint.trim_end_matches('/');
                    format!(
                        "{}/openai/deployments/{}/chat/completions?api-version=2024-10-21",
                        base, self.config.model
                    )
                }
            }
            LlmProvider::Openai => {
                let base = if self.config.endpoint.is_empty() {
                    "https://api.openai.com".to_string()
                } else {
                    self.config.endpoint.trim_end_matches('/').to_string()
                };
                format!("{}/v1/chat/completions", base)
            }
        }
    }

    /// Build the models/deployments list URL based on provider.
    fn models_url(&self) -> String {
        match self.config.provider {
            LlmProvider::AzureOpenai => {
                if self.is_foundry() {
                    let base = self.foundry_base();
                    format!(
                        "{}/openai/models?api-version=2024-10-21",
                        base
                    )
                } else {
                    let base = self.config.endpoint.trim_end_matches('/');
                    format!(
                        "{}/openai/deployments?api-version=2024-10-21",
                        base
                    )
                }
            }
            LlmProvider::Openai => {
                let base = if self.config.endpoint.is_empty() {
                    "https://api.openai.com".to_string()
                } else {
                    self.config.endpoint.trim_end_matches('/').to_string()
                };
                format!("{}/v1/models", base)
            }
        }
    }

    /// Build auth headers based on provider type and auth mode.
    fn auth_headers(&self) -> HeaderMap {
        let mut headers = HeaderMap::new();
        headers.insert(CONTENT_TYPE, HeaderValue::from_static("application/json"));

        // Bearer token takes priority (from OAuth flow)
        if let Some(ref token) = self.config.bearer_token {
            if !token.is_empty() {
                let bearer = format!("Bearer {}", token);
                if let Ok(v) = HeaderValue::from_str(&bearer) {
                    headers.insert(AUTHORIZATION, v);
                }
                return headers;
            }
        }

        // Fall back to API key
        match self.config.provider {
            LlmProvider::AzureOpenai => {
                if let Ok(v) = HeaderValue::from_str(&self.config.api_key) {
                    headers.insert("api-key", v);
                }
            }
            LlmProvider::Openai => {
                let bearer = format!("Bearer {}", self.config.api_key);
                if let Ok(v) = HeaderValue::from_str(&bearer) {
                    headers.insert(AUTHORIZATION, v);
                }
            }
        }
        headers
    }

    /// List available models from the provider.
    pub async fn list_models(&self) -> Result<Vec<ModelInfo>, String> {
        // For Foundry, try deployments endpoints first (deployed only), then fall back to models
        if self.config.provider == LlmProvider::AzureOpenai && self.is_foundry() {
            return self.list_models_foundry().await;
        }

        let url = self.models_url();
        let body = self.fetch_models_body(&url).await?;
        self.parse_models_response(&body, false)
    }

    /// Foundry-specific model listing: tries deployments endpoints first, falls back to /openai/models.
    async fn list_models_foundry(&self) -> Result<Vec<ModelInfo>, String> {
        let base = self.foundry_base();
        let full_endpoint = self.config.endpoint.trim_end_matches('/');

        // Build candidate URLs in priority order:
        // 1. Project-level /deployments with api-version=v1 (deployed only, 7 items)
        // 2. Fallback: /openai/models (full catalog — 288+ items, filtered by capability)
        let mut urls = Vec::new();
        if full_endpoint.contains("/api/projects") {
            urls.push(format!("{}/deployments?api-version=v1", full_endpoint));
        }
        urls.push(format!("{}/openai/models?api-version=2024-10-21", base));

        let mut last_err = String::new();
        for url in &urls {
            let is_deployments = url.contains("/deployments");
            log::info!("[list_models_foundry] trying: {} (filter_chat={})", url, !is_deployments);
            match self.fetch_models_body(url).await {
                Ok(body) => match self.parse_models_response(&body, !is_deployments) {
                    Ok(models) if !models.is_empty() => {
                        log::info!("[list_models_foundry] success from {} — {} models", url, models.len());
                        return Ok(models);
                    }
                    Ok(_) => {
                        log::info!("[list_models_foundry] empty result from {}", url);
                        continue;
                    }
                    Err(e) => {
                        log::info!("[list_models_foundry] parse failed from {}: {}", url, e);
                        continue;
                    }
                },
                Err(e) => {
                    log::info!("[list_models_foundry] fetch failed from {}: {}", url, e);
                    last_err = e;
                    continue;
                }
            }
        }

        Err(format!("No Foundry deployments found. Last error: {last_err}"))
    }

    /// Fetch the raw body from a models/deployments URL.
    async fn fetch_models_body(&self, url: &str) -> Result<String, String> {
        let resp = self
            .http
            .get(url)
            .headers(self.auth_headers())
            .timeout(std::time::Duration::from_secs(30))
            .send()
            .await
            .map_err(|e| format!("Failed to list models: {e}"))?;

        if !resp.status().is_success() {
            let status = resp.status();
            let body = resp.text().await.unwrap_or_default();
            let token_info = self
                .config
                .bearer_token
                .as_deref()
                .and_then(decode_jwt_audience)
                .map(|aud| format!(" [token aud={aud}]"))
                .unwrap_or_default();
            return Err(format!(
                "Model list failed ({status}){token_info} [url={url}]: {body}"
            ));
        }

        resp.text()
            .await
            .map_err(|e| format!("Failed to read models response: {e}"))
    }

    /// Parse a models/deployments response body into ModelInfo list.
    /// When `filter_chat_only` is true, only include chat-capable models (for catalog responses).
    fn parse_models_response(&self, body: &str, filter_chat_only: bool) -> Result<Vec<ModelInfo>, String> {
        // Try standard OpenAI format: { "data": [{ "id": "...", ... }] }
        if let Ok(parsed) = serde_json::from_str::<ModelsResponse>(body) {
            if !parsed.data.is_empty() {
                return Ok(parsed.data);
            }
        }
        // Azure deployments format: { "data": [{ "id": "...", "model": "..." }] }
        if let Ok(parsed) = serde_json::from_str::<AzureDeploymentsResponse>(body) {
            if !parsed.data.is_empty() {
                return Ok(
                    parsed
                        .data
                        .into_iter()
                        .map(|d| ModelInfo {
                            id: d.id,
                            created: None,
                            owned_by: d.model,
                            capabilities: None,
                            context_length: None,
                        })
                        .collect(),
                );
            }
        }
        // Foundry format: { "value": [{ "name": "...", "modelName": "...", "capabilities": {...} }] }
        if let Ok(parsed) = serde_json::from_str::<FoundryModelsResponse>(body) {
            if !parsed.value.is_empty() {
                return Ok(
                    parsed
                        .value
                        .into_iter()
                        .filter(|m| {
                            if !filter_chat_only {
                                return true; // deployments endpoint: show all
                            }
                            // catalog: include chat-capable models AND Responses API models
                            let has_chat = m.capabilities
                                .as_ref()
                                .and_then(|c| c.get("chat_completion"))
                                .map(|v| v == "true")
                                .unwrap_or(true);
                            if has_chat {
                                return true;
                            }
                            // Also include codex/pro models (we support them via Responses API)
                            let name = m.name.to_lowercase();
                            name.contains("codex")
                                || (name.contains("gpt-5") && name.ends_with("-pro"))
                        })
                        .map(|m| ModelInfo {
                            id: m.name,
                            created: None,
                            owned_by: m.model_name,
                            capabilities: m.capabilities,
                            context_length: None,
                        })
                        .collect(),
                );
            }
        }
        // Foundry project deployments: { "value": [{ "name": "...", "properties": { "model": { "name": "..." } } }] }
        if let Ok(parsed) = serde_json::from_str::<FoundryProjectDeploymentsResponse>(body) {
            if !parsed.value.is_empty() {
                return Ok(
                    parsed
                        .value
                        .into_iter()
                        .map(|d| ModelInfo {
                            id: d.name,
                            created: None,
                            owned_by: d.properties
                                .and_then(|p| p.model)
                                .map(|m| m.name),
                            capabilities: None,
                            context_length: None,
                        })
                        .collect(),
                );
            }
        }
        Err(format!("Failed to parse models response: {body}"))
    }

    /// Send a non-streaming chat completion request.
    pub async fn chat(
        &self,
        messages: &[ChatMessage],
        tools: Option<&[ToolDefinition]>,
    ) -> Result<ChatCompletionResponse, String> {
        let mut clean_messages = messages.to_vec();
        for msg in &mut clean_messages {
            msg.sanitize();
        }

        // Codex/Pro models require the Responses API
        if self.needs_responses_api() {
            return self.chat_responses(&clean_messages, tools).await;
        }

        let body = ChatCompletionRequest {
            model: match self.config.provider {
                LlmProvider::Openai => Some(self.config.model.clone()),
                LlmProvider::AzureOpenai => {
                    if self.is_foundry() {
                        // Foundry v1: model goes in body
                        Some(self.config.model.clone())
                    } else {
                        None // standard Azure: model is in the URL
                    }
                }
            },
            messages: clean_messages,
            tools: tools.map(|t| t.to_vec()),
            stream: None,
        };

        let body_json = serde_json::to_string(&body).unwrap_or_default();
        let body_json = escape_non_ascii_json(&body_json);
        let url = self.chat_url();
        let resp = self
            .http
            .post(&url)
            .headers(self.auth_headers())
            .timeout(std::time::Duration::from_secs(300))
            .header(reqwest::header::CONTENT_TYPE, "application/json")
            .body(body_json.as_bytes().to_vec())
            .send()
            .await
            .map_err(|e| format!("Chat request failed: {e}"))?;

        if !resp.status().is_success() {
            let status = resp.status();
            let text = resp.text().await.unwrap_or_default();
            if status == 400 {
                Self::log_body_context_at_error(&body_json, &text);
            }
            return Err(format!("Chat API error ({status}) [url={url}]: {text}"));
        }

        resp.json()
            .await
            .map_err(|e| format!("Failed to parse chat response: {e}"))
    }

    /// Send a non-streaming request via the Responses API (for codex/pro models).
    async fn chat_responses(
        &self,
        messages: &[ChatMessage],
        tools: Option<&[ToolDefinition]>,
    ) -> Result<ChatCompletionResponse, String> {
        let body = ResponsesApiRequest {
            model: self.config.model.clone(),
            input: Self::messages_to_responses_input(messages),
            tools: Self::tools_to_responses_format(tools),
            stream: None,
        };

        let url = self.responses_url();
        log::info!(
            "[llm] chat_responses → {} ({} input items, {} tools)",
            self.config.model,
            body.input.len(),
            body.tools.as_ref().map_or(0, |t| t.len())
        );

        let raw_json = serde_json::to_string(&body).unwrap_or_default();
        let escaped = escape_non_ascii_json(&raw_json);
        let body_json = if let Err(e) = serde_json::from_str::<serde_json::Value>(&escaped) {
            log::error!(
                "[llm] escape_non_ascii_json corrupted JSON (non-stream) at byte {}: {} — falling back to raw UTF-8",
                e.column().saturating_sub(1), e
            );
            raw_json
        } else {
            escaped
        };

        let resp = self
            .http
            .post(&url)
            .headers(self.auth_headers())
            .timeout(std::time::Duration::from_secs(300))
            .header(reqwest::header::CONTENT_TYPE, "application/json")
            .body(body_json.into_bytes())
            .send()
            .await
            .map_err(|e| format!("Responses API request failed: {e}"))?;

        if !resp.status().is_success() {
            let status = resp.status();
            let text = resp.text().await.unwrap_or_default();
            let mut end = 2000.min(text.len());
            while end < text.len() && !text.is_char_boundary(end) {
                end -= 1;
            }
            let detail = &text[..end];

            let lower = detail.to_lowercase();
            let error_class = if status == 400 {
                if lower.contains("context_length_exceeded") || lower.contains("maximum context length") {
                    "token_limit"
                } else if lower.contains("invalid_payload") || lower.contains("validation") {
                    "format_error"
                } else if lower.contains("tool call") || lower.contains("function_call") || lower.contains("call_id") {
                    "orphaned_tool_result"
                } else {
                    "unknown_400"
                }
            } else {
                "server_error"
            };

            log::error!(
                "[llm] Responses API error {} [{}]: {}",
                status, error_class, detail
            );

            crate::util::trace::emit("llm_error", "llm", serde_json::json!({
                "status": status.as_u16(),
                "error_class": error_class,
                "api": "responses",
                "model": self.config.model,
                "detail": crate::util::trace::truncate(detail, 500),
            }));

            return Err(format!(
                "Responses API error ({status}) [{error_class}]: {detail}"
            ));
        }

        let api_resp: ResponsesApiResponse = resp
            .json()
            .await
            .map_err(|e| format!("Failed to parse Responses API response: {e}"))?;

        Ok(Self::responses_output_to_chat_response(&api_resp.output))
    }

    /// Send a streaming chat completion request.
    /// Returns an async stream of SSE chunks.
    /// Automatically uses the Responses API for codex/pro models.
    pub async fn chat_stream(
        &self,
        messages: &[ChatMessage],
        tools: Option<&[ToolDefinition]>,
    ) -> Result<impl futures_util::Stream<Item = Result<Vec<StreamChunk>, String>>, String> {
        self.last_compaction_dropped.store(0, std::sync::atomic::Ordering::Relaxed);
        let use_responses = self.needs_responses_api();
        let tool_defs = tools.map(|t| t.to_vec());

        let mut final_messages = messages.to_vec();

        // Sanitize all messages before serialization to prevent server-side
        // JSON parse errors from control characters in tool results, user input,
        // or model-generated content.
        for msg in &mut final_messages {
            msg.sanitize();
        }

        // Build the appropriate request body and URL
        let serialize_body = |msgs: &[ChatMessage]| -> String {
            if use_responses {
                serde_json::to_string(&ResponsesApiRequest {
                    model: String::new(), // placeholder — replaced below
                    input: Self::messages_to_responses_input(msgs),
                    tools: Self::tools_to_responses_format(tools),
                    stream: Some(true),
                })
                .unwrap_or_default()
            } else {
                let model_field = match &self.config.provider {
                    LlmProvider::Openai => Some(self.config.model.clone()),
                    LlmProvider::AzureOpenai => {
                        if self.is_foundry() {
                            Some(self.config.model.clone())
                        } else {
                            None
                        }
                    }
                };
                serde_json::to_string(&ChatCompletionRequest {
                    model: model_field,
                    messages: msgs.to_vec(),
                    tools: tool_defs.clone(),
                    stream: Some(true),
                })
                .unwrap_or_default()
            }
        };

        let mut body_json = serialize_body(&final_messages);

        let api_label = if use_responses { "responses" } else { "chat" };
        let msg_count = final_messages.len();
        let tool_count = tools.map_or(0, |t| t.len());
        let body_kb = body_json.len() / 1024;
        log::info!(
            "[llm] chat_stream ({}) → {} ({} messages, {} tools, {}KB body)",
            api_label, self.config.model, msg_count, tool_count, body_kb
        );
        crate::util::trace::emit("llm_request", "llm", serde_json::json!({
            "api": api_label,
            "model": self.config.model,
            "messages": msg_count,
            "tools": tool_count,
            "body_kb": body_kb,
        }));

        // The Responses API endpoint (or its Azure gateway) consistently rejects
        // bodies around ~79KB with JSON parse errors at byte ~79257, regardless of
        // content. This appears to be a hard server-side size limit. Compact well
        // below that threshold.
        const MAX_BODY_BYTES_RESPONSES: usize = 64 * 1024; // 64KB — safely below the ~79KB wall
        const MAX_BODY_BYTES_CHAT: usize = 3 * 1024 * 1024; // 3MB for Chat Completions
        let max_body = if use_responses { MAX_BODY_BYTES_RESPONSES } else { MAX_BODY_BYTES_CHAT };
        if body_json.len() > max_body {
            log::warn!(
                "[llm] body {}KB exceeds {}KB — compacting with memory summary",
                body_json.len() / 1024,
                max_body / 1024
            );
            use crate::engine::agent::runner::summarize_dropped;

            // Split: system prefix + conversation
            let sys_end = final_messages
                .iter()
                .position(|m| m.role != "system")
                .unwrap_or(final_messages.len());
            let system_msgs: Vec<ChatMessage> = final_messages.drain(..sys_end).collect();

            // Drop oldest conversation messages until under budget.
            // IMPORTANT: tool_call / tool_result pairs must be dropped together —
            // the Responses API rejects orphaned tool results whose call_id has no
            // matching tool_call in the conversation.
            let mut dropped: Vec<ChatMessage> = Vec::new();
            loop {
                let trial_msgs =
                    [system_msgs.clone(), final_messages.clone()].concat();
                let size = serialize_body(&trial_msgs).len();
                if size <= max_body || final_messages.len() <= 2 {
                    break;
                }
                let removed = final_messages.remove(0);

                // If we just dropped an assistant message with tool_calls,
                // also drop all immediately following tool-result messages
                // that reference those call IDs.
                if removed.role == "assistant" {
                    if let Some(ref calls) = removed.tool_calls {
                        let call_ids: std::collections::HashSet<&str> =
                            calls.iter().map(|c| c.id.as_str()).collect();
                        while !final_messages.is_empty()
                            && final_messages[0].role == "tool"
                            && final_messages[0]
                                .tool_call_id
                                .as_deref()
                                .map(|id| call_ids.contains(id))
                                .unwrap_or(false)
                        {
                            dropped.push(final_messages.remove(0));
                        }
                    }
                }

                dropped.push(removed);
            }

            // Safety sweep: remove any leading orphaned tool results
            while !final_messages.is_empty() && final_messages[0].role == "tool" {
                dropped.push(final_messages.remove(0));
            }

            // Summarize what was dropped and inject as a memory message
            let summary = summarize_dropped(&dropped);
            let mut reassembled = system_msgs;
            if !summary.is_empty() {
                reassembled.push(ChatMessage::user(&summary));
            }
            reassembled.extend(final_messages);
            final_messages = reassembled;

            body_json = serialize_body(&final_messages);

            log::info!(
                "[llm] compacted: dropped {} msgs → summary, now {} messages ({}KB)",
                dropped.len(),
                final_messages.len(),
                body_json.len() / 1024
            );
            self.last_compaction_dropped.store(dropped.len(), std::sync::atomic::Ordering::Relaxed);
        }

        // For Responses API, ensure the model field is set correctly
        // (serialize_body used a placeholder for efficiency in the size check)
        if use_responses {
            body_json = serde_json::to_string(&ResponsesApiRequest {
                model: self.config.model.clone(),
                input: Self::messages_to_responses_input(&final_messages),
                tools: Self::tools_to_responses_format(tools),
                stream: Some(true),
            })
            .map_err(|e| format!("Failed to serialize Responses API request: {e}"))?;
        }

        let url = if use_responses {
            self.responses_url()
        } else {
            self.chat_url()
        };

        // Validate body is well-formed JSON before sending.
        // serde_json::to_string should always produce valid JSON, but corrupt data
        // in message content (e.g. from tool results) can occasionally cause issues.
        if let Err(e) = serde_json::from_str::<serde_json::Value>(&body_json) {
            let offset = match e.classify() {
                serde_json::error::Category::Syntax | serde_json::error::Category::Eof => {
                    let col = e.column();
                    col.saturating_sub(1)
                }
                _ => 0,
            };
            let context_start = offset.saturating_sub(100);
            let context_end = (offset + 100).min(body_json.len());
            // Find safe char boundaries
            let safe_start = (context_start..=offset).rev()
                .find(|&i| body_json.is_char_boundary(i))
                .unwrap_or(0);
            let safe_end = (context_end..=body_json.len())
                .find(|&i| body_json.is_char_boundary(i))
                .unwrap_or(body_json.len());
            log::error!(
                "[llm] body JSON invalid at byte {}: {} — context: …{}…",
                offset,
                e,
                &body_json[safe_start..safe_end]
            );
            return Err(format!("Request body JSON invalid at byte {offset}: {e}"));
        }

        // No per-request timeout for streaming — the client-level connect_timeout
        // handles unreachable endpoints, and the stream can legitimately run for
        // many minutes as chunks arrive progressively.
        // Escape non-ASCII to prevent Azure gateway JSON parse failures on
        // multi-byte UTF-8 chars (em dashes, smart quotes, etc.).
        let escaped_json = escape_non_ascii_json(&body_json);

        // Validate AFTER escaping — if escape_non_ascii_json corrupted the JSON,
        // fall back to the pre-escape version (which passed validation above).
        let body_json = if let Err(e) = serde_json::from_str::<serde_json::Value>(&escaped_json) {
            let col = e.column().saturating_sub(1);
            let start = col.saturating_sub(60);
            let end = (col + 60).min(escaped_json.len());
            let safe_start = (start..=col).rev()
                .find(|&i| escaped_json.is_char_boundary(i)).unwrap_or(0);
            let safe_end = (end..=escaped_json.len())
                .find(|&i| escaped_json.is_char_boundary(i)).unwrap_or(escaped_json.len());
            log::error!(
                "[llm] escape_non_ascii_json corrupted JSON at byte {}: {} — context: …{}…  — falling back to raw UTF-8",
                col, e, &escaped_json[safe_start..safe_end]
            );
            body_json // fall back to the valid pre-escape body
        } else {
            escaped_json
        };

        // Keep body_json alive for diagnostics on 400 errors.
        let body_bytes = body_json.as_bytes().to_vec();
        let resp = self
            .http
            .post(&url)
            .headers(self.auth_headers())
            .header(reqwest::header::CONTENT_TYPE, "application/json")
            .body(body_bytes)
            .send()
            .await
            .map_err(|e| format!("Stream request failed: {e}"))?;

        if !resp.status().is_success() {
            let status = resp.status();
            let text = resp.text().await.unwrap_or_default();
            let mut end = 2000.min(text.len());
            while end < text.len() && !text.is_char_boundary(end) {
                end -= 1;
            }
            let detail = &text[..end];

            // Classify the error for better diagnostics
            let error_class = if status == 400 {
                let lower = detail.to_lowercase();
                if lower.contains("context_length_exceeded") || lower.contains("maximum context length") {
                    "token_limit"
                } else if lower.contains("invalid_payload") || lower.contains("validation") {
                    "format_error"
                } else if lower.contains("tool call") || lower.contains("function_call") || lower.contains("call_id") {
                    "orphaned_tool_result"
                } else if lower.contains("body too large") || lower.contains("content length") {
                    "body_size"
                } else {
                    "unknown_400"
                }
            } else if status == 429 {
                "rate_limit"
            } else {
                "server_error"
            };

            log::error!(
                "[llm] API error {} [{}] ({}KB body, {} api): {}",
                status, error_class, body_json.len() / 1024, api_label, detail
            );

            crate::util::trace::emit("llm_error", "llm", serde_json::json!({
                "status": status.as_u16(),
                "error_class": error_class,
                "model": self.config.model,
                "api": api_label,
                "body_kb": body_json.len() / 1024,
                "detail": crate::util::trace::truncate(detail, 500),
            }));

            // On 400 errors, try to extract the byte offset from the error and
            // log the surrounding body context for debugging.
            if status == 400 {
                Self::log_body_context_at_error(&body_json, detail);
            }

            return Err(format!("Chat stream error ({status}) [{error_class}]: {detail}"));
        }

        // Shared state for Responses API streaming (function call index tracking)
        let fc_state = std::sync::Arc::new(std::sync::Mutex::new(
            ResponsesStreamState::default(),
        ));

        let stream = resp.bytes_stream().map(move |chunk_result| {
            let bytes =
                chunk_result.map_err(|e| format!("Stream read error: {e}"))?;
            let text = String::from_utf8_lossy(&bytes);

            // SSE format: "data: {...}\n\n" — collect ALL chunks from this batch
            let mut chunks = Vec::new();
            for line in text.lines() {
                let line = line.trim();
                if let Some(data) = line.strip_prefix("data: ") {
                    if data == "[DONE]" {
                        continue;
                    }

                    if use_responses {
                        // Responses API: parse as generic JSON, dispatch by type
                        if let Ok(val) =
                            serde_json::from_str::<serde_json::Value>(data)
                        {
                            let mut state = fc_state.lock().unwrap();
                            chunks.extend(
                                Self::parse_responses_sse_event(&val, &mut state),
                            );
                        }
                    } else {
                        // Chat Completions: parse as StreamChunk directly
                        if let Ok(chunk) =
                            serde_json::from_str::<StreamChunk>(data)
                        {
                            chunks.push(chunk);
                        }
                    }
                }
            }

            Ok(chunks)
        });

        Ok(stream)
    }
}

/// Decode the `aud` claim from a JWT without verifying the signature.
fn decode_jwt_audience(token: &str) -> Option<String> {
    use base64::Engine;
    let parts: Vec<&str> = token.split('.').collect();
    let payload = parts.get(1)?;
    // JWT uses base64url without padding
    let bytes = base64::engine::general_purpose::URL_SAFE_NO_PAD
        .decode(payload)
        .ok()?;
    let val: serde_json::Value = serde_json::from_slice(&bytes).ok()?;
    val.get("aud")
        .and_then(|a| a.as_str())
        .map(|s| s.to_string())
}

/// Escape all non-ASCII characters in a JSON string to `\uXXXX` sequences.
///
/// Some API endpoints (Azure OpenAI gateway) misparse multi-byte UTF-8 in
/// JSON bodies, reporting "Expecting ',' delimiter" at em-dash positions etc.
/// By escaping non-ASCII to `\uXXXX` (and `\uXXXX\uXXXX` surrogate pairs
/// for characters above U+FFFF), the body becomes pure ASCII and eliminates
/// any encoding ambiguity.
///
/// Only characters inside JSON string values are escaped — structural JSON
/// syntax (`{}[]:,"`) and whitespace are never non-ASCII so they pass through.
fn escape_non_ascii_json(json: &str) -> String {
    let mut out = String::with_capacity(json.len());
    let mut in_string = false;
    let mut escape_next = false;

    for ch in json.chars() {
        if escape_next {
            out.push(ch);
            escape_next = false;
            continue;
        }

        if in_string {
            if ch == '\\' {
                out.push(ch);
                escape_next = true;
            } else if ch == '"' {
                out.push(ch);
                in_string = false;
            } else if !ch.is_ascii() {
                // Escape non-ASCII as \uXXXX (or surrogate pair)
                let code = ch as u32;
                if code <= 0xFFFF {
                    write!(out, "\\u{:04x}", code).unwrap();
                } else {
                    // Surrogate pair for characters above BMP
                    let high = ((code - 0x10000) >> 10) + 0xD800;
                    let low = ((code - 0x10000) & 0x3FF) + 0xDC00;
                    write!(out, "\\u{:04x}\\u{:04x}", high, low).unwrap();
                }
            } else {
                out.push(ch);
            }
        } else {
            out.push(ch);
            if ch == '"' {
                in_string = true;
            }
        }
    }
    out
}

#[cfg(test)]
mod tests {
    use super::*;

    fn make_client(model: &str) -> LlmClient {
        LlmClient::new(LlmConfig {
            provider: LlmProvider::Openai,
            endpoint: "https://api.openai.com".into(),
            api_key: "test".into(),
            model: model.into(),
            bearer_token: None,
        })
    }

    #[test]
    fn context_budget_varies_by_model() {
        let gpt4o = make_client("gpt-4o");
        let gpt35 = make_client("gpt-35-turbo");
        let claude = make_client("claude-3.5-sonnet");
        let unknown = make_client("my-custom-model");

        // GPT-4o should have a much larger budget than GPT-3.5
        assert!(gpt4o.context_char_budget() > gpt35.context_char_budget() * 2);
        // Claude should have the largest budget
        assert!(claude.context_char_budget() > gpt4o.context_char_budget());
        // Unknown defaults to a conservative budget
        assert!(unknown.context_char_budget() < gpt4o.context_char_budget());
        assert!(unknown.context_char_budget() > 0);
    }

    #[test]
    fn context_budget_gpt4o_reasonable() {
        let client = make_client("gpt-4o");
        let budget = client.context_char_budget();
        // 128k tokens * 0.75 * 4 chars = 384,000 chars
        assert_eq!(budget, 384_000);
    }

    #[test]
    fn context_budget_small_model() {
        let client = make_client("gpt-35-turbo");
        let budget = client.context_char_budget();
        // 4096 tokens * 0.75 * 4 chars = 12,288 chars
        assert_eq!(budget, 12_288);
    }

    #[test]
    fn context_budget_o1_starts_with_not_contains() {
        // "o1-preview" should match as OpenAI reasoning model
        let o1 = make_client("o1-preview");
        assert_eq!(o1.context_char_budget(), 384_000);

        // But "my-foo-o1-bar" should NOT match — falls to unknown default
        let not_o1 = make_client("my-foo-o1-bar");
        assert_eq!(not_o1.context_char_budget(), 96_000); // 32k default
    }

    #[test]
    fn context_budget_deepseek_and_phi() {
        let ds = make_client("deepseek-r1");
        assert_eq!(ds.context_char_budget(), 192_000); // 64k * 0.75 * 4

        let phi = make_client("phi-4");
        assert_eq!(phi.context_char_budget(), 48_000); // 16k * 0.75 * 4
    }

    #[test]
    fn reported_context_overrides_heuristic() {
        let client = make_client("my-custom-deployment");
        // Heuristic gives 32k default → 96,000 chars
        assert_eq!(client.context_char_budget(), 96_000);

        // API reports 200k context window
        client.set_reported_context_length(200_000);
        // 200k * 0.75 * 4 = 600,000 chars
        assert_eq!(client.context_char_budget(), 600_000);
    }

    #[test]
    fn message_content_text_serializes_as_string() {
        let msg = ChatMessage::user("hello world");
        let json = serde_json::to_string(&msg).unwrap();
        assert!(json.contains(r#""content":"hello world""#));
        // Round-trip
        let deserialized: ChatMessage = serde_json::from_str(&json).unwrap();
        assert_eq!(deserialized.text(), Some("hello world"));
    }

    #[test]
    fn message_content_parts_serializes_as_array() {
        let msg = ChatMessage::user_with_images("describe this", vec![
            ContentPart::ImageUrl {
                image_url: ImageUrlData {
                    url: "data:image/png;base64,abc123".into(),
                    detail: Some("low".into()),
                },
            },
        ]);
        let json = serde_json::to_string(&msg).unwrap();
        assert!(json.contains(r#""type":"text""#));
        assert!(json.contains(r#""type":"image_url""#));
        assert!(json.contains("abc123"));
        // Round-trip
        let deserialized: ChatMessage = serde_json::from_str(&json).unwrap();
        assert_eq!(deserialized.text(), Some("describe this"));
        if let Some(MessageContent::Parts(parts)) = &deserialized.content {
            assert_eq!(parts.len(), 2); // text + image
        } else {
            panic!("expected Parts");
        }
    }

    #[test]
    fn message_content_char_len() {
        let text = MessageContent::Text("hello".into());
        assert_eq!(text.char_len(), 5);

        let parts = MessageContent::Parts(vec![
            ContentPart::Text { text: "hello".into() },
            ContentPart::ImageUrl {
                image_url: ImageUrlData { url: "data:...".into(), detail: None },
            },
        ]);
        assert_eq!(parts.char_len(), 205); // 5 + 200 (image overhead)
    }

    #[test]
    fn vision_detection() {
        assert!(make_client("gpt-4o").supports_vision());
        assert!(make_client("gpt-4o-mini").supports_vision());
        assert!(make_client("gpt-4.1").supports_vision());
        assert!(make_client("gpt-5.2").supports_vision());
        assert!(make_client("claude-3-5-sonnet").supports_vision());
        assert!(make_client("claude-4-opus").supports_vision());
        assert!(make_client("gemini-1.5-pro").supports_vision());
        assert!(make_client("o1-preview").supports_vision());
        assert!(make_client("o3-mini").supports_vision());
        // Non-vision models
        assert!(!make_client("gpt-3.5-turbo").supports_vision());
        assert!(!make_client("gpt-4").supports_vision()); // base GPT-4 (no turbo/vision)
        assert!(!make_client("deepseek-r1").supports_vision());
        assert!(!make_client("phi-4").supports_vision());
        assert!(!make_client("my-custom-model").supports_vision());
    }

    // -----------------------------------------------------------------------
    // Responses API detection
    // -----------------------------------------------------------------------

    #[test]
    fn needs_responses_api_codex_models() {
        assert!(make_client("gpt-5.1-codex").needs_responses_api());
        assert!(make_client("gpt-5.1-codex-mini").needs_responses_api());
        assert!(make_client("gpt-5.1-codex-max").needs_responses_api());
        assert!(make_client("gpt-5.2-codex").needs_responses_api());
        assert!(make_client("gpt-5.3-codex").needs_responses_api());
        assert!(make_client("gpt-5-codex").needs_responses_api());
        assert!(make_client("codex-mini").needs_responses_api());
    }

    #[test]
    fn needs_responses_api_pro_models() {
        assert!(make_client("gpt-5.4-pro").needs_responses_api());
        assert!(make_client("gpt-5-pro").needs_responses_api());
    }

    #[test]
    fn needs_responses_api_chat_completions_models() {
        assert!(!make_client("gpt-5.4").needs_responses_api());
        assert!(!make_client("gpt-5.2").needs_responses_api());
        assert!(!make_client("gpt-5.1").needs_responses_api());
        assert!(!make_client("gpt-5").needs_responses_api());
        assert!(!make_client("gpt-5-mini").needs_responses_api());
        assert!(!make_client("gpt-4.1").needs_responses_api());
        assert!(!make_client("gpt-4o").needs_responses_api());
        assert!(!make_client("claude-3.5-sonnet").needs_responses_api());
        assert!(!make_client("o3-mini").needs_responses_api());
    }

    // -----------------------------------------------------------------------
    // Responses API URL building
    // -----------------------------------------------------------------------

    #[test]
    fn responses_url_openai() {
        let client = make_client("gpt-5.1-codex");
        assert_eq!(
            client.responses_url(),
            "https://api.openai.com/v1/responses"
        );
    }

    #[test]
    fn responses_url_azure() {
        let client = LlmClient::new(LlmConfig {
            provider: LlmProvider::AzureOpenai,
            endpoint: "https://my-resource.openai.azure.com".into(),
            api_key: "test".into(),
            model: "gpt-5.1-codex".into(),
            bearer_token: None,
        });
        assert_eq!(
            client.responses_url(),
            "https://my-resource.openai.azure.com/openai/v1/responses"
        );
    }

    #[test]
    fn responses_url_foundry() {
        let client = LlmClient::new(LlmConfig {
            provider: LlmProvider::AzureOpenai,
            endpoint: "https://my-foundry.services.ai.azure.com/api/projects/proj1"
                .into(),
            api_key: "test".into(),
            model: "gpt-5.1-codex".into(),
            bearer_token: None,
        });
        assert_eq!(
            client.responses_url(),
            "https://my-foundry.services.ai.azure.com/openai/v1/responses"
        );
    }

    // -----------------------------------------------------------------------
    // Message translation
    // -----------------------------------------------------------------------

    #[test]
    fn messages_to_responses_input_system_becomes_developer() {
        let msgs = vec![ChatMessage::system("You are helpful")];
        let input = LlmClient::messages_to_responses_input(&msgs);
        assert_eq!(input.len(), 1);
        assert_eq!(input[0]["role"], "developer");
        assert_eq!(input[0]["content"], "You are helpful");
    }

    #[test]
    fn messages_to_responses_input_user_passthrough() {
        let msgs = vec![ChatMessage::user("Hello")];
        let input = LlmClient::messages_to_responses_input(&msgs);
        assert_eq!(input.len(), 1);
        assert_eq!(input[0]["role"], "user");
        assert_eq!(input[0]["content"], "Hello");
    }

    #[test]
    fn messages_to_responses_input_tool_results() {
        let msgs = vec![ChatMessage::tool_result("call_123", "result text")];
        let input = LlmClient::messages_to_responses_input(&msgs);
        assert_eq!(input.len(), 1);
        assert_eq!(input[0]["type"], "function_call_output");
        assert_eq!(input[0]["call_id"], "call_123");
        assert_eq!(input[0]["output"], "result text");
    }

    #[test]
    fn messages_to_responses_input_assistant_with_tool_calls() {
        let msgs = vec![ChatMessage {
            role: "assistant".into(),
            content: None,
            tool_calls: Some(vec![ToolCall {
                id: "call_abc".into(),
                call_type: "function".into(),
                function: FunctionCall {
                    name: "get_weather".into(),
                    arguments: r#"{"city":"SF"}"#.into(),
                },
            }]),
            tool_call_id: None,
        }];
        let input = LlmClient::messages_to_responses_input(&msgs);
        assert_eq!(input.len(), 1);
        assert_eq!(input[0]["type"], "function_call");
        assert_eq!(input[0]["call_id"], "call_abc");
        assert_eq!(input[0]["name"], "get_weather");
    }

    // -----------------------------------------------------------------------
    // Tool definition translation
    // -----------------------------------------------------------------------

    #[test]
    fn tools_to_responses_format_flattens() {
        let tools = vec![ToolDefinition {
            tool_type: "function".into(),
            function: FunctionDefinition {
                name: "search".into(),
                description: "Search things".into(),
                parameters: serde_json::json!({"type": "object"}),
            },
        }];
        let result = LlmClient::tools_to_responses_format(Some(&tools)).unwrap();
        assert_eq!(result.len(), 1);
        assert_eq!(result[0].name, "search");
        assert_eq!(result[0].description, "Search things");
        // Verify serialized format has no "function" wrapper
        let json = serde_json::to_value(&result[0]).unwrap();
        assert_eq!(json["name"], "search");
        assert!(json.get("function").is_none());
    }

    // -----------------------------------------------------------------------
    // Response output translation
    // -----------------------------------------------------------------------

    #[test]
    fn responses_output_to_chat_text_only() {
        let output = vec![serde_json::json!({
            "type": "message",
            "role": "assistant",
            "content": [{"type": "output_text", "text": "Hello world"}]
        })];
        let resp = LlmClient::responses_output_to_chat_response(&output);
        assert_eq!(resp.choices.len(), 1);
        assert_eq!(
            resp.choices[0].message.text(),
            Some("Hello world")
        );
        assert!(resp.choices[0].message.tool_calls.is_none());
    }

    #[test]
    fn responses_output_to_chat_function_call() {
        let output = vec![serde_json::json!({
            "type": "function_call",
            "call_id": "call_xyz",
            "name": "set_row_visual",
            "arguments": r#"{"doc":{}}"#
        })];
        let resp = LlmClient::responses_output_to_chat_response(&output);
        let tc = resp.choices[0].message.tool_calls.as_ref().unwrap();
        assert_eq!(tc.len(), 1);
        assert_eq!(tc[0].id, "call_xyz");
        assert_eq!(tc[0].function.name, "set_row_visual");
    }

    #[test]
    fn responses_output_to_chat_mixed() {
        let output = vec![
            serde_json::json!({
                "type": "message",
                "role": "assistant",
                "content": [{"type": "output_text", "text": "Let me search."}]
            }),
            serde_json::json!({
                "type": "function_call",
                "call_id": "call_1",
                "name": "search",
                "arguments": "{}"
            }),
        ];
        let resp = LlmClient::responses_output_to_chat_response(&output);
        assert_eq!(
            resp.choices[0].message.text(),
            Some("Let me search.")
        );
        let tc = resp.choices[0].message.tool_calls.as_ref().unwrap();
        assert_eq!(tc[0].function.name, "search");
    }

    // -----------------------------------------------------------------------
    // Streaming event parsing
    // -----------------------------------------------------------------------

    #[test]
    fn parse_responses_sse_text_delta() {
        let val = serde_json::json!({
            "type": "response.output_text.delta",
            "output_index": 0,
            "content_index": 0,
            "delta": "Hello "
        });
        let mut state = ResponsesStreamState::default();
        let chunks = LlmClient::parse_responses_sse_event(&val, &mut state);
        assert_eq!(chunks.len(), 1);
        assert_eq!(
            chunks[0].choices[0].delta.content.as_deref(),
            Some("Hello ")
        );
    }

    #[test]
    fn parse_responses_sse_function_call_flow() {
        let mut state = ResponsesStreamState::default();

        // 1. Function call added
        let added = serde_json::json!({
            "type": "response.output_item.added",
            "output_index": 1,
            "item": {
                "type": "function_call",
                "call_id": "call_abc",
                "name": "get_weather",
                "arguments": ""
            }
        });
        let chunks = LlmClient::parse_responses_sse_event(&added, &mut state);
        assert_eq!(chunks.len(), 1);
        let tc = &chunks[0].choices[0].delta.tool_calls.as_ref().unwrap()[0];
        assert_eq!(tc.index, 0); // First tool call gets index 0
        assert_eq!(tc.id.as_deref(), Some("call_abc"));
        assert_eq!(
            tc.function.as_ref().unwrap().name.as_deref(),
            Some("get_weather")
        );

        // 2. Arguments delta
        let delta = serde_json::json!({
            "type": "response.function_call_arguments.delta",
            "output_index": 1,
            "delta": r#"{"city":"#
        });
        let chunks = LlmClient::parse_responses_sse_event(&delta, &mut state);
        assert_eq!(chunks.len(), 1);
        let tc = &chunks[0].choices[0].delta.tool_calls.as_ref().unwrap()[0];
        assert_eq!(tc.index, 0); // Same tool call
        assert_eq!(
            tc.function.as_ref().unwrap().arguments.as_deref(),
            Some(r#"{"city":"#)
        );
    }

    #[test]
    fn parse_responses_sse_completed() {
        let val = serde_json::json!({"type": "response.completed"});
        let mut state = ResponsesStreamState::default();
        let chunks = LlmClient::parse_responses_sse_event(&val, &mut state);
        assert_eq!(chunks.len(), 1);
        assert_eq!(
            chunks[0].choices[0].finish_reason.as_deref(),
            Some("stop")
        );
    }

    #[test]
    fn parse_responses_sse_unknown_event_ignored() {
        let val = serde_json::json!({
            "type": "response.some_future_event",
            "data": "whatever"
        });
        let mut state = ResponsesStreamState::default();
        let chunks = LlmClient::parse_responses_sse_event(&val, &mut state);
        assert!(chunks.is_empty());
    }

    #[test]
    fn parse_responses_sse_multiple_function_calls() {
        let mut state = ResponsesStreamState::default();

        // First function call at output_index 1
        let added1 = serde_json::json!({
            "type": "response.output_item.added",
            "output_index": 1,
            "item": {"type": "function_call", "call_id": "call_1", "name": "func_a", "arguments": ""}
        });
        LlmClient::parse_responses_sse_event(&added1, &mut state);

        // Second function call at output_index 2
        let added2 = serde_json::json!({
            "type": "response.output_item.added",
            "output_index": 2,
            "item": {"type": "function_call", "call_id": "call_2", "name": "func_b", "arguments": ""}
        });
        let chunks = LlmClient::parse_responses_sse_event(&added2, &mut state);
        let tc = &chunks[0].choices[0].delta.tool_calls.as_ref().unwrap()[0];
        assert_eq!(tc.index, 1); // Second tool call gets index 1

        // Arguments for second call
        let delta = serde_json::json!({
            "type": "response.function_call_arguments.delta",
            "output_index": 2,
            "delta": "{}"
        });
        let chunks = LlmClient::parse_responses_sse_event(&delta, &mut state);
        let tc = &chunks[0].choices[0].delta.tool_calls.as_ref().unwrap()[0];
        assert_eq!(tc.index, 1); // Correctly mapped to tool call index 1
    }

    // -----------------------------------------------------------------------
    // Body context extraction for 400 diagnostics
    // -----------------------------------------------------------------------

    #[test]
    fn log_body_context_extracts_pydantic_offset() {
        // This just verifies it doesn't panic. The actual logging goes to log::error!
        // which won't show in tests, but the function should handle the format correctly.
        let body = "a".repeat(100_000);
        let error = "{'type': 'json_invalid', 'loc': ('body', 81960), 'msg': 'JSON decode error'}";
        // Should not panic
        LlmClient::log_body_context_at_error(&body, error);
    }

    #[test]
    fn log_body_context_handles_no_offset() {
        let body = "some body";
        let error = "Unknown error";
        // Should not panic — no offset found, nothing logged
        LlmClient::log_body_context_at_error(&body, error);
    }

    #[test]
    fn assistant_message_content_null_serializes() {
        // Verify that content: None serializes as `null`, not omitted
        let msg = ChatMessage {
            role: "assistant".into(),
            content: None,
            tool_calls: Some(vec![ToolCall {
                id: "call_1".into(),
                call_type: "function".into(),
                function: FunctionCall {
                    name: "test".into(),
                    arguments: "{}".into(),
                },
            }]),
            tool_call_id: None,
        };
        let json = serde_json::to_string(&msg).unwrap();
        assert!(json.contains("\"content\":null"), "content should be null, not omitted: {json}");
    }

    #[test]
    fn escape_non_ascii_leaves_ascii_untouched() {
        let input = r#"{"key":"hello world","n":42}"#;
        assert_eq!(escape_non_ascii_json(input), input);
    }

    #[test]
    fn escape_non_ascii_escapes_em_dash() {
        let input = r#"{"text":"keyword matching — be specific"}"#;
        let result = escape_non_ascii_json(input);
        assert!(!result.contains('—'), "em dash should be escaped");
        assert!(result.contains(r"\u2014"), "should contain \\u2014");
        // Should be valid JSON that roundtrips
        let parsed: serde_json::Value = serde_json::from_str(&result).unwrap();
        assert_eq!(parsed["text"].as_str().unwrap(), "keyword matching — be specific");
    }

    #[test]
    fn escape_non_ascii_handles_escaped_quotes() {
        let input = r#"{"text":"say \"hello\" — world"}"#;
        let result = escape_non_ascii_json(input);
        assert!(result.contains(r"\u2014"));
        let parsed: serde_json::Value = serde_json::from_str(&result).unwrap();
        assert_eq!(parsed["text"].as_str().unwrap(), "say \"hello\" — world");
    }

    #[test]
    fn escape_non_ascii_handles_emoji() {
        // 🎬 = U+1F3AC (above BMP, needs surrogate pair)
        let input = r#"{"text":"action 🎬 cut"}"#;
        let result = escape_non_ascii_json(input);
        assert!(result.is_ascii(), "all chars should be ASCII after escape");
        let parsed: serde_json::Value = serde_json::from_str(&result).unwrap();
        assert_eq!(parsed["text"].as_str().unwrap(), "action 🎬 cut");
    }

    #[test]
    fn escape_non_ascii_preserves_structure() {
        let input = r#"{"msgs":[{"role":"user","content":"café — résumé"}]}"#;
        let result = escape_non_ascii_json(input);
        assert!(result.is_ascii());
        let parsed: serde_json::Value = serde_json::from_str(&result).unwrap();
        assert_eq!(
            parsed["msgs"][0]["content"].as_str().unwrap(),
            "café — résumé"
        );
    }
}
