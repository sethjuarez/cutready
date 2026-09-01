//! The CutReady-owned harness boundary: request/result DTOs, the
//! capability/ownership contract, and the [`AgentHarness`] trait.
//!
//! Harness-native types (for example `prompty::*`, `agentive::*`, or the
//! Copilot SDK types) must stay inside the concrete adapter for that harness.
//! Nothing harness-specific may appear in this module or leak past
//! [`AgentHarness::run`].

use std::collections::HashMap;
use std::path::PathBuf;
use std::sync::Arc;

use async_trait::async_trait;
use serde::Serialize;

use crate::execution::{
    AgentEvent, ChatMessage, ContextItem, RunCancellation, Usage, VisionConfig, WebAccessConfig,
};
use crate::llm::LlmConfig;
use crate::tools::ToolDefinition;

/// Streaming sink for [`AgentEvent`]s produced during a run.
///
/// The host builds the emitter (it owns the event DTO shape and the Tauri
/// channel); the harness only forwards events through it.
pub type HarnessEventEmitter = Arc<dyn Fn(AgentEvent) + Send + Sync>;

/// Configuration used to build and drive a harness for a single run.
///
/// This is the CutReady-level, harness-agnostic view of provider and run
/// settings. Adapters translate it into their own native configuration behind
/// the seam.
#[derive(Debug, Clone)]
pub struct HarnessConfig {
    /// Provider/model configuration (CutReady's provider abstraction).
    pub llm: LlmConfig,
    /// API-reported context window (tokens) for the selected model, if known.
    pub reported_context_length: Option<usize>,
    /// Maximum tool-call rounds before the run stops.
    pub max_tool_rounds: usize,
    /// Effective vision configuration for this run.
    pub vision: VisionConfig,
    /// Effective web-access configuration for this run.
    pub web_access: WebAccessConfig,
}

/// Everything a harness needs to execute one agent run.
///
/// All fields are CutReady-owned types. The harness must not require any
/// harness-native type to be constructed by the host.
pub struct AgentRunRequest {
    /// Provider/run configuration.
    pub config: HarnessConfig,
    /// Conversation so far (already sanitized by the host).
    pub messages: Vec<ChatMessage>,
    /// Repository root for path confinement.
    pub repo_root: PathBuf,
    /// Active project root for path confinement.
    pub project_root: PathBuf,
    /// Which built-in agent persona to run (planner, writer, editor, ...).
    pub agent_id: String,
    /// Per-agent system prompt overrides supplied by the host.
    pub agent_prompts: HashMap<String, String>,
    /// Whether mutation (write) tools are permitted for this run.
    pub mutation_tools_enabled: bool,
    /// Tool contract the model may call. The host owns tool selection/policy.
    pub tools: Vec<ToolDefinition>,
    /// Preselected context items for the run.
    pub context_items: Vec<ContextItem>,
    /// Stable run identifier for durable state and tracing.
    ///
    /// Durable run/checkpoint state is deliberately *not* a field here: it is a
    /// per-adapter concern (only the Prompty harness persists it; agentive runs
    /// stateless and the Copilot harness `Provides` its own session memory). The
    /// host injects the concrete store into the one adapter that owns it rather
    /// than threading a handle every harness must accept and most must discard.
    pub run_id: String,
    /// Cooperative cancellation handle for the run.
    pub cancellation: RunCancellation,
}

/// Outcome of an agent run, in host terms.
#[derive(Debug, Clone)]
pub struct AgentRunResult {
    /// Full message history after the run.
    pub messages: Vec<ChatMessage>,
    /// Final assistant response text.
    pub response: String,
    /// Aggregate token usage for the run.
    pub usage: Usage,
}

