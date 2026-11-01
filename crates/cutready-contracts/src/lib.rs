//! Typra-generated CutReady document contracts.
//!
//! `model/` and `generated_tests/` are emitted from `contracts/*.tsp`; do not
//! edit them by hand. Run `npm run generate` in `contracts/` instead.
//! `vector_adapters.rs` binds the contract's `@vector` operations to the
//! production document code in `cutready-core`.

/// The edit contract version (`EditService`, `EditOp`, `CmdError` and the
/// document shapes) every host speaks. `cutready-cli mcp` reports it in its
/// `initialize` handshake, and a peer with another version is refused, so
/// bump it whenever a change would make an older peer misread or misapply
/// edits.
pub const CONTRACT_VERSION: u32 = 1;

#[rustfmt::skip]
pub mod model;
pub use model::*;

#[cfg(test)]
#[rustfmt::skip]
#[path = "generated_tests/main.rs"]
mod conformance;
