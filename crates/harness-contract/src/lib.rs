//! CutReady-owned agent harness seam (the "shim" CutReady owns).
//!
//! This crate holds the stable host boundary around any pluggable agent
//! runtime: the request/result DTOs, the event shape, the tool contract, the
//! provider configuration, and the capability/ownership metadata — plus the
//! [`AgentHarness`] trait itself. These types never change when a harness
//! implementation changes.
//!
//! The single non-negotiable rule that makes the seam work: **harness adapter
//! crates depend on `harness-contract`, never on the app crate.** Harness-native
//! types (`prompty::*`, `agentive::*`, `copilot_sdk::*`) stay confined to their
//! own adapter and never appear here or leak past [`AgentHarness::run`].
//!
//! Persistence is deliberately kept out of this contract: durable run state is
//! a per-adapter concern (only the Prompty harness persists it), so the host
//! injects the concrete SQLite-backed store into that one adapter instead of
//! routing a handle through the shared request that every harness would have to
//! accept and most would discard.

pub mod execution;
pub mod harness;
pub mod llm;
pub mod sanitize;
pub mod tools;

pub use execution::{
    AgentEvent, ChatMessage, ContentPart, ContextItem, ContextKind, ContextScope, ContextSource,
    FunctionCall, ImageUrl, LargeContextRef, MemoryPromotionCandidate, MessageContent,
    ResourceOperation, RunCancellation, RunResult, ToolCall, ToolOutput, TouchedResource, Usage,
    VerificationResult, VerificationStatus, VisionConfig, WebAccessConfig,
};
pub use harness::{
    AgentHarness, AgentRunRequest, AgentRunResult, HarnessCapabilities, HarnessConfig,
    HarnessContract, HarnessDescriptor, HarnessEventEmitter, Ownership,
};
pub use llm::{LlmConfig, LlmProvider};
pub use tools::{HostToolExecutor, ToolDefinition, ToolExecutionContext, ToolFunctionDefinition};
