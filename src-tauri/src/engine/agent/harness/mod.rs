//! CutReady-owned agent harness seam.
//!
//! An *agent harness* is the pluggable runtime that actually drives an agent
//! turn (model calls, the tool loop, streaming, cancellation). CutReady owns
//! the host boundary around that runtime: the request/result DTOs, the event
//! shape, the tool contract, path confinement, settings UX, and persistence
//! policy all live on this side of the seam and never change when the harness
//! implementation changes.
//!
//! Harness-native types (for example `prompty::*`, and — in later PRs —
//! `agentive::*` or the Copilot SDK types) must stay inside the concrete
//! adapter for that harness. Nothing harness-specific may appear in this
//! module or leak past [`AgentHarness::run`].
//!
//! This PR ships a single active implementation, [`prompty::PromptyHarness`],
//! selected through [`HarnessRegistry`]. Reintroducing agentive (issue #246)
//! and the Copilot SDK spike (issue #247) each add a new adapter module and a
//! new registry arm without touching this boundary.

pub mod agentive;
pub use harness_copilot_sdk as copilot_sdk;
pub mod prompty;

use std::sync::Arc;

// The stable host boundary vocabulary and the `AgentHarness` trait now live in
// the `harness-contract` crate so harness adapter crates can depend on them
// without depending on the app. Re-export the whole seam here so this module
// stays the single import surface and existing `harness::` call sites are
// unchanged.
pub use harness_contract::harness::{
    AgentHarness, AgentRunRequest, AgentRunResult, HarnessCapabilities, HarnessConfig,
    HarnessContract, HarnessDescriptor, HarnessEventEmitter, Ownership,
};

// Boundary DTOs the seam also surfaces. They live in `execution.rs` / `tools.rs`
// (which now re-export from the contract crate); kept here so harness authors
// have a single import surface for the seam.
#[allow(unused_imports)]
pub use crate::engine::agent::execution::{AgentEvent, ContextItem, ToolCall, ToolOutput};
pub use crate::engine::agent::tools::ToolDefinition;

use self::agentive::AgentiveHarness;
use self::copilot_sdk::CopilotSdkHarness;
use self::prompty::PromptyHarness;
use crate::engine::agent_state::AgentStateStore;
// ---------------------------------------------------------------------------
// Registry / factory
// ---------------------------------------------------------------------------

/// Canonical id of the harness selected when the host requests no specific one.
pub const DEFAULT_HARNESS_ID: &str = "prompty";

/// A second selectable harness id. Now that the agentive adapter is wired
/// (issue #246), `"agentive"` resolves to the real [`agentive::AgentiveHarness`]
/// rather than aliasing onto Prompty.
pub const AGENTIVE_HARNESS_ID: &str = "agentive";

/// The GitHub Copilot SDK harness id (issue #247). Resolves to the real
/// [`copilot_sdk::CopilotSdkHarness`], which drives the GitHub Copilot CLI.
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
            Some(id) if id == AGENTIVE_HARNESS_ID => Ok(AGENTIVE_HARNESS_ID),
            // The Copilot SDK adapter is wired (issue #247).
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
            DEFAULT_HARNESS_ID => Ok(Arc::new(PromptyHarness::new(
                self.prompty_steering.clone(),
                agent_state,
            ))),
            AGENTIVE_HARNESS_ID => Ok(Arc::new(AgentiveHarness::new())),
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
            AGENTIVE_HARNESS_ID => Ok(agentive::static_capabilities()),
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
            AGENTIVE_HARNESS_ID => Ok(agentive::static_contract()),
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
        vec![
            HarnessDescriptor {
                capabilities: PromptyHarness::static_capabilities(),
                contract: PromptyHarness::static_contract(),
                available: true,
            },
            HarnessDescriptor {
                capabilities: agentive::static_capabilities(),
                contract: agentive::static_contract(),
                available: agentive::AVAILABLE,
            },
            HarnessDescriptor {
                capabilities: copilot_sdk::static_capabilities(),
                contract: copilot_sdk::static_contract(),
                available: copilot_sdk::is_available(),
            },
        ]
    }
}

fn unsupported_harness_error(requested: &str) -> String {
    // Preserve the user-facing contract from the pre-seam
    // `ExecutionEngine::from_config`: the frontend still sends this value under
    // the `execution_engine` config key, so the error names that key and lists
    // the currently supported values.
    format!(
        "Unsupported execution_engine '{requested}'. Expected one of 'prompty', 'agentive', \
         'copilot-sdk'."
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
        // listing every selectable harness.
        assert_eq!(
            err,
            "Unsupported execution_engine 'totally-unknown'. Expected one of 'prompty', \
             'agentive', 'copilot-sdk'."
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
        assert_eq!(ids, vec!["prompty", "agentive", "copilot-sdk"]);

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
        assert_eq!(find("agentive").available, agentive::AVAILABLE);
        assert_eq!(find("copilot-sdk").available, copilot_sdk::is_available());
    }

    #[test]
    fn provider_requiring_harnesses_declare_requires() {
        // Prompty and agentive cannot run without a host-supplied provider, so
        // they must advertise that stance rather than silently tolerating a
        // missing one.
        for id in ["prompty", "agentive"] {
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

        // Prompty requires its provider.
        let prompty = HarnessRegistry::available_harnesses()
            .into_iter()
            .find(|descriptor| descriptor.capabilities.id == "prompty")
            .expect("prompty descriptor");
        let prompty_value = serde_json::to_value(&prompty).unwrap();
        assert_eq!(prompty_value["contract"]["provider"], "requires");
    }
}
