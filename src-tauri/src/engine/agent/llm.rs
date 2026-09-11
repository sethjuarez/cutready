//! LLM provider configuration and model discovery.
//!
//! Bridges CutReady's settings (LlmProvider, LlmConfig) to the Prompty
//! provider crates.  Execution and one-shot turns run through the
//! [`harness_prompty`] crate; model discovery calls each provider crate's
//! `list_models_async`.  This module owns only CutReady-specific policy
//! (model heuristics, context budget) and the frontend-facing `ModelInfo`
//! presentation DTO.

use serde::{Deserialize, Serialize};
use std::collections::HashMap;

use serde_json::{json, Value};

use prompty::model::ModelInfo as PromptyModelInfo;

// ---------------------------------------------------------------------------
// Frontend-facing model discovery DTO
// ---------------------------------------------------------------------------

/// Information about an available model or deployment, in the snake_case shape
/// the frontend model picker consumes.  Mapped from Prompty's provider
/// [`PromptyModelInfo`] at the discovery boundary.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
pub struct ModelInfo {
    /// Model or deployment ID (what you pass as the model name).
    pub id: String,
    /// The underlying model name (for deployments that wrap a model).
    #[serde(default)]
    pub owned_by: Option<String>,
    /// Capability flags (e.g., `"chat_completion": "true"`).
    #[serde(default)]
    pub capabilities: Option<HashMap<String, String>>,
    /// Max context window in tokens, if reported.
    #[serde(default)]
    pub context_length: Option<usize>,
}

pub fn supports_vision(model: &str) -> bool {
    let model = model.to_ascii_lowercase();
    model.contains("gpt-4o")
        || model.contains("gpt-4.1")
        || model.contains("gpt-5")
        || model.contains("gpt-4-turbo")
        || model.contains("gpt-4-vision")
        || model.contains("claude-3-5")
        || model.contains("claude-3.5")
        || model.contains("claude-4")
        || model.contains("gemini")
        || model.starts_with("o1")
        || model.starts_with("o3")
        || model.starts_with("o4")
}

pub fn supported_reasoning_efforts(model: &str) -> Vec<&'static str> {
    let model = model.to_ascii_lowercase();
    if model.contains("gpt-6") {
        return vec!["low", "medium", "high", "xhigh", "max"];
    }
    if model.contains("gpt-5") {
        return vec!["low", "medium", "high", "xhigh"];
    }
    if model.starts_with("o1") || model.starts_with("o3") || model.starts_with("o4") {
        return vec!["low", "medium", "high"];
    }
    Vec::new()
}


// ---------------------------------------------------------------------------
// CutReady-specific provider configuration
// ---------------------------------------------------------------------------

/// Provider configuration (`LlmProvider`, `LlmConfig`) now lives in the
/// `harness-contract` crate — the harness boundary vocabulary. Re-exported
/// here so existing call sites and the discovery functions below resolve them
/// at this path unchanged.
pub use harness_contract::llm::{
    context_budget, needs_responses_api, LlmConfig, LlmProvider,
};

// ---------------------------------------------------------------------------
// Model discovery (Prompty provider crates)
// ---------------------------------------------------------------------------

/// List available models for the configured provider via Prompty's per-provider
/// discovery, mapped into CutReady's frontend [`ModelInfo`] DTO.
pub async fn list_models(config: &LlmConfig) -> Result<Vec<ModelInfo>, String> {
    let connection = discovery_connection(config)?;
    let raw = match config.provider {
        LlmProvider::Openai => prompty_openai::list_models_async(&connection).await,
        LlmProvider::Anthropic => prompty_anthropic::list_models_async(&connection).await,
        LlmProvider::MicrosoftFoundry | LlmProvider::AzureOpenai => {
            prompty_foundry::list_models_async(&connection).await
        }
    }
    .map_err(|error| error.to_string())?;
    Ok(raw
        .into_iter()
        .map(map_prompty_model_info)
        .map(normalize_model_info)
        .collect())
}

/// Build the Prompty connection JSON for model discovery.  The Foundry lister
/// prefers a caller-supplied bearer token (connection `apiKey`); Azure catalog
/// and OpenAI/Anthropic listers use their respective keys.
fn discovery_connection(config: &LlmConfig) -> Result<Value, String> {
    let discovery_token = || {
        config
            .bearer_token
            .as_deref()
            .filter(|token| !token.is_empty())
            .unwrap_or(&config.api_key)
            .to_string()
    };
    match config.provider {
        LlmProvider::Openai => Ok(json!({
            "kind": "key",
            "endpoint": effective_endpoint(config),
            "apiKey": config.api_key,
        })),
        LlmProvider::Anthropic => Ok(json!({
            "kind": "key",
            "endpoint": "https://api.anthropic.com",
            "apiKey": config.api_key,
        })),
        LlmProvider::MicrosoftFoundry => {
            let endpoint = effective_endpoint(config);
            if endpoint.contains(".openai.azure.com") {
                return Err(
                    "Microsoft Foundry model discovery requires a Foundry project endpoint like https://<resource>.services.ai.azure.com/api/projects/<project>; the saved endpoint is an Azure OpenAI inference endpoint.".into(),
                );
            }
            Ok(json!({
                "kind": "foundry",
                "endpoint": endpoint,
                "apiKey": discovery_token(),
            }))
        }
        LlmProvider::AzureOpenai => Ok(json!({
            "kind": "key",
            "endpoint": effective_endpoint(config),
            "apiKey": discovery_token(),
        })),
    }
}

