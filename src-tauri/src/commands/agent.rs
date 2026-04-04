//! Tauri commands for the AI assistant (chat, model listing, ✨ generation).

use serde::Deserialize;

use crate::engine::agent::azure_auth::{self, AuthCodeFlowInit, DeviceCodeResponse, TokenResponse};
use crate::engine::agent::llm::{
    ChatMessage, LlmClient, LlmConfig, LlmProvider, ModelInfo,
};
use crate::engine::agent::runner::{self, AgentEvent};
use crate::AppState;

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
}

impl From<ProviderConfig> for LlmConfig {
    fn from(c: ProviderConfig) -> Self {
        Self {
            provider: match c.provider.as_str() {
                "openai" => LlmProvider::Openai,
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
    let client = LlmClient::new(config.into());
    client.list_models().await
}

/// A single chat turn (non-streaming) for quick operations like ✨ field fill.
#[tauri::command]
pub async fn agent_chat(
    config: ProviderConfig,
    messages: Vec<ChatMessage>,
) -> Result<ChatMessage, String> {
    let client = LlmClient::new(config.into());
    let resp = client.chat(&messages, None).await?;
    resp.choices
        .into_iter()
        .next()
        .map(|c| c.message)
        .ok_or_else(|| "No response from model".into())
}

/// Push a message onto the pending stack while the agent loop is running.
#[tauri::command]
pub async fn push_pending_chat_message(
    state: tauri::State<'_, AppState>,
    message: String,
) -> Result<(), String> {
    state.pending_chat_messages.lock().unwrap().push(message);
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

    let project_root = {
        let guard = state.current_project.lock().unwrap();
        guard
            .as_ref()
            .ok_or("No project open")?
            .root
            .clone()
    };

    let pending = state.pending_chat_messages.clone();
    // Clear any stale pending messages before starting
    pending.lock().unwrap().clear();

    let prompts = agent_prompts.unwrap_or_default();
    let reported_context = config.context_length;
    let vision_mode = config.vision_mode.clone().unwrap_or_else(|| "off".into());
    let client = LlmClient::new(config.into());
    if let Some(ctx) = reported_context {
        client.set_reported_context_length(ctx);
    }

    // Determine effective vision: user setting AND model capability
    let vision_enabled = vision_mode != "off" && client.supports_vision();
    let include_sketches = vision_mode == "notes_and_sketches";
    let vision = runner::VisionConfig { enabled: vision_enabled, include_sketches };

    let emit_handle = app.clone();
    let result = runner::run(
        &client,
        messages,
        &project_root,
        &prompts,
        &pending,
        &vision,
        move |event: AgentEvent| {
            let _ = emit_handle.emit("agent-event", &event);
        },
    )
    .await?;

    Ok(AgentChatResult {
        messages: result.messages,
        response: result.response,
    })
}

/// Fetch a URL and return clean text content. Used by @web: references.
#[tauri::command]
pub async fn fetch_url_content(url: String) -> Result<String, String> {
    crate::engine::agent::web::fetch_and_clean(&url).await
}

/// Serializable result from the agentic chat.
#[derive(serde::Serialize)]
pub struct AgentChatResult {
    pub messages: Vec<ChatMessage>,
    pub response: String,
}

// ---------------------------------------------------------------------------
// GitHub Copilot SDK commands
// ---------------------------------------------------------------------------

use crate::engine::copilot;

/// Check whether the Copilot CLI is installed, and get version info.
#[tauri::command]
pub async fn check_copilot_available() -> Result<copilot::CopilotCliStatus, String> {
    Ok(copilot::get_cli_status().await)
}

/// List models available through the Copilot CLI.
#[tauri::command]
pub async fn list_copilot_models() -> Result<Vec<copilot::CopilotModelInfo>, String> {
    copilot::list_models().await
}

/// Agentic chat through the Copilot SDK — parallel to agent_chat_with_tools.
/// The SDK manages the agent loop, tool dispatch, and streaming.
/// Emits `agent-event` events identical to the existing provider path.
#[tauri::command]
pub async fn agent_chat_with_copilot(
    app: tauri::AppHandle,
    state: tauri::State<'_, AppState>,
    model: String,
    system_prompt: String,
    user_message: String,
    agent_prompts: Option<std::collections::HashMap<String, String>>,
    vision_mode: Option<String>,
) -> Result<AgentChatResult, String> {
    use tauri::Emitter;

    let project_root = {
        let guard = state.current_project.lock().unwrap();
        guard
            .as_ref()
            .ok_or("No project open")?
            .root
            .clone()
    };

    let prompts = agent_prompts.unwrap_or_default();
    let vision_enabled = vision_mode.as_deref() != Some("off")
        && vision_mode.as_deref() != None;

    let emit_handle = app.clone();
    let result = copilot::chat(
        &model,
        &system_prompt,
        &user_message,
        &prompts,
        &project_root,
        vision_enabled,
        move |event: AgentEvent| {
            let _ = emit_handle.emit("agent-event", &event);
        },
    )
    .await?;

    Ok(AgentChatResult {
        messages: vec![], // SDK manages history internally
        response: result.response,
    })
}

/// Simple non-streaming chat via Copilot SDK (for ✨ sparkle operations).
#[tauri::command]
pub async fn agent_chat_copilot_simple(
    model: String,
    system_prompt: String,
    user_message: String,
) -> Result<ChatMessage, String> {
    let response = copilot::chat_simple(&model, &system_prompt, &user_message).await?;
    Ok(ChatMessage {
        role: "assistant".into(),
        content: Some(crate::engine::agent::llm::MessageContent::Text(response)),
        tool_calls: None,
        tool_call_id: None,
    })
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
    let abs = crate::engine::project::safe_resolve(&root, &relative_path).map_err(|e| e.to_string())?;
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
    let abs = crate::engine::project::safe_resolve(&root, &relative_path).map_err(|e| e.to_string())?;
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
    let abs = crate::engine::project::safe_resolve(&root, &relative_path).map_err(|e| e.to_string())?;
    crate::engine::project::delete_chat_session(&abs).map_err(|e| e.to_string())
}

// ---------------------------------------------------------------------------
// Memory system
// ---------------------------------------------------------------------------

/// Get core memories formatted for injection into the system prompt.
#[tauri::command]
pub async fn get_memory_context(
    state: tauri::State<'_, AppState>,
) -> Result<String, String> {
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
pub async fn delete_memory(
    index: usize,
    state: tauri::State<'_, AppState>,
) -> Result<(), String> {
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
    let tid = if tenant_id.is_empty() { "organizations" } else { &tenant_id };
    azure_auth::request_device_code(tid, client_id.as_deref(), None).await
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
    let tid = if tenant_id.is_empty() { "organizations" } else { &tenant_id };
    azure_auth::poll_for_token(tid, &device_code, interval, timeout, client_id.as_deref()).await
}

/// Refresh an Azure OAuth token using a refresh token.
#[tauri::command]
pub async fn azure_token_refresh(
    tenant_id: String,
    refresh_token: String,
    client_id: Option<String>,
) -> Result<TokenResponse, String> {
    let tid = if tenant_id.is_empty() { "organizations" } else { &tenant_id };
    azure_auth::refresh_token(tid, &refresh_token, client_id.as_deref(), None).await
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
    let tid = if tenant_id.is_empty() { "organizations" } else { &tenant_id };
    let (init, verifier) =
        azure_auth::start_auth_code_flow(tid, client_id.as_deref(), None).await?;

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
    let tid = if tenant_id.is_empty() { "organizations" } else { &tenant_id };

    let (verifier, port) = {
        let guard = pending_auth().lock().await;
        let p = guard
            .as_ref()
            .ok_or("No pending browser auth flow")?;
        (p.code_verifier.clone(), p.port)
    };

    let code = azure_auth::wait_for_auth_code(port, timeout.unwrap_or(300), "CutReady").await?;

    let redirect_uri = format!("http://localhost:{port}");
    let token = azure_auth::exchange_code_for_token(
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
