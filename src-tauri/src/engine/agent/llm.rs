//! LLM provider configuration, model discovery, and agentive integration.
//!
//! This module provides CutReady-specific configuration types (LlmProvider,
//! LlmConfig), model capability heuristics, and a bridge to the agentive
//! crate's Provider system.  The actual streaming, SSE parsing, and agentic
//! loop are handled by agentive.

use std::sync::Arc;
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
// Shared types — re-exported from agentive
// ---------------------------------------------------------------------------

pub use agentive::{ChatMessage, ContentPart, FunctionCall, ImageUrl, MessageContent, Tool, ToolCall, ToolFunction};
pub use agentive::Provider;

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
// Model capability heuristics
// ---------------------------------------------------------------------------

/// Whether the model supports vision (image) inputs.
pub fn supports_vision(model: &str) -> bool {
    let model = model.to_lowercase();
    model.contains("gpt-4o")
        || model.contains("gpt-4.1")
        || model.contains("gpt-5")
        || model.contains("gpt-4-turbo")
        || model.contains("gpt-4-vision")
        || model.contains("claude-3-5") || model.contains("claude-3.5")
        || model.contains("claude-4")
        || model.contains("gemini")
        || model.starts_with("o1") || model.starts_with("o3") || model.starts_with("o4")
}

/// Whether the model requires the Responses API instead of Chat Completions.
/// Codex and Pro model variants are Responses API only.
pub fn needs_responses_api(model: &str) -> bool {
    let model = model.to_lowercase();
    model.contains("codex")
        || (model.contains("gpt-5") && model.ends_with("-pro"))
}

