//! GitHub Copilot SDK agent harness adapter.
//!
//! This module is the *only* place the [`copilot_sdk`] crate is wired into the
//! harness seam. The Copilot runtime is the GitHub Copilot CLI driven as a
//! subprocess over JSON-RPC; all `copilot_sdk::*` types — client, session,
//! events — stay behind this adapter and never leak past the CutReady-owned
//! boundary types in [`super`].
//!
//! Unlike the Prompty and agentive harnesses, the Copilot harness runs
//! Copilot's *own* agent loop with Copilot's *own* tools; it does not drive
//! CutReady's path-confined project tools, sub-agent delegation, mid-run
//! steering queue, or durable run-state persistence. Those differences are
//! advertised explicitly through [`static_capabilities`] rather than silently
//! downgraded, and the CutReady conversation/system prompt/context are handed
//! to the CLI so nothing the host gathered is dropped.
//!
//! Availability tracks whether the `copilot` CLI can be located on the host at
//! enumeration time (see [`is_available`]); the adapter never pretends to run
//! without it.

use std::time::Duration;

use async_trait::async_trait;

use crate::engine::agent::execution::{AgentEvent, ChatMessage, ContextItem, Usage};
use crate::engine::agent::llm::{LlmConfig, LlmProvider};

use super::{
    AgentHarness, AgentRunRequest, AgentRunResult, HarnessCapabilities, HarnessContract,
    HarnessEventEmitter, Ownership,
};

/// Canonical, stable identifier for the Copilot SDK harness.
pub const ID: &str = "copilot-sdk";

/// Whether the Copilot SDK harness can currently execute a run on this host.
///
/// Unlike the other adapters — whose availability is a compile-time constant —
/// the Copilot harness needs the GitHub Copilot CLI present at run time, so
/// availability is probed rather than assumed. The registry surfaces this to the
/// settings UI so the harness is only offered when it can actually run, instead
/// of being advertised and then failing when selected.
pub fn is_available() -> bool {
    copilot_sdk::find_copilot_cli().is_some()
}

/// Plain, host-facing snapshot of GitHub Copilot CLI availability and sign-in
/// state.
///
/// Deliberately a CutReady-owned DTO with **no** `copilot_sdk::*` types, so it
/// can cross the harness boundary — into the Tauri command layer and the
/// settings UI — without leaking the SDK's native `GetAuthStatusResponse`. The
/// only place that native type is touched is [`probe_auth`], immediately below.
#[derive(Debug, Clone, Default, PartialEq, Eq, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CopilotAuthStatus {
    /// Whether the `copilot` CLI could be located on this host.
    pub installed: bool,
    /// Whether the CLI reports an authenticated GitHub Copilot session.
    pub authenticated: bool,
    /// The signed-in GitHub login (`@login`), when authenticated.
    pub login: Option<String>,
    /// A human-readable status/detail message from the CLI or probe, if any.
    pub message: Option<String>,
    /// The detected CLI version, when the client could be started.
    pub cli_version: Option<String>,
}

