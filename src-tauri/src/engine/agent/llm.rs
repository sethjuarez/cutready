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
    pub fn assistant(content: &str) -> Self {
        Self {
            role: "assistant".into(),
            content: Some(content.into()),
            tool_calls: None,
            tool_call_id: None,
        }
    }
    pub fn assistant_with_tool_calls(tool_calls: Vec<ToolCall>) -> Self {
        Self {
            role: "assistant".into(),
            content: None,
            tool_calls: Some(tool_calls),
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
    pub role: Option<String>,
    pub content: Option<String>,
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

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ModelInfo {
    pub id: String,
    #[serde(default)]
    pub created: Option<u64>,
    #[serde(default)]
    pub owned_by: Option<String>,
}

// ---------------------------------------------------------------------------
// LLM Client
// ---------------------------------------------------------------------------

pub struct LlmClient {
    config: LlmConfig,
    http: reqwest::Client,
}

impl LlmClient {
    pub fn new(config: LlmConfig) -> Self {
        Self {
            config,
            http: reqwest::Client::new(),
        }
    }

    /// Detect whether the endpoint is Azure AI Foundry (`.services.ai.azure.com`).
    fn is_foundry(&self) -> bool {
        self.config.endpoint.contains(".services.ai.azure.com")
    }

    /// Build the chat completions URL based on provider.
    fn chat_url(&self) -> String {
        match self.config.provider {
            LlmProvider::AzureOpenai => {
                let base = self.config.endpoint.trim_end_matches('/');
                if self.is_foundry() {
                    // Foundry projects API — model name in URL path
                    format!(
                        "{}/models/{}/chat/completions?api-version=2024-05-01-preview",
                        base, self.config.model
                    )
                } else {
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

    /// Build the models list URL based on provider.
    fn models_url(&self) -> String {
        match self.config.provider {
            LlmProvider::AzureOpenai => {
                let base = self.config.endpoint.trim_end_matches('/');
                if self.is_foundry() {
                    // Foundry project API: list deployments
                    format!(
                        "{}/models?api-version=2024-05-01-preview",
                        base
                    )
                } else {
                    format!(
                        "{}/openai/models?api-version=2024-10-21",
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
        let url = self.models_url();
        let resp = self
            .http
            .get(&url)
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

        // Foundry /models may use { "data": [...] } or { "value": [...] }
        let body = resp
            .text()
            .await
            .map_err(|e| format!("Failed to read models response: {e}"))?;

        // Try standard OpenAI format first, then Foundry deployments format
        if let Ok(parsed) = serde_json::from_str::<ModelsResponse>(&body) {
            return Ok(parsed.data);
        }
        if let Ok(parsed) = serde_json::from_str::<FoundryModelsResponse>(&body) {
            return Ok(
                parsed
                    .value
                    .into_iter()
                    .filter(|m| {
                        // Show chat-capable deployments
                        m.capabilities
                            .as_ref()
                            .and_then(|c| c.get("chat_completion"))
                            .map(|v| v == "true")
                            .unwrap_or(false)
                    })
                    .map(|m| ModelInfo {
                        id: m.name,
                        created: None,
                        owned_by: m.model_name,
                    })
                    .collect(),
            );
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
    ) -> Result<impl futures_util::Stream<Item = Result<StreamChunk, String>>, String> {
        let body = ChatCompletionRequest {
            model: match self.config.provider {
                LlmProvider::Openai => Some(self.config.model.clone()),
                LlmProvider::AzureOpenai => {
                    if self.is_foundry() {
                        Some(self.config.model.clone())
                    } else {
                        None
                    }
                }
            },
            messages: messages.to_vec(),
            tools: tools.map(|t| t.to_vec()),
            stream: Some(true),
        };

        let resp = self
            .http
            .post(&self.chat_url())
            .headers(self.auth_headers())
            .json(&body)
            .send()
            .await
            .map_err(|e| format!("Stream request failed: {e}"))?;

        if !resp.status().is_success() {
            let status = resp.status();
            let text = resp.text().await.unwrap_or_default();
            return Err(format!("Chat stream error ({status}): {text}"));
        }

        let stream = resp.bytes_stream().map(|chunk_result| {
            let bytes = chunk_result.map_err(|e| format!("Stream read error: {e}"))?;
            let text = String::from_utf8_lossy(&bytes);

            // SSE format: "data: {...}\n\n"
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

            // Return the last chunk from this SSE batch (most common: 1 per batch)
            chunks
                .into_iter()
                .last()
                .ok_or_else(|| "No parseable chunk in SSE data".to_string())
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
