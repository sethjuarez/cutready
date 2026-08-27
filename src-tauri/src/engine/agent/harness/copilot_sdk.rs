//! GitHub Copilot SDK agent harness adapter.
//!
//! This module is the *only* place the [`copilot_sdk`] crate is wired into the
//! harness seam. The Copilot runtime is the GitHub Copilot CLI driven as a
//! subprocess over JSON-RPC; all `copilot_sdk::*` types — client, session,
//! events — stay behind this adapter and never leak past the CutReady-owned
//! boundary types in [`super`].
//!
//! Unlike the Prompty and agentive harnesses, the Copilot harness runs
//! Copilot's *own* agent loop with Copilot's *own* tools; it does not drive
//! CutReady's path-confined project tools. Those differences are advertised
//! explicitly through [`static_capabilities`] rather than silently downgraded.
//!
//! Capability metadata lives here so the registry can advertise the harness
//! honestly even before/while its runtime is wired. `AVAILABLE` flips to `true`
//! once the adapter can execute a run (issue #247).

use super::HarnessCapabilities;

/// Canonical, stable identifier for the Copilot SDK harness.
pub const ID: &str = "copilot-sdk";

/// Whether the Copilot SDK harness can currently execute a run.
///
/// Set to `true` once [`CopilotSdkHarness`] is wired end-to-end. Requires the
/// GitHub Copilot CLI to be installed on the host at run time.
pub const AVAILABLE: bool = false;

/// Capability metadata for the Copilot SDK runtime.
///
/// The Copilot CLI streams assistant deltas and runs its own tool loop, so
/// `streaming` and `tool_calls` are supported. It does *not* drive CutReady's
/// project tools, sub-agent delegation, or durable run-state persistence, so
/// those are advertised as unsupported. Remaining flags are refined when the
/// adapter is wired against the SDK's event surface (issue #247).
pub fn static_capabilities() -> HarnessCapabilities {
    HarnessCapabilities {
        id: ID.to_string(),
        display_name: "GitHub Copilot".to_string(),
        streaming: true,
        tool_calls: true,
        vision: true,
        web_search: false,
        delegation: false,
        steering: true,
        cancellation: true,
        durable_state: false,
    }
}
