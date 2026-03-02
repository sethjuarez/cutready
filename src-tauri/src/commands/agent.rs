//! Tauri commands for the AI assistant (chat, model listing, ✨ generation).

use serde::Deserialize;

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
