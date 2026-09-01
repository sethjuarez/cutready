//! Prompty agent harness adapter.
//!
//! This module is the *only* place the production Prompty runtime is wired into
//! the harness seam. Everything Prompty-specific — building the Prompty model,
//! driving the `TurnEngine` through [`crate::run`], and the per-run steering
//! queue — stays behind this adapter. Nothing harness-native is exposed to the
//! host beyond the CutReady-owned boundary types in [`harness_contract`].
//!
//! Host-owned capabilities the runner needs but does not own are injected as
//! seams rather than imported, so this crate never depends on the app: the
//! [`PromptyHost`] tool/reference seam and the optional [`DurableRunStore`] are
//! handed to [`PromptyHarness::new`] by the host factory.

use async_trait::async_trait;
use std::sync::Arc;

use harness_contract::execution::AgentEvent;
use harness_contract::{
    AgentHarness, AgentRunRequest, AgentRunResult, HarnessCapabilities, HarnessContract,
    HarnessEventEmitter, Ownership,
};

use crate::{build_production_model, DurableRunStore, PromptyHost, PromptySteering};

/// Production harness backed by the Prompty `TurnEngine`.
pub struct PromptyHarness {
    steering: PromptySteering,
    /// Host-owned tool contract and project-reference resolution.
    ///
    /// Prompty owns none of its tools or project knowledge, so the host injects
    /// a concrete [`PromptyHost`] rather than this crate importing app domain
    /// logic.
    host: Arc<dyn PromptyHost>,
    /// Concrete durable run-state store for this run, when available.
    ///
    /// Durable persistence is a Prompty-only concern, so the host injects the
    /// concrete store directly into this adapter (via [`PromptyHarness::new`])
    /// instead of routing it through the harness-agnostic [`AgentRunRequest`].
    /// The other adapters never receive it, and it is `None` when durability is
    /// unavailable for the run.
    durable: Option<Arc<dyn DurableRunStore>>,
}

impl PromptyHarness {
    /// Canonical, stable identifier for this harness.
    pub const ID: &'static str = "prompty";

    /// Build a Prompty harness bound to the host-owned steering queue, the
    /// injected [`PromptyHost`], and the per-run durable store (when durability
    /// is available for the run).
    pub fn new(
        steering: PromptySteering,
        host: Arc<dyn PromptyHost>,
        durable: Option<Arc<dyn DurableRunStore>>,
    ) -> Self {
        Self {
            steering,
            host,
            durable,
        }
    }

    /// Capability metadata for the Prompty runtime.
    ///
    /// Prompty currently backs the full CutReady host feature set, so every
    /// capability is advertised as supported. Consumed by the registry's
    /// capability lookup and conformance tests.
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

        // Durable run state and the tool/reference host are injected directly
        // into this adapter by the host factory, not carried on the
        // harness-agnostic request. Prompty is the only harness that persists
        // durable state; `durable` is `None` when durability is unavailable.
        let durable = self.durable.clone();
        let host = self.host.clone();

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

        let result = crate::run(
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
    use std::path::Path;

    use harness_contract::execution::{ToolCall, ToolOutput};
    use harness_contract::tools::{ToolDefinition, ToolExecutionContext};

    use crate::{ContextAssetExcerpt, ResolvedProjectReference};

    /// Minimal host stub: the injection seam tests only need a value of the
    /// right trait type, never a real tool run.
    struct StubHost;

    impl PromptyHost for StubHost {
        fn all_tools(&self, _: bool, _: bool, _: bool) -> Vec<ToolDefinition> {
            Vec::new()
        }

        fn execute_tool(&self, _: &ToolCall, _: &ToolExecutionContext) -> ToolOutput {
            unreachable!("injection seam tests never execute tools")
        }

        fn is_read_only_tool(&self, _: &str) -> bool {
            true
        }

        fn is_tool_error(&self, _: &str) -> bool {
            false
        }

        fn resolve_project_references(
            &self,
            _: &Path,
            _: &[String],
        ) -> Vec<ResolvedProjectReference> {
            Vec::new()
        }
    }

    /// Durable store stub. The retention test proves the exact injected store
    /// survives construction by comparing `Arc` identity, so no state is needed.
    struct StubDurable;

    impl DurableRunStore for StubDurable {
        fn append_event(&self, _: &::prompty::EngineEvent) -> Result<(), String> {
            Ok(())
        }

        fn append_events_with_checkpoint(
            &self,
            _: &[::prompty::EngineEvent],
            _: &::prompty::EngineCheckpoint,
        ) -> Result<(), String> {
            Ok(())
        }

        fn read_context_asset(
            &self,
            _: &str,
            _: usize,
            _: usize,
        ) -> Result<ContextAssetExcerpt, String> {
            Err("unused".to_string())
        }

        fn record_native_memory_promotion(
            &self,
            _: &serde_json::Value,
        ) -> Result<(), String> {
            Ok(())
        }
    }

    fn host() -> Arc<dyn PromptyHost> {
        Arc::new(StubHost)
    }

    /// The host injects the concrete durable store through the constructor
    /// (never through the harness-agnostic request), so the adapter must retain
    /// exactly what it was handed. This guards the injection seam that replaced
    /// the removed `AgentRunRequest::agent_state` field: a regression that drops
    /// the store on the floor would silently disable durable checkpoints.
    #[test]
    fn new_retains_injected_durable_store() {
        let store = Arc::new(StubDurable);
        // Keep a second handle so we can compare identity after injection.
        let store_ptr = Arc::as_ptr(&store) as *const () as usize;

        let harness = PromptyHarness::new(
            PromptySteering::new(),
            host(),
            Some(store as Arc<dyn DurableRunStore>),
        );

        let injected = harness
            .durable
            .as_ref()
            .expect("Prompty adapter must retain the injected durable store");
        assert_eq!(
            Arc::as_ptr(injected) as *const () as usize,
            store_ptr,
            "the adapter must retain the exact store it was handed"
        );
    }

    /// When durability is unavailable the host injects `None`, and the adapter
    /// must not fabricate a store — the downstream runner keys its "durable
    /// checkpoints unavailable" fallback off this being absent.
    #[test]
    fn new_without_store_leaves_durability_absent() {
        let harness = PromptyHarness::new(PromptySteering::new(), host(), None);
        assert!(harness.durable.is_none());
    }
}
