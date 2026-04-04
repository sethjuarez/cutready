//! LLM provider configuration and agentive integration.
//!
//! Thin bridge between CutReady's settings (LlmProvider, LlmConfig) and the
//! agentive crate.  All heavy lifting — streaming, SSE parsing, agentic loops,
//! model heuristics, and discovery — lives in agentive.

use std::sync::Arc;
use serde::{Deserialize, Serialize};

// ---------------------------------------------------------------------------
// Shared types — re-exported from agentive
// ---------------------------------------------------------------------------

pub use agentive::{
    ChatMessage, ContentPart, FunctionCall, ImageUrl, MessageContent,
    Provider, Tool, ToolCall, ToolFunction,
    context_budget, needs_responses_api, simple_chat, supports_vision,
};
pub use agentive::discovery::ModelInfo;

// ---------------------------------------------------------------------------
// CutReady-specific provider configuration
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
// Provider + discovery
// ---------------------------------------------------------------------------

/// Build an agentive Provider from CutReady's LlmConfig.
pub fn build_provider(
    config: &LlmConfig,
    reported_context_length: Option<usize>,
) -> Arc<dyn Provider + Send + Sync> {
    let endpoint = config.endpoint.trim_end_matches('/');
    let auth = resolve_auth(config);
    let budget = context_budget(&config.model, reported_context_length);
    let vision = supports_vision(&config.model);

    if needs_responses_api(&config.model) {
        Arc::new(
            agentive::ResponsesProvider::with_auth(endpoint, auth, &config.model)
                .with_context_budget(budget)
                .with_vision(vision),
        )
    } else {
        Arc::new(
            agentive::OpenAiProvider::with_auth(endpoint, auth, &config.model)
                .with_context_budget(budget)
                .with_vision(vision),
        )
    }
}

/// List available models from the provider via agentive discovery.
pub async fn list_models(config: &LlmConfig) -> Result<Vec<ModelInfo>, String> {
    let auth = resolve_auth(config);
    agentive::discovery::list_models(&config.endpoint, &auth).await
}

/// Map CutReady's LlmConfig to an agentive AuthStrategy.
fn resolve_auth(config: &LlmConfig) -> agentive::AuthStrategy {
    if let Some(ref token) = config.bearer_token {
        if !token.is_empty() {
            return agentive::AuthStrategy::Bearer(token.clone());
        }
    }
    match config.provider {
        LlmProvider::AzureOpenai => agentive::AuthStrategy::ApiKey(config.api_key.clone()),
        LlmProvider::Openai => agentive::AuthStrategy::Bearer(config.api_key.clone()),
    }
}
