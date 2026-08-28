//! CutReady-owned execution boundary shared by host commands and agent engines.
//!
//! The definitions now live in the `harness-contract` crate so harness adapter
//! crates can depend on them without depending on the app. This module
//! re-exports them at the original path so existing call sites are unchanged.

pub use harness_contract::execution::*;