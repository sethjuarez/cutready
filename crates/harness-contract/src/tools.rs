//! The tool contract the model may call.
//!
//! Only the wire-shape definitions live here; the concrete tool
//! implementations (reading/writing sketches, web fetch, visuals, ...) are
//! app-owned and stay in the app crate.

use std::path::PathBuf;

use serde::{Deserialize, Serialize};
use serde_json::Value;

use crate::execution::{ToolCall, ToolOutput};

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ToolDefinition {
    #[serde(rename = "type")]
    pub tool_type: String,
    pub function: ToolFunctionDefinition,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ToolFunctionDefinition {
    pub name: String,
    pub description: String,
    pub parameters: Value,
}

impl ToolDefinition {
    pub fn function(name: &str, description: &str, parameters: Value) -> Self {
        Self {
            tool_type: "function".into(),
            function: ToolFunctionDefinition {
                name: name.into(),
                description: description.into(),
                parameters,
            },
        }
    }
}

/// Per-run context for host tool execution: the confinement roots and the tool
/// policy the host computes for a run. Bundling these avoids passing a string of
/// positional booleans across the seam, where a transposition would still
/// compile.
#[derive(Debug, Clone)]
pub struct ToolExecutionContext {
    /// Repository root the tools are confined to.
    pub repo_root: PathBuf,
    /// Project root the tools are confined to.
    pub project_root: PathBuf,
    /// Whether vision-capable tools may be offered.
    pub vision_enabled: bool,
    /// Whether path-confined project workspace tools are offered this run.
    pub project_workspace_tools_enabled: bool,
    /// Whether mutating tools are permitted this run.
    pub mutation_tools_enabled: bool,
}

/// Host-owned tool execution injected into a harness adapter.
///
/// Concrete tool implementations (path-confined project tools, web fetch,
/// visuals, ...) stay in the app crate. A harness that lets the host own tool
/// execution (e.g. the agentive adapter) receives an implementation of this
/// trait instead of importing the app's executor directly, keeping the adapter
/// crate free of any app dependency. Adapters that run their own tool loop
/// (e.g. the Copilot SDK adapter, `tools: Provides`) never need it.
///
/// This mirrors the per-adapter injection of durable run state: a host-owned
/// capability that only one adapter needs is handed to that adapter rather than
/// routed through the shared [`AgentRunRequest`](crate::harness::AgentRunRequest)
/// that every harness would otherwise have to accept and most would discard.
pub trait HostToolExecutor: Send + Sync {
    /// Execute a single tool call under the host's tool policy and path
    /// confinement, returning the host-shaped tool output.
    fn execute(&self, call: &ToolCall, ctx: &ToolExecutionContext) -> ToolOutput;
}