/// Declarative description of what a harness supports.
///
/// Differences between harnesses are represented explicitly here rather than by
/// silently downgrading behavior. Each adapter advertises its own honest
/// capability set instead of pretending to match another runtime.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
pub struct HarnessCapabilities {
    /// Canonical harness identifier (matches [`AgentHarness::id`]).
    pub id: String,
    /// Human-readable name for settings/diagnostics surfaces.
    pub display_name: String,
    /// Emits incremental token deltas while generating.
    pub streaming: bool,
    /// Supports function/tool calling.
    pub tool_calls: bool,
    /// Can consume image content when the model allows it.
    pub vision: bool,
    /// Exposes a web-search/browse tool.
    pub web_search: bool,
    /// Supports sub-agent delegation.
    pub delegation: bool,
    /// Supports mid-run steering messages.
    pub steering: bool,
    /// Honors cooperative cancellation.
    pub cancellation: bool,
    /// Persists durable run/checkpoint state.
    pub durable_state: bool,
}

/// Per-concern ownership stance a harness declares for a host resource.
///
/// [`HarnessCapabilities`] describe *behavior*; this describes
/// *provisioning/ownership* — for each host concern, who supplies it. The host
/// reacts to the stance instead of assembling everything unconditionally and
/// hoping the adapter ignores what it does not use.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "lowercase")]
pub enum Ownership {
    /// The host must supply this; the harness cannot run without it (for
    /// example prompty/agentive require a provider config and tool set).
    Requires,
    /// The harness owns it and the host must not send its own (for example the
    /// Copilot harness runs its own tool loop and session memory).
    Provides,
    /// The host sends its contribution and the harness merges it with its own
    /// (for example CutReady personas registered as native Copilot agents, or
    /// an optional BYOK provider layered over the Copilot entitlement).
    Augments,
}

/// Declarative, per-concern ownership contract for a harness.
///
/// Sits alongside [`HarnessCapabilities`] on the CutReady-owned boundary. It
/// covers the concerns whose *provisioning* differs between harnesses; the host
/// invariants that can never be opted out of — path confinement, the
/// [`AgentEvent`] DTO shape, and persistence policy — are deliberately absent
/// here so the contract can never weaken them.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
pub struct HarnessContract {
    /// Who supplies the model provider / auth for agent turns.
    pub provider: Ownership,
    /// Who supplies the agent personas / system prompts.
    pub personas: Ownership,
    /// Who supplies the tool contract the model may call.
    pub tools: Ownership,
    /// Who supplies durable run/checkpoint memory.
    pub memory: Ownership,
}

impl HarnessContract {
    /// Apply this contract's provider-ownership stance to a host-supplied
    /// provider configuration, returning the provider config the host is
    /// permitted to hand the harness for agent turns.
    ///
    /// The provider concern covers the model *and* its auth ([`Self::provider`]
    /// is "who supplies the model provider / auth for agent turns"). When the
    /// harness [`Ownership::Provides`] its own provider — for example the
    /// Copilot harness, which authenticates through the signed-in Copilot
    /// entitlement — the host must not send its own: the shared connection
    /// credentials belong to narration/voice, not to agent turns. Forwarding
    /// them would turn an *optional* BYOK override into a mandatory one and make
    /// the harness fail against a provider the user never chose for the agent.
    /// So for [`Ownership::Provides`] the provider-owned fields (endpoint,
    /// api_key, bearer_token, and model) are cleared and the harness falls back
    /// to its own entitlement and default model.
    ///
    /// [`Ownership::Requires`] and [`Ownership::Augments`] both forward the host
    /// configuration unchanged: `Requires` cannot run without it, and `Augments`
    /// deliberately layers the host's provider over the harness's own.
    pub fn host_provider_config(&self, llm: LlmConfig) -> LlmConfig {
        match self.provider {
            Ownership::Provides => LlmConfig {
                provider: llm.provider,
                endpoint: String::new(),
                api_key: String::new(),
                model: String::new(),
                bearer_token: None,
            },
            Ownership::Requires | Ownership::Augments => llm,
        }
    }

