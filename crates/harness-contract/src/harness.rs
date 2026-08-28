//! The CutReady-owned harness boundary: request/result DTOs, the
//! capability/ownership contract, and the [`AgentHarness`] trait.
//!
//! Harness-native types (for example `prompty::*`, `agentive::*`, or the
//! Copilot SDK types) must stay inside the concrete adapter for that harness.
//! Nothing harness-specific may appear in this module or leak past
//! [`AgentHarness::run`].

use std::any::Any;
use std::collections::HashMap;
use std::path::PathBuf;
use std::sync::Arc;

use async_trait::async_trait;
use serde::Serialize;

use crate::execution::{
    AgentEvent, ChatMessage, ContextItem, RunCancellation, Usage, VisionConfig, WebAccessConfig,
};
use crate::llm::LlmConfig;
use crate::tools::ToolDefinition;

/// Streaming sink for [`AgentEvent`]s produced during a run.
///
/// The host builds the emitter (it owns the event DTO shape and the Tauri
/// channel); the harness only forwards events through it.
pub type HarnessEventEmitter = Arc<dyn Fn(AgentEvent) + Send + Sync>;

/// Opaque, host-owned handle to durable run/checkpoint state.
///
/// Persistence is a non-negotiable host concern, so the contract crate never
/// sees the concrete store (which is SQLite-backed and lives in the app). A
/// harness that needs durable state recovers the concrete type by downcasting
/// this handle; harnesses that manage their own memory ignore it.
pub trait RunStateHandle: Any + Send + Sync {
    /// Recover the concrete store by erasing to [`Any`]. The app implements
    /// this by returning `self`; adapters downcast the result.
    fn into_any(self: Arc<Self>) -> Arc<dyn Any + Send + Sync>;
}

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
    /// Durable run-state handle, when available. Opaque to the contract; the
    /// consuming adapter recovers the concrete store via [`RunStateHandle`].
    pub agent_state: Option<Arc<dyn RunStateHandle>>,
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
/// silently downgrading behavior. Each adapter advertises its own honest
/// capability set instead of pretending to match another runtime.
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
