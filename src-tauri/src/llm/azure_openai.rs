//! Azure OpenAI LLM provider implementation.
//!
//! Not yet implemented. Will make HTTP calls to the Azure OpenAI chat completions
//! endpoint with support for structured output (response_format: json_schema).

use async_trait::async_trait;

use super::types::{JsonSchema, Message};
use super::LlmProvider;

/// Azure OpenAI provider configuration and client.
pub struct AzureOpenAiProvider {
    pub endpoint: String,
    pub api_key: String,
    pub deployment: String,
    // client: reqwest::Client will be added when implementing
}

impl AzureOpenAiProvider {
    pub fn new(endpoint: String, api_key: String, deployment: String) -> Self {
        Self {
            endpoint,
            api_key,
            deployment,
        }
    }
}

#[async_trait]
impl LlmProvider for AzureOpenAiProvider {
    async fn complete(&self, _messages: &[Message]) -> anyhow::Result<String> {
        // TODO: POST to /openai/deployments/{deployment}/chat/completions
        // with api-version=2024-10-21
        anyhow::bail!("AzureOpenAiProvider::complete not yet implemented")
    }

    async fn complete_structured(
        &self,
        _messages: &[Message],
        _schema: &JsonSchema,
    ) -> anyhow::Result<serde_json::Value> {
        // TODO: Same endpoint with response_format: { type: "json_schema", ... }
        anyhow::bail!("AzureOpenAiProvider::complete_structured not yet implemented")
    }
}
