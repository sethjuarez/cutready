//! Azure Entra ID OAuth for keyless Azure OpenAI authentication.
//!
//! Delegates to the shared `agentive::azure_oauth` module for all OAuth
//! protocol logic (PKCE, token exchange, refresh, device code). CutReady
//! keeps only the Tauri command wrappers in `commands/agent.rs`.

pub use agentive::azure_oauth::*;
