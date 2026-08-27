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

/// Deprecated harness id still accepted from persisted configs; it maps onto the
/// current default. Kept so older settings that named `"agentive"` keep working
/// until the real agentive harness returns in issue #246.
pub const DEPRECATED_AGENTIVE_ALIAS: &str = "agentive";

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
            // `agentive` is a deprecated alias while Prompty is the sole
            // runtime; persisted configs still naming it map onto Prompty
            // rather than erroring. Issue #246 reintroduces a real agentive
            // harness under its own id.
            Some(alias) if alias == DEPRECATED_AGENTIVE_ALIAS => Ok(DEFAULT_HARNESS_ID),
            Some(other) => Err(unsupported_harness_error(other)),
        }
    }

    /// Resolve a requested harness id to a ready-to-run harness instance.
    pub fn resolve(&self, requested: Option<&str>) -> Result<Arc<dyn AgentHarness>, String> {
        match Self::canonical_id(requested)? {
            DEFAULT_HARNESS_ID => Ok(Arc::new(PromptyHarness::new(self.prompty_steering.clone()))),
            // `canonical_id` only ever yields ids we can build.
            other => Err(unsupported_harness_error(other)),
        }
    }

    /// Report capability metadata for a requested harness id without building
    /// the harness. Consumed by conformance tests now; wired into diagnostics
    /// surfaces alongside the additional adapters in issues #246/#247.
    #[allow(dead_code)]
    pub fn capabilities(requested: Option<&str>) -> Result<HarnessCapabilities, String> {
        match Self::canonical_id(requested)? {
            DEFAULT_HARNESS_ID => Ok(PromptyHarness::static_capabilities()),
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
                available: true,
            },
            HarnessDescriptor {
                capabilities: agentive::static_capabilities(),
                available: agentive::AVAILABLE,
            },
            HarnessDescriptor {
                capabilities: copilot_sdk::static_capabilities(),
                available: copilot_sdk::AVAILABLE,
            },
        ]
    }
}

fn unsupported_harness_error(requested: &str) -> String {
    // Preserve the exact user-facing contract from the pre-seam
    // `ExecutionEngine::from_config`: the frontend still sends this value under
    // the `execution_engine` config key, so the error names that key and lists
    // the one supported value.
    format!("Unsupported execution_engine '{requested}'. Expected 'prompty'.")
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
    fn deprecated_agentive_alias_still_maps_to_prompty() {
        assert_eq!(
            HarnessRegistry::canonical_id(Some("agentive")).unwrap(),
            DEFAULT_HARNESS_ID
        );
        let harness = registry().resolve(Some("  agentive  ")).unwrap();
        assert_eq!(harness.id(), DEFAULT_HARNESS_ID);
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
    fn unsupported_id_is_reported_clearly() {
        let err = match registry().resolve(Some("copilot-sdk")) {
            Ok(_) => panic!("unsupported id should not resolve"),
            Err(err) => err,
        };
        assert!(
            err.contains("copilot-sdk"),
            "error should echo the bad id: {err}"
        );
        assert!(
            err.contains("prompty"),
            "error should list supported ids: {err}"
        );
        // The exact user-facing contract is preserved from the pre-seam
        // `ExecutionEngine::from_config`, keyed on `execution_engine`.
        assert_eq!(
            err,
            "Unsupported execution_engine 'copilot-sdk'. Expected 'prompty'."
        );

        let capability_err = HarnessRegistry::capabilities(Some("copilot-sdk")).unwrap_err();
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
        // availability tracks whether their adapter can execute a run yet.
        assert_eq!(find("agentive").available, agentive::AVAILABLE);
        assert_eq!(find("copilot-sdk").available, copilot_sdk::AVAILABLE);
    }
}
