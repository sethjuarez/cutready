//! Tauri commands for the AI assistant (chat, model listing, ✨ generation).

use serde::Deserialize;

use crate::engine::agent::llm::{self, ChatMessage, LlmConfig, LlmProvider, ModelInfo};
use crate::engine::agent::runner::{self, AgentEvent};
use crate::AppState;
use agentive::azure_oauth::{self, AuthCodeFlowInit, DeviceCodeResponse, TokenResponse};
use std::time::{Duration, Instant};

const SIMPLE_CHAT_TIMEOUT: Duration = Duration::from_secs(45);
const MIN_SIMPLE_CHAT_TIMEOUT_MS: u64 = 5_000;
const MAX_SIMPLE_CHAT_TIMEOUT_MS: u64 = 120_000;

/// Serialisable provider config sent from the frontend.
#[derive(Debug, Deserialize)]
pub struct ProviderConfig {
    pub provider: String,
    pub endpoint: String,
    pub api_key: String,
    pub model: String,
    #[serde(default)]
    pub bearer_token: Option<String>,
    /// API-reported context window (tokens) for the selected model.
    #[serde(default)]
    pub context_length: Option<usize>,
    /// Vision mode: "off", "notes", "notes_and_sketches".
    #[serde(default)]
    pub vision_mode: Option<String>,
    /// Capability discovered for the selected model/deployment.
    #[serde(default)]
    pub model_supports_vision: Option<bool>,
    /// Web search access: "disabled" or "enabled".
    #[serde(default)]
    pub web_access: Option<String>,
}

impl From<ProviderConfig> for LlmConfig {
    fn from(c: ProviderConfig) -> Self {
        Self {
            provider: match c.provider.as_str() {
                "openai" => LlmProvider::Openai,
                "anthropic" => LlmProvider::Anthropic,
                "microsoft_foundry" => LlmProvider::MicrosoftFoundry,
                _ => LlmProvider::AzureOpenai,
            },
            endpoint: c.endpoint,
            api_key: c.api_key,
            model: c.model,
            bearer_token: c.bearer_token,
        }
    }
}

/// List available models for the configured provider.
#[tauri::command]
pub async fn list_models(config: ProviderConfig) -> Result<Vec<ModelInfo>, String> {
    let llm_config: LlmConfig = config.into();
    llm::list_models(&llm_config).await
}