/// Return a conservative character budget for the model's context window.
/// Prefers API-reported context length if available, otherwise uses model
/// name heuristics.  ~4 chars/token as a rough proxy (no tokenizer dependency).
pub fn context_char_budget(model: &str, reported_context_length: Option<usize>) -> usize {
    if let Some(reported) = reported_context_length {
        let usable = reported * 3 / 4;
        return usable * 4;
    }

    let model = model.to_lowercase();

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

// ---------------------------------------------------------------------------
// Provider construction
// ---------------------------------------------------------------------------

/// Build an agentive Provider from CutReady's LlmConfig.
///
/// Normalises the endpoint (strips trailing slashes and Foundry project paths),
/// selects the correct auth strategy, and picks `ResponsesProvider` vs
/// `OpenAiProvider` based on the model name.
pub fn build_provider(
    config: &LlmConfig,
    reported_context_length: Option<usize>,
) -> Arc<dyn Provider + Send + Sync> {
    let raw_endpoint = config.endpoint.trim_end_matches('/');

    // Strip Foundry project paths so both providers build correct URLs.
    let endpoint = match raw_endpoint.find("/api/projects") {
        Some(idx) => &raw_endpoint[..idx],
        None => raw_endpoint,
    };

    let model = &config.model;

    // Determine auth strategy
    let auth = if let Some(ref token) = config.bearer_token {
        if !token.is_empty() {
            agentive::AuthStrategy::Bearer(token.clone())
        } else {
            default_auth(config)
        }
    } else {
        default_auth(config)
    };

    let budget = context_char_budget(model, reported_context_length);
    let vision = supports_vision(model);

    if needs_responses_api(model) {
        Arc::new(
            agentive::ResponsesProvider::with_auth(endpoint, auth, model)
                .with_context_budget(budget)
                .with_vision(vision),
        )
    } else {
        Arc::new(
            agentive::OpenAiProvider::with_auth(endpoint, auth, model)
                .with_context_budget(budget)
                .with_vision(vision),
        )
    }
}

/// Default auth strategy based on provider type.
fn default_auth(config: &LlmConfig) -> agentive::AuthStrategy {
    match config.provider {
        LlmProvider::AzureOpenai => agentive::AuthStrategy::ApiKey(config.api_key.clone()),
        LlmProvider::Openai => agentive::AuthStrategy::Bearer(config.api_key.clone()),
    }
}

// ---------------------------------------------------------------------------
// Simple one-shot chat
// ---------------------------------------------------------------------------

/// Perform a single non-streaming chat turn using an agentive provider.
/// Used for quick operations like ✨ sparkle fills.
pub async fn simple_chat(
    provider: Arc<dyn Provider + Send + Sync>,
    messages: Vec<ChatMessage>,
) -> Result<ChatMessage, String> {
    use agentive::{ChatRequest, ChatEvent, CancellationToken};

    let (tx, mut rx) = tokio::sync::mpsc::channel(100);
    let cancel = CancellationToken::new();
    let request = ChatRequest {
        messages,
        model: String::new(),
        tools: None,
        stream: false,
        response_format: None,
    };

    provider
        .chat(request, tx, &cancel)
        .await
        .map_err(|e| format!("Chat failed: {e}"))?;

    while let Some(event) = rx.recv().await {
        match event {
            ChatEvent::Done { response } => return Ok(response.message),
            ChatEvent::Error { message } => return Err(message),
            _ => {}
        }
    }

    Err("No response received from model".into())
}

// ---------------------------------------------------------------------------
// Model discovery
// ---------------------------------------------------------------------------

/// List available models from the provider.
pub async fn list_models(config: &LlmConfig) -> Result<Vec<ModelInfo>, String> {
    let http = reqwest::Client::builder()
        .pool_max_idle_per_host(0)
        .connect_timeout(std::time::Duration::from_secs(30))
        .build()
        .unwrap_or_else(|_| reqwest::Client::new());

    if config.provider == LlmProvider::AzureOpenai && is_foundry(&config.endpoint) {
        return list_models_foundry(config, &http).await;
    }

    let url = models_url(config);
    let body = fetch_models_body(config, &http, &url).await?;
    parse_models_response(&body, false)
}

/// Detect whether the endpoint is Azure AI Foundry (`.services.ai.azure.com`).
fn is_foundry(endpoint: &str) -> bool {
    endpoint.contains(".services.ai.azure.com")
}

/// Extract the Foundry host base, stripping any /api/projects/... suffix.
fn foundry_base(endpoint: &str) -> String {
    let base = endpoint.trim_end_matches('/');
    if let Some(idx) = base.find("/api/projects") {
        base[..idx].to_string()
    } else {
        base.to_string()
    }
}

/// Build the models/deployments list URL based on provider.
fn models_url(config: &LlmConfig) -> String {
    match config.provider {
        LlmProvider::AzureOpenai => {
            if is_foundry(&config.endpoint) {
                let base = foundry_base(&config.endpoint);
                format!("{}/openai/models?api-version=2024-10-21", base)
            } else {
                let base = config.endpoint.trim_end_matches('/');
                format!("{}/openai/deployments?api-version=2024-10-21", base)
            }
        }
        LlmProvider::Openai => {
            let base = if config.endpoint.is_empty() {
                "https://api.openai.com".to_string()
            } else {
                config.endpoint.trim_end_matches('/').to_string()
            };
            format!("{}/v1/models", base)
        }
    }
}

/// Build auth headers based on provider type and auth mode.
fn auth_headers(config: &LlmConfig) -> HeaderMap {
    let mut headers = HeaderMap::new();
    headers.insert(CONTENT_TYPE, HeaderValue::from_static("application/json"));

    if let Some(ref token) = config.bearer_token {
        if !token.is_empty() {
            let bearer = format!("Bearer {}", token);
            if let Ok(v) = HeaderValue::from_str(&bearer) {
                headers.insert(AUTHORIZATION, v);
            }
            return headers;
        }
    }

    match config.provider {
        LlmProvider::AzureOpenai => {
            if let Ok(v) = HeaderValue::from_str(&config.api_key) {
                headers.insert("api-key", v);
            }
        }
        LlmProvider::Openai => {
            let bearer = format!("Bearer {}", config.api_key);
            if let Ok(v) = HeaderValue::from_str(&bearer) {
                headers.insert(AUTHORIZATION, v);
            }
        }
    }
    headers
}

/// Foundry-specific model listing: tries deployments endpoints first,
/// falls back to /openai/models.
async fn list_models_foundry(
    config: &LlmConfig,
    http: &reqwest::Client,
) -> Result<Vec<ModelInfo>, String> {
    let base = foundry_base(&config.endpoint);
    let full_endpoint = config.endpoint.trim_end_matches('/');

    let mut urls = Vec::new();
    if full_endpoint.contains("/api/projects") {
        urls.push(format!("{}/deployments?api-version=v1", full_endpoint));
    }
    urls.push(format!("{}/openai/models?api-version=2024-10-21", base));

    let mut last_err = String::new();
    for url in &urls {
        let is_deployments = url.contains("/deployments");
        log::info!("[list_models_foundry] trying: {} (filter_chat={})", url, !is_deployments);
        match fetch_models_body(config, http, url).await {
            Ok(body) => match parse_models_response(&body, !is_deployments) {
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
async fn fetch_models_body(
    config: &LlmConfig,
    http: &reqwest::Client,
    url: &str,
) -> Result<String, String> {
    let resp = http
        .get(url)
        .headers(auth_headers(config))
        .timeout(std::time::Duration::from_secs(30))
        .send()
        .await
        .map_err(|e| format!("Failed to list models: {e}"))?;

    if !resp.status().is_success() {
        let status = resp.status();
        let body = resp.text().await.unwrap_or_default();
        let token_info = config
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
/// When `filter_chat_only` is true, only include chat-capable models.
fn parse_models_response(body: &str, filter_chat_only: bool) -> Result<Vec<ModelInfo>, String> {
    // Try standard OpenAI format
    if let Ok(parsed) = serde_json::from_str::<ModelsResponse>(body) {
        if !parsed.data.is_empty() {
            return Ok(parsed.data);
        }
    }
    // Azure deployments format
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
    // Foundry format
    if let Ok(parsed) = serde_json::from_str::<FoundryModelsResponse>(body) {
        if !parsed.value.is_empty() {
            return Ok(
                parsed
                    .value
                    .into_iter()
                    .filter(|m| {
                        if !filter_chat_only {
                            return true;
                        }
                        let has_chat = m.capabilities
                            .as_ref()
                            .and_then(|c| c.get("chat_completion"))
                            .map(|v| v == "true")
                            .unwrap_or(true);
                        if has_chat {
                            return true;
                        }
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
    // Foundry project deployments
    if let Ok(parsed) = serde_json::from_str::<FoundryProjectDeploymentsResponse>(body) {
        if !parsed.value.is_empty() {
            return Ok(
                parsed
                    .value
                    .into_iter()
                    .map(|d| ModelInfo {
                        id: d.name,
                        created: None,
                        owned_by: d.properties.and_then(|p| p.model).map(|m| m.name),
                        capabilities: None,
                        context_length: None,
                    })
                    .collect(),
            );
        }
    }
    Err(format!("Failed to parse models response: {body}"))
}

/// Decode the `aud` claim from a JWT without verifying the signature.
fn decode_jwt_audience(token: &str) -> Option<String> {
    use base64::Engine;
    let parts: Vec<&str> = token.split('.').collect();
    let payload = parts.get(1)?;
    let bytes = base64::engine::general_purpose::URL_SAFE_NO_PAD
        .decode(payload)
        .ok()?;
    let val: serde_json::Value = serde_json::from_slice(&bytes).ok()?;
    val.get("aud")
        .and_then(|a| a.as_str())
        .map(|s| s.to_string())
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn context_budget_varies_by_model() {
        let gpt4o = context_char_budget("gpt-4o", None);
        let gpt35 = context_char_budget("gpt-35-turbo", None);
        let claude = context_char_budget("claude-3.5-sonnet", None);
        let unknown = context_char_budget("my-custom-model", None);

        assert!(gpt4o > gpt35 * 2);
        assert!(claude > gpt4o);
        assert!(unknown < gpt4o);
        assert!(unknown > 0);
    }

    #[test]
    fn context_budget_gpt4o_reasonable() {
        assert_eq!(context_char_budget("gpt-4o", None), 384_000);
    }

    #[test]
    fn context_budget_small_model() {
        assert_eq!(context_char_budget("gpt-35-turbo", None), 12_288);
    }

    #[test]
    fn context_budget_o1_starts_with_not_contains() {
        assert_eq!(context_char_budget("o1-preview", None), 384_000);
        assert_eq!(context_char_budget("my-foo-o1-bar", None), 96_000);
    }

    #[test]
    fn context_budget_deepseek_and_phi() {
        assert_eq!(context_char_budget("deepseek-r1", None), 192_000);
        assert_eq!(context_char_budget("phi-4", None), 48_000);
    }

    #[test]
    fn reported_context_overrides_heuristic() {
        assert_eq!(context_char_budget("my-custom-deployment", None), 96_000);
        assert_eq!(context_char_budget("my-custom-deployment", Some(200_000)), 600_000);
    }

    #[test]
    fn message_content_text_serializes_as_string() {
        let msg = ChatMessage::user("hello world");
        let json = serde_json::to_string(&msg).unwrap();
        assert!(json.contains(r#""content":"hello world""#));
        let deserialized: ChatMessage = serde_json::from_str(&json).unwrap();
        assert_eq!(deserialized.text(), Some("hello world"));
    }

    #[test]
    fn message_content_parts_serializes_as_array() {
        let msg = ChatMessage::user_with_images("describe this", vec![
            ContentPart::ImageUrl {
                image_url: ImageUrl {
                    url: "data:image/png;base64,abc123".into(),
                    detail: Some("low".into()),
                },
            },
        ]);
        let json = serde_json::to_string(&msg).unwrap();
        assert!(json.contains(r#""type":"text""#));
        assert!(json.contains(r#""type":"image_url""#));
        assert!(json.contains("abc123"));
        let deserialized: ChatMessage = serde_json::from_str(&json).unwrap();
        assert_eq!(deserialized.text(), Some("describe this"));
        if let Some(MessageContent::Parts(parts)) = &deserialized.content {
            assert_eq!(parts.len(), 2);
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
                image_url: ImageUrl { url: "data:...".into(), detail: None },
            },
        ]);
        assert_eq!(parts.char_len(), 205);
    }

    #[test]
    fn vision_detection() {
        assert!(supports_vision("gpt-4o"));
        assert!(supports_vision("gpt-4o-mini"));
        assert!(supports_vision("gpt-4.1"));
        assert!(supports_vision("gpt-5.2"));
        assert!(supports_vision("claude-3-5-sonnet"));
        assert!(supports_vision("claude-4-opus"));
        assert!(supports_vision("gemini-1.5-pro"));
        assert!(supports_vision("o1-preview"));
        assert!(supports_vision("o3-mini"));
        assert!(!supports_vision("gpt-3.5-turbo"));
        assert!(!supports_vision("gpt-4"));
        assert!(!supports_vision("deepseek-r1"));
        assert!(!supports_vision("phi-4"));
        assert!(!supports_vision("my-custom-model"));
    }

    #[test]
    fn needs_responses_api_codex_models() {
        assert!(needs_responses_api("gpt-5.1-codex"));
        assert!(needs_responses_api("gpt-5.1-codex-mini"));
        assert!(needs_responses_api("gpt-5.1-codex-max"));
        assert!(needs_responses_api("gpt-5.2-codex"));
        assert!(needs_responses_api("gpt-5.3-codex"));
        assert!(needs_responses_api("gpt-5-codex"));
        assert!(needs_responses_api("codex-mini"));
    }

    #[test]
    fn needs_responses_api_pro_models() {
        assert!(needs_responses_api("gpt-5.4-pro"));
        assert!(needs_responses_api("gpt-5-pro"));
    }

    #[test]
    fn needs_responses_api_chat_completions_models() {
        assert!(!needs_responses_api("gpt-5.4"));
        assert!(!needs_responses_api("gpt-5.2"));
        assert!(!needs_responses_api("gpt-5.1"));
        assert!(!needs_responses_api("gpt-5"));
        assert!(!needs_responses_api("gpt-5-mini"));
        assert!(!needs_responses_api("gpt-4.1"));
        assert!(!needs_responses_api("gpt-4o"));
        assert!(!needs_responses_api("claude-3.5-sonnet"));
        assert!(!needs_responses_api("o3-mini"));
    }

    #[test]
    fn assistant_message_content_null_serializes() {
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
}
