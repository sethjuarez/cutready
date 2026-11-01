//! The CutReady command line (`cutready-cli`) and MCP server.
//!
//! Every write goes through `cutready-core`'s `EditSession` with the desktop
//! ports, so CLI and MCP edits land in the project's op log as runs the app
//! shows for review, exactly like its own agent's edits. Nothing here writes
//! project files directly.

pub mod discovery;
pub mod edit;
pub mod mcp;
pub mod project;
pub mod validate;

/// The edit contract this build speaks (see `cutready_contracts::CONTRACT_VERSION`).
pub use cutready_core::contracts::CONTRACT_VERSION;