    /// Whether this harness supplies its own model provider for agent turns
    /// (i.e. [`Self::provider`] is [`Ownership::Provides`]).
    ///
    /// When true, the host's configured provider/model are *not* the run's
    /// effective provider/model — the harness authenticates and selects a model
    /// on its own — so run diagnostics should record the harness as the provider
    /// rather than the (unused) host connection.
    pub fn provides_own_provider(&self) -> bool {
        matches!(self.provider, Ownership::Provides)
    }

    /// Apply this contract's tools-ownership stance to the host-supplied tool
    /// contract, returning the tools the host is permitted to hand the harness.
    ///
    /// The tools concern covers the function/tool set the model may call. When
    /// the harness [`Ownership::Provides`] its own tool loop — for example the
    /// Copilot harness, which runs Copilot's own tools inside the CLI — the host
    /// must not send its tool contract: handing over tools the harness neither
    /// owns nor executes would blur the ownership boundary and grant a tool
    /// surface it never asked for. So for [`Ownership::Provides`] the host tools
    /// are withheld entirely and the harness runs on its own set.
    ///
    /// [`Ownership::Requires`] and [`Ownership::Augments`] both forward the host
    /// tools unchanged: `Requires` cannot run without them, and `Augments`
    /// layers them onto the harness's own tools.
    pub fn host_tools(&self, tools: Vec<ToolDefinition>) -> Vec<ToolDefinition> {
        match self.tools {
            Ownership::Provides => Vec::new(),
            Ownership::Requires | Ownership::Augments => tools,
        }
    }

    /// Apply this contract's personas-ownership stance to the host-supplied
    /// agent prompts, returning the personas the host is permitted to hand the
    /// harness.
    ///
    /// The personas concern covers the agent system prompts. When the harness
    /// [`Ownership::Provides`] its own personas the host withholds its prompts
    /// entirely. [`Ownership::Requires`] (prompty/agentive drive the turn from
    /// the host persona) and [`Ownership::Augments`] (the Copilot harness
    /// registers the host personas as native custom agents and merges them with
    /// its own) both forward the host prompts unchanged.
    pub fn host_agent_prompts(
        &self,
        agent_prompts: HashMap<String, String>,
    ) -> HashMap<String, String> {
        match self.personas {
            Ownership::Provides => HashMap::new(),
            Ownership::Requires | Ownership::Augments => agent_prompts,
        }
    }
}

/// A harness entry as surfaced to the host/UI: its capabilities plus whether it
/// can execute a run right now.
///
/// `available` lets the settings UI list every known harness (so users see
/// what's coming) while only enabling the ones whose runtime is wired. A harness
/// that is declared but not yet runnable is advertised honestly rather than
/// hidden or silently mapped onto another runtime.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
pub struct HarnessDescriptor {
    /// Capability metadata for the harness.
    #[serde(flatten)]
    pub capabilities: HarnessCapabilities,
    /// Per-concern ownership contract for the harness.
    pub contract: HarnessContract,
    /// Whether the harness can currently be resolved and run.
    pub available: bool,
}

/// A pluggable agent runtime behind the CutReady host boundary.
#[async_trait]
pub trait AgentHarness: Send + Sync {
    /// Canonical, stable identifier for this harness (for example `"prompty"`).
    fn id(&self) -> &str;

    /// Capability metadata describing what this harness supports.
    #[allow(dead_code)]
    fn capabilities(&self) -> HarnessCapabilities;

    /// Ownership contract describing who provisions each host concern for this
    /// harness (provider, personas, tools, memory).
    #[allow(dead_code)]
    fn contract(&self) -> HarnessContract;

    /// Execute one agent run, forwarding events through `emit`.
    async fn run(
        &self,
        request: AgentRunRequest,
        emit: HarnessEventEmitter,
    ) -> Result<AgentRunResult, String>;
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::llm::LlmProvider;

    fn byok_config() -> LlmConfig {
        LlmConfig {
            provider: LlmProvider::MicrosoftFoundry,
            endpoint: "https://example.services.ai.azure.com".to_string(),
            api_key: "secret-key".to_string(),
            model: "gpt-5.6-terra".to_string(),
            bearer_token: Some("entra-token".to_string()),
        }
    }

