//! Agent engine — LLM-powered sketch assistant.
//!
//! Core module providing the LLM client for chat completions with
//! function calling, streaming, and the agentic tool loop.

pub mod execution;
pub mod harness;
pub mod llm;
pub mod prompty_model;
pub mod prompty_runner;
pub mod reference_context;
pub mod sanitize;
pub mod tools;
pub mod web;