/// Probe the GitHub Copilot CLI for install + sign-in state, returning a plain
/// host DTO.
///
/// This confines every `copilot_sdk::*` call to this module: it builds a
/// short-lived client, asks the CLI for its version and auth status over
/// JSON-RPC, and **always** shuts the client (and its CLI subprocess) down
/// before returning. When the CLI is not installed it returns early without
/// spawning anything, so a red "not installed" state is cheap.
///
/// `use_logged_in_user(false)` maps to the CLI's `--no-auto-login`, so merely
/// probing never triggers an interactive sign-in as a side effect. The SDK's
/// own process spawn already sets `CREATE_NO_WINDOW`, so no console window
/// flashes while probing on Windows.
#[tracing::instrument(name = "copilot_probe_auth", skip_all)]
pub async fn probe_auth() -> CopilotAuthStatus {
    if !is_available() {
        tracing::debug!(installed = false, "copilot cli not installed");
        return CopilotAuthStatus {
            installed: false,
            ..Default::default()
        };
    }

    tracing::debug!("probing copilot auth status");

    let client = match copilot_sdk::Client::builder()
        .use_stdio(true)
        .use_logged_in_user(false)
        .build()
    {
        Ok(client) => client,
        Err(error) => {
            tracing::warn!(error = %error, "failed to build copilot client");
            return CopilotAuthStatus {
                installed: true,
                message: Some(format!("Failed to build Copilot client: {error}")),
                ..Default::default()
            };
        }
    };

    if let Err(error) = client.start().await {
        tracing::warn!(error = %error, "failed to start copilot cli");
        let _ = client.stop().await;
        return CopilotAuthStatus {
            installed: true,
            message: Some(format!("Failed to start Copilot CLI: {error}")),
            ..Default::default()
        };
    }

    let cli_version = client
        .get_status()
        .await
        .ok()
        .and_then(|status| non_empty(&status.version));

    let result = match client.get_auth_status().await {
        Ok(status) => {
            tracing::info!(
                authenticated = status.is_authenticated,
                cli_version = cli_version.as_deref(),
                "copilot auth status probed"
            );
            auth_status_from_parts(
                status.is_authenticated,
                status.login.as_deref(),
                status.status_message.as_deref(),
                cli_version,
            )
        }
        Err(error) => {
            tracing::warn!(error = %error, "could not read copilot auth status");
            CopilotAuthStatus {
                installed: true,
                authenticated: false,
                login: None,
                message: Some(format!("Could not read Copilot auth status: {error}")),
                cli_version,
            }
        }
    };

    // Tear the CLI down regardless of outcome.
    let _ = client.stop().await;
    result
}

/// Build a [`CopilotAuthStatus`] from the plain fields the CLI reports.
///
/// Kept as a pure helper (no `copilot_sdk::*` types) so the mapping — trimming
/// blank logins/messages to `None`, marking the CLI installed — is unit-tested
/// without a live CLI subprocess.
fn auth_status_from_parts(
    is_authenticated: bool,
    login: Option<&str>,
    message: Option<&str>,
    cli_version: Option<String>,
) -> CopilotAuthStatus {
    CopilotAuthStatus {
        installed: true,
        authenticated: is_authenticated,
        login: login.and_then(non_empty),
        message: message.and_then(non_empty),
        cli_version,
    }
}

/// Launch the GitHub Copilot CLI sign-in flow and wait for it to finish.
///
/// On a local desktop `copilot login` opens the system browser and captures the
/// result on a loopback callback, so this is a genuine one-click sign-in for
/// non-technical users — no device code needs to be surfaced or parsed. The
/// call blocks until the CLI exits (bounded by a timeout) and returns an error
/// with a short output tail if sign-in did not complete, so the caller can fall
/// back to guided steps and the Recheck button.
///
/// The subprocess sets `CREATE_NO_WINDOW` on Windows (no console flash) and
/// `kill_on_drop` so an abandoned attempt does not leak a process.
#[tracing::instrument(name = "copilot_sign_in", skip_all)]
pub async fn sign_in() -> Result<(), String> {
    let Some(cli) = copilot_sdk::find_copilot_cli() else {
        tracing::warn!("copilot cli not found for sign-in");
        return Err(
            "GitHub Copilot CLI was not found on this system. Install it first, then try again."
                .to_string(),
        );
    };

    let mut command = tokio::process::Command::new(cli);
    command
        .arg("login")
        .stdin(std::process::Stdio::null())
        .stdout(std::process::Stdio::piped())
        .stderr(std::process::Stdio::piped())
        .kill_on_drop(true);
    #[cfg(target_os = "windows")]
    {
        use std::os::windows::process::CommandExt;
        command.creation_flags(0x08000000); // CREATE_NO_WINDOW
    }

    tracing::info!("launching copilot login");
    let child = command
        .spawn()
        .map_err(|error| format!("Failed to launch `copilot login`: {error}"))?;

    let output =
        match tokio::time::timeout(Duration::from_secs(300), child.wait_with_output()).await {
            Ok(Ok(output)) => output,
            Ok(Err(error)) => {
                tracing::warn!(error = %error, "copilot login process failed");
                return Err(format!("`copilot login` failed: {error}"));
            }
            Err(_) => {
                tracing::warn!("copilot login timed out");
                return Err(
                    "Sign-in timed out. Finish signing in in your browser, then click Recheck."
                        .to_string(),
                );
            }
        };

    if output.status.success() {
        tracing::info!("copilot login completed");
        return Ok(());
    }

    let tail = sign_in_error_tail(&output.stderr, &output.stdout);
    tracing::warn!(reason = %tail, "copilot login did not complete");
    Err(if tail.is_empty() {
        "`copilot login` did not complete. Try running `copilot login` in a terminal, then click Recheck."
            .to_string()
    } else {
        tail
    })
}