/// A single chat turn (non-streaming) for quick operations like ✨ field fill.
#[tauri::command]
pub async fn agent_chat(
    config: ProviderConfig,
    messages: Vec<ChatMessage>,
    timeout_ms: Option<u64>,
) -> Result<ChatMessage, String> {
    let started = Instant::now();
    let mut messages = messages;
    let stripped = crate::engine::agent::sanitize::sanitize_user_messages(&mut messages);
    if stripped > 0 {
        log::warn!(
            "[agent_chat] stripped {} control character(s) from user messages before send",
            stripped
        );
    }
    let message_chars = agentive::context::estimate_chars(&messages);
    let provider_name = config.provider.clone();
    let model = config.model.clone();
    let timeout = timeout_ms
        .map(|ms| ms.clamp(MIN_SIMPLE_CHAT_TIMEOUT_MS, MAX_SIMPLE_CHAT_TIMEOUT_MS))
        .map(Duration::from_millis)
        .unwrap_or(SIMPLE_CHAT_TIMEOUT);
    let llm_config: LlmConfig = config.into();
    let provider = llm::build_provider(&llm_config, None);
    let budget_chars = provider.context_budget_chars();
    log::info!(
        "[agent_chat] start provider={} model={} messages={} chars={} budget={}chars timeout={}ms",
        provider_name,
        model,
        messages.len(),
        message_chars,
        budget_chars,
        timeout.as_millis()
    );
    crate::util::trace::emit(
        "agent_chat_start",
        "agent",
        serde_json::json!({
            "provider": provider_name,
            "model": model,
            "messages": messages.len(),
            "chars": message_chars,
            "budget_chars": budget_chars,
            "timeout_ms": timeout.as_millis(),
        }),
    );

    match tokio::time::timeout(timeout, llm::simple_chat(provider, messages)).await {
        Err(_) => {
            let elapsed_ms = started.elapsed().as_millis();
            log::warn!(
                "[agent_chat] timeout provider={} model={} elapsed={}ms",
                provider_name,
                model,
                elapsed_ms
            );
            crate::util::trace::emit(
                "agent_chat_timeout",
                "agent",
                serde_json::json!({
                    "provider": provider_name,
                    "model": model,
                    "elapsed_ms": elapsed_ms,
                    "timeout_ms": timeout.as_millis(),
                }),
            );
            Err(format!(
                "AI request timed out after {} seconds",
                timeout.as_secs()
            ))
        }
        Ok(Ok(response)) => {
            let elapsed_ms = started.elapsed().as_millis();
            log::info!(
                "[agent_chat] done provider={} model={} elapsed={}ms response_chars={}",
                provider_name,
                model,
                elapsed_ms,
                response.content.as_ref().map(|s| s.char_len()).unwrap_or(0)
            );
            crate::util::trace::emit(
                "agent_chat_done",
                "agent",
                serde_json::json!({
                    "provider": provider_name,
                    "model": model,
                    "elapsed_ms": elapsed_ms,
                    "response_chars": response.content.as_ref().map(|s| s.char_len()).unwrap_or(0),
                }),
            );
            Ok(response)
        }
        Ok(Err(err)) => {
            let elapsed_ms = started.elapsed().as_millis();
            log::warn!(
                "[agent_chat] error provider={} model={} elapsed={}ms error={}",
                provider_name,
                model,
                elapsed_ms,
                err
            );
            crate::util::trace::emit(
                "agent_chat_error",
                "agent",
                serde_json::json!({
                    "provider": provider_name,
                    "model": model,
                    "elapsed_ms": elapsed_ms,
                    "error": err.to_string(),
                }),
            );
            Err(err.to_string())
        }
    }
}

/// Push a message onto the pending stack while the agent loop is running.
#[tauri::command]
pub async fn push_pending_chat_message(
    state: tauri::State<'_, AppState>,
    message: String,
) -> Result<(), String> {
    state.steering.send(&message);
    Ok(())
}

