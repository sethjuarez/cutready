//! Prompty harness crate.
//!
//! Prompty is a host-driven engine: unlike the Copilot SDK adapter (which owns
//! its own tools and memory), Prompty *requires* the host to supply the model
//! provider, the tool contract, project reference resolution, and durable run
//! state. Its ownership contract is therefore [`Ownership::Requires`] across the
//! board.
//!
//! To keep this crate free of any dependency on the CutReady app crate, those
//! host-owned capabilities are expressed here as injected seams — [`PromptyHost`]
//! for tools and project references, and [`DurableRunStore`] for durable
//! persistence — and the app supplies concrete implementations. This mirrors the
//! per-adapter injection already used for the agentive tool executor and the
//! Prompty durable store: a host-owned capability that only this adapter needs is
//! handed to it directly rather than routed through the harness-agnostic request.
//!
//! The durable-store seam intentionally lives in this crate rather than in the
//! neutral `harness-contract`, because its methods speak Prompty-native types
//! (`prompty::EngineEvent`, `prompty::EngineCheckpoint`). The contract must never
//! depend on a harness SDK, so a Prompty-specific persistence seam belongs with
//! the Prompty adapter.

use std::path::Path;

use harness_contract::execution::{ToolCall, ToolOutput};
use harness_contract::tools::{ToolDefinition, ToolExecutionContext};

/// A project reference (a sketch, note, or storyboard named in a user message)
/// resolved to its content for context packing.
///
/// Resolving references reads project files (sketches/notes), which is app
/// domain logic, so the host resolves them and hands back this neutral shape.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ResolvedProjectReference {
    /// Stable identifier, e.g. `project-reference:intro`.
    pub id: String,
    /// The raw reference token as written by the user.
    pub reference: String,
    /// Human-readable name of the resolved artifact.
    pub name: String,
    /// Resolved textual content.
    pub content: String,
    /// Content type discriminator (e.g. `sketch`, `note`).
    pub content_type: String,
}

/// An excerpt of a stored context asset read back from durable run state.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ContextAssetExcerpt {
    /// Display name of the stored asset.
    pub name: String,
    /// The excerpt text for the requested window.
    pub excerpt: String,
}

/// Host-owned capabilities the Prompty runner requires but does not own: the
/// tool contract (listing, execution, and policy predicates) and project
/// reference resolution.
///
/// The concrete implementation lives in the app crate, so tool definitions,
/// path-confined execution, and sketch/note resolution never move into this
/// crate and this crate never depends on the app.
pub trait PromptyHost: Send + Sync {
    /// The tool definitions offered for a run, under the run's tool policy.
    fn all_tools(
        &self,
        web_search_enabled: bool,
        project_workspace_tools_enabled: bool,
        mutation_tools_enabled: bool,
    ) -> Vec<ToolDefinition>;

    /// Execute a single tool call under the host's path confinement and policy.
    fn execute_tool(&self, call: &ToolCall, ctx: &ToolExecutionContext) -> ToolOutput;

    /// Whether the named tool is read-only (permitted when mutations are off).
    fn is_read_only_tool(&self, name: &str) -> bool;

    /// Whether a tool's textual result indicates an error, for retry accounting.
    fn is_tool_error(&self, result_text: &str) -> bool;

    /// Resolve project references named in the user messages to their content.
    fn resolve_project_references(
        &self,
        project_root: &Path,
        user_messages: &[String],
    ) -> Vec<ResolvedProjectReference>;
}

/// Durable run-state persistence for the Prompty engine.
///
/// Persistence is a Prompty-only concern; the host injects a concrete store when
/// durability is available for a run (and `None` otherwise). The methods speak
/// Prompty-native event/checkpoint types, which is why this seam is defined in
/// the Prompty crate rather than the neutral contract.
pub trait DurableRunStore: Send + Sync {
    /// Append a single engine event to the run journal.
    fn append_event(&self, event: &prompty::EngineEvent) -> Result<(), String>;

    /// Append a batch of engine events together with a durable checkpoint.
    fn append_events_with_checkpoint(
        &self,
        events: &[prompty::EngineEvent],
        checkpoint: &prompty::EngineCheckpoint,
    ) -> Result<(), String>;

    /// Read a window of a stored context asset by id.
    fn read_context_asset(
        &self,
        asset_id: &str,
        offset: usize,
        limit: usize,
    ) -> Result<ContextAssetExcerpt, String>;

    /// Record a native memory-promotion candidate produced during the run.
    fn record_native_memory_promotion(
        &self,
        candidate: &serde_json::Value,
    ) -> Result<(), String>;
}

mod model;
mod runner;

pub use model::{build_production_model, one_shot_chat, ProductionPromptyModel};
pub use runner::{
    native_to_prompty_message, prompty_to_native_message, run, PromptySteering,
    DEFAULT_MAX_TOOL_ROUNDS,
};