/// Extract a short, human-readable tail from a failed `copilot login` run,
/// preferring stderr and capping the length so the UI stays tidy.
fn sign_in_error_tail(stderr: &[u8], stdout: &[u8]) -> String {
    let source = if stderr.iter().any(|byte| !byte.is_ascii_whitespace()) {
        stderr
    } else {
        stdout
    };
    let text = String::from_utf8_lossy(source);
    let trimmed = text.trim();
    let chars: Vec<char> = trimmed.chars().collect();
    if chars.len() <= 400 {
        return trimmed.to_string();
    }
    let tail: String = chars[chars.len() - 400..].iter().collect();
    format!("…{tail}")
}

/// Capability metadata for the Copilot SDK runtime.
///
/// The Copilot CLI streams assistant deltas and runs its own tool loop, so
/// `streaming` and `tool_calls` are supported (the tool calls are Copilot's own,
/// not CutReady's path-confined project tools). It does not participate in
/// CutReady's sub-agent delegation, mid-run steering queue, web-search tool, or
/// durable run-state persistence, so those are advertised as unsupported.
pub fn static_capabilities() -> HarnessCapabilities {
    HarnessCapabilities {
        id: ID.to_string(),
        display_name: "GitHub Copilot".to_string(),
        streaming: true,
        tool_calls: true,
        vision: true,
        web_search: false,
        delegation: false,
        steering: false,
        cancellation: true,
        durable_state: false,
    }
}

/// Ownership contract for the Copilot SDK runtime.
///
/// The Copilot harness runs on the GitHub Copilot entitlement and drives
/// Copilot's own agent loop, so it *provides* its own provider, tool contract,
/// and session memory rather than requiring the host to supply them. CutReady's
/// personas are still authoritative, but they are layered onto Copilot's base
/// prompt (via `SystemMessageMode::Append`) and registered as native custom
/// agents, so personas are *augmented* rather than owned outright. An optional
/// BYOK provider (see [`build_provider_config`]) also merely augments the
/// entitlement, which is why `provider` is `Provides` rather than `Requires`.
pub fn static_contract() -> HarnessContract {
    HarnessContract {
        provider: Ownership::Provides,
        personas: Ownership::Augments,
        tools: Ownership::Provides,
        memory: Ownership::Provides,
    }
}

/// Production harness backed by the GitHub Copilot CLI via [`copilot_sdk`].
///
/// Stateless: the registry constructs it fresh per resolve. Each run spins up a
/// dedicated CLI client/session and tears it down when the run completes.
pub struct CopilotSdkHarness;

impl CopilotSdkHarness {
    /// Build a Copilot SDK harness.
    pub fn new() -> Self {
        Self
    }
}

impl Default for CopilotSdkHarness {
    fn default() -> Self {
        Self::new()
    }
}

#[async_trait]
impl AgentHarness for CopilotSdkHarness {
    fn id(&self) -> &str {
        ID
    }

    fn capabilities(&self) -> HarnessCapabilities {
        static_capabilities()
    }

    fn contract(&self) -> HarnessContract {
        static_contract()
    }

