//! CutReady-owned agent harness seam.
//!
//! An *agent harness* is the pluggable runtime that actually drives an agent
//! turn (model calls, the tool loop, streaming, cancellation). CutReady owns
//! the host boundary around that runtime: the request/result DTOs, the event
//! shape, the tool contract, path confinement, settings UX, and persistence
//! policy all live on this side of the seam and never change when the harness
//! implementation changes.
//!
//! Harness-native types (for example `prompty::*`, `agentive::*`, or Copilot
//! SDK types) must stay inside the concrete adapter for that harness. Nothing
//! harness-specific may appear in this module or leak past [`AgentHarness::run`].
//!
//! Prompty is the stable default implementation, selected through
//! [`HarnessRegistry`]. Agentive and the Copilot SDK remain distinct optional
//! adapters rather than aliases onto Prompty.

#[cfg(feature = "harness-agentive")]
pub use harness_agentive as agentive;
#[cfg(feature = "harness-copilot-sdk")]
pub use harness_copilot_sdk as copilot_sdk;
pub use harness_prompty as prompty;

use std::sync::Arc;

// The stable host boundary vocabulary and the `AgentHarness` trait now live in
// the `harness-contract` crate so harness adapter crates can depend on them
// without depending on the app. Re-export the whole seam here so this module
// stays the single import surface and existing `harness::` call sites are
// unchanged. Some names are only consumed by adapter crates or tests; the seam
// stays complete regardless, so unused-in-app re-exports are allowed.
#[allow(unused_imports)]
pub use harness_contract::harness::{
    AgentHarness, AgentRunRequest, AgentRunResult, HarnessCapabilities, HarnessConfig,
    HarnessContract, HarnessDescriptor, HarnessEventEmitter, HarnessStability, Ownership,
};

// Boundary DTOs the seam also surfaces. They live in `execution.rs` / `tools.rs`
// (which now re-export from the contract crate); kept here so harness authors
// have a single import surface for the seam.
#[allow(unused_imports)]
pub use crate::engine::agent::execution::{AgentEvent, ContextItem, ToolCall, ToolOutput};
pub use crate::engine::agent::tools::ToolDefinition;

#[cfg(feature = "harness-agentive")]
use self::agentive::AgentiveHarness;
#[cfg(feature = "harness-copilot-sdk")]
use self::copilot_sdk::CopilotSdkHarness;
use self::prompty::PromptyHarness;
use crate::engine::agent_state::AgentStateStore;

/// Host-side [`HostToolExecutor`](harness_contract::tools::HostToolExecutor)
/// injected into the agentive harness. It forwards to the app's path-confined
/// [`execute_tool`](crate::engine::agent::tools::execute_tool), keeping tool
/// policy and filesystem confinement on the CutReady side of the seam while the
/// adapter crate stays free of any app dependency.
#[cfg(feature = "harness-agentive")]
struct AppToolExecutor;

#[cfg(feature = "harness-agentive")]
impl harness_contract::tools::HostToolExecutor for AppToolExecutor {
    fn execute(
        &self,
        call: &ToolCall,
        ctx: &harness_contract::tools::ToolExecutionContext,
    ) -> ToolOutput {
        crate::engine::agent::tools::execute_tool(
            call,
            &ctx.repo_root,
            &ctx.project_root,
            ctx.vision_enabled,
            ctx.project_workspace_tools_enabled,
            ctx.mutation_tools_enabled,
        )
    }
}
// ---------------------------------------------------------------------------
// Registry / factory
// ---------------------------------------------------------------------------

/// Host-side [`PromptyHost`](harness_prompty::PromptyHost) injected into the
/// Prompty harness. Prompty owns none of its tools or project knowledge, so this
/// forwards tool listing, path-confined execution, tool policy, and project
/// reference resolution to the app while the adapter crate stays free of any app
/// dependency.
pub(crate) struct AppPromptyHost;

impl harness_prompty::PromptyHost for AppPromptyHost {
    fn all_tools(
        &self,
        web_search_enabled: bool,
        project_workspace_tools_enabled: bool,
        mutation_tools_enabled: bool,
    ) -> Vec<ToolDefinition> {
        crate::engine::agent::tools::all_tools(
            web_search_enabled,
            project_workspace_tools_enabled,
            mutation_tools_enabled,
        )
    }

