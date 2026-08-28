//! Provider configuration on the harness boundary.
//!
//! These are CutReady's harness-agnostic provider types. They carry no
//! provider-SDK dependency: model discovery and the Prompty/agentive/copilot
//! model construction that consume an [`LlmConfig`] live in the app and in the
//! individual harness adapters, never here.

use serde::{Deserialize, Serialize};

/// Which LLM provider to use.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "snake_case")]
pub enum LlmProvider {
    MicrosoftFoundry,
    AzureOpenai,
    Openai,
    Anthropic,
}

/// Full configuration for an LLM provider.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct LlmConfig {
    pub provider: LlmProvider,
    /// For Azure/Foundry: resource endpoint.  For OpenAI: optional.
    /// For Anthropic: ignored (fixed to api.anthropic.com).
    pub endpoint: String,
    /// API key (OpenAI, Azure api_key mode, Anthropic).
    pub api_key: String,
    /// Deployment / model name (e.g. "gpt-4o", "claude-sonnet-4").
    pub model: String,
    /// ****** (Entra OAuth for Azure/Foundry).
    #[serde(default)]
    pub bearer_token: Option<String>,
}
