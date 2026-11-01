//! Unit tests for `commands::agent`, kept out of the module to hold its file budget.

use super::*;
use crate::engine::agent::llm::LlmProvider;

#[test]
fn oauth_token_ipc_matches_frontend_refresh_fixture() {
    let fixture: serde_json::Value = serde_json::from_str(include_str!(
        "../../../src/test/fixtures/oauth-token-response.json"
    ))
    .unwrap();
    let token: TokenResponse = serde_json::from_value(fixture.clone()).unwrap();

    assert_eq!(token.access_token, "fixture-access-token");
    assert_eq!(
        token.refresh_token.as_deref(),
        Some("fixture-refresh-token")
    );
    assert_eq!(serde_json::to_value(token).unwrap(), fixture);
}

fn make_config(provider: &str) -> ProviderConfig {
    ProviderConfig {
        provider_id: Some("provider-test".into()),
        provider_name: Some("Provider Test".into()),
        provider: provider.into(),
        endpoint: "https://example.com".into(),
        api_key: "key".into(),
        model: "gpt-4o".into(),
        model_base_model: None,
        bearer_token: Some("token".into()),
        context_length: Some(128_000),
        vision_mode: Some("off".into()),
        model_supports_vision: Some(true),
        web_access: Some("disabled".into()),
        max_tool_rounds: Some(harness_prompty::DEFAULT_MAX_TOOL_ROUNDS),
        reasoning_effort: None,
        model_reasoning_efforts: None,
        execution_engine: None,
    }
}

#[cfg(feature = "harness-agentive")]
#[test]
fn execution_engine_defaults_to_prompty_and_resolves_agentive() {
    assert_eq!(
        HarnessRegistry::canonical_id(None).unwrap(),
        crate::engine::agent::harness::DEFAULT_HARNESS_ID
    );
    // Agentive is now a real, selectable harness (issue #246) and resolves
    // to its own id rather than aliasing onto Prompty.
    assert_eq!(
        HarnessRegistry::canonical_id(Some("agentive")).unwrap(),
        crate::engine::agent::harness::AGENTIVE_HARNESS_ID
    );
    assert_eq!(
        HarnessRegistry::canonical_id(Some("prompty")).unwrap(),
        crate::engine::agent::harness::DEFAULT_HARNESS_ID
    );
    let mut expected_ids = vec!["'prompty'"];
    #[cfg(feature = "harness-agentive")]
    expected_ids.push("'agentive'");
    #[cfg(feature = "harness-copilot-sdk")]
    expected_ids.push("'copilot-sdk'");
    assert_eq!(
        HarnessRegistry::canonical_id(Some("other")).unwrap_err(),
        format!(
            "Unsupported execution_engine 'other'. Expected one of {}.",
            expected_ids.join(", ")
        )
    );
}

#[test]
fn provider_config_to_llm_config_azure() {
    let config: LlmConfig = make_config("azure_openai").into();
    assert_eq!(config.provider, LlmProvider::AzureOpenai);
    assert_eq!(config.endpoint, "https://example.com");
    assert_eq!(config.api_key, "key");
    assert_eq!(config.model, "gpt-4o");
    assert_eq!(config.bearer_token, Some("token".into()));
}

#[test]
fn provider_config_to_llm_config_preserves_reasoning_effort() {
    let mut config = make_config("openai");
    config.model = "gpt-5.6-terra".into();
    config.reasoning_effort = Some("high".into());
    let config: LlmConfig = config.into();
    assert_eq!(config.reasoning_effort.as_deref(), Some("high"));
}

#[test]
fn reasoning_effort_validation_rejects_unsupported_model() {
    let error = normalize_reasoning_effort(Some("high"), "openai", "gpt-4o", None)
        .expect_err("gpt-4o should not accept reasoning effort");
    assert!(error.contains("not supported"));
    assert_eq!(
        normalize_reasoning_effort(Some("high"), "openai", "gpt-5.6-terra", None).unwrap(),
        Some("high".into())
    );
}

#[test]
fn reasoning_effort_validation_accepts_discovered_deployment_capability() {
    assert_eq!(
        normalize_reasoning_effort(
            Some("medium"),
            "microsoft_foundry",
            "demo-deployment",
            Some("low,medium,high")
        )
        .unwrap(),
        Some("medium".into())
    );
    assert_eq!(
        normalize_reasoning_effort(
            Some("high"),
            "microsoft_foundry",
            "demo-deployment",
            Some("Low,Medium,High")
        )
        .unwrap(),
        Some("high".into())
    );
    assert_eq!(
        normalize_reasoning_effort(Some("high"), "openai", "gpt-6.1-sol", Some("")).unwrap(),
        Some("high".into())
    );
    assert!(normalize_reasoning_effort(
        Some("medium"),
        "anthropic",
        "claude-opus-4-8",
        Some("low,medium,high")
    )
    .is_err());
}

