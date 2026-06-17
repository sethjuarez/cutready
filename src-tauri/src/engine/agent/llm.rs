//! LLM provider configuration and agentive integration.
//!
//! Thin bridge between CutReady's settings (LlmProvider, LlmConfig) and the
//! agentive crate.  All heavy lifting — streaming, SSE parsing, agentic loops,
//! model heuristics, and discovery — lives in agentive.

use serde::{Deserialize, Serialize};
use std::sync::Arc;

// ---------------------------------------------------------------------------
// Shared types — re-exported from agentive
// ---------------------------------------------------------------------------

pub use agentive::discovery::ModelInfo;
pub use agentive::{
    context_budget, needs_responses_api, simple_chat, supports_vision, ChatMessage, ContentPart,
    ImageUrl, Provider, Tool, ToolCall,
};

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
    let model = effective_model(config);
    let budget = context_budget(model, reported_context_length);
    let vision = supports_vision(model);

    if config.provider == LlmProvider::Anthropic {
        return Arc::new(
            agentive::AnthropicProvider::new(&config.api_key, model).with_context_budget(budget),
        );
    }

    let endpoint = effective_endpoint(config);
    let auth = resolve_auth(config);

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

/// List available models from the provider via agentive discovery.
pub async fn list_models(config: &LlmConfig) -> Result<Vec<ModelInfo>, String> {
    let auth = resolve_auth(config);
    agentive::discovery::list_models(effective_endpoint(config), &auth)
        .await
        .map(|models| models.into_iter().map(normalize_model_info).collect())
}

fn effective_endpoint(config: &LlmConfig) -> &str {
    let endpoint = config.endpoint.trim_end_matches('/');
    if endpoint.is_empty() {
        return match config.provider {
            LlmProvider::Openai => "https://api.openai.com",
            LlmProvider::Anthropic => "https://api.anthropic.com",
            _ => endpoint,
        };
    }
    endpoint
}

fn effective_model(config: &LlmConfig) -> &str {
    if config.provider != LlmProvider::Anthropic {
        return &config.model;
    }

    match config.model.as_str() {
        "claude-sonnet-4-20250514" => "claude-sonnet-4-6",
        "claude-opus-4-20250514" => "claude-opus-4-8",
        "claude-haiku-3-5-20241022" => "claude-haiku-4-5",
        _ => &config.model,
    }
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

fn capability_model_name(model: &ModelInfo) -> &str {
    model
        .owned_by
        .as_deref()
        .filter(|owned_by| looks_like_model_id(owned_by))
        .unwrap_or(&model.id)
}

fn looks_like_model_id(value: &str) -> bool {
    let value = value.to_ascii_lowercase();
    value.starts_with("gpt-")
        || value.starts_with("o1")
        || value.starts_with("o3")
        || value.starts_with("o4")
        || value.starts_with("claude-")
        || value.starts_with("text-")
        || value.starts_with("dall-")
}

fn normalize_model_info(mut model: ModelInfo) -> ModelInfo {
    let model_name = capability_model_name(&model).to_string();
    let mut caps = model.capabilities.take().unwrap_or_default();
    let vision = supports_vision(&model_name);
    let responses_api = needs_responses_api(&model_name);

    caps.entry("vision".into())
        .or_insert_with(|| vision.to_string());
    caps.entry("responses_api".into())
        .or_insert_with(|| responses_api.to_string());
    caps.entry("chat_completion".into())
        .or_insert_with(|| (!responses_api).to_string());
    caps.entry("streaming".into())
        .or_insert_with(|| "true".into());
    caps.entry("tool_calling".into())
        .or_insert_with(|| "true".into());

    if model.context_length.is_none() {
        model.context_length = Some(context_budget(&model_name, None));
    }
    model.capabilities = Some(caps);
    model
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
            model: "claude-sonnet-4-6".into(),
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

    #[test]
    fn effective_endpoint_defaults_anthropic() {
        let config = LlmConfig {
            provider: LlmProvider::Anthropic,
            endpoint: String::new(),
            api_key: "sk-ant-test".into(),
            model: "claude-sonnet-4-6".into(),
            bearer_token: None,
        };
        assert_eq!(effective_endpoint(&config), "https://api.anthropic.com");
    }

    #[test]
    fn effective_model_maps_stale_anthropic_ids() {
        let mut config = LlmConfig {
            provider: LlmProvider::Anthropic,
            endpoint: String::new(),
            api_key: "sk-ant-test".into(),
            model: "claude-sonnet-4-20250514".into(),
            bearer_token: None,
        };
        assert_eq!(effective_model(&config), "claude-sonnet-4-6");

        config.model = "claude-opus-4-20250514".into();
        assert_eq!(effective_model(&config), "claude-opus-4-8");

        config.model = "claude-haiku-3-5-20241022".into();
        assert_eq!(effective_model(&config), "claude-haiku-4-5");
    }

    #[test]
    fn normalize_model_info_adds_context_and_capabilities() {
        let model = normalize_model_info(ModelInfo {
            id: "gpt-4o".into(),
            owned_by: Some("openai".into()),
            capabilities: None,
            context_length: None,
        });

        assert_eq!(model.context_length, Some(context_budget("gpt-4o", None)));
        let caps = model.capabilities.unwrap();
        assert_eq!(caps.get("vision").map(String::as_str), Some("true"));
        assert_eq!(
            caps.get("chat_completion").map(String::as_str),
            Some("true")
        );
        assert_eq!(caps.get("responses_api").map(String::as_str), Some("false"));
        assert_eq!(caps.get("tool_calling").map(String::as_str), Some("true"));
    }

    #[test]
    fn normalize_model_info_uses_underlying_model_for_deployments() {
        let model = normalize_model_info(ModelInfo {
            id: "prod-demo-writer".into(),
            owned_by: Some("gpt-5-codex".into()),
            capabilities: None,
            context_length: None,
        });

        let caps = model.capabilities.unwrap();
        assert_eq!(caps.get("responses_api").map(String::as_str), Some("true"));
        assert_eq!(
            caps.get("chat_completion").map(String::as_str),
            Some("false")
        );
    }

    // ── list_models ──────────────────────────────────────────────
}
