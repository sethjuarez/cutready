//! Harness-neutral model capability and routing policy.
//!
//! CutReady owns model/provider policy. Harnesses declare what execution
//! surfaces they can consume, then receive a normalized route instead of
//! re-deciding provider quirks inside each adapter.

use serde::{Deserialize, Serialize};

use crate::llm::LlmProvider;

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct ModelIdentity {
    pub provider: LlmProvider,
    pub requested_model: String,
    pub base_model: String,
    #[serde(default)]
    pub deployment_id: Option<String>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct ModelCapabilityProfile {
    pub text_generation: bool,
    pub tool_calling: bool,
    pub vision: bool,
    pub reasoning_efforts: Vec<String>,
    pub realtime: bool,
    pub audio: bool,
    pub image_generation: bool,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum ModelApiRoute {
    ChatCompletions,
    Responses,
    AnthropicMessages,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum HistoryStrategy {
    ChatMessages,
    ResponsesSanitizedReplay,
    ResponsesContinuation,
    AnthropicMessages,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct HarnessRouteCapabilities {
    pub provider_owned: bool,
    pub external_model_selection: bool,
    pub chat_completions: bool,
    pub responses: bool,
    pub anthropic_messages: bool,
    pub tool_calling: bool,
    pub vision: bool,
    pub reasoning_effort: bool,
    pub sanitized_replay: bool,
    pub stateful_continuation: bool,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct AgentRunRequirements {
    pub tool_calling: bool,
    pub vision: bool,
    #[serde(default)]
    pub reasoning_effort: Option<String>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct AgentModelRoute {
    pub identity: ModelIdentity,
    pub capabilities: ModelCapabilityProfile,
    pub api_route: ModelApiRoute,
    pub history_strategy: HistoryStrategy,
    #[serde(default)]
    pub effective_reasoning_effort: Option<String>,
    pub effective_vision: bool,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum RouteError {
    HarnessOwnsProvider(String),
    ModelNotAgentCompatible(String),
    ToolCallingUnsupported(String),
    VisionUnsupported(String),
    RouteUnsupported(String),
}

impl std::fmt::Display for RouteError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            Self::HarnessOwnsProvider(harness) => {
                write!(f, "Harness '{harness}' owns provider/model selection")
            }
            Self::ModelNotAgentCompatible(model) => {
                write!(f, "Model '{model}' is not compatible with CutReady agents")
            }
            Self::ToolCallingUnsupported(model) => {
                write!(f, "Model '{model}' does not support agent tool calling")
            }
            Self::VisionUnsupported(model) => {
                write!(f, "Model '{model}' does not support the requested vision input")
            }
            Self::RouteUnsupported(route) => write!(f, "Selected harness cannot run {route}"),
        }
    }
}

pub fn harness_route_capabilities(harness_id: &str) -> HarnessRouteCapabilities {
    match harness_id {
        "copilot-sdk" => HarnessRouteCapabilities {
            provider_owned: true,
            external_model_selection: false,
            chat_completions: false,
            responses: false,
            anthropic_messages: false,
            tool_calling: true,
            vision: true,
            reasoning_effort: false,
            sanitized_replay: false,
            stateful_continuation: true,
        },
        "agentive" => HarnessRouteCapabilities {
            provider_owned: false,
            external_model_selection: true,
            chat_completions: true,
            responses: true,
            anthropic_messages: true,
            tool_calling: true,
            vision: true,
            reasoning_effort: true,
            sanitized_replay: true,
            stateful_continuation: false,
        },
        _ => HarnessRouteCapabilities {
            provider_owned: false,
            external_model_selection: true,
            chat_completions: true,
            responses: true,
            anthropic_messages: true,
            tool_calling: true,
            vision: true,
            reasoning_effort: true,
            sanitized_replay: true,
            stateful_continuation: false,
        },
    }
}

pub fn model_capability_profile(
    provider: &LlmProvider,
    model: &str,
    owned_by: Option<&str>,
    discovered_reasoning_efforts: Option<&str>,
) -> ModelCapabilityProfile {
    let classifier = owned_by.filter(|value| !value.trim().is_empty()).unwrap_or(model);
    let key = classifier.to_ascii_lowercase();
    let non_agent = is_non_agent_model(&key);
    let text_generation = !non_agent;
    let tool_calling = text_generation && !is_legacy_completion_model(&key);
    let vision = text_generation
        && (key.contains("gpt-4o")
            || key.contains("gpt-4.1")
            || key.contains("gpt-5")
            || key.contains("gpt-6")
            || key.contains("claude"));
    ModelCapabilityProfile {
        text_generation,
        tool_calling,
        vision,
        reasoning_efforts: reasoning_efforts(provider, &key, discovered_reasoning_efforts),
        realtime: key.contains("realtime") || key.contains("voice"),
        audio: key.contains("audio") || key.contains("speech") || key.contains("transcrib"),
        image_generation: key.contains("dall-e") || key.contains("image"),
    }
}

pub fn resolve_agent_model_route(
    provider: LlmProvider,
    model: &str,
    harness_id: &str,
    requirements: AgentRunRequirements,
    owned_by: Option<&str>,
    discovered_reasoning_efforts: Option<&str>,
) -> Result<AgentModelRoute, RouteError> {
    let harness = harness_route_capabilities(harness_id);
    if harness.provider_owned {
        return Err(RouteError::HarnessOwnsProvider(harness_id.to_string()));
    }

    let identity = ModelIdentity {
        provider: provider.clone(),
        requested_model: model.to_string(),
        base_model: owned_by
            .filter(|value| !value.trim().is_empty())
            .unwrap_or(model)
            .to_string(),
        deployment_id: owned_by
            .filter(|value| !value.trim().is_empty())
            .map(|_| model.to_string()),
    };
    let capabilities =
        model_capability_profile(&provider, model, owned_by, discovered_reasoning_efforts);

    if !capabilities.text_generation {
        return Err(RouteError::ModelNotAgentCompatible(model.to_string()));
    }
    if requirements.tool_calling && (!capabilities.tool_calling || !harness.tool_calling) {
        return Err(RouteError::ToolCallingUnsupported(model.to_string()));
    }
    if requirements.vision && (!capabilities.vision || !harness.vision) {
        return Err(RouteError::VisionUnsupported(model.to_string()));
    }

    let api_route = model_api_route(&provider, &identity.base_model);
    match api_route {
        ModelApiRoute::ChatCompletions if !harness.chat_completions => {
            return Err(RouteError::RouteUnsupported("Chat Completions".into()));
        }
        ModelApiRoute::Responses if !harness.responses => {
            return Err(RouteError::RouteUnsupported("Responses".into()));
        }
        ModelApiRoute::AnthropicMessages if !harness.anthropic_messages => {
            return Err(RouteError::RouteUnsupported("Anthropic Messages".into()));
        }
        _ => {}
    }

    let history_strategy = match api_route {
        ModelApiRoute::ChatCompletions => HistoryStrategy::ChatMessages,
        ModelApiRoute::Responses if harness.stateful_continuation => {
            HistoryStrategy::ResponsesContinuation
        }
        ModelApiRoute::Responses => HistoryStrategy::ResponsesSanitizedReplay,
        ModelApiRoute::AnthropicMessages => HistoryStrategy::AnthropicMessages,
    };

    let effective_reasoning_effort = requirements
        .reasoning_effort
        .as_deref()
        .map(str::trim)
        .filter(|effort| !effort.is_empty())
        .filter(|effort| {
            harness.reasoning_effort
                && api_route == ModelApiRoute::Responses
                && capabilities
                    .reasoning_efforts
                    .iter()
                    .any(|allowed| allowed.eq_ignore_ascii_case(effort))
        })
        .map(str::to_string);

    Ok(AgentModelRoute {
        identity,
        capabilities,
        api_route,
        history_strategy,
        effective_reasoning_effort,
        effective_vision: requirements.vision,
    })
}

pub fn model_api_route(provider: &LlmProvider, model: &str) -> ModelApiRoute {
    if matches!(provider, LlmProvider::Anthropic) {
        return ModelApiRoute::AnthropicMessages;
    }
    if requires_responses_api(model) {
        ModelApiRoute::Responses
    } else {
        ModelApiRoute::ChatCompletions
    }
}

pub fn requires_responses_api(model: &str) -> bool {
    let model = model.to_ascii_lowercase();
    model.contains("codex")
        || model.contains("gpt-6")
        || (model.contains("gpt-5") && model.ends_with("-pro"))
}

fn is_non_agent_model(model: &str) -> bool {
    [
        "embedding",
        "moderation",
        "rerank",
        "dall-e",
        "image",
        "audio",
        "speech",
        "transcrib",
        "realtime",
        "voice",
    ]
    .iter()
    .any(|needle| model.contains(needle))
}

fn is_legacy_completion_model(model: &str) -> bool {
    model.starts_with("babbage")
        || model.starts_with("davinci")
        || model.starts_with("curie")
        || model.starts_with("ada")
        || model.starts_with("text-")
}

fn reasoning_efforts(
    provider: &LlmProvider,
    model: &str,
    discovered_reasoning_efforts: Option<&str>,
) -> Vec<String> {
    let discovered = discovered_reasoning_efforts
        .unwrap_or_default()
        .split(',')
        .map(str::trim)
        .filter(|value| !value.is_empty())
        .map(str::to_ascii_lowercase)
        .collect::<Vec<_>>();
    if !discovered.is_empty() {
        return discovered;
    }
    if !matches!(
        provider,
        LlmProvider::Openai | LlmProvider::AzureOpenai | LlmProvider::MicrosoftFoundry
    ) {
        return Vec::new();
    }
    if model.contains("gpt-6") {
        return ["low", "medium", "high", "xhigh", "max"]
            .into_iter()
            .map(str::to_string)
            .collect();
    }
    if model.contains("gpt-5") {
        return ["low", "medium", "high", "xhigh"]
            .into_iter()
            .map(str::to_string)
            .collect();
    }
    if model.starts_with("o1") || model.starts_with("o3") || model.starts_with("o4") {
        return ["low", "medium", "high"]
            .into_iter()
            .map(str::to_string)
            .collect();
    }
    Vec::new()
}

#[cfg(test)]
mod tests {
    use super::*;

    fn requirements() -> AgentRunRequirements {
        AgentRunRequirements {
            tool_calling: true,
            vision: false,
            reasoning_effort: Some("high".into()),
        }
    }

    #[test]
    fn routes_gpt6_to_responses_for_prompty() {
        let route = resolve_agent_model_route(
            LlmProvider::Openai,
            "gpt-6.1-sol",
            "prompty",
            requirements(),
            None,
            None,
        )
        .unwrap();

        assert_eq!(route.api_route, ModelApiRoute::Responses);
        assert_eq!(
            route.history_strategy,
            HistoryStrategy::ResponsesSanitizedReplay
        );
        assert_eq!(route.effective_reasoning_effort.as_deref(), Some("high"));
    }

    #[test]
    fn routes_gpt4o_to_chat_for_prompty() {
        let route = resolve_agent_model_route(
            LlmProvider::Openai,
            "gpt-4o",
            "prompty",
            requirements(),
            None,
            None,
        )
        .unwrap();

        assert_eq!(route.api_route, ModelApiRoute::ChatCompletions);
        assert_eq!(route.history_strategy, HistoryStrategy::ChatMessages);
        assert_eq!(route.effective_reasoning_effort, None);
    }

    #[test]
    fn suppresses_reasoning_for_chat_route_even_without_tools() {
        let route = resolve_agent_model_route(
            LlmProvider::Openai,
            "gpt-5.6-luna",
            "prompty",
            AgentRunRequirements {
                tool_calling: false,
                vision: false,
                reasoning_effort: Some("high".into()),
            },
            None,
            None,
        )
        .unwrap();

        assert_eq!(route.api_route, ModelApiRoute::ChatCompletions);
        assert_eq!(route.effective_reasoning_effort, None);
    }

    #[test]
    fn routes_deployment_alias_by_base_model() {
        let route = resolve_agent_model_route(
            LlmProvider::MicrosoftFoundry,
            "demo-deployment",
            "prompty",
            requirements(),
            Some("gpt-6-astra"),
            Some("low,medium,high,xhigh,max"),
        )
        .unwrap();

        assert_eq!(route.identity.requested_model, "demo-deployment");
        assert_eq!(route.identity.base_model, "gpt-6-astra");
        assert_eq!(route.identity.deployment_id.as_deref(), Some("demo-deployment"));
        assert_eq!(route.api_route, ModelApiRoute::Responses);
        assert_eq!(route.effective_reasoning_effort.as_deref(), Some("high"));
    }

    #[test]
    fn rejects_non_agent_models() {
        let error = resolve_agent_model_route(
            LlmProvider::Openai,
            "gpt-4o-realtime-preview",
            "prompty",
            requirements(),
            None,
            None,
        )
        .unwrap_err();

        assert!(matches!(error, RouteError::ModelNotAgentCompatible(_)));
    }

    #[test]
    fn copilot_sdk_owns_model_selection() {
        let error = resolve_agent_model_route(
            LlmProvider::Openai,
            "gpt-4o",
            "copilot-sdk",
            requirements(),
            None,
            None,
        )
        .unwrap_err();

        assert!(matches!(error, RouteError::HarnessOwnsProvider(_)));
    }
}