#[test]
fn prompty_reasoning_effort_only_applies_to_responses_models() {
    let mut chat = make_config("openai");
    chat.model = "gpt-5.6-luna".into();
    chat.reasoning_effort = Some("high".into());
    let chat_route = resolve_prompty_model_route(&chat).unwrap();
    assert_eq!(chat_route.effective_reasoning_effort, None);

    let mut responses = make_config("openai");
    responses.model = "gpt-6.1-sol".into();
    responses.reasoning_effort = Some("high".into());
    let responses_route = resolve_prompty_model_route(&responses).unwrap();
    assert_eq!(
        responses_route.effective_reasoning_effort.as_deref(),
        Some("high")
    );

    for model in ["gpt-5.1-codex", "gpt-5-pro"] {
        let mut config = make_config("openai");
        config.model = model.into();
        config.reasoning_effort = Some("high".into());
        let route = resolve_prompty_model_route(&config).unwrap();
        assert_eq!(route.effective_reasoning_effort.as_deref(), Some("high"));
    }

    let mut alias = make_config("microsoft_foundry");
    alias.model = "demo-deployment".into();
    alias.model_base_model = Some("gpt-6-astra".into());
    alias.model_reasoning_efforts = Some("low,medium,high,xhigh,max".into());
    alias.reasoning_effort = Some("medium".into());
    let alias_route = resolve_prompty_model_route(&alias).unwrap();
    assert_eq!(alias_route.identity.base_model, "gpt-6-astra");
    assert_eq!(
        alias_route.effective_reasoning_effort.as_deref(),
        Some("medium")
    );
}

#[tokio::test]
async fn route_preview_matches_run_policy_for_deployment_alias() {
    let mut config = make_config("microsoft_foundry");
    config.model = "demo-deployment".into();
    config.model_base_model = Some("gpt-6-astra".into());
    config.model_reasoning_efforts = Some("low,medium,high,xhigh,max".into());
    config.reasoning_effort = Some("medium".into());

    let route = preview_agent_model_route_inner(config)
        .unwrap()
        .expect("prompty exposes an explicit route");

    assert_eq!(route.identity.base_model, "gpt-6-astra");
    assert_eq!(
        route.api_route,
        harness_contract::routing::ModelApiRoute::Responses
    );
    assert_eq!(route.effective_reasoning_effort.as_deref(), Some("medium"));
}

#[tokio::test]
async fn route_preview_uses_shared_policy_without_provider_secrets() {
    let mut config = make_config("openai");
    config.api_key = String::new();
    config.bearer_token = None;
    config.model = "gpt-6.1-sol".into();
    config.reasoning_effort = Some("high".into());

    let route = preview_agent_model_route_inner(config)
        .unwrap()
        .expect("prompty exposes an explicit route");

    assert_eq!(
        route.api_route,
        harness_contract::routing::ModelApiRoute::Responses
    );
    assert_eq!(route.effective_reasoning_effort.as_deref(), Some("high"));
}

#[tokio::test]
async fn route_preview_returns_none_when_harness_owns_provider() {
    if HarnessRegistry::canonical_id(Some("copilot-sdk")).is_err() {
        return;
    }
    let mut config = make_config("openai");
    config.execution_engine = Some("copilot-sdk".into());

    assert!(preview_agent_model_route_inner(config).unwrap().is_none());
}

#[test]
fn provider_config_to_llm_config_foundry() {
    let config: LlmConfig = make_config("microsoft_foundry").into();
    assert_eq!(config.provider, LlmProvider::MicrosoftFoundry);
}

#[test]
fn provider_config_to_llm_config_openai() {
    let config: LlmConfig = make_config("openai").into();
    assert_eq!(config.provider, LlmProvider::Openai);
}

#[test]
fn provider_config_to_llm_config_anthropic() {
    let config: LlmConfig = make_config("anthropic").into();
    assert_eq!(config.provider, LlmProvider::Anthropic);
}

#[test]
fn provider_config_unknown_defaults_to_azure() {
    let config: LlmConfig = make_config("some_future_provider").into();
    assert_eq!(config.provider, LlmProvider::AzureOpenai);
}