/// Agentic chat with function calling — the LLM can read/write project files.
/// Returns the full conversation (including tool calls) and the final response.
/// Emits `agent-event` events to the frontend for real-time streaming.
#[tauri::command]
pub async fn agent_chat_with_tools(
    app: tauri::AppHandle,
    state: tauri::State<'_, AppState>,
    config: ProviderConfig,
    messages: Vec<ChatMessage>,
    agent_prompts: Option<std::collections::HashMap<String, String>>,
) -> Result<AgentChatResult, String> {
    use tauri::Emitter;

    let started = Instant::now();
    let mut messages = messages;
    let stripped = crate::engine::agent::sanitize::sanitize_user_messages(&mut messages);
    if stripped > 0 {
        log::warn!(
            "[agent_chat_with_tools] stripped {} control character(s) from user messages before send",
            stripped
        );
    }
    let message_chars = agentive::context::estimate_chars(&messages);
    let message_count = messages.len();
    // Heads-up log for unusually large request payloads. Azure OpenAI and other
    // gateways have rejected ~80KB+ bodies in the past with confusing
    // 'Unterminated string' parse errors (see issue #60); having a clear
    // size-based warning makes future occurrences easier to triage.
    if message_chars > 100_000 {
        log::warn!(
            "[agent_chat_with_tools] large request: messages={} chars={} (threshold=100000)",
            message_count,
            message_chars,
        );
    }
    let project_root = {
        let guard = state.current_project.lock().unwrap();
        guard.as_ref().ok_or("No project open")?.root.clone()
    };

    let steering = state.steering.clone();

    let prompts = agent_prompts.unwrap_or_default();
    let reported_context = config.context_length;
    let vision_mode = config.vision_mode.clone().unwrap_or_else(|| "off".into());
    let discovered_vision_support = config.model_supports_vision;
    let search_enabled = config.web_access.as_deref() == Some("enabled");
    let provider_name = config.provider.clone();
    let model = config.model.clone();
    let llm_config: LlmConfig = config.into();

    // Determine effective vision: user setting AND discovered/static model capability.
    let model_supports_vision =
        discovered_vision_support.unwrap_or_else(|| llm::supports_vision(&llm_config.model));
    let vision_enabled = vision_mode != "off" && model_supports_vision;
    let vision = runner::VisionConfig {
        enabled: vision_enabled,
    };
    let web_access = runner::WebAccessConfig { search_enabled };

    let provider = llm::build_provider(&llm_config, reported_context);
    let budget_chars = provider.context_budget_chars();
    log::info!(
        "[agent_chat_with_tools] start provider={} model={} messages={} chars={} budget={}chars reported_context={:?} vision={} web_search={} prompts={}",
        provider_name,
        model,
        message_count,
        message_chars,
        budget_chars,
        reported_context,
        vision.enabled,
        web_access.search_enabled,
        prompts.len()
    );
    crate::util::trace::emit(
        "agent_chat_with_tools_start",
        "agent",
        serde_json::json!({
            "provider": provider_name,
            "model": model,
            "messages": message_count,
            "chars": message_chars,
            "budget_chars": budget_chars,
            "reported_context": reported_context,
            "vision_enabled": vision.enabled,
            "web_search_enabled": web_access.search_enabled,
            "agent_prompts": prompts.len(),
        }),
    );

    let emit_handle = app.clone();
    let result = match runner::run(
        provider,
        messages,
        &project_root,
        &prompts,
        &steering,
        &vision,
        &web_access,
        move |event: AgentEvent| {
            let _ = emit_handle.emit("agent-event", &event);
        },
    )
    .await
    {
        Ok(result) => {
            let elapsed_ms = started.elapsed().as_millis();
            log::info!(
                "[agent_chat_with_tools] done provider={} model={} elapsed={}ms response_chars={} total_messages={} total_tokens={}",
                provider_name,
                model,
                elapsed_ms,
                result.response.len(),
                result.messages.len(),
                result.total_usage.total_tokens
            );
            crate::util::trace::emit(
                "agent_chat_with_tools_done",
                "agent",
                serde_json::json!({
                    "provider": provider_name,
                    "model": model,
                    "elapsed_ms": elapsed_ms,
                    "response_chars": result.response.len(),
                    "total_messages": result.messages.len(),
                    "total_tokens": result.total_usage.total_tokens,
                }),
            );
            result
        }
        Err(err) => {
            let elapsed_ms = started.elapsed().as_millis();
            log::warn!(
                "[agent_chat_with_tools] error provider={} model={} elapsed={}ms error={}",
                provider_name,
                model,
                elapsed_ms,
                err
            );
            crate::util::trace::emit(
                "agent_chat_with_tools_error",
                "agent",
                serde_json::json!({
                    "provider": provider_name,
                    "model": model,
                    "elapsed_ms": elapsed_ms,
                    "error": err,
                }),
            );
            return Err(err);
        }
    };

    Ok(AgentChatResult {
        messages: result.messages,
        response: result.response,
    })
}

/// Fetch a URL and return clean text content. Used by @web: references.
#[tauri::command]
pub async fn fetch_url_content(url: String) -> Result<String, String> {
    agentive::web::fetch_and_clean(&url).await
}

/// Serializable result from the agentic chat.
#[derive(serde::Serialize)]
pub struct AgentChatResult {
    pub messages: Vec<ChatMessage>,
    pub response: String,
}

// ---------------------------------------------------------------------------
// Chat session persistence
// ---------------------------------------------------------------------------

use crate::engine::project::{ChatSession, ChatSessionSummary};

/// List all chat sessions in the current project.
#[tauri::command]
pub async fn list_chat_sessions(
    state: tauri::State<'_, AppState>,
) -> Result<Vec<ChatSessionSummary>, String> {
    let root = {
        let guard = state.current_project.lock().unwrap();
        guard.as_ref().ok_or("No project open")?.root.clone()
    };
    crate::engine::project::scan_chat_sessions(&root).map_err(|e| e.to_string())
}

