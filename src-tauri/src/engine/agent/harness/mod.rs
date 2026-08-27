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
pub mod copilot_sdk;
pub mod prompty;

use std::collections::HashMap;
use std::path::PathBuf;
use std::sync::Arc;

use async_trait::async_trait;
use serde::Serialize;

// Stable host boundary types are CutReady-owned. Several already live in
// `execution.rs` and `tools.rs`; re-export them here so the harness module is
// the single import surface for the seam. `ToolCall`/`ToolOutput` are part of
// that surface for harness authors even though the host command still imports
// them from their original module today.
#[allow(unused_imports)]
pub use crate::engine::agent::execution::{AgentEvent, ContextItem, ToolCall, ToolOutput};
pub use crate::engine::agent::tools::ToolDefinition;

use crate::engine::agent::execution::{
    ChatMessage, RunCancellation, Usage, VisionConfig, WebAccessConfig,
};
use crate::engine::agent::llm::LlmConfig;
use crate::engine::agent_state::AgentStateStore;

use self::agentive::AgentiveHarness;
use self::copilot_sdk::CopilotSdkHarness;
use self::prompty::PromptyHarness;

// ---------------------------------------------------------------------------
// Stable host boundary types (CutReady-owned)
// ---------------------------------------------------------------------------

/// Streaming sink for [`AgentEvent`]s produced during a run.
///
/// The host builds the emitter (it owns the event DTO shape and the Tauri
/// channel); the harness only forwards events through it.
pub type HarnessEventEmitter = Arc<dyn Fn(AgentEvent) + Send + Sync>;

/// Configuration used to build and drive a harness for a single run.
///
/// This is the CutReady-level, harness-agnostic view of provider and run
/// settings. Adapters translate it into their own native configuration behind
/// the seam.
#[derive(Debug, Clone)]
pub struct HarnessConfig {
    /// Provider/model configuration (CutReady's provider abstraction).
    pub llm: LlmConfig,
    /// API-reported context window (tokens) for the selected model, if known.
    pub reported_context_length: Option<usize>,
    /// Maximum tool-call rounds before the run stops.
    pub max_tool_rounds: usize,
    /// Effective vision configuration for this run.
    pub vision: VisionConfig,
    /// Effective web-access configuration for this run.
    pub web_access: WebAccessConfig,
}

/// Everything a harness needs to execute one agent run.
///
/// All fields are CutReady-owned types. The harness must not require any
/// harness-native type to be constructed by the host.
pub struct AgentRunRequest {
    /// Provider/run configuration.
    pub config: HarnessConfig,
    /// Conversation so far (already sanitized by the host).
    pub messages: Vec<ChatMessage>,
    /// Repository root for path confinement.
    pub repo_root: PathBuf,
    /// Active project root for path confinement.
    pub project_root: PathBuf,
    /// Which built-in agent persona to run (planner, writer, editor, ...).
    pub agent_id: String,
    /// Per-agent system prompt overrides supplied by the host.
    pub agent_prompts: HashMap<String, String>,
    /// Whether mutation (write) tools are permitted for this run.
    pub mutation_tools_enabled: bool,
    /// Tool contract the model may call. The host owns tool selection/policy.
    pub tools: Vec<ToolDefinition>,
    /// Preselected context items for the run.
    pub context_items: Vec<ContextItem>,
    /// Stable run identifier for durable state and tracing.
    pub run_id: String,
    /// Durable agent-state store, when available.
    pub agent_state: Option<AgentStateStore>,
    /// Cooperative cancellation handle for the run.
    pub cancellation: RunCancellation,
}

/// Outcome of an agent run, in host terms.
#[derive(Debug, Clone)]
pub struct AgentRunResult {
    /// Full message history after the run.
    pub messages: Vec<ChatMessage>,
    /// Final assistant response text.
    pub response: String,
    /// Aggregate token usage for the run.
    pub usage: Usage,
}

/// Declarative description of what a harness supports.
///
/// Differences between harnesses are represented explicitly here rather than by
/// silently downgrading behavior. Later adapters advertise their own honest
/// capability set instead of pretending to match Prompty.
///
/// Only conformance tests consume this today; the registry and adapters that
/// read capabilities at runtime arrive with issues #246/#247.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
pub struct HarnessCapabilities {
    /// Canonical harness identifier (matches [`AgentHarness::id`]).
    pub id: String,
    /// Human-readable name for settings/diagnostics surfaces.
    pub display_name: String,
    /// Emits incremental token deltas while generating.
    pub streaming: bool,
    /// Supports function/tool calling.
    pub tool_calls: bool,
    /// Can consume image content when the model allows it.
    pub vision: bool,
    /// Exposes a web-search/browse tool.
    pub web_search: bool,
    /// Supports sub-agent delegation.
    pub delegation: bool,
    /// Supports mid-run steering messages.
    pub steering: bool,
    /// Honors cooperative cancellation.
    pub cancellation: bool,
    /// Persists durable run/checkpoint state.
    pub durable_state: bool,
}