#[cfg(all(feature = "harness-agentive", feature = "harness-copilot-sdk"))]
#[test]
fn all_known_engines_resolve_through_the_registry() {
    // Engine selection is centralized in the registry. Every selectable id
    // maps to its own canonical harness; agentive (#246) and the Copilot SDK
    // (#247) are wired alongside the Prompty default.
    assert_eq!(
        HarnessRegistry::canonical_id(Some("prompty")).unwrap(),
        crate::engine::agent::harness::DEFAULT_HARNESS_ID
    );
    assert_eq!(
        HarnessRegistry::canonical_id(Some("agentive")).unwrap(),
        crate::engine::agent::harness::AGENTIVE_HARNESS_ID
    );
    assert_eq!(
        HarnessRegistry::canonical_id(Some("copilot-sdk")).unwrap(),
        crate::engine::agent::harness::COPILOT_SDK_HARNESS_ID
    );
}

#[test]
fn prompty_production_boundary_has_no_agentive_mapping_static_or_runtime() {
    assert_eq!(
        HarnessRegistry::canonical_id(Some("prompty")).unwrap(),
        crate::engine::agent::harness::DEFAULT_HARNESS_ID
    );

    let runner = include_str!("../../../crates/harness-prompty/src/runner.rs")
        .split("\n#[cfg(test)]\nmod tests")
        .next()
        .unwrap();
    let model = include_str!("../../../crates/harness-prompty/src/model.rs")
        .split("\n#[cfg(test)]\nmod tests")
        .next()
        .unwrap();
    // The Prompty harness adapter must also stay free of agentive mappings;
    // the real agentive harness lives under its own adapter crate (#246).
    let harness_adapter = include_str!("../../../crates/harness-prompty/src/adapter.rs")
        .split("\n#[cfg(test)]\nmod tests")
        .next()
        .unwrap();
    for forbidden in [
        "agentive::",
        "agentive_adapter",
        "agentive::CancellationToken",
        "agentive::ToolCall",
        "agentive::ToolResult",
    ] {
        assert!(
            !runner.contains(forbidden)
                && !model.contains(forbidden)
                && !harness_adapter.contains(forbidden),
            "production Prompty boundary contains forbidden mapping: {forbidden}"
        );
    }
}

#[test]
fn prompty_lifecycle_failure_trace_payload_omits_sensitive_bodies() {
    let payload =
        agent_run_failure_trace_payload("openai", "gpt-test", "prompty", "run-1", 42, false);

    assert_eq!(payload["error_kind"], "execution_failed");
    assert!(payload.get("error").is_none());
    assert!(payload.get("messages").is_none());
    assert!(payload.get("request").is_none());
    assert!(payload.get("response").is_none());
    assert!(!payload.to_string().contains("sensitive-body-marker"));
}

#[tokio::test]
async fn cancellation_registry_cancels_only_the_matching_client_run() {
    let cancellations = Arc::new(Mutex::new(std::collections::HashMap::new()));
    let first_cancellation = RunCancellation::new();
    let second_cancellation = RunCancellation::new();
    let _first_guard = AgentChatCancellationGuard::register(
        cancellations.clone(),
        "first".into(),
        first_cancellation.clone(),
    )
    .unwrap();
    let _second_guard = AgentChatCancellationGuard::register(
        cancellations.clone(),
        "second".into(),
        second_cancellation.clone(),
    )
    .unwrap();

    assert!(cancel_agent_chat_run_in_registry(&cancellations, "first").unwrap());
    assert!(first_cancellation.is_cancelled());
    assert!(!second_cancellation.is_cancelled());
    assert!(!cancel_agent_chat_run_in_registry(&cancellations, "first").unwrap());
    assert!(cancel_agent_chat_run_in_registry(&cancellations, "second").unwrap());
    assert!(second_cancellation.is_cancelled());
}

#[test]
fn cancellation_registry_rejects_duplicate_client_run_ids() {
    let cancellations = Arc::new(Mutex::new(std::collections::HashMap::new()));
    let _guard = AgentChatCancellationGuard::register(
        cancellations.clone(),
        "same-run".into(),
        RunCancellation::new(),
    )
    .unwrap();

    assert!(matches!(
        AgentChatCancellationGuard::register(
            cancellations,
            "same-run".into(),
            RunCancellation::new(),
        ),
        Err(error) if error.contains("already active")
    ));
}

#[test]
fn agent_events_keep_original_fields_when_client_run_id_is_added() {
    let payload = agent_event_payload(
        &AgentEvent::Status {
            message: "Thinking…".into(),
        },
        Some("42"),
    );

    assert_eq!(payload["type"], "status");
    assert_eq!(payload["message"], "Thinking…");
    assert_eq!(payload["client_run_id"], "42");
}
