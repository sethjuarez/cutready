//! Prompty agent harness adapter.
//!
//! This module is the *only* place the production Prompty runtime is wired into
//! the harness seam. Everything Prompty-specific — building the Prompty model,
//! driving the `TurnEngine` through [`crate::engine::agent::prompty_runner`],
//! and the per-run steering queue — stays behind this adapter. Nothing
//! harness-native is exposed to the host beyond the CutReady-owned boundary
//! types in [`super`].

use async_trait::async_trait;
use std::sync::Arc;

use crate::engine::agent::execution::AgentEvent;
use crate::engine::agent::prompty_model::build_production_model;
use crate::engine::agent::prompty_runner;
use crate::engine::agent_state::AgentStateStore;

use super::{
    AgentHarness, AgentRunRequest, AgentRunResult, HarnessCapabilities, HarnessContract,
    HarnessEventEmitter, Ownership,
};

/// CutReady's steering queue for the Prompty engine.
///
/// It is defined in [`prompty_runner`] and owned by the Prompty adapter so that
/// steering never crosses the harness boundary. Re-exported here as the
/// harness-facing handle the registry threads through from app state.
pub use crate::engine::agent::prompty_runner::PromptySteering;

/// Production harness backed by the Prompty `TurnEngine`.
pub struct PromptyHarness {
    steering: PromptySteering,
    /// Concrete durable run-state store for this run, when available.
    ///
    /// Durable persistence is a Prompty-only concern, so the host injects the
    /// concrete store directly into this adapter (via [`PromptyHarness::new`])
    /// instead of routing it through the harness-agnostic [`AgentRunRequest`].
    /// The other adapters never receive it.
    agent_state: Option<AgentStateStore>,
}

impl PromptyHarness {
    /// Canonical, stable identifier for this harness.
    pub const ID: &'static str = "prompty";

    /// Build a Prompty harness bound to the host-owned steering queue and the
    /// per-run durable store (when durability is available for the run).
    pub fn new(steering: PromptySteering, agent_state: Option<AgentStateStore>) -> Self {
        Self {
            steering,
            agent_state,
        }
    }

    /// Capability metadata for the Prompty runtime.
    ///
    /// Prompty currently backs the full CutReady host feature set, so every
    /// capability is advertised as supported. Consumed by the registry's
    /// capability lookup and conformance tests.
    #[allow(dead_code)]
    pub fn static_capabilities() -> HarnessCapabilities {
        HarnessCapabilities {
            id: Self::ID.to_string(),
            display_name: "Prompty".to_string(),
            streaming: true,
            tool_calls: true,
            vision: true,
            web_search: true,
            delegation: true,
            steering: true,
            cancellation: true,
            durable_state: true,
        }
    }

    /// Ownership contract for the Prompty runtime.
    ///
    /// Prompty is a host-driven engine: CutReady must supply the model provider,
    /// the agent personas, the tool contract, and the durable run state. It owns
    /// none of them, so every concern is [`Ownership::Requires`].
    #[allow(dead_code)]
    pub fn static_contract() -> HarnessContract {
        HarnessContract {
            provider: Ownership::Requires,
            personas: Ownership::Requires,
            tools: Ownership::Requires,
            memory: Ownership::Requires,
        }
    }
}

#[async_trait]
impl AgentHarness for PromptyHarness {
    fn id(&self) -> &str {
        Self::ID
    }

    fn capabilities(&self) -> HarnessCapabilities {
        Self::static_capabilities()
    }

    fn contract(&self) -> HarnessContract {
        Self::static_contract()
    }

    async fn run(
        &self,
        request: AgentRunRequest,
        emit: HarnessEventEmitter,
    ) -> Result<AgentRunResult, String> {
        let AgentRunRequest {
            config,
            messages,
            repo_root,
            project_root,
            agent_id,
            agent_prompts,
            mutation_tools_enabled,
            tools,
            context_items,
            run_id,
            cancellation,
        } = request;

        // Durable run state is injected directly into this adapter by the host,
        // not carried on the harness-agnostic request. Prompty is the only
        // harness that persists it; the store is `None` when durability is
        // unavailable for the run.
        let durable = self
            .agent_state
            .clone()
            .map(|store| Arc::new(store) as Arc<dyn harness_prompty::DurableRunStore>);
        let host: Arc<dyn harness_prompty::PromptyHost> = Arc::new(super::AppPromptyHost);

        // Translate the CutReady-owned tool contract and provider config into a
        // Prompty model. This is the boundary where `prompty::*` types begin.
        let production_model =
            build_production_model(&config.llm, config.reported_context_length, tools)?;

        // Adapt the host-owned event sink into the closure the runner expects.
        // The runner immediately wraps this in its own `Arc`, so forwarding
        // through the shared emitter preserves the exact event shape.
        let emit_for_runner = move |event: AgentEvent| {
            (*emit)(event);
        };

        let result = prompty_runner::run(
            production_model.port,
            production_model.provider_name,
            production_model.model_name,
            production_model.context_budget_chars,
            messages,
            &repo_root,
            &project_root,
            &agent_id,
            &agent_prompts,
            self.steering.clone(),
            &config.vision,
            &config.web_access,
            mutation_tools_enabled,
            config.max_tool_rounds,
            context_items,
            Some(run_id),
            host,
            durable,
            cancellation,
            emit_for_runner,
        )
        .await?;

        Ok(AgentRunResult {
            messages: result.messages,
            response: result.response,
            usage: result.total_usage,
        })
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    /// The host injects the concrete durable store through the constructor
    /// (never through the harness-agnostic request), so the adapter must retain
    /// exactly what it was handed. This guards the injection seam that replaced
    /// the removed `AgentRunRequest::agent_state` field: a regression that drops
    /// the store on the floor would silently disable durable checkpoints.
    #[test]
    fn new_retains_injected_durable_store() {
        let project_root = tempfile::tempdir().unwrap().keep();
        let store =
            AgentStateStore::for_project(&project_root, &project_root, "run-harness-injection")
                .unwrap();

        let harness = PromptyHarness::new(PromptySteering::new(), Some(store));

        let injected = harness
            .agent_state
            .as_ref()
            .expect("Prompty adapter must retain the injected durable store");
        assert_eq!(injected.run_id(), "run-harness-injection");
    }

    /// When durability is unavailable the host injects `None`, and the adapter
    /// must not fabricate a store — the downstream runner keys its "durable
    /// checkpoints unavailable" fallback off this being absent.
    #[test]
    fn new_without_store_leaves_durability_absent() {
        let harness = PromptyHarness::new(PromptySteering::new(), None);
        assert!(harness.agent_state.is_none());
    }
}
