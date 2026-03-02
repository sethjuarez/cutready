//! Tauri commands for the AI assistant (chat, model listing, ✨ generation).

use serde::Deserialize;

use crate::engine::agent::azure_auth::{self, DeviceCodeResponse, TokenResponse};
use crate::engine::agent::llm::{
    ChatMessage, LlmClient, LlmConfig, LlmProvider, ModelInfo,
};

/// Serialisable provider config sent from the frontend.
#[derive(Debug, Deserialize)]
pub struct ProviderConfig {
    pub provider: String,
    pub endpoint: String,
    pub api_key: String,
    pub model: String,
    #[serde(default)]
    pub bearer_token: Option<String>,
}

impl From<ProviderConfig> for LlmConfig {
    fn from(c: ProviderConfig) -> Self {
        Self {
            provider: match c.provider.as_str() {
                "openai" => LlmProvider::Openai,
                _ => LlmProvider::AzureOpenai,
            },
            endpoint: c.endpoint,
            api_key: c.api_key,
            model: c.model,
            bearer_token: c.bearer_token,
        }
    }
}

/// List available models for the configured provider.
#[tauri::command]
pub async fn list_models(config: ProviderConfig) -> Result<Vec<ModelInfo>, String> {
    let client = LlmClient::new(config.into());
    client.list_models().await
}

/// A single chat turn (non-streaming) for quick operations like ✨ field fill.
#[tauri::command]
pub async fn agent_chat(
    config: ProviderConfig,
    messages: Vec<ChatMessage>,
) -> Result<ChatMessage, String> {
    let client = LlmClient::new(config.into());
    let resp = client.chat(&messages, None).await?;
    resp.choices
        .into_iter()
        .next()
        .map(|c| c.message)
        .ok_or_else(|| "No response from model".into())
}

// ---------------------------------------------------------------------------
// Azure Device Code OAuth
// ---------------------------------------------------------------------------

/// Start the Azure device code flow. Returns the user code + URL to display.
#[tauri::command]
pub async fn azure_device_code_start(
    tenant_id: String,
) -> Result<DeviceCodeResponse, String> {
    let tid = if tenant_id.is_empty() { "common" } else { &tenant_id };
    azure_auth::request_device_code(tid).await
}

/// Poll for the token after the user has completed sign-in.
/// This blocks until success, timeout, or error.
#[tauri::command]
pub async fn azure_device_code_poll(
    tenant_id: String,
    device_code: String,
    interval: u64,
    timeout: u64,
) -> Result<TokenResponse, String> {
    let tid = if tenant_id.is_empty() { "common" } else { &tenant_id };
    azure_auth::poll_for_token(tid, &device_code, interval, timeout).await
}

/// Refresh an Azure OAuth token using a refresh token.
#[tauri::command]
pub async fn azure_token_refresh(
    tenant_id: String,
    refresh_token: String,
) -> Result<TokenResponse, String> {
    let tid = if tenant_id.is_empty() { "common" } else { &tenant_id };
    azure_auth::refresh_token(tid, &refresh_token).await
}