    async fn run(
        &self,
        request: AgentRunRequest,
        emit: HarnessEventEmitter,
    ) -> Result<AgentRunResult, String> {
        let AgentRunRequest {
            config,
            messages,
            repo_root: _repo_root,
            project_root,
            agent_id,
            agent_prompts,
            // The Copilot CLI runs its own tool loop with its own tools, so
            // CutReady's tool contract and mutation policy are not bridged here
            // (advertised via `tool_calls: true` for Copilot's own tools and
            // `delegation: false`). Path confinement stays with the CLI's cwd.
            mutation_tools_enabled: _mutation_tools_enabled,
            tools: _tools,
            context_items,
            run_id: _run_id,
            // Durable run-state persistence is not a Copilot-harness capability
            // (advertised as `durable_state: false`), so the store is not used.
            agent_state: _agent_state,
            cancellation,
        } = request;

        if !is_available() {
            return fail(
                &emit,
                "GitHub Copilot CLI was not found on this system. Install the Copilot CLI \
                 (or set COPILOT_CLI_PATH) to use the Copilot harness."
                    .to_string(),
            );
        }

        // Build and start the CLI client. `use_stdio` drives the CLI over stdio
        // (no local socket); `allow_all_tools` keeps the run non-interactive so a
        // headless harness never blocks on a permission prompt.
        let client = match copilot_sdk::Client::builder()
            .use_stdio(true)
            .cwd(&project_root)
            .allow_all_tools(true)
            .build()
        {
            Ok(client) => client,
            Err(error) => return fail(&emit, format!("Failed to build Copilot client: {error}")),
        };

        if let Err(error) = client.start().await {
            return fail(&emit, format!("Failed to start Copilot CLI: {error}"));
        }

        // Compose the system message: the active agent persona prompt plus any
        // preselected context items, folded in so nothing the host gathered is
        // silently dropped. `Append` mode layers the CutReady persona onto
        // Copilot's own base prompt instead of clobbering it, so Copilot keeps
        // its native capabilities while CutReady's persona stays authoritative
        // for the turn's intent.
        let system_message = build_system_message(&agent_id, &agent_prompts, &context_items);

        // Register CutReady's personas as native Copilot custom agents so the
        // host-owned prompts are available for delegation under their own names,
        // not just as the single active system message.
        let custom_agents = build_custom_agents(&agent_prompts);

        let model = config.llm.model.trim().to_string();
        let session_config = copilot_sdk::SessionConfig {
            model: (!model.is_empty()).then(|| model.clone()),
            system_message,
            custom_agents,
            provider: build_provider_config(&config.llm),
            streaming: true,
            working_directory: project_root.to_str().map(str::to_string),
            // Non-interactive: don't round-trip permission decisions to the SDK.
            request_permission: Some(false),
            ..Default::default()
        };

        let session = match client.create_session(session_config).await {
            Ok(session) => session,
            Err(error) => {
                let _ = client.stop().await;
                return fail(&emit, format!("Failed to create Copilot session: {error}"));
            }
        };

        // Subscribe before sending so no assistant events are missed.
        let mut events = session.subscribe();

        // Flatten the CutReady conversation into a single prompt. The CLI keeps
        // its own session history, but CutReady creates a fresh session per run,
        // so prior turns are rendered into the prompt to preserve context.
        let prompt = flatten_conversation(&messages);
        if let Err(error) = session.send(prompt).await {
            let _ = client.stop().await;
            return fail(&emit, format!("Failed to send prompt to Copilot: {error}"));
        }

        let mut response = String::new();
        let mut usage = Usage::default();
        let mut cancelled = false;
        let mut run_error: Option<String> = None;
        // Map tool_call_id -> tool_name from start events so completion events
        // (which carry only the id) can be labeled with a meaningful name.
        let mut tool_names: std::collections::HashMap<String, String> =
            std::collections::HashMap::new();

        loop {
            if cancellation.is_cancelled() {
                let _ = session.abort().await;
                cancelled = true;
                break;
            }
            // Poll with a bounded timeout so cancellation is observed promptly
            // even while the model is quiet between events.
            match tokio::time::timeout(Duration::from_millis(200), events.recv()).await {
                // Timed out waiting for the next event: loop to re-check cancel.
                Err(_elapsed) => continue,
                // The broadcast channel closed (CLI went away): stop reading.
                Ok(Err(_closed)) => break,
                Ok(Ok(event)) => {
                    use copilot_sdk::SessionEventData as Data;
                    match event.data {
                        Data::AssistantMessageDelta(delta) => {
                            response.push_str(&delta.delta_content);
                            (*emit)(AgentEvent::Delta {
                                content: delta.delta_content,
                            });
                        }
                        Data::AssistantMessage(message) => {
                            // Authoritative full message. If streaming produced
                            // nothing (non-streaming turn), surface it as a delta
                            // so the UI still shows the response.
                            if response.is_empty() && !message.content.is_empty() {
                                (*emit)(AgentEvent::Delta {
                                    content: message.content.clone(),
                                });
                            }
                            response = message.content;
                        }
                        Data::AssistantReasoningDelta(delta) => {
                            (*emit)(AgentEvent::Thinking {
                                content: delta.delta_content,
                            });
                        }
                        Data::ToolExecutionStart(tool) => {
                            let arguments = tool
                                .arguments
                                .as_ref()
                                .map(|value| value.to_string())
                                .unwrap_or_default();
                            tool_names.insert(tool.tool_call_id.clone(), tool.tool_name.clone());
                            (*emit)(AgentEvent::ToolCall {
                                name: tool.tool_name,
                                arguments,
                            });
                        }
                        Data::ToolExecutionComplete(tool) => {
                            let result = if tool.success {
                                tool.result
                                    .map(|content| content.content)
                                    .unwrap_or_default()
                            } else {
                                tool.error
                                    .map(|error| error.message)
                                    .unwrap_or_else(|| "Tool execution failed.".to_string())
                            };
                            let name = tool_names
                                .remove(&tool.tool_call_id)
                                .unwrap_or_else(|| tool.tool_call_id.clone());
                            (*emit)(AgentEvent::ToolResult { name, result });
                        }
                        Data::AssistantUsage(reported) => {
                            usage = to_host_usage(&reported);
                        }
                        Data::SessionError(error) => {
                            run_error = Some(format!("Copilot session error: {}", error.message));
                            break;
                        }
                        Data::SessionIdle(_) => break,
                        // Turn boundaries, info, compaction, hooks, and other
                        // lifecycle events have no CutReady frontend
                        // representation and are ignored.
                        _ => {}
                    }
                }
            }
        }

        // Tear the CLI down regardless of outcome.
        let _ = session.destroy().await;
        let _ = client.stop().await;

        if cancelled || cancellation.is_cancelled() {
            // The host command normalizes the cancelled outcome; don't emit an
            // Error/Done event for a user-cancelled run.
            return Err("Agent run cancelled by user.".to_string());
        }

        if let Some(message) = run_error {
            (*emit)(AgentEvent::Error {
                message: message.clone(),
            });
            return Err(message);
        }

        // Append the assistant turn to the conversation the host handed us so the
        // returned history matches the other harnesses' contract.
        let mut history = messages;
        history.push(ChatMessage::assistant(&response));

        (*emit)(AgentEvent::Done {
            response: response.clone(),
        });

        Ok(AgentRunResult {
            messages: history,
            response,
            usage,
        })
    }
}

