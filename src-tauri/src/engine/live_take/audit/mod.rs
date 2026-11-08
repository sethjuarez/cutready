//! Independent take audit: checks the FINAL take (MP4 + its audio) against
//! the script with evidence the planner never used. See
//! `docs/video/audit.md`.

pub mod align;
pub mod media;
pub mod run;
pub mod sheet;
pub mod stt;
pub mod verdict;
pub mod visual;
pub mod witness;

pub use run::{audit_take, AuditConfig, AuditOptions, TakeAudit, TAKE_AUDIT_SCHEMA_V1};
