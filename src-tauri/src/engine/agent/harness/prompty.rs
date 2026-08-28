//! Prompty agent harness adapter.
//!
//! This module is the *only* place the production Prompty runtime is wired into
//! the harness seam. Everything Prompty-specific — building the Prompty model,
//! driving the `TurnEngine` through [`crate::engine::agent::prompty_runner`],
//! and the per-run steering queue — stays behind this adapter. Nothing
//! harness-native is exposed to the host beyond the CutReady-owned boundary
//! types in [`super`].

use async_trait::async_trait;

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
}

impl PromptyHarness {
    /// Canonical, stable identifier for this harness.
    pub const ID: &'static str = "prompty";

    /// Build a Prompty harness bound to the host-owned steering queue.
    pub fn new(steering: PromptySteering) -> Self {
        Self { steering }
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
            agent_state,
            cancellation,
        } = request;

        // Recover the concrete durable store from the opaque, host-owned
        // [`RunStateHandle`]. Prompty is the only harness that consumes durable
        // run state; the downcast yields `None` for any other handle type.
        let agent_state = agent_state
            .and_then(|handle| handle.into_any().downcast::<AgentStateStore>().ok())
            .map(|store| (*store).clone());

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
            agent_state,
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
