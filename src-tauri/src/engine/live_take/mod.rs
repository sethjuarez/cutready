//! Live narrated take: one demo script in, one MP4 plus `take.json` out.
//!
//! Rust orchestrates; the Playwright sidecar synthesizes the narration
//! (Azure Speech, word boundaries) and records the browser take with
//! calibration markers. The pure timing core in
//! [`crate::engine::demo_timing`] plans the retime; this module does the IO
//! around it. Run it headlessly with
//! `cargo run -p cutready --example live_take -- <script.json>`.

pub mod analysis;
pub mod audio;
pub mod audit;
pub mod cli;
pub mod narration;
pub mod pipeline;
pub mod script;
pub mod sidecar_io;
pub mod video;

pub use cli::{parse_args, run_cli, CliArgs, CliMode};
pub use pipeline::{run_live_take, LiveTakeOptions, LiveTakeOutcome};
pub use script::LiveTakeScript;