// ---------------------------------------------------------------------------
// Prompt / system-message composition
// ---------------------------------------------------------------------------

/// Compose the CLI system message from the agent persona prompt and any
/// preselected context items. Returns `None` when there is nothing to send.
fn compose_system_message(
    agent_id: &str,
    agent_prompts: &std::collections::HashMap<String, String>,
    context_items: &[ContextItem],
) -> Option<String> {
    let mut blocks: Vec<String> = Vec::new();
    if let Some(system) = agent_prompts
        .get(agent_id)
        .map(|prompt| prompt.trim())
        .filter(|prompt| !prompt.is_empty())
    {
        blocks.push(system.to_string());
    }
    if let Some(context) = context_items_to_block(context_items) {
        blocks.push(context);
    }
    (!blocks.is_empty()).then(|| blocks.join("\n\n"))
}

/// Build the CLI system-message config from the composed persona/context text.
///
/// Uses [`copilot_sdk::SystemMessageMode::Append`] so CutReady's persona layers
/// onto Copilot's own base prompt rather than replacing it (the earlier
/// `Replace` clobbered Copilot's base capabilities). Returns `None` when there
/// is nothing host-side to contribute, letting the CLI run on its own prompt.
fn build_system_message(
    agent_id: &str,
    agent_prompts: &std::collections::HashMap<String, String>,
    context_items: &[ContextItem],
) -> Option<copilot_sdk::SystemMessageConfig> {
    compose_system_message(agent_id, agent_prompts, context_items).map(|content| {
        copilot_sdk::SystemMessageConfig {
            mode: Some(copilot_sdk::SystemMessageMode::Append),
            content: Some(content),
        }
    })
}