/// Per-concern ownership stance a harness declares for a host resource.
///
/// [`HarnessCapabilities`] describe *behavior*; this describes
/// *provisioning/ownership* — for each host concern, who supplies it. The host
/// reacts to the stance instead of assembling everything unconditionally and
/// hoping the adapter ignores what it does not use.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "lowercase")]
pub enum Ownership {
    /// The host must supply this; the harness cannot run without it (for
    /// example prompty/agentive require a provider config and tool set).
    Requires,
    /// The harness owns it and the host must not send its own (for example the
    /// Copilot harness runs its own tool loop and session memory).
    Provides,
    /// The host sends its contribution and the harness merges it with its own
    /// (for example CutReady personas registered as native Copilot agents, or
    /// an optional BYOK provider layered over the Copilot entitlement).
    Augments,
}

/// Declarative, per-concern ownership contract for a harness.
///
/// Sits alongside [`HarnessCapabilities`] on the CutReady-owned boundary. It
/// covers the concerns whose *provisioning* differs between harnesses; the host
/// invariants that can never be opted out of — path confinement, the
/// [`AgentEvent`] DTO shape, and persistence policy — are deliberately absent
/// here so the contract can never weaken them.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
pub struct HarnessContract {
    /// Who supplies the model provider / auth for agent turns.
    pub provider: Ownership,
    /// Who supplies the agent personas / system prompts.
    pub personas: Ownership,
    /// Who supplies the tool contract the model may call.
    pub tools: Ownership,
    /// Who supplies durable run/checkpoint memory.
    pub memory: Ownership,
}

/// A harness entry as surfaced to the host/UI: its capabilities plus whether it
/// can execute a run right now.
///
/// `available` lets the settings UI list every known harness (so users see
/// what's coming) while only enabling the ones whose runtime is wired. A harness
/// that is declared but not yet runnable is advertised honestly rather than
/// hidden or silently mapped onto another runtime.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
pub struct HarnessDescriptor {
    /// Capability metadata for the harness.
    #[serde(flatten)]
    pub capabilities: HarnessCapabilities,
    /// Per-concern ownership contract for the harness.
    pub contract: HarnessContract,
    /// Whether the harness can currently be resolved and run.
    pub available: bool,
}

/// A pluggable agent runtime behind the CutReady host boundary.
#[async_trait]
pub trait AgentHarness: Send + Sync {
    /// Canonical, stable identifier for this harness (for example `"prompty"`).
    fn id(&self) -> &str;

    /// Capability metadata describing what this harness supports.
    #[allow(dead_code)]
    fn capabilities(&self) -> HarnessCapabilities;

    /// Ownership contract describing who provisions each host concern for this
    /// harness (provider, personas, tools, memory).
    #[allow(dead_code)]
    fn contract(&self) -> HarnessContract;

    /// Execute one agent run, forwarding events through `emit`.
    async fn run(
        &self,
        request: AgentRunRequest,
        emit: HarnessEventEmitter,
    ) -> Result<AgentRunResult, String>;
}

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
    pub fn resolve(&self, requested: Option<&str>) -> Result<Arc<dyn AgentHarness>, String> {
        match Self::canonical_id(requested)? {
            DEFAULT_HARNESS_ID => Ok(Arc::new(PromptyHarness::new(self.prompty_steering.clone()))),
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
        let harness = registry().resolve(None).unwrap();
        assert_eq!(harness.id(), DEFAULT_HARNESS_ID);

        let explicit = registry().resolve(Some("prompty")).unwrap();
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
        let harness = registry().resolve(Some("  agentive  ")).unwrap();
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
        let harness = registry().resolve(Some("  copilot-sdk  ")).unwrap();
        assert_eq!(harness.id(), COPILOT_SDK_HARNESS_ID);
        assert_eq!(harness.capabilities(), copilot_sdk::static_capabilities());
    }

    #[test]
    fn unsupported_id_is_reported_clearly() {
        let err = match registry().resolve(Some("totally-unknown")) {
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
        let harness = registry().resolve(None).unwrap();
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
        registry().resolve(Some("prompty")).unwrap();

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

        let harness = registry().resolve(None).unwrap();
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
}
