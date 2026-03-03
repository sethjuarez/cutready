//! Tauri commands for the AI assistant (chat, model listing, ✨ generation).

use serde::Deserialize;

use crate::engine::agent::azure_auth::{self, AuthCodeFlowInit, DeviceCodeResponse, TokenResponse};
use crate::engine::agent::llm::{
    ChatMessage, LlmClient, LlmConfig, LlmProvider, ModelInfo,
};
use crate::engine::agent::runner;
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
#[tauri::command]
pub async fn agent_chat_with_tools(
    state: tauri::State<'_, AppState>,
    config: ProviderConfig,
    messages: Vec<ChatMessage>,
    agent_prompts: Option<std::collections::HashMap<String, String>>,
) -> Result<AgentChatResult, String> {
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
    let client = LlmClient::new(config.into());
    let result = runner::run(&client, messages, &project_root, &prompts, &pending).await?;

    Ok(AgentChatResult {
        messages: result.messages,
        response: result.response,
    })
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
// Azure Device Code OAuth
// ---------------------------------------------------------------------------

/// Start the Azure device code flow. Returns the user code + URL to display.
#[tauri::command]
pub async fn azure_device_code_start(
    tenant_id: String,
    client_id: Option<String>,
) -> Result<DeviceCodeResponse, String> {
    let tid = if tenant_id.is_empty() { "organizations" } else { &tenant_id };
    azure_auth::request_device_code(tid, client_id.as_deref()).await
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
    azure_auth::refresh_token(tid, &refresh_token, client_id.as_deref()).await
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
        azure_auth::start_auth_code_flow(tid, client_id.as_deref()).await?;

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

    let code = azure_auth::wait_for_auth_code(port, timeout.unwrap_or(300)).await?;

    let redirect_uri = format!("http://localhost:{port}");
    let token = azure_auth::exchange_code_for_token(
        tid,
        &code,
        &redirect_uri,
        &verifier,
        client_id.as_deref(),
    )
    .await?;

    // Clean up
    let mut guard = pending_auth().lock().await;
    *guard = None;

    Ok(token)
}
