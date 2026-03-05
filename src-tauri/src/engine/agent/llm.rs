//! LLM client for Azure OpenAI and OpenAI-compatible APIs.
//!
//! Supports chat completions with function calling, streaming via SSE,
//! and an agentic tool loop that executes tool calls and feeds results back.

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
// Chat message types (OpenAI-compatible)
// ---------------------------------------------------------------------------

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ChatMessage {
    pub role: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub content: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub tool_calls: Option<Vec<ToolCall>>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub tool_call_id: Option<String>,
}

impl ChatMessage {
    pub fn system(content: &str) -> Self {
        Self {
            role: "system".into(),
            content: Some(content.into()),
            tool_calls: None,
            tool_call_id: None,
        }
    }
    pub fn user(content: &str) -> Self {
        Self {
            role: "user".into(),
            content: Some(content.into()),
            tool_calls: None,
            tool_call_id: None,
        }
    }
    pub fn tool_result(tool_call_id: &str, content: &str) -> Self {
        Self {
            role: "tool".into(),
            content: Some(content.into()),
            tool_calls: None,
            tool_call_id: Some(tool_call_id.into()),
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
}

impl LlmClient {
    pub fn new(config: LlmConfig) -> Self {
        // Disable connection pooling — Azure gateways can return cryptic
        // errors when reusing connections after SSE streams.
        let http = reqwest::Client::builder()
            .pool_max_idle_per_host(0)
            .build()
            .unwrap_or_else(|_| reqwest::Client::new());
        Self {
            config,
            http,
            reported_context_length: std::sync::Mutex::new(None),
        }
    }

    /// Record the API-reported context window for the selected model.
    pub fn set_reported_context_length(&self, tokens: usize) {
        *self.reported_context_length.lock().unwrap() = Some(tokens);
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
                            // catalog: only chat-capable models
                            m.capabilities
                                .as_ref()
                                .and_then(|c| c.get("chat_completion"))
                                .map(|v| v == "true")
                                .unwrap_or(true)
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
            messages: messages.to_vec(),
            tools: tools.map(|t| t.to_vec()),
            stream: None,
        };

        let url = self.chat_url();
        let resp = self
            .http
            .post(&url)
            .headers(self.auth_headers())
            .json(&body)
            .send()
            .await
            .map_err(|e| format!("Chat request failed: {e}"))?;

        if !resp.status().is_success() {
            let status = resp.status();
            let text = resp.text().await.unwrap_or_default();
            return Err(format!("Chat API error ({status}) [url={url}]: {text}"));
        }

        resp.json()
            .await
            .map_err(|e| format!("Failed to parse chat response: {e}"))
    }

    /// Send a streaming chat completion request.
    /// Returns an async stream of SSE chunks.
    pub async fn chat_stream(
        &self,
        messages: &[ChatMessage],
        tools: Option<&[ToolDefinition]>,
    ) -> Result<impl futures_util::Stream<Item = Result<Vec<StreamChunk>, String>>, String> {
        let model_field = match self.config.provider {
            LlmProvider::Openai => Some(self.config.model.clone()),
            LlmProvider::AzureOpenai => {
                if self.is_foundry() {
                    Some(self.config.model.clone())
                } else {
                    None
                }
            }
        };
        let tool_defs = tools.map(|t| t.to_vec());

        let mut final_messages = messages.to_vec();

        // Serialize to measure body size
        let mut body_json = serde_json::to_string(&ChatCompletionRequest {
            model: model_field.clone(),
            messages: final_messages.clone(),
            tools: tool_defs.clone(),
            stream: Some(true),
        }).map_err(|e| format!("Failed to serialize request: {e}"))?;

        log::info!("[llm] chat_stream → {} ({} messages, {} tools, {}KB body)",
            self.config.model, final_messages.len(),
            tools.map_or(0, |t| t.len()), body_json.len() / 1024);

        // Azure gateway rejects bodies over ~4MB with cryptic IIS errors.
        // When trimming, summarize dropped messages into working memory so the
        // LLM retains context about what was discussed earlier.
        const MAX_BODY_BYTES: usize = 3 * 1024 * 1024; // 3MB safety margin
        if body_json.len() > MAX_BODY_BYTES {
            log::warn!("[llm] body {}KB exceeds {}KB — compacting with memory summary", body_json.len() / 1024, MAX_BODY_BYTES / 1024);
            use crate::engine::agent::runner::summarize_dropped;

            // Split: system prefix + conversation
            let sys_end = final_messages.iter().position(|m| m.role != "system").unwrap_or(final_messages.len());
            let system_msgs: Vec<ChatMessage> = final_messages.drain(..sys_end).collect();

            // Drop oldest conversation messages until under budget
            let mut dropped: Vec<ChatMessage> = Vec::new();
            loop {
                let trial = ChatCompletionRequest {
                    model: model_field.clone(),
                    messages: [system_msgs.clone(), final_messages.clone()].concat(),
                    tools: tool_defs.clone(),
                    stream: Some(true),
                };
                let size = serde_json::to_string(&trial).map(|s| s.len()).unwrap_or(0);
                if size <= MAX_BODY_BYTES || final_messages.len() <= 2 {
                    break;
                }
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

            body_json = serde_json::to_string(&ChatCompletionRequest {
                model: model_field.clone(),
                messages: final_messages.clone(),
                tools: tool_defs.clone(),
                stream: Some(true),
            }).unwrap_or_default();

            log::info!("[llm] compacted: dropped {} msgs → summary, now {} messages ({}KB)",
                dropped.len(), final_messages.len(), body_json.len() / 1024);
        }

        let resp = self
            .http
            .post(&self.chat_url())
            .headers(self.auth_headers())
            .header(reqwest::header::CONTENT_TYPE, "application/json")
            .body(body_json)
            .send()
            .await
            .map_err(|e| format!("Stream request failed: {e}"))?;

        if !resp.status().is_success() {
            let status = resp.status();
            let text = resp.text().await.unwrap_or_default();
            let detail = if text.len() > 2000 { &text[..2000] } else { &text };
            log::error!("[llm] API error {}: {}", status, detail);
            return Err(format!("Chat stream error ({status}): {detail}"));
        }

        let stream = resp.bytes_stream().map(|chunk_result| {
            let bytes = chunk_result.map_err(|e| format!("Stream read error: {e}"))?;
            let text = String::from_utf8_lossy(&bytes);

            // SSE format: "data: {...}\n\n" — collect ALL chunks from this batch
            let mut chunks = Vec::new();
            for line in text.lines() {
                let line = line.trim();
                if let Some(data) = line.strip_prefix("data: ") {
                    if data == "[DONE]" {
                        continue;
                    }
                    if let Ok(chunk) = serde_json::from_str::<StreamChunk>(data) {
                        chunks.push(chunk);
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
}
