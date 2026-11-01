//! CutReady's host-neutral core.
//!
//! Every host (Tauri app, CLI, MCP server, iOS) reaches documents through this
//! crate. Side effects go through the traits in [`ports`]; hosts supply the
//! implementations (`cutready-desktop-io` on desktop, [`testing`] in tests).
//! The crate must keep building for `aarch64-apple-ios`, so it takes no C,
//! process, network, database or Tauri dependencies.

#![deny(clippy::disallowed_methods, clippy::disallowed_types)]

pub mod assets;
pub mod document;
pub mod edit_ops;
pub mod edit_session;
pub mod import;
pub mod models;
pub mod notes;
pub mod path;
pub mod ports;
pub mod review;
pub mod sketch_edits;
pub mod testing;
pub mod visual_document;

pub use cutready_contracts as contracts;
pub use ports::{
    Baseline, Clock, Files, Images, Lock, LockGuard, Log, LogLevel, NewOpLogEntry, OpLogEntry,
    OpLogState, OpLogStore, PortError, PortErrorKind, Resolution, ReviewEffect, Run, Secrets,
};
