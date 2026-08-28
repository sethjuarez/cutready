//! The tool contract the model may call.
//!
//! Only the wire-shape definitions live here; the concrete tool
//! implementations (reading/writing sketches, web fetch, visuals, ...) are
//! app-owned and stay in the app crate.

use serde::{Deserialize, Serialize};
use serde_json::Value;

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