    fn execute_tool(
        &self,
        call: &ToolCall,
        ctx: &harness_contract::tools::ToolExecutionContext,
    ) -> ToolOutput {
        crate::engine::agent::tools::execute_tool(
            call,
            &ctx.repo_root,
            &ctx.project_root,
            ctx.vision_enabled,
            ctx.project_workspace_tools_enabled,
            ctx.mutation_tools_enabled,
        )
    }

    fn is_read_only_tool(&self, name: &str) -> bool {
        crate::engine::agent::tools::is_read_only_tool(name)
    }

    fn is_tool_error(&self, result_text: &str) -> bool {
        crate::engine::agent::tools::is_tool_error(result_text)
    }

    fn resolve_project_references(
        &self,
        project_root: &std::path::Path,
        user_messages: &[String],
    ) -> Vec<harness_prompty::ResolvedProjectReference> {
        crate::engine::agent::reference_context::resolve_project_references(
            project_root,
            user_messages,
        )
        .into_iter()
        .map(|reference| harness_prompty::ResolvedProjectReference {
            id: reference.id,
            reference: reference.reference,
            name: reference.name,
            content: reference.content,
            content_type: reference.content_type,
        })
        .collect()
    }
}

/// The app's durable [`AgentStateStore`] is the concrete Prompty run-state store.
/// Implementing the adapter crate's [`DurableRunStore`](harness_prompty::DurableRunStore)
/// seam here keeps the SQLite-backed persistence on the CutReady side while the
/// Prompty adapter depends only on the trait.
impl harness_prompty::DurableRunStore for AgentStateStore {
    fn append_event(&self, event: &::prompty::EngineEvent) -> Result<(), String> {
        self.append_prompty_event(event)
    }

    fn append_events_with_checkpoint(
        &self,
        events: &[::prompty::EngineEvent],
        checkpoint: &::prompty::EngineCheckpoint,
    ) -> Result<(), String> {
        self.append_prompty_events_with_checkpoint(events, checkpoint)
    }

    fn read_context_asset(
        &self,
        asset_id: &str,
        offset: usize,
        limit: usize,
    ) -> Result<harness_prompty::ContextAssetExcerpt, String> {
        let excerpt = AgentStateStore::read_context_asset(self, asset_id, offset, limit)?;
        Ok(harness_prompty::ContextAssetExcerpt {
            name: excerpt.asset.name,
            excerpt: excerpt.excerpt,
        })
    }

    fn record_native_memory_promotion(
        &self,
        candidate: &serde_json::Value,
    ) -> Result<(), String> {
        AgentStateStore::record_native_memory_promotion(self, candidate)
    }
}

/// Canonical id of the harness selected when the host requests no specific one.
pub const DEFAULT_HARNESS_ID: &str = "prompty";

/// A second selectable harness id. Now that the agentive adapter is wired
/// (issue #246), `"agentive"` resolves to the real [`agentive::AgentiveHarness`]
/// rather than aliasing onto Prompty.
#[cfg(feature = "harness-agentive")]
pub const AGENTIVE_HARNESS_ID: &str = "agentive";

/// The GitHub Copilot SDK harness id (issue #247). Resolves to the real
/// [`copilot_sdk::CopilotSdkHarness`], which drives the GitHub Copilot CLI.
#[cfg(feature = "harness-copilot-sdk")]
pub const COPILOT_SDK_HARNESS_ID: &str = "copilot-sdk";

/// Resolves harness identifiers to concrete [`AgentHarness`] instances.
///
/// This is the single place engine selection happens; hosts must not branch on
/// harness ids themselves. New harnesses register a new arm here.
#[derive(Clone)]
pub struct HarnessRegistry {
    prompty_steering: prompty::PromptySteering,
}

impl HarnessRegistry {
    /// Build a registry bound to the host-owned Prompty steering queue.
    pub fn new(prompty_steering: prompty::PromptySteering) -> Self {
        Self { prompty_steering }
    }

