//! Agent engine — LLM-powered refinement pipeline.
//!
//! Sub-modules handle each stage of refinement:
//! - cleanup: remove accidental/redundant actions
//! - selectors: stabilize targeting strategies
//! - narrative: generate voiceover text
//! - animations: suggest and generate ManimCE code
//! - healing: self-heal broken selectors during replay

pub mod animations;
pub mod cleanup;
pub mod healing;
pub mod narrative;
pub mod selectors;
