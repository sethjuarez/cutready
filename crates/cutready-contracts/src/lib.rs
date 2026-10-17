//! Typra-generated CutReady document contracts.
//!
//! `model/` and `generated_tests/` are emitted from `contracts/*.tsp`; do not
//! edit them by hand. Run `npm run generate` in `contracts/` instead.
//! `vector_adapters.rs` binds the contract's `@vector` operations to the
//! desktop's production document code.

#[rustfmt::skip]
pub mod model;
pub use model::*;

#[cfg(test)]
#[rustfmt::skip]
#[path = "generated_tests/main.rs"]
mod conformance;
