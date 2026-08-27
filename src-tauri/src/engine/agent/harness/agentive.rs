//! Agentive agent harness adapter.
//!
//! This module is the *only* place the [`agentive`] crate is wired into the
//! harness seam. Everything `agentive::*` — providers, the run loop, its native
//! message/tool/event types — stays behind this adapter and never leaks past the
//! CutReady-owned boundary types in [`super`].
//!
//! Capability metadata lives here so the registry can advertise agentive
//! honestly (see [`static_capabilities`]) even before/while its runtime is
//! wired. `AVAILABLE` flips to `true` once the adapter can execute a run.

use super::HarnessCapabilities;

/// Canonical, stable identifier for the agentive harness.
pub const ID: &str = "agentive";

/// Whether the agentive harness can currently execute a run.
///
/// Set to `true` once [`AgentiveHarness`] is wired end-to-end (issue #246). The
/// registry uses this to mark the harness selectable in the UI without ever
/// silently downgrading to a different runtime.
pub const AVAILABLE: bool = false;

/// Capability metadata for the agentive runtime.
///
/// Differences from Prompty are represented explicitly rather than by pretending
/// to match it. The agentive path drives CutReady's own path-confined tools and
/// provider abstraction, but it does not participate in CutReady's sub-agent
/// delegation, mid-run steering queue, or durable run-state persistence — those
/// are advertised as unsupported.
pub fn static_capabilities() -> HarnessCapabilities {
    HarnessCapabilities {
        id: ID.to_string(),
        display_name: "Agentive".to_string(),
        streaming: true,
        tool_calls: true,
        vision: true,
        web_search: true,
        delegation: false,
        steering: false,
        cancellation: true,
        durable_state: false,
    }
}