/// Load a chat session by relative path.
#[tauri::command]
pub async fn get_chat_session(
    relative_path: String,
    state: tauri::State<'_, AppState>,
) -> Result<ChatSession, String> {
    let root = {
        let guard = state.current_project.lock().unwrap();
        guard.as_ref().ok_or("No project open")?.root.clone()
    };
    let abs =
        crate::engine::project::safe_resolve(&root, &relative_path).map_err(|e| e.to_string())?;
    crate::engine::project::read_chat_session(&abs).map_err(|e| e.to_string())
}

/// Save a chat session to a relative path.
#[tauri::command]
pub async fn save_chat_session(
    relative_path: String,
    session: ChatSession,
    state: tauri::State<'_, AppState>,
) -> Result<(), String> {
    let root = {
        let guard = state.current_project.lock().unwrap();
        guard.as_ref().ok_or("No project open")?.root.clone()
    };
    let abs =
        crate::engine::project::safe_resolve(&root, &relative_path).map_err(|e| e.to_string())?;
    crate::engine::project::write_chat_session(&abs, &session).map_err(|e| e.to_string())
}

/// Delete a chat session by relative path.
#[tauri::command]
pub async fn delete_chat_session(
    relative_path: String,
    state: tauri::State<'_, AppState>,
) -> Result<(), String> {
    let root = {
        let guard = state.current_project.lock().unwrap();
        guard.as_ref().ok_or("No project open")?.root.clone()
    };
    let abs =
        crate::engine::project::safe_resolve(&root, &relative_path).map_err(|e| e.to_string())?;
    crate::engine::project::delete_chat_session(&abs).map_err(|e| e.to_string())
}

// ---------------------------------------------------------------------------
// Memory system
// ---------------------------------------------------------------------------

/// Get core memories formatted for injection into the system prompt.
#[tauri::command]
pub async fn get_memory_context(state: tauri::State<'_, AppState>) -> Result<String, String> {
    let root = {
        let guard = state.current_project.lock().unwrap();
        guard.as_ref().ok_or("No project open")?.root.clone()
    };
    Ok(crate::engine::memory::format_for_system_prompt(&root))
}

/// Save a session summary to archival memory (called when chat session ends).
#[tauri::command]
pub async fn archive_chat_session(
    session_id: String,
    summary: String,
    state: tauri::State<'_, AppState>,
) -> Result<(), String> {
    let root = {
        let guard = state.current_project.lock().unwrap();
        guard.as_ref().ok_or("No project open")?.root.clone()
    };
    // Clear the pending summary since we're archiving now
    *state.last_chat_summary.lock().unwrap() = None;
    crate::engine::memory::archive_session(&root, &summary, &session_id)
}

/// Update the current chat summary (called periodically by frontend).
/// Stored in AppState so the Rust-side window close handler can archive it.
#[tauri::command]
pub async fn update_chat_summary(
    session_id: String,
    summary: String,
    state: tauri::State<'_, AppState>,
) -> Result<(), String> {
    *state.last_chat_summary.lock().unwrap() = Some((session_id, summary));
    Ok(())
}

/// List all memories in the current project.
#[tauri::command]
pub async fn list_memories(
    state: tauri::State<'_, AppState>,
) -> Result<Vec<crate::engine::memory::MemoryEntry>, String> {
    let root = {
        let guard = state.current_project.lock().unwrap();
        guard.as_ref().ok_or("No project open")?.root.clone()
    };
    Ok(crate::engine::memory::load(&root).memories)
}

/// Delete a memory by index.
#[tauri::command]
pub async fn delete_memory(index: usize, state: tauri::State<'_, AppState>) -> Result<(), String> {
    let root = {
        let guard = state.current_project.lock().unwrap();
        guard.as_ref().ok_or("No project open")?.root.clone()
    };
    crate::engine::memory::delete_memory(&root, index)
}