    /// Map a requested harness id (or `None`) to a canonical id, applying the
    /// deprecated `"agentive"` alias and rejecting unknown ids with a clear
    /// message.
    pub fn canonical_id(requested: Option<&str>) -> Result<&'static str, String> {
        match requested.map(str::trim).filter(|value| !value.is_empty()) {
            None | Some("prompty") => Ok(DEFAULT_HARNESS_ID),
            // The agentive adapter is wired (issue #246), so its id resolves to
            // the real harness rather than aliasing onto Prompty.
            #[cfg(feature = "harness-agentive")]
            Some(id) if id == AGENTIVE_HARNESS_ID => Ok(AGENTIVE_HARNESS_ID),
            // The Copilot SDK adapter is wired (issue #247).
            #[cfg(feature = "harness-copilot-sdk")]
            Some(id) if id == COPILOT_SDK_HARNESS_ID => Ok(COPILOT_SDK_HARNESS_ID),
            Some(other) => Err(unsupported_harness_error(other)),
        }
    }

    /// Resolve a requested harness id to a ready-to-run harness instance.
    ///
    /// `agent_state` is the per-run durable store. It is injected only into the
    /// harness that owns durable persistence (Prompty today); the other adapters
    /// run stateless or provide their own memory and never receive it.
    pub fn resolve(
        &self,
        requested: Option<&str>,
        agent_state: Option<AgentStateStore>,
    ) -> Result<Arc<dyn AgentHarness>, String> {
        match Self::canonical_id(requested)? {
            DEFAULT_HARNESS_ID => {
                // Prompty owns none of its tools, project knowledge, or durable
                // state, so the host injects both seams here rather than the
                // adapter crate importing app domain logic. Durability is only
                // injected when the run has a store (`None` otherwise).
                let host: Arc<dyn harness_prompty::PromptyHost> = Arc::new(AppPromptyHost);
                let durable = agent_state
                    .map(|store| Arc::new(store) as Arc<dyn harness_prompty::DurableRunStore>);
                Ok(Arc::new(PromptyHarness::new(
                    self.prompty_steering.clone(),
                    host,
                    durable,
                )))
            }
            #[cfg(feature = "harness-agentive")]
            AGENTIVE_HARNESS_ID => Ok(Arc::new(AgentiveHarness::new(Arc::new(AppToolExecutor)))),
            #[cfg(feature = "harness-copilot-sdk")]
            COPILOT_SDK_HARNESS_ID => Ok(Arc::new(CopilotSdkHarness::new())),
            // `canonical_id` only ever yields ids we can build.
            other => Err(unsupported_harness_error(other)),
        }
    }

    /// Report capability metadata for a requested harness id without building
    /// the harness. Consumed by conformance tests and diagnostics surfaces.
    #[allow(dead_code)]
    pub fn capabilities(requested: Option<&str>) -> Result<HarnessCapabilities, String> {
        match Self::canonical_id(requested)? {
            DEFAULT_HARNESS_ID => Ok(PromptyHarness::static_capabilities()),
            #[cfg(feature = "harness-agentive")]
            AGENTIVE_HARNESS_ID => Ok(agentive::static_capabilities()),
            #[cfg(feature = "harness-copilot-sdk")]
            COPILOT_SDK_HARNESS_ID => Ok(copilot_sdk::static_capabilities()),
            other => Err(unsupported_harness_error(other)),
        }
    }

    /// Report the ownership contract for a requested harness id without building
    /// the harness. Consumed by conformance tests and the contract-aware
    /// settings UI.
    #[allow(dead_code)]
    pub fn contract(requested: Option<&str>) -> Result<HarnessContract, String> {
        match Self::canonical_id(requested)? {
            DEFAULT_HARNESS_ID => Ok(PromptyHarness::static_contract()),
            #[cfg(feature = "harness-agentive")]
            AGENTIVE_HARNESS_ID => Ok(agentive::static_contract()),
            #[cfg(feature = "harness-copilot-sdk")]
            COPILOT_SDK_HARNESS_ID => Ok(copilot_sdk::static_contract()),
            other => Err(unsupported_harness_error(other)),
        }
    }

    /// Enumerate every known harness with its capabilities and availability.
    ///
    /// This is the single source the host exposes to the settings UI so users
    /// can see and switch between harnesses. Harnesses whose runtime is not yet
    /// wired report `available: false` and stay honest about it rather than
    /// being hidden or aliased onto another runtime. The order is stable and
    /// UI-facing: the default harness first, then the others.
    pub fn available_harnesses() -> Vec<HarnessDescriptor> {
        let mut harnesses = vec![HarnessDescriptor {
            capabilities: PromptyHarness::static_capabilities(),
            contract: PromptyHarness::static_contract(),
            available: true,
            // The recommended default runtime. It is always linked and has
            // passed end-to-end provider drills across Foundry, OpenAI, and
            // Anthropic.
            stability: HarnessStability::Stable,
        }];
        #[cfg(feature = "harness-agentive")]
        harnesses.push(HarnessDescriptor {
            capabilities: agentive::static_capabilities(),
            contract: agentive::static_contract(),
            available: agentive::AVAILABLE,
            // The shipped bring-your-own-model runtime.
            stability: HarnessStability::Stable,
        });
        #[cfg(feature = "harness-copilot-sdk")]
        harnesses.push(HarnessDescriptor {
            capabilities: copilot_sdk::static_capabilities(),
            contract: copilot_sdk::static_contract(),
            available: copilot_sdk::is_available(),
            // The primary shipping path (GitHub Copilot entitlement).
            stability: HarnessStability::Stable,
        });
        harnesses
    }
}

