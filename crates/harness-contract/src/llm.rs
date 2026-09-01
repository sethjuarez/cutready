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

/// Whether a model must be driven through the Responses API rather than
/// Chat Completions. A harness-neutral model-name heuristic used by adapters
/// when constructing a provider model.
pub fn needs_responses_api(model: &str) -> bool {
    let model = model.to_ascii_lowercase();
    model.contains("codex") || (model.contains("gpt-5") && model.ends_with("-pro"))
}

/// Character budget for a model's usable context window. When the provider
/// reports a token context length it is honored (×3 chars/token); otherwise a
/// harness-neutral per-family default is applied. Used by adapters to size the
/// host policy history budget.
pub fn context_budget(model: &str, reported_context: Option<usize>) -> usize {
    if let Some(reported) = reported_context {
        return reported.saturating_mul(3);
    }
    let model = model.to_ascii_lowercase();
    let token_limit: usize = if model.contains("codex") {
        16_000
    } else if model.contains("claude-3-5")
        || model.contains("claude-3.5")
        || model.contains("claude-4")
    {
        200_000
    } else if model.contains("claude") {
        100_000
    } else if model.contains("gpt-5")
        || model.contains("gpt-4o")
        || model.contains("gpt-4.1")
        || model.contains("gpt-4-turbo")
        || model.contains("gpt-4-1106")
        || model.contains("gpt-4-0125")
        || model.starts_with("o1")
        || model.starts_with("o3")
        || model.starts_with("o4")
        || model.contains("gemini")
    {
        128_000
    } else if model.contains("deepseek") {
        64_000
    } else if model.contains("16k") || model.contains("phi-4") || model.contains("phi-3") {
        16_000
    } else if model.contains("mistral-large") || model.contains("mistral-medium") {
        32_000
    } else if model.contains("mistral") {
        8_000
    } else if model.contains("gpt-4") {
        8_192
    } else if model.contains("gpt-35") || model.contains("gpt-3.5") {
        4_096
    } else {
        32_000
    };
    token_limit.saturating_mul(3)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn needs_responses_api_targets_codex_and_gpt5_pro() {
        assert!(needs_responses_api("gpt-5-codex"));
        assert!(needs_responses_api("gpt-5-pro"));
        assert!(!needs_responses_api("gpt-4o"));
        assert!(!needs_responses_api("gpt-5"));
    }

    #[test]
    fn context_budget_preserves_legacy_host_policy_defaults() {
        assert_eq!(context_budget("mistral-7b", None), 24_000);
        assert_eq!(context_budget("custom-private-model", None), 96_000);
        assert_eq!(context_budget("custom-private-model", Some(10_000)), 30_000);
    }
}