/// Update a memory's content by index.
#[tauri::command]
pub async fn update_memory(
    index: usize,
    content: String,
    state: tauri::State<'_, AppState>,
) -> Result<(), String> {
    let root = {
        let guard = state.current_project.lock().unwrap();
        guard.as_ref().ok_or("No project open")?.root.clone()
    };
    crate::engine::memory::update_memory(&root, index, &content)
}

/// Clear memories by category (or all if no category provided).
#[tauri::command]
pub async fn clear_memories(
    category: Option<String>,
    state: tauri::State<'_, AppState>,
) -> Result<usize, String> {
    let root = {
        let guard = state.current_project.lock().unwrap();
        guard.as_ref().ok_or("No project open")?.root.clone()
    };
    let cat = category.map(|c| match c.as_str() {
        "core" => crate::engine::memory::MemoryCategory::Core,
        "archival" => crate::engine::memory::MemoryCategory::Archival,
        "insight" => crate::engine::memory::MemoryCategory::Insight,
        _ => crate::engine::memory::MemoryCategory::Archival,
    });
    crate::engine::memory::clear_memories(&root, cat)
}

// ---------------------------------------------------------------------------
// Azure Device Code OAuth
// ---------------------------------------------------------------------------

/// Start the Azure device code flow. Returns the user code + URL to display.
#[tauri::command]
pub async fn azure_device_code_start(
    tenant_id: String,
    client_id: Option<String>,
) -> Result<DeviceCodeResponse, String> {
    let tid = if tenant_id.is_empty() {
        "organizations"
    } else {
        &tenant_id
    };
    azure_oauth::request_device_code(tid, client_id.as_deref(), None).await
}

/// Poll for the token after the user has completed sign-in.
/// This blocks until success, timeout, or error.
#[tauri::command]
pub async fn azure_device_code_poll(
    tenant_id: String,
    device_code: String,
    interval: u64,
    timeout: u64,
    client_id: Option<String>,
) -> Result<TokenResponse, String> {
    let tid = if tenant_id.is_empty() {
        "organizations"
    } else {
        &tenant_id
    };
    azure_oauth::poll_for_token(tid, &device_code, interval, timeout, client_id.as_deref()).await
}

/// Refresh an Azure OAuth token using a refresh token.
#[tauri::command]
pub async fn azure_token_refresh(
    tenant_id: String,
    refresh_token: String,
    client_id: Option<String>,
    scope: Option<String>,
) -> Result<TokenResponse, String> {
    let tid = if tenant_id.is_empty() {
        "organizations"
    } else {
        &tenant_id
    };
    azure_oauth::refresh_token(tid, &refresh_token, client_id.as_deref(), scope.as_deref()).await
}

// ---------------------------------------------------------------------------
// Browser-based Authorization Code + PKCE flow
// ---------------------------------------------------------------------------

/// State for an in-progress browser auth flow.
struct PendingBrowserAuth {
    code_verifier: String,
    port: u16,
}

static PENDING_BROWSER_AUTH: std::sync::OnceLock<tokio::sync::Mutex<Option<PendingBrowserAuth>>> =
    std::sync::OnceLock::new();

fn pending_auth() -> &'static tokio::sync::Mutex<Option<PendingBrowserAuth>> {
    PENDING_BROWSER_AUTH.get_or_init(|| tokio::sync::Mutex::new(None))
}

/// Start the browser auth flow. Returns the auth URL + port for the frontend to open.
#[tauri::command]
pub async fn azure_browser_auth_start(
    tenant_id: String,
    client_id: Option<String>,
) -> Result<AuthCodeFlowInit, String> {
    let tid = if tenant_id.is_empty() {
        "organizations"
    } else {
        &tenant_id
    };
    let (init, verifier) =
        azure_oauth::start_auth_code_flow(tid, client_id.as_deref(), None).await?;

    // Store verifier + port for the exchange step
    let mut guard = pending_auth().lock().await;
    *guard = Some(PendingBrowserAuth {
        code_verifier: verifier,
        port: init.port,
    });

    Ok(init)
}