fn unsupported_harness_error(requested: &str) -> String {
    // Preserve the user-facing contract from the pre-seam
    // `ExecutionEngine::from_config`: the frontend still sends this value under
    // the `execution_engine` config key, so the error names that key and lists
    // the currently supported values. The list tracks the compiled-in adapters
    // so a reduced (feature-gated) build never claims to support a harness it
    // cannot build.
    let mut ids = vec!["'prompty'"];
    #[cfg(feature = "harness-agentive")]
    ids.push("'agentive'");
    #[cfg(feature = "harness-copilot-sdk")]
    ids.push("'copilot-sdk'");
    format!(
        "Unsupported execution_engine '{requested}'. Expected one of {}.",
        ids.join(", ")
    )
}

#[cfg(test)]
mod tests {
    use super::*;

    fn registry() -> HarnessRegistry {
        HarnessRegistry::new(prompty::PromptySteering::new())
    }

    #[test]
    fn default_selection_resolves_to_prompty() {
        let harness = registry().resolve(None, None).unwrap();
        assert_eq!(harness.id(), DEFAULT_HARNESS_ID);

        let explicit = registry().resolve(Some("prompty"), None).unwrap();
        assert_eq!(explicit.id(), DEFAULT_HARNESS_ID);
    }

    #[cfg(feature = "harness-agentive")]
    #[test]
    fn agentive_id_resolves_to_the_agentive_harness() {
        // Once the agentive adapter is wired (issue #246) its id resolves to the
        // real harness instead of aliasing onto Prompty.
        assert_eq!(
            HarnessRegistry::canonical_id(Some("agentive")).unwrap(),
            AGENTIVE_HARNESS_ID
        );
        let harness = registry().resolve(Some("  agentive  "), None).unwrap();
        assert_eq!(harness.id(), AGENTIVE_HARNESS_ID);
        assert_eq!(
            harness.capabilities(),
            agentive::static_capabilities()
        );
    }

    #[test]
    fn blank_or_missing_id_uses_the_default() {
        assert_eq!(
            HarnessRegistry::canonical_id(None).unwrap(),
            DEFAULT_HARNESS_ID
        );
        assert_eq!(
            HarnessRegistry::canonical_id(Some("   ")).unwrap(),
            DEFAULT_HARNESS_ID
        );
    }

    #[cfg(feature = "harness-copilot-sdk")]
    #[test]
    fn copilot_sdk_id_resolves_to_the_copilot_sdk_harness() {
        // The Copilot SDK adapter is wired (issue #247); its id resolves to the
        // real harness.
        assert_eq!(
            HarnessRegistry::canonical_id(Some("copilot-sdk")).unwrap(),
            COPILOT_SDK_HARNESS_ID
        );
        let harness = registry().resolve(Some("  copilot-sdk  "), None).unwrap();
        assert_eq!(harness.id(), COPILOT_SDK_HARNESS_ID);
        assert_eq!(harness.capabilities(), copilot_sdk::static_capabilities());
    }

