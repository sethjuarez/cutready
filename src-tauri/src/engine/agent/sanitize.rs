//! Re-export of the harness-contract content sanitizer.
//!
//! The implementation lives in `harness_contract::sanitize` so both the app
//! and the harness adapter crates can strip API-hostile content from shared
//! `ChatMessage` values without depending on the app crate.

pub use harness_contract::sanitize::*;