/// Register CutReady's agent personas as native Copilot custom agents.
///
/// Each host persona prompt becomes a [`copilot_sdk::CustomAgentConfig`] keyed
/// by its stable persona id (for example `planner`, `writer`, `editor`,
/// `designer`), so Copilot can address them by name and delegate between them
/// while the host-owned prompt stays authoritative. Ordering is stable
/// (sorted by id) so session config is deterministic. Returns `None` when no
/// non-empty personas are configured.
fn build_custom_agents(
    agent_prompts: &std::collections::HashMap<String, String>,
) -> Option<Vec<copilot_sdk::CustomAgentConfig>> {
    let mut entries: Vec<(&String, &String)> = agent_prompts
        .iter()
        .filter(|(id, prompt)| !id.trim().is_empty() && !prompt.trim().is_empty())
        .collect();
    if entries.is_empty() {
        return None;
    }
    entries.sort_by(|a, b| a.0.cmp(b.0));

    let agents = entries
        .into_iter()
        .map(|(id, prompt)| copilot_sdk::CustomAgentConfig {
            name: id.trim().to_string(),
            prompt: prompt.trim().to_string(),
            display_name: Some(title_case(id.trim())),
            description: None,
            tools: None,
            mcp_servers: None,
            infer: None,
        })
        .collect();
    Some(agents)
}

/// Title-case a persona id for a human-friendly display name (`writer` ->
/// `Writer`). Non-alphanumeric separators are preserved as spaces.
fn title_case(id: &str) -> String {
    id.split(|c: char| c == '-' || c == '_' || c == ' ')
        .filter(|word| !word.is_empty())
        .map(|word| {
            let mut chars = word.chars();
            match chars.next() {
                Some(first) => first.to_uppercase().collect::<String>() + chars.as_str(),
                None => String::new(),
            }
        })
        .collect::<Vec<_>>()
        .join(" ")
}

/// Fold preselected context items into a single text block so nothing the host
/// gathered is silently dropped.
fn context_items_to_block(items: &[ContextItem]) -> Option<String> {
    if items.is_empty() {
        return None;
    }
    let mut block = String::from("Relevant context gathered for this task. Use it when helpful.\n");
    let mut wrote_any = false;
    for item in items {
        let body = item
            .content
            .as_deref()
            .map(str::trim)
            .filter(|content| !content.is_empty())
            .unwrap_or_else(|| item.description.trim());
        if body.is_empty() && item.name.trim().is_empty() {
            continue;
        }
        wrote_any = true;
        block.push_str("\n## ");
        block.push_str(item.name.trim());
        block.push('\n');
        if !body.is_empty() {
            block.push_str(body);
            block.push('\n');
        }
    }
    wrote_any.then_some(block)
}

/// Flatten the CutReady conversation into a single prompt string.
///
/// System messages are handled separately (via the CLI system message), so only
/// user/assistant/tool turns are rendered. A single trailing user turn is sent
/// verbatim; multi-turn history is labeled so the CLI can follow the exchange.
fn flatten_conversation(messages: &[ChatMessage]) -> String {
    let turns: Vec<&ChatMessage> = messages
        .iter()
        .filter(|message| message.role != "system")
        .collect();

    // Common case: a single user turn — send it verbatim.
    if let [only] = turns.as_slice() {
        if only.role == "user" {
            return only.text().unwrap_or_default().to_string();
        }
    }

    let mut rendered = String::new();
    for message in turns {
        let text = message.text().unwrap_or_default().trim();
        if text.is_empty() {
            continue;
        }
        let label = match message.role.as_str() {
            "user" => "User",
            "assistant" => "Assistant",
            "tool" => "Tool result",
            other => other,
        };
        rendered.push_str(label);
        rendered.push_str(":\n");
        rendered.push_str(text);
        rendered.push_str("\n\n");
    }
    rendered.trim_end().to_string()
}

// ---------------------------------------------------------------------------
// Provider construction
// ---------------------------------------------------------------------------