    #[test]
    fn unsupported_id_is_reported_clearly() {
        let err = match registry().resolve(Some("totally-unknown"), None) {
            Ok(_) => panic!("unsupported id should not resolve"),
            Err(err) => err,
        };
        assert!(
            err.contains("totally-unknown"),
            "error should echo the bad id: {err}"
        );
        assert!(
            err.contains("prompty"),
            "error should list supported ids: {err}"
        );
        // The exact user-facing contract is preserved from the pre-seam
        // `ExecutionEngine::from_config`, keyed on `execution_engine`, now
        // listing every selectable harness the build actually links.
        let mut expected_ids = vec!["'prompty'"];
        #[cfg(feature = "harness-agentive")]
        expected_ids.push("'agentive'");
        #[cfg(feature = "harness-copilot-sdk")]
        expected_ids.push("'copilot-sdk'");
        assert_eq!(
            err,
            format!(
                "Unsupported execution_engine 'totally-unknown'. Expected one of {}.",
                expected_ids.join(", ")
            )
        );

        let capability_err = HarnessRegistry::capabilities(Some("totally-unknown")).unwrap_err();
        assert_eq!(capability_err, err);
    }

    #[test]
    fn capability_metadata_is_exposed_for_the_default_harness() {
        let capabilities = HarnessRegistry::capabilities(None).unwrap();
        assert_eq!(capabilities.id, DEFAULT_HARNESS_ID);
        assert_eq!(capabilities, PromptyHarness::static_capabilities());
        // Prompty advertises the full host feature set today.
        assert!(capabilities.streaming);
        assert!(capabilities.tool_calls);
        assert!(capabilities.cancellation);
        assert!(capabilities.steering);
        assert!(capabilities.durable_state);
    }

    #[test]
    fn resolved_harness_reports_matching_capabilities() {
        let harness = registry().resolve(None, None).unwrap();
        assert_eq!(
            harness.capabilities(),
            PromptyHarness::static_capabilities()
        );
    }

    #[test]
    fn enumeration_lists_every_known_harness_with_honest_availability() {
        let harnesses = HarnessRegistry::available_harnesses();
        let ids: Vec<&str> = harnesses
            .iter()
            .map(|descriptor| descriptor.capabilities.id.as_str())
            .collect();
        // The enumeration tracks exactly the compiled-in adapters, in stable
        // UI order: the default harness first, then each optional adapter the
        // build actually links.
        let mut expected = vec!["prompty"];
        #[cfg(feature = "harness-agentive")]
        expected.push("agentive");
        #[cfg(feature = "harness-copilot-sdk")]
        expected.push("copilot-sdk");
        assert_eq!(ids, expected);

        let find = |id: &str| {
            harnesses
                .iter()
                .find(|descriptor| descriptor.capabilities.id == id)
                .unwrap_or_else(|| panic!("missing harness {id}"))
        };

        // Prompty is the wired default and must resolve.
        assert!(find("prompty").available);
        registry().resolve(Some("prompty"), None).unwrap();

        // The other harnesses are declared with honest capability metadata; their
        // availability tracks whether their adapter can execute a run yet
        // (agentive is always wired; the Copilot harness needs its CLI present).
        #[cfg(feature = "harness-agentive")]
        assert_eq!(find("agentive").available, agentive::AVAILABLE);
        #[cfg(feature = "harness-copilot-sdk")]
        assert_eq!(find("copilot-sdk").available, copilot_sdk::is_available());

        // A compiled-out adapter is not silently present — its id is rejected
        // rather than enumerated.
        #[cfg(not(feature = "harness-agentive"))]
        assert!(HarnessRegistry::canonical_id(Some("agentive")).is_err());
        #[cfg(not(feature = "harness-copilot-sdk"))]
        assert!(HarnessRegistry::canonical_id(Some("copilot-sdk")).is_err());
    }

    #[test]
    fn provider_requiring_harnesses_declare_requires() {
        // Prompty and agentive cannot run without a host-supplied provider, so
        // they must advertise that stance rather than silently tolerating a
        // missing one.
        let mut ids = vec!["prompty"];
        #[cfg(feature = "harness-agentive")]
        ids.push("agentive");
        for id in ids {
            let contract = HarnessRegistry::contract(Some(id)).unwrap();
            assert_eq!(
                contract.provider,
                Ownership::Requires,
                "{id} must require a host provider"
            );
            assert_eq!(contract.personas, Ownership::Requires);
            assert_eq!(contract.tools, Ownership::Requires);
            assert_eq!(contract.memory, Ownership::Requires);
        }
    }

