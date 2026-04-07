//! Agent engine — LLM-powered sketch assistant.
//!
//! Core module providing the LLM client for chat completions with
//! function calling, streaming, and the agentic tool loop.

pub mod llm;
pub mod runner;
pub mod tools;
