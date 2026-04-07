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
    Provider, Tool, ToolCall,
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

#[cfg(test)]
mod tests {
    use super::*;

    fn azure_config(bearer: Option<&str>) -> LlmConfig {
        LlmConfig {
            provider: LlmProvider::AzureOpenai,
            endpoint: "https://my-resource.openai.azure.com".into(),
            api_key: "test-key".into(),
            model: "gpt-4o".into(),
            bearer_token: bearer.map(String::from),
        }
    }

    // ── build_provider routing ───────────────────────────────────

    #[test]
    fn build_provider_routes_anthropic() {
        let config = LlmConfig {
            provider: LlmProvider::Anthropic,
            endpoint: String::new(),
            api_key: "sk-ant-test".into(),
            model: "claude-sonnet-4-20250514".into(),
            bearer_token: None,
        };
        let p = build_provider(&config, None);
        assert_eq!(p.name(), "anthropic");
    }

    #[test]
    fn build_provider_routes_azure_to_openai_provider() {
        let config = azure_config(None);
        let p = build_provider(&config, None);
        assert_eq!(p.name(), "openai"); // OpenAiProvider for chat completions
    }

    #[test]
    fn build_provider_routes_openai() {
        let config = LlmConfig {
            provider: LlmProvider::Openai,
            endpoint: "https://api.openai.com".into(),
            api_key: "sk-test".into(),
            model: "gpt-4o".into(),
            bearer_token: None,
        };
        let p = build_provider(&config, None);
        assert_eq!(p.name(), "openai");
    }

    #[test]
    fn build_provider_routes_foundry() {
        let config = LlmConfig {
            provider: LlmProvider::MicrosoftFoundry,
            endpoint: "https://my-ai.services.ai.azure.com".into(),
            api_key: String::new(),
            model: "gpt-4o".into(),
            bearer_token: Some("entra-token".into()),
        };
        let p = build_provider(&config, None);
        assert_eq!(p.name(), "openai");
    }

    #[test]
    fn build_provider_routes_responses_api_model() {
        let config = LlmConfig {
            provider: LlmProvider::AzureOpenai,
            endpoint: "https://my-resource.openai.azure.com".into(),
            api_key: "test-key".into(),
            model: "gpt-5-codex".into(), // codex models need Responses API
            bearer_token: None,
        };
        let p = build_provider(&config, None);
        assert_eq!(p.name(), "responses");
    }

    // ── resolve_auth ─────────────────────────────────────────────

    #[test]
    fn resolve_auth_prefers_bearer_token() {
        let config = azure_config(Some("my-bearer"));
        let auth = resolve_auth(&config);
        assert!(matches!(auth, agentive::AuthStrategy::Bearer(ref t) if t == "my-bearer"));
    }

    #[test]
    fn resolve_auth_azure_falls_back_to_api_key() {
        let config = azure_config(None);
        let auth = resolve_auth(&config);
        assert!(matches!(auth, agentive::AuthStrategy::ApiKey(ref k) if k == "test-key"));
    }

    #[test]
    fn resolve_auth_openai_uses_bearer_for_api_key() {
        let config = LlmConfig {
            provider: LlmProvider::Openai,
            endpoint: String::new(),
            api_key: "sk-openai".into(),
            model: "gpt-4o".into(),
            bearer_token: None,
        };
        let auth = resolve_auth(&config);
        assert!(matches!(auth, agentive::AuthStrategy::Bearer(ref k) if k == "sk-openai"));
    }

    #[test]
    fn resolve_auth_ignores_empty_bearer() {
        let config = azure_config(Some(""));
        let auth = resolve_auth(&config);
        assert!(matches!(auth, agentive::AuthStrategy::ApiKey(_)));
    }

    #[test]
    fn resolve_auth_foundry_falls_back_to_api_key() {
        let config = LlmConfig {
            provider: LlmProvider::MicrosoftFoundry,
            endpoint: "https://foundry.ai.azure.com".into(),
            api_key: "foundry-key".into(),
            model: "gpt-4o".into(),
            bearer_token: None,
        };
        let auth = resolve_auth(&config);
        assert!(matches!(auth, agentive::AuthStrategy::ApiKey(ref k) if k == "foundry-key"));
    }

    // ── anthropic_models ─────────────────────────────────────────

    #[test]
    fn anthropic_models_have_context_length() {
        let models = anthropic_models();
        assert_eq!(models.len(), 3);
        for m in &models {
            assert_eq!(m.context_length, Some(200_000));
        }
    }

    #[test]
    fn anthropic_models_have_vision_capability() {
        let models = anthropic_models();
        for m in &models {
            let caps = m.capabilities.as_ref().unwrap();
            assert_eq!(caps.get("vision").map(|s| s.as_str()), Some("true"));
        }
    }

    #[test]
    fn anthropic_models_have_expected_ids() {
        let models = anthropic_models();
        let ids: Vec<&str> = models.iter().map(|m| m.id.as_str()).collect();
        assert!(ids.contains(&"claude-sonnet-4-20250514"));
        assert!(ids.contains(&"claude-opus-4-20250514"));
        assert!(ids.contains(&"claude-haiku-3-5-20241022"));
    }

    // ── list_models ──────────────────────────────────────────────

    #[tokio::test]
    async fn list_models_returns_anthropic_hardcoded() {
        let config = LlmConfig {
            provider: LlmProvider::Anthropic,
            endpoint: String::new(),
            api_key: String::new(),
            model: String::new(),
            bearer_token: None,
        };
        let result = list_models(&config).await;
        assert!(result.is_ok());
        assert_eq!(result.unwrap().len(), 3);
    }
}