    #[cfg(feature = "harness-copilot-sdk")]
    #[test]
    fn copilot_sdk_provides_its_own_provider_and_augments_personas() {
        // The Copilot harness runs on the GitHub Copilot entitlement, owns its
        // tool loop and session memory, and merges CutReady personas into its
        // own base prompt as native custom agents.
        let contract = HarnessRegistry::contract(Some("copilot-sdk")).unwrap();
        assert_eq!(contract.provider, Ownership::Provides);
        assert_eq!(contract.personas, Ownership::Augments);
        assert_eq!(contract.tools, Ownership::Provides);
        assert_eq!(contract.memory, Ownership::Provides);
    }

    fn populated_host_llm() -> crate::engine::agent::llm::LlmConfig {
        use crate::engine::agent::llm::{LlmConfig, LlmProvider};
        LlmConfig {
            provider: LlmProvider::MicrosoftFoundry,
            endpoint: "https://seth-foundry-dev.services.ai.azure.com".to_string(),
            api_key: "shared-narration-key".to_string(),
            model: "gpt-5.6-terra".to_string(),
            bearer_token: Some("shared-bearer".to_string()),
            reasoning_effort: None,
        }
    }

    #[cfg(feature = "harness-copilot-sdk")]
    #[test]
    fn copilot_sdk_contract_strips_host_provider_via_registry() {
        // End-to-end through the real registry contract: a Provides harness
        // must never receive the host's shared connection credentials for an
        // agent turn. Only the provider discriminant survives so the adapter
        // can route correctly; everything auth/model-bearing is cleared and the
        // harness falls back to its own Copilot entitlement + default model.
        use crate::engine::agent::llm::LlmProvider;
        let contract = HarnessRegistry::contract(Some("copilot-sdk")).unwrap();
        let sent = contract.host_provider_config(populated_host_llm());
        assert_eq!(sent.provider, LlmProvider::MicrosoftFoundry);
        assert!(sent.endpoint.is_empty(), "endpoint must be stripped");
        assert!(sent.api_key.is_empty(), "api_key must be stripped");
        assert!(sent.model.is_empty(), "model must be stripped");
        assert!(sent.bearer_token.is_none(), "bearer_token must be stripped");
    }

    #[test]
    fn prompty_contract_forwards_host_provider_via_registry() {
        // A Requires harness cannot run without the host provider, so the
        // registry contract must forward it verbatim.
        let contract = HarnessRegistry::contract(Some("prompty")).unwrap();
        let original = populated_host_llm();
        let sent = contract.host_provider_config(original.clone());
        assert_eq!(sent.provider, original.provider);
        assert_eq!(sent.endpoint, original.endpoint);
        assert_eq!(sent.api_key, original.api_key);
        assert_eq!(sent.model, original.model);
        assert_eq!(sent.bearer_token, original.bearer_token);
    }

    fn sample_host_tools() -> Vec<ToolDefinition> {
        vec![ToolDefinition::function(
            "read_sketch",
            "Read a sketch",
            serde_json::json!({"type": "object"}),
        )]
    }

    fn sample_host_prompts() -> std::collections::HashMap<String, String> {
        std::collections::HashMap::from([("writer".to_string(), "You are the writer.".to_string())])
    }

    #[cfg(feature = "harness-copilot-sdk")]
    #[test]
    fn copilot_sdk_contract_withholds_host_tools_but_forwards_personas_via_registry() {
        // copilot-sdk Provides its own tool loop, so the host tool contract must
        // be withheld end-to-end through the real registry contract. It Augments
        // personas (registers host personas as native custom agents), so the
        // host prompts must still be forwarded.
        let contract = HarnessRegistry::contract(Some("copilot-sdk")).unwrap();
        assert!(
            contract.host_tools(sample_host_tools()).is_empty(),
            "a Provides-tools harness must receive no host tools"
        );
        let prompts = contract.host_agent_prompts(sample_host_prompts());
        assert_eq!(
            prompts.get("writer").map(String::as_str),
            Some("You are the writer."),
            "an Augments-personas harness must still receive host personas"
        );
    }