/// Translate CutReady's provider config into a Copilot BYOK provider config.
///
/// Returns `None` when no API key or bearer token is configured, in which case
/// the CLI falls back to the signed-in user's Copilot entitlement.
fn build_provider_config(llm: &LlmConfig) -> Option<copilot_sdk::ProviderConfig> {
    let api_key = non_empty(&llm.api_key);
    let bearer_token = llm.bearer_token.as_deref().and_then(non_empty);
    if api_key.is_none() && bearer_token.is_none() {
        return None;
    }

    match llm.provider {
        LlmProvider::Openai => Some(copilot_sdk::ProviderConfig {
            base_url: openai_base_url(&llm.endpoint),
            provider_type: Some("openai".to_string()),
            wire_api: Some("openai".to_string()),
            api_key,
            bearer_token: None,
            azure: None,
        }),
        LlmProvider::Anthropic => Some(copilot_sdk::ProviderConfig {
            base_url: non_empty(&llm.endpoint)
                .unwrap_or_else(|| "https://api.anthropic.com".to_string()),
            provider_type: Some("anthropic".to_string()),
            wire_api: Some("anthropic".to_string()),
            api_key,
            bearer_token: None,
            azure: None,
        }),
        LlmProvider::AzureOpenai | LlmProvider::MicrosoftFoundry => {
            let base_url = non_empty(&llm.endpoint)?;
            Some(copilot_sdk::ProviderConfig {
                base_url,
                provider_type: Some("azure".to_string()),
                wire_api: Some("openai".to_string()),
                // Prefer an Entra bearer token when present; fall back to the
                // classic api-key header otherwise.
                api_key: if bearer_token.is_some() { None } else { api_key },
                bearer_token,
                azure: Some(copilot_sdk::AzureOptions { api_version: None }),
            })
        }
    }
}

/// Normalize an OpenAI endpoint to a `/v1` base URL. CutReady stores the bare
/// host (`https://api.openai.com`); the Copilot BYOK config expects the full
/// base URL including `/v1`.
fn openai_base_url(raw: &str) -> String {
    let trimmed = raw.trim_end_matches('/');
    let base = if trimmed.is_empty() {
        "https://api.openai.com"
    } else {
        trimmed
    };
    if base.ends_with("/v1") || base.contains("/v1/") {
        base.to_string()
    } else {
        format!("{base}/v1")
    }
}

fn non_empty(value: &str) -> Option<String> {
    let trimmed = value.trim();
    (!trimmed.is_empty()).then(|| trimmed.to_string())
}

fn to_host_usage(reported: &copilot_sdk::AssistantUsageData) -> Usage {
    let prompt_tokens = reported.input_tokens.unwrap_or(0.0).max(0.0) as u32;
    let completion_tokens = reported.output_tokens.unwrap_or(0.0).max(0.0) as u32;
    Usage {
        prompt_tokens,
        completion_tokens,
        total_tokens: prompt_tokens + completion_tokens,
    }
}