/// Map Prompty's provider-owned `ModelInfo` into CutReady's frontend DTO.  The
/// underlying model name (Prompty `display_name`) is preferred for capability
/// keying and display; `capabilities` are synthesized by [`normalize_model_info`].
fn map_prompty_model_info(model: PromptyModelInfo) -> ModelInfo {
    ModelInfo {
        id: model.id,
        owned_by: model.display_name.or(model.owned_by),
        capabilities: None,
        context_length: model
            .context_window
            .and_then(|window| usize::try_from(window).ok()),
    }
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

/// Pick the name capability detection keys off: prefer `owned_by` when it looks
/// like a real model id (Foundry deployments report the underlying model there).
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
    let reasoning_efforts = supported_reasoning_efforts(&model_name);
    caps.entry("reasoning_effort".into())
        .or_insert_with(|| (!reasoning_efforts.is_empty()).to_string());
    if !reasoning_efforts.is_empty() {
        caps.entry("reasoning_efforts".into())
            .or_insert_with(|| reasoning_efforts.join(","));
    }

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
            reasoning_effort: None,
        }
    }

    // ── discovery_connection ─────────────────────────────────────

    #[test]
    fn discovery_connection_foundry_prefers_bearer_token() {
        let config = LlmConfig {
            provider: LlmProvider::MicrosoftFoundry,
            endpoint: "https://my-ai.services.ai.azure.com/".into(),
            api_key: String::new(),
            model: "gpt-4o".into(),
            bearer_token: Some("entra-token".into()),
            reasoning_effort: None,
        };
        let connection = discovery_connection(&config).unwrap();
        assert_eq!(connection["kind"], "foundry");
        assert_eq!(connection["apiKey"], "entra-token");
        assert_eq!(
            connection["endpoint"],
            "https://my-ai.services.ai.azure.com"
        );
    }

    #[test]
    fn discovery_connection_foundry_rejects_inference_endpoint() {
        let config = LlmConfig {
            provider: LlmProvider::MicrosoftFoundry,
            endpoint: "https://my-ai.openai.azure.com".into(),
            api_key: String::new(),
            model: "gpt-4o".into(),
            bearer_token: Some("entra-token".into()),
            reasoning_effort: None,
        };

        let error = discovery_connection(&config).unwrap_err();

        assert!(error.contains("requires a Foundry project endpoint"));
    }

    #[test]
    fn discovery_connection_azure_uses_key_kind() {
        let config = azure_config(None);
        let connection = discovery_connection(&config).unwrap();
        assert_eq!(connection["kind"], "key");
        assert_eq!(connection["apiKey"], "test-key");
    }

    #[test]
    fn discovery_connection_openai_uses_key_kind() {
        let config = LlmConfig {
            provider: LlmProvider::Openai,
            endpoint: String::new(),
            api_key: "sk-test".into(),
            model: "gpt-4o".into(),
            bearer_token: None,
            reasoning_effort: None,
        };
        let connection = discovery_connection(&config).unwrap();
        assert_eq!(connection["kind"], "key");
        assert_eq!(connection["endpoint"], "https://api.openai.com");
        assert_eq!(connection["apiKey"], "sk-test");
    }

    #[test]
    fn map_prompty_model_info_prefers_display_name() {
        let mapped = map_prompty_model_info(PromptyModelInfo {
            id: "chat-prod".into(),
            display_name: Some("gpt-4o".into()),
            owned_by: Some("Microsoft".into()),
            context_window: Some(128_000),
            input_modalities: None,
            output_modalities: None,
            additional_properties: serde_json::Value::Null,
        });
        assert_eq!(mapped.id, "chat-prod");
        assert_eq!(mapped.owned_by.as_deref(), Some("gpt-4o"));
        assert_eq!(mapped.context_length, Some(128_000));
    }

    #[test]
    fn effective_endpoint_anthropic_uses_default() {
        let config = LlmConfig {
            provider: LlmProvider::Anthropic,
            endpoint: String::new(),
            api_key: "sk-ant-test".into(),
            model: "claude-sonnet-4-6".into(),
            bearer_token: None,
            reasoning_effort: None,
        };
        assert_eq!(effective_endpoint(&config), "https://api.anthropic.com");
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
    fn context_budget_preserves_legacy_host_policy_defaults() {
        assert_eq!(context_budget("mistral-7b", None), 24_000);
        assert_eq!(context_budget("custom-private-model", None), 96_000);
        assert_eq!(context_budget("custom-private-model", Some(10_000)), 30_000);
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