    #[test]
    fn prompty_contract_forwards_host_tools_and_personas_via_registry() {
        // A Requires harness cannot run without the host tools or personas, so
        // the registry contract must forward both verbatim.
        let contract = HarnessRegistry::contract(Some("prompty")).unwrap();
        let tools = contract.host_tools(sample_host_tools());
        assert_eq!(tools.len(), 1);
        assert_eq!(tools[0].function.name, "read_sketch");
        let prompts = contract.host_agent_prompts(sample_host_prompts());
        assert_eq!(prompts.get("writer").map(String::as_str), Some("You are the writer."));
    }

    #[test]
    fn contract_default_matches_prompty_and_resolved_harness() {
        // A missing id falls back to the default harness for the contract just
        // like it does for capabilities and resolution.
        let default_contract = HarnessRegistry::contract(None).unwrap();
        assert_eq!(default_contract, PromptyHarness::static_contract());

        let harness = registry().resolve(None, None).unwrap();
        assert_eq!(harness.contract(), PromptyHarness::static_contract());
    }

    #[test]
    fn contract_for_unsupported_id_is_reported_clearly() {
        // Unsupported concerns/ids surface the same clear error as capabilities
        // and resolution rather than defaulting silently.
        let err = HarnessRegistry::contract(Some("totally-unknown")).unwrap_err();
        assert_eq!(
            err,
            HarnessRegistry::capabilities(Some("totally-unknown")).unwrap_err()
        );
        assert!(err.contains("totally-unknown"));
    }

    #[test]
    fn enumeration_carries_each_harness_contract() {
        // The UI-facing descriptor list must expose the ownership contract next
        // to capabilities so Settings can gate the agent provider affordance.
        let harnesses = HarnessRegistry::available_harnesses();
        for descriptor in &harnesses {
            let expected =
                HarnessRegistry::contract(Some(descriptor.capabilities.id.as_str())).unwrap();
            assert_eq!(descriptor.contract, expected);
        }
    }

    #[cfg(feature = "harness-copilot-sdk")]
    #[test]
    fn descriptor_json_shape_matches_the_frontend_contract() {
        // The TS `HarnessDescriptor` interface flattens capabilities, nests
        // `contract`, and expects lowercase ownership strings. Lock that wire
        // shape so a rename can't silently break Settings' harness picker.
        let copilot = HarnessRegistry::available_harnesses()
            .into_iter()
            .find(|descriptor| descriptor.capabilities.id == "copilot-sdk")
            .expect("copilot-sdk descriptor");
        let value = serde_json::to_value(&copilot).unwrap();

        // Capabilities are flattened onto the descriptor root, not nested.
        assert_eq!(value["id"], "copilot-sdk");
        assert_eq!(value["streaming"], true);
        assert!(value.get("capabilities").is_none());

        // `contract` is a nested object with lowercase ownership stances.
        let contract = &value["contract"];
        assert_eq!(contract["provider"], "provides");
        assert_eq!(contract["personas"], "augments");
        assert_eq!(contract["tools"], "provides");
        assert_eq!(contract["memory"], "provides");

        // Rollout maturity travels on the descriptor root as a lowercase string.
        // copilot-sdk is the primary shipping path.
        assert_eq!(value["stability"], "stable");

        // Prompty requires its provider and is the stable default runtime.
        let prompty = HarnessRegistry::available_harnesses()
            .into_iter()
            .find(|descriptor| descriptor.capabilities.id == "prompty")
            .expect("prompty descriptor");
        let prompty_value = serde_json::to_value(&prompty).unwrap();
        assert_eq!(prompty_value["contract"]["provider"], "requires");
        assert_eq!(prompty_value["stability"], "stable");
    }

    #[test]
    fn prompty_backbone_is_advertised_stable() {
        // The default backbone is the recommended stable runtime.
        let prompty = HarnessRegistry::available_harnesses()
            .into_iter()
            .find(|descriptor| descriptor.capabilities.id == "prompty")
            .expect("prompty descriptor");
        assert_eq!(prompty.stability, HarnessStability::Stable);
        assert!(prompty.available);
    }

    #[cfg(feature = "harness-agentive")]
    #[test]
    fn agentive_shipped_runtime_is_advertised_stable() {
        // agentive is the shipped bring-your-own-model runtime, not experimental.
        let agentive = HarnessRegistry::available_harnesses()
            .into_iter()
            .find(|descriptor| descriptor.capabilities.id == "agentive")
            .expect("agentive descriptor");
        assert_eq!(agentive.stability, HarnessStability::Stable);
    }
}
