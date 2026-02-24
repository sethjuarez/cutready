//! LLM provider abstraction — pluggable trait for AI completions.

pub mod azure_openai;
pub mod types;

use async_trait::async_trait;

use types::{JsonSchema, Message};

/// Pluggable LLM provider trait. Implementations handle the specifics of
/// communicating with a particular LLM API (Azure OpenAI, etc.).
#[async_trait]
pub trait LlmProvider: Send + Sync {
    /// Send a chat completion request and return the response text.
    async fn complete(&self, messages: &[Message]) -> anyhow::Result<String>;

    /// Send a chat completion request with structured output (JSON schema)
    /// and deserialize the response into the target type.
    async fn complete_structured(
        &self,
        messages: &[Message],
        schema: &JsonSchema,
    ) -> anyhow::Result<serde_json::Value>;
}
