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
    ChatMessage, ContentPart, ImageUrl,
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
    /// Bearer token (Entra OAuth for Azure/Foundry).
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
    let budget = context_budget(&config.model, reported_context_length);
    let vision = supports_vision(&config.model);

    if config.provider == LlmProvider::Anthropic {
        return Arc::new(
            agentive::AnthropicProvider::new(&config.api_key, &config.model)
                .with_context_budget(budget),
        );
    }

    let endpoint = config.endpoint.trim_end_matches('/');
    let auth = resolve_auth(config);

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
///
/// For Anthropic, returns a hardcoded list (no discovery API).
pub async fn list_models(config: &LlmConfig) -> Result<Vec<ModelInfo>, String> {
    if config.provider == LlmProvider::Anthropic {
        return Ok(anthropic_models());
    }
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
        LlmProvider::MicrosoftFoundry => {
            // Foundry should always have a bearer token from Entra.
            // Fall back to ApiKey if somehow set without OAuth.
            agentive::AuthStrategy::ApiKey(config.api_key.clone())
        }
        LlmProvider::AzureOpenai => agentive::AuthStrategy::ApiKey(config.api_key.clone()),
        LlmProvider::Openai => agentive::AuthStrategy::Bearer(config.api_key.clone()),
        LlmProvider::Anthropic => {
            // Anthropic uses its own header (x-api-key), handled by AnthropicProvider.
            // This shouldn't be called for Anthropic, but return a placeholder.
            agentive::AuthStrategy::ApiKey(config.api_key.clone())
        }
    }
}

/// Known Anthropic models (no discovery API available).
fn anthropic_models() -> Vec<ModelInfo> {
    [
        ("claude-sonnet-4-20250514", 200_000, true),
        ("claude-opus-4-20250514", 200_000, true),
        ("claude-haiku-3-5-20241022", 200_000, true),
    ]
    .into_iter()
    .map(|(id, ctx, vision)| {
        let mut caps = std::collections::HashMap::new();
        if vision {
            caps.insert("vision".into(), "true".into());
        }
        ModelInfo {
            id: id.into(),
            owned_by: Some("Anthropic".into()),
            capabilities: Some(caps),
            context_length: Some(ctx),
        }
    })
    .collect()
}
