//! Agent engine — LLM-powered sketch assistant.
//!
//! Core module providing the LLM client for chat completions with
//! function calling, streaming, and the agentic tool loop.

pub mod execution;
pub mod harness;
pub mod llm;
pub mod reference_context;
pub mod sanitize;
pub mod steering;
pub mod tools;
pub mod web;

#[cfg(test)]
mod prompty_integration_tests;