/// Emit an `Error` event and return the same message as the run failure.
fn fail(emit: &HarnessEventEmitter, message: String) -> Result<AgentRunResult, String> {
    (*emit)(AgentEvent::Error {
        message: message.clone(),
    });
    Err(message)
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::collections::HashMap;

    fn prompts() -> HashMap<String, String> {
        let mut map = HashMap::new();
        map.insert("planner".to_string(), "Plan the demo.".to_string());
        map.insert("writer".to_string(), "Write the narration.".to_string());
        map.insert("blank".to_string(), "   ".to_string());
        map
    }

    #[test]
    fn contract_provides_provider_and_augments_personas() {
        let contract = static_contract();
        assert_eq!(contract.provider, Ownership::Provides);
        assert_eq!(contract.personas, Ownership::Augments);
        assert_eq!(contract.tools, Ownership::Provides);
        assert_eq!(contract.memory, Ownership::Provides);
    }

    #[test]
    fn custom_agents_are_built_from_non_empty_personas_in_stable_order() {
        let agents = build_custom_agents(&prompts()).expect("expected custom agents");
        // Blank persona is dropped; remaining are sorted by id for determinism.
        let names: Vec<&str> = agents.iter().map(|a| a.name.as_str()).collect();
        assert_eq!(names, vec!["planner", "writer"]);

        let planner = &agents[0];
        assert_eq!(planner.prompt, "Plan the demo.");
        assert_eq!(planner.display_name.as_deref(), Some("Planner"));
        assert!(planner.tools.is_none());
        assert!(planner.mcp_servers.is_none());
    }

    #[test]
    fn custom_agents_none_when_no_usable_personas() {
        let mut map = HashMap::new();
        map.insert("planner".to_string(), "  ".to_string());
        assert!(build_custom_agents(&map).is_none());
        assert!(build_custom_agents(&HashMap::new()).is_none());
    }

    #[test]
    fn system_message_uses_append_mode_and_carries_active_persona() {
        // Regression guard for the Replace->Append fix: the CutReady persona
        // must layer onto Copilot's base prompt, never clobber it.
        let message = build_system_message("planner", &prompts(), &[])
            .expect("expected a system message for a non-empty persona");
        assert!(matches!(
            message.mode,
            Some(copilot_sdk::SystemMessageMode::Append)
        ));
        assert_eq!(message.content.as_deref(), Some("Plan the demo."));
    }

    #[test]
    fn system_message_none_when_nothing_host_side_to_contribute() {
        // Unknown persona id and no context => nothing to append, so the CLI
        // runs on its own base prompt.
        assert!(build_system_message("unknown", &prompts(), &[]).is_none());
    }

    #[test]
    fn title_case_humanizes_persona_ids() {
        assert_eq!(title_case("writer"), "Writer");
        assert_eq!(title_case("system-designer"), "System Designer");
        assert_eq!(title_case("copilot_sdk"), "Copilot Sdk");
    }

    #[test]
    fn auth_status_mapping_trims_blank_login_and_message() {
        let status = auth_status_from_parts(
            true,
            Some("  octocat  "),
            Some("   "),
            Some("0.9.0".to_string()),
        );
        assert!(status.installed);
        assert!(status.authenticated);
        // Blank/whitespace fields collapse to None; real values are trimmed.
        assert_eq!(status.login.as_deref(), Some("octocat"));
        assert_eq!(status.message, None);
        assert_eq!(status.cli_version.as_deref(), Some("0.9.0"));
    }

    #[test]
    fn auth_status_mapping_marks_installed_even_when_unauthenticated() {
        let status = auth_status_from_parts(false, None, Some("not signed in"), None);
        assert!(status.installed);
        assert!(!status.authenticated);
        assert_eq!(status.login, None);
        assert_eq!(status.message.as_deref(), Some("not signed in"));
    }

    #[test]
    fn auth_status_serializes_with_camel_case_keys() {
        // The settings UI reads `cliVersion`, so the DTO must serialize in
        // camelCase, not the Rust snake_case field name.
        let status = auth_status_from_parts(true, Some("octocat"), None, Some("1.2.3".to_string()));
        let value = serde_json::to_value(&status).expect("serialize");
        assert_eq!(value["installed"], serde_json::json!(true));
        assert_eq!(value["authenticated"], serde_json::json!(true));
        assert_eq!(value["login"], serde_json::json!("octocat"));
        assert_eq!(value["cliVersion"], serde_json::json!("1.2.3"));
        assert!(value.get("cli_version").is_none());
    }

    #[test]
    fn not_installed_status_is_the_default_all_false_shape() {
        let status = CopilotAuthStatus {
            installed: false,
            ..Default::default()
        };
        assert!(!status.installed);
        assert!(!status.authenticated);
        assert_eq!(status.login, None);
        assert_eq!(status.cli_version, None);
    }

    #[test]
    fn sign_in_error_tail_prefers_stderr_and_caps_length() {
        assert_eq!(
            sign_in_error_tail(b"  boom  ", b"stdout noise"),
            "boom".to_string()
        );
        // Falls back to stdout when stderr is blank.
        assert_eq!(sign_in_error_tail(b"   ", b" fallback "), "fallback".to_string());
        // Long output is truncated to a bounded tail with a leading ellipsis.
        let long = "x".repeat(1000);
        let tail = sign_in_error_tail(long.as_bytes(), b"");
        assert!(tail.starts_with('…'));
        assert_eq!(tail.chars().count(), 401); // 400 chars + ellipsis
    }
}