    fn contract_with_provider(provider: Ownership) -> HarnessContract {
        HarnessContract {
            provider,
            personas: Ownership::Requires,
            tools: Ownership::Requires,
            memory: Ownership::Requires,
        }
    }

    fn contract_with_tools(tools: Ownership) -> HarnessContract {
        HarnessContract {
            provider: Ownership::Requires,
            personas: Ownership::Requires,
            tools,
            memory: Ownership::Requires,
        }
    }

    fn contract_with_personas(personas: Ownership) -> HarnessContract {
        HarnessContract {
            provider: Ownership::Requires,
            personas,
            tools: Ownership::Requires,
            memory: Ownership::Requires,
        }
    }

    fn sample_tools() -> Vec<ToolDefinition> {
        vec![ToolDefinition::function(
            "read_sketch",
            "Read a sketch",
            serde_json::json!({"type": "object"}),
        )]
    }

    fn sample_prompts() -> HashMap<String, String> {
        HashMap::from([("writer".to_string(), "You are the writer.".to_string())])
    }

    #[test]
    fn provides_strips_host_provider_credentials_and_model() {
        let out = contract_with_provider(Ownership::Provides).host_provider_config(byok_config());
        // The provider concern (endpoint, auth, model) belongs to the harness;
        // the host must not send its own. Only the discriminant is retained.
        assert_eq!(out.provider, LlmProvider::MicrosoftFoundry);
        assert!(out.endpoint.is_empty());
        assert!(out.api_key.is_empty());
        assert!(out.model.is_empty());
        assert_eq!(out.bearer_token, None);
    }

    #[test]
    fn requires_forwards_host_provider_unchanged() {
        let out = contract_with_provider(Ownership::Requires).host_provider_config(byok_config());
        assert_eq!(out.endpoint, "https://example.services.ai.azure.com");
        assert_eq!(out.api_key, "secret-key");
        assert_eq!(out.model, "gpt-5.6-terra");
        assert_eq!(out.bearer_token.as_deref(), Some("entra-token"));
    }

    #[test]
    fn augments_forwards_host_provider_unchanged() {
        let out = contract_with_provider(Ownership::Augments).host_provider_config(byok_config());
        assert_eq!(out.api_key, "secret-key");
        assert_eq!(out.model, "gpt-5.6-terra");
        assert_eq!(out.bearer_token.as_deref(), Some("entra-token"));
    }

    #[test]
    fn provides_own_provider_is_true_only_for_provides() {
        assert!(contract_with_provider(Ownership::Provides).provides_own_provider());
        assert!(!contract_with_provider(Ownership::Requires).provides_own_provider());
        assert!(!contract_with_provider(Ownership::Augments).provides_own_provider());
    }

    #[test]
    fn provides_withholds_host_tools() {
        let out = contract_with_tools(Ownership::Provides).host_tools(sample_tools());
        assert!(
            out.is_empty(),
            "a harness that provides its own tool loop must receive no host tools"
        );
    }

    #[test]
    fn requires_and_augments_forward_host_tools_unchanged() {
        for ownership in [Ownership::Requires, Ownership::Augments] {
            let out = contract_with_tools(ownership).host_tools(sample_tools());
            assert_eq!(out.len(), 1);
            assert_eq!(out[0].function.name, "read_sketch");
        }
    }

    #[test]
    fn provides_withholds_host_agent_prompts() {
        let out = contract_with_personas(Ownership::Provides).host_agent_prompts(sample_prompts());
        assert!(
            out.is_empty(),
            "a harness that provides its own personas must receive no host prompts"
        );
    }

    #[test]
    fn requires_and_augments_forward_host_agent_prompts_unchanged() {
        for ownership in [Ownership::Requires, Ownership::Augments] {
            let out = contract_with_personas(ownership).host_agent_prompts(sample_prompts());
            assert_eq!(out.get("writer").map(String::as_str), Some("You are the writer."));
        }
    }
}