/// Wait for the browser callback, then exchange the code for tokens.
#[tauri::command]
pub async fn azure_browser_auth_complete(
    tenant_id: String,
    client_id: Option<String>,
    timeout: Option<u64>,
) -> Result<TokenResponse, String> {
    let tid = if tenant_id.is_empty() {
        "organizations"
    } else {
        &tenant_id
    };

    let (verifier, port) = {
        let guard = pending_auth().lock().await;
        let p = guard.as_ref().ok_or("No pending browser auth flow")?;
        (p.code_verifier.clone(), p.port)
    };

    let code = azure_oauth::wait_for_auth_code(port, timeout.unwrap_or(300), "CutReady").await?;

    let redirect_uri = format!("http://localhost:{port}");
    let token = azure_oauth::exchange_code_for_token(
        tid,
        &code,
        &redirect_uri,
        &verifier,
        client_id.as_deref(),
        None,
    )
    .await?;

    // Clean up
    let mut guard = pending_auth().lock().await;
    *guard = None;

    Ok(token)
}

// ---------------------------------------------------------------------------
// ARM Resource Discovery (Microsoft Foundry setup wizard)
// ---------------------------------------------------------------------------

use agentive::arm_discovery::{AiResource, FoundryProject, Subscription};

/// List Azure subscriptions accessible to the user.
#[tauri::command]
pub async fn list_azure_subscriptions(
    management_token: String,
) -> Result<Vec<Subscription>, String> {
    agentive::arm_discovery::list_subscriptions(&management_token).await
}

/// List AI resources (Azure OpenAI / AI Services) in a subscription.
#[tauri::command]
pub async fn list_azure_ai_resources(
    management_token: String,
    subscription_id: String,
) -> Result<Vec<AiResource>, String> {
    agentive::arm_discovery::list_ai_resources(&management_token, &subscription_id).await
}

/// List Foundry projects under an AI resource.
#[tauri::command]
pub async fn list_foundry_projects(
    management_token: String,
    subscription_id: String,
    resource_group: String,
    resource_name: String,
) -> Result<Vec<FoundryProject>, String> {
    agentive::arm_discovery::list_foundry_projects(
        &management_token,
        &subscription_id,
        &resource_group,
        &resource_name,
    )
    .await
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::engine::agent::llm::LlmProvider;

    fn make_config(provider: &str) -> ProviderConfig {
        ProviderConfig {
            provider: provider.into(),
            endpoint: "https://example.com".into(),
            api_key: "key".into(),
            model: "gpt-4o".into(),
            bearer_token: Some("token".into()),
            context_length: Some(128_000),
            vision_mode: Some("off".into()),
            model_supports_vision: Some(true),
            web_access: Some("disabled".into()),
        }
    }

    #[test]
    fn provider_config_to_llm_config_azure() {
        let config: LlmConfig = make_config("azure_openai").into();
        assert_eq!(config.provider, LlmProvider::AzureOpenai);
        assert_eq!(config.endpoint, "https://example.com");
        assert_eq!(config.api_key, "key");
        assert_eq!(config.model, "gpt-4o");
        assert_eq!(config.bearer_token, Some("token".into()));
    }

    #[test]
    fn provider_config_to_llm_config_foundry() {
        let config: LlmConfig = make_config("microsoft_foundry").into();
        assert_eq!(config.provider, LlmProvider::MicrosoftFoundry);
    }

    #[test]
    fn provider_config_to_llm_config_openai() {
        let config: LlmConfig = make_config("openai").into();
        assert_eq!(config.provider, LlmProvider::Openai);
    }

    #[test]
    fn provider_config_to_llm_config_anthropic() {
        let config: LlmConfig = make_config("anthropic").into();
        assert_eq!(config.provider, LlmProvider::Anthropic);
    }

    #[test]
    fn provider_config_unknown_defaults_to_azure() {
        let config: LlmConfig = make_config("some_future_provider").into();
        assert_eq!(config.provider, LlmProvider::AzureOpenai);
    }
}
