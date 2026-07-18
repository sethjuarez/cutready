//! Tauri commands for the AI assistant (chat, model listing, ✨ generation).

use agentive::LocalContextIndex;
use serde::Deserialize;

use crate::engine::agent::llm::{self, ChatMessage, LlmConfig, LlmProvider, ModelInfo};
use crate::engine::agent::runner::{self, AgentEvent};
use crate::engine::agent_state::{
    AgentRunDetail, AgentRunSummary, AgentStateMaintenanceResult, AgentStateStore, ChatSessionPage,
    ChatSessionRecord, ChatSessionSummary, ContextAssetInput, ContextAssetScope,
};
use crate::{AgentChatCancellationRegistry, AppState};
use agentive::azure_oauth::{self, AuthCodeFlowInit, DeviceCodeResponse, TokenResponse};
use std::collections::HashSet;
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};
use tauri_plugin_auditaur::auditaur_command;

const SIMPLE_CHAT_TIMEOUT: Duration = Duration::from_secs(45);
const MIN_SIMPLE_CHAT_TIMEOUT_MS: u64 = 5_000;
const MAX_SIMPLE_CHAT_TIMEOUT_MS: u64 = 120_000;
const AGENT_RUN_CANCELLED_ERROR: &str = "Agent run cancelled";

struct ActiveAgentRunGuard {
    run_id: String,
    active_runs: Arc<Mutex<HashSet<String>>>,
}

impl ActiveAgentRunGuard {
    fn register(active_runs: Arc<Mutex<HashSet<String>>>, run_id: String) -> Self {
        match active_runs.lock() {
            Ok(mut runs) => {
                runs.insert(run_id.clone());
            }
            Err(err) => {
                log::warn!("[agent_chat_with_tools] active run tracking unavailable: {err}");
            }
        }
        Self {
            run_id,
            active_runs,
        }
    }
}

impl Drop for ActiveAgentRunGuard {
    fn drop(&mut self) {
        if let Ok(mut runs) = self.active_runs.lock() {
            runs.remove(&self.run_id);
        }
    }
}

struct AgentChatCancellationGuard {
    client_run_id: String,
    generation: String,
    cancellations: AgentChatCancellationRegistry,
}

impl AgentChatCancellationGuard {
    fn register(
        cancellations: AgentChatCancellationRegistry,
        client_run_id: String,
        cancellation: agentive::CancellationToken,
    ) -> Result<Self, String> {
        let generation = uuid::Uuid::new_v4().to_string();
        let mut active_cancellations = cancellations
            .lock()
            .map_err(|err| format!("Agent cancellation registry unavailable: {err}"))?;
        if active_cancellations.contains_key(&client_run_id) {
            return Err(format!(
                "A chat run with client run ID {client_run_id} is already active"
            ));
        }
        active_cancellations.insert(
            client_run_id.clone(),
            crate::AgentChatCancellationEntry {
                generation: generation.clone(),
                cancellation,
            },
        );
        drop(active_cancellations);
        Ok(Self {
            client_run_id,
            generation,
            cancellations,
        })
    }
}

impl Drop for AgentChatCancellationGuard {
    fn drop(&mut self) {
        if let Ok(mut active_cancellations) = self.cancellations.lock() {
            if active_cancellations
                .get(&self.client_run_id)
                .is_some_and(|entry| entry.generation == self.generation)
            {
                active_cancellations.remove(&self.client_run_id);
            }
        }
    }
}

fn cancel_agent_chat_run_in_registry(
    cancellations: &AgentChatCancellationRegistry,
    client_run_id: &str,
) -> Result<bool, String> {
    let active_cancellations = cancellations
        .lock()
        .map_err(|err| format!("Agent cancellation registry unavailable: {err}"))?;
    let Some(entry) = active_cancellations.get(client_run_id) else {
        return Ok(false);
    };
    if entry.cancellation.is_cancelled() {
        return Ok(false);
    }
    entry.cancellation.cancel();
    Ok(true)
}

fn agent_event_payload(event: &AgentEvent, client_run_id: Option<&str>) -> serde_json::Value {
    let mut payload = serde_json::to_value(event).unwrap_or_default();
    if let (Some(client_run_id), serde_json::Value::Object(payload)) = (client_run_id, &mut payload)
    {
        payload.insert(
            "client_run_id".into(),
            serde_json::Value::String(client_run_id.into()),
        );
    }
    payload
}

/// Serialisable provider config sent from the frontend.
#[derive(Debug, Deserialize)]
pub struct ProviderConfig {
    #[serde(default)]
    pub provider_id: Option<String>,
    #[serde(default)]
    pub provider_name: Option<String>,
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
    /// Maximum agentive tool-call rounds before stopping the run.
    #[serde(default)]
    pub max_tool_rounds: Option<usize>,
}

#[derive(Debug, Deserialize)]
pub struct AgentContextItemConfig {
    pub name: String,
    #[serde(default)]
    pub source: Option<String>,
    #[serde(default)]
    pub kind: Option<String>,
    pub content: String,
    #[serde(default)]
    pub content_type: Option<String>,
    #[serde(default)]
    pub priority: Option<i32>,
    #[serde(default)]
    pub origin: Option<String>,
    #[serde(default)]
    pub persist: bool,
}

impl AgentContextItemConfig {
    fn into_context_item(
        self,
        store: Option<&AgentStateStore>,
    ) -> Result<agentive::ContextItem, String> {
        let source = match self.source.as_deref() {
            Some("user") => agentive::ContextSource::User,
            Some("system") => agentive::ContextSource::System,
            Some("tool_result") => agentive::ContextSource::ToolResult,
            Some("file") => agentive::ContextSource::File,
            Some("search") => agentive::ContextSource::Search,
            Some("checkpoint") => agentive::ContextSource::Checkpoint,
            Some("memory") => agentive::ContextSource::Memory,
            Some("host") => agentive::ContextSource::Host,
            _ => agentive::ContextSource::Custom,
        };
        let kind = match self.kind.as_deref() {
            Some("recent_turn") => agentive::ContextKind::RecentTurn,
            Some("memory_fact") => agentive::ContextKind::MemoryFact,
            Some("reference_doc") => agentive::ContextKind::ReferenceDoc,
            Some("tool_observation") => agentive::ContextKind::ToolObservation,
            Some("file_excerpt") => agentive::ContextKind::FileExcerpt,
            Some("web_excerpt") => agentive::ContextKind::WebExcerpt,
            Some("error_trace") => agentive::ContextKind::ErrorTrace,
            Some("media_summary") => agentive::ContextKind::MediaSummary,
            _ => agentive::ContextKind::Other,
        };
        let scope = if self.persist {
            ContextAssetScope::Project
        } else {
            ContextAssetScope::Session
        };
        let origin = self
            .origin
            .unwrap_or_else(|| self.name.clone())
            .trim()
            .to_string();
        let asset = store
            .map(|store| {
                store.store_context_asset(ContextAssetInput {
                    name: self.name.clone(),
                    origin: origin.clone(),
                    source: "user_attachment".into(),
                    kind: self.kind.clone().unwrap_or_else(|| "other".into()),
                    content: self.content.clone(),
                    content_type: self
                        .content_type
                        .clone()
                        .unwrap_or_else(|| "text/plain".into()),
                    scope,
                })
            })
            .transpose()?;
        let preview = bounded_context_preview(&self.content, 6_000);
        let mut item = agentive::ContextItem::new(
            asset
                .as_ref()
                .map(|asset| format!("context-asset:{}", asset.id))
                .unwrap_or_else(|| format!("transient:{}", uuid::Uuid::new_v4())),
            source,
            self.name,
            "User-selected chat context",
        )
        .with_kind(kind)
        .with_priority(self.priority.unwrap_or(50))
        .with_sensitivity(agentive::ContextSensitivity::Internal)
        .with_scope(match scope {
            ContextAssetScope::Session => agentive::ContextScope::Session,
            ContextAssetScope::Project => agentive::ContextScope::Project,
        })
        .with_content(
            preview,
            self.content_type.unwrap_or_else(|| "text/plain".into()),
        )
        .with_metadata("origin", origin);
        if let Some(asset) = asset {
            item = item.with_large_ref(
                agentive::LargeContextRef::new(asset.id, "read_context_asset")
                    .with_bytes(asset.bytes)
                    .with_hash(asset.hash),
            );
        }
        Ok(item)
    }
}

fn bounded_context_preview(content: &str, max_bytes: usize) -> String {
    if content.len() <= max_bytes {
        return content.to_string();
    }
    let mut end = max_bytes.min(content.len());
    while end > 0 && !content.is_char_boundary(end) {
        end -= 1;
    }
    format!(
        "{}\n\n[Stored context excerpt truncated. Use read_context_asset for more.]",
        &content[..end]
    )
}

fn context_kind_from_name(kind: &str) -> agentive::ContextKind {
    match kind {
        "recent_turn" => agentive::ContextKind::RecentTurn,
        "memory_fact" => agentive::ContextKind::MemoryFact,
        "reference_doc" => agentive::ContextKind::ReferenceDoc,
        "tool_observation" => agentive::ContextKind::ToolObservation,
        "file_excerpt" => agentive::ContextKind::FileExcerpt,
        "web_excerpt" => agentive::ContextKind::WebExcerpt,
        "error_trace" => agentive::ContextKind::ErrorTrace,
        "media_summary" => agentive::ContextKind::MediaSummary,
        _ => agentive::ContextKind::Other,
    }
}

fn recalled_context_items(
    messages: &[ChatMessage],
    store: Option<&AgentStateStore>,
) -> Vec<agentive::ContextItem> {
    let Some(store) = store else {
        return Vec::new();
    };
    let Some(query) = messages
        .iter()
        .rev()
        .find(|message| message.role == "user")
        .and_then(ChatMessage::text)
    else {
        return Vec::new();
    };
    let assets = match store.search_context_assets(query, 4) {
        Ok(assets) => assets,
        Err(err) => {
            log::warn!("[agent_chat_with_tools] context recall unavailable: {err}");
            return Vec::new();
        }
    };
    let items = assets
        .into_iter()
        .map(|asset| {
            agentive::ContextItem::new(
                format!("context-asset:{}", asset.asset.id),
                agentive::ContextSource::Host,
                asset.asset.name,
                format!("Saved project context from {}", asset.asset.origin),
            )
            .with_kind(context_kind_from_name(&asset.asset.kind))
            .with_priority(35)
            .with_sensitivity(agentive::ContextSensitivity::Internal)
            .with_scope(agentive::ContextScope::Project)
            .with_content(asset.excerpt, asset.asset.content_type.clone())
            .with_large_ref(
                agentive::LargeContextRef::new(asset.asset.id, "read_context_asset")
                    .with_bytes(asset.asset.bytes)
                    .with_hash(asset.asset.hash),
            )
            .with_metadata("origin", asset.asset.origin)
        })
        .collect::<Vec<_>>();
    let mut index = agentive::InMemoryContextIndex::new();
    for item in items {
        index.upsert(item);
    }
    index
        .search(&agentive::ContextSearchQuery::new(query).with_limit(4))
        .into_iter()
        .map(|result| result.item)
        .collect()
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
#[auditaur_command(skip_all, err)]
pub async fn list_models(config: ProviderConfig) -> Result<Vec<ModelInfo>, String> {
    let provider = config.provider.clone();
    let provider_id = config.provider_id.clone();
    let provider_name = config.provider_name.clone();
    let model = config.model.clone();
    let auth_mode = if config.bearer_token.is_some() {
        "bearer"
    } else {
        "api_key"
    };
    let endpoint_present = !config.endpoint.trim().is_empty();
    let api_key_present = !config.api_key.trim().is_empty();
    let bearer_token_present = config
        .bearer_token
        .as_deref()
        .is_some_and(|token| !token.trim().is_empty());
    log::info!(
        "[list_models] start provider={} provider_id={:?} provider_name={:?} auth={} endpoint_present={} api_key_present={} bearer_token_present={} model={}",
        provider,
        provider_id,
        provider_name,
        auth_mode,
        endpoint_present,
        api_key_present,
        bearer_token_present,
        model,
    );
    crate::util::trace::emit(
        "list_models_start",
        "agent",
        serde_json::json!({
            "provider": provider,
            "provider_id": &provider_id,
            "provider_name": &provider_name,
            "auth_mode": auth_mode,
            "endpoint_present": endpoint_present,
            "api_key_present": api_key_present,
            "bearer_token_present": bearer_token_present,
            "model": model,
        }),
    );
    let llm_config: LlmConfig = config.into();
    match llm::list_models(&llm_config).await {
        Ok(models) => {
            log::info!(
                "[list_models] success provider={} provider_id={:?} model_count={}",
                provider,
                provider_id,
                models.len()
            );
            crate::util::trace::emit(
                "list_models_success",
                "agent",
                serde_json::json!({
                    "provider": provider,
                    "provider_id": &provider_id,
                    "provider_name": &provider_name,
                    "model_count": models.len(),
                }),
            );
            Ok(models)
        }
        Err(err) => {
            log::warn!(
                "[list_models] error provider={} provider_id={:?} api_key_present={} bearer_token_present={} error={}",
                provider,
                provider_id,
                api_key_present,
                bearer_token_present,
                err
            );
            crate::util::trace::emit(
                "list_models_error",
                "agent",
                serde_json::json!({
                    "provider": provider,
                    "provider_id": &provider_id,
                    "provider_name": &provider_name,
                    "api_key_present": api_key_present,
                    "bearer_token_present": bearer_token_present,
                    "error": err.to_string(),
                }),
            );
            Err(err.to_string())
        }
    }
}

/// A single chat turn (non-streaming) for quick operations like ✨ field fill.
#[auditaur_command(skip_all, err)]
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
    let configured_provider_name = config.provider_name.clone();
    let configured_provider_id = config.provider_id.clone();
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
            "provider_id": &configured_provider_id,
            "provider_name": &configured_provider_name,
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
#[auditaur_command(skip_all, err)]
pub async fn push_pending_chat_message(
    state: tauri::State<'_, AppState>,
    message: String,
) -> Result<(), String> {
    state.steering.send(&message);
    Ok(())
}

#[auditaur_command(skip_all, err)]
pub async fn list_agent_runs(
    state: tauri::State<'_, AppState>,
    limit: Option<usize>,
) -> Result<Vec<AgentRunSummary>, String> {
    let (repo_root, root) = {
        let guard = state.current_project.lock().unwrap();
        let view = guard.as_ref().ok_or("No project open")?;
        (view.repo_root.clone(), view.root.clone())
    };
    AgentStateStore::list_recent_runs(&repo_root, &root, limit.unwrap_or(25).clamp(1, 100))
}

#[auditaur_command(skip_all, err)]
pub async fn get_agent_run(
    state: tauri::State<'_, AppState>,
    run_id: String,
) -> Result<Option<AgentRunDetail>, String> {
    let (repo_root, root) = {
        let guard = state.current_project.lock().unwrap();
        let view = guard.as_ref().ok_or("No project open")?;
        (view.repo_root.clone(), view.root.clone())
    };
    AgentStateStore::get_run_detail(&repo_root, &root, &run_id)
}

#[auditaur_command(skip_all, err)]
pub async fn list_chat_sessions(
    state: tauri::State<'_, AppState>,
    limit: Option<usize>,
    offset: Option<usize>,
) -> Result<ChatSessionPage, String> {
    let (repo_root, root) = {
        let guard = state.current_project.lock().unwrap();
        let view = guard.as_ref().ok_or("No project open")?;
        (view.repo_root.clone(), view.root.clone())
    };
    AgentStateStore::list_chat_sessions(
        &repo_root,
        &root,
        limit.unwrap_or(25).clamp(1, 100),
        offset.unwrap_or(0),
    )
}

#[auditaur_command(skip_all, err)]
pub async fn get_chat_session(
    state: tauri::State<'_, AppState>,
    session_id: String,
) -> Result<Option<ChatSessionRecord>, String> {
    let (repo_root, root) = {
        let guard = state.current_project.lock().unwrap();
        let view = guard.as_ref().ok_or("No project open")?;
        (view.repo_root.clone(), view.root.clone())
    };
    AgentStateStore::get_chat_session(&repo_root, &root, &session_id)
}

#[auditaur_command(skip_all, err)]
pub async fn save_chat_session(
    state: tauri::State<'_, AppState>,
    session_id: String,
    title: String,
    messages: Vec<serde_json::Value>,
    metadata: Option<serde_json::Value>,
) -> Result<ChatSessionSummary, String> {
    if session_id.trim().is_empty() {
        return Err("Chat session ID cannot be empty".into());
    }
    let (repo_root, root) = {
        let guard = state.current_project.lock().unwrap();
        let view = guard.as_ref().ok_or("No project open")?;
        (view.repo_root.clone(), view.root.clone())
    };
    AgentStateStore::save_chat_session(
        &repo_root,
        &root,
        &session_id,
        &title,
        &messages,
        metadata.unwrap_or_else(|| serde_json::json!({})),
    )
}

#[auditaur_command(skip_all, err)]
pub async fn has_active_agent_run(state: tauri::State<'_, AppState>) -> Result<bool, String> {
    let active_count = state
        .active_agent_runs
        .lock()
        .map_err(|e| format!("Could not inspect active agent runs: {e}"))?
        .len();
    Ok(active_count > 0)
}

#[auditaur_command(skip_all, err)]
pub async fn delete_agent_run(
    state: tauri::State<'_, AppState>,
    run_id: String,
) -> Result<AgentStateMaintenanceResult, String> {
    let (repo_root, root) = {
        let guard = state.current_project.lock().unwrap();
        let view = guard.as_ref().ok_or("No project open")?;
        (view.repo_root.clone(), view.root.clone())
    };
    AgentStateStore::delete_run(&repo_root, &root, &run_id)
}

#[auditaur_command(skip_all, err)]
pub async fn prune_agent_runs(
    state: tauri::State<'_, AppState>,
    keep_recent_completed: Option<usize>,
) -> Result<AgentStateMaintenanceResult, String> {
    let (repo_root, root) = {
        let guard = state.current_project.lock().unwrap();
        let view = guard.as_ref().ok_or("No project open")?;
        (view.repo_root.clone(), view.root.clone())
    };
    AgentStateStore::prune_completed_runs_for_project(
        &repo_root,
        &root,
        keep_recent_completed.unwrap_or(25).clamp(1, 100),
    )
}

#[auditaur_command(skip_all, err)]
pub async fn compact_agent_state_database(
    state: tauri::State<'_, AppState>,
) -> Result<AgentStateMaintenanceResult, String> {
    let active_count = state
        .active_agent_runs
        .lock()
        .map_err(|e| format!("Could not inspect active agent runs: {e}"))?
        .len();
    if active_count > 0 {
        return Err("Cannot compact the agent-state database while an agent run is active".into());
    }
    let (repo_root, root) = {
        let guard = state.current_project.lock().unwrap();
        let view = guard.as_ref().ok_or("No project open")?;
        (view.repo_root.clone(), view.root.clone())
    };
    AgentStateStore::compact_project_database(&repo_root, &root)
}

#[auditaur_command(skip_all, err)]
pub async fn clear_saved_context(state: tauri::State<'_, AppState>) -> Result<usize, String> {
    let (repo_root, root) = {
        let guard = state.current_project.lock().unwrap();
        let view = guard.as_ref().ok_or("No project open")?;
        (view.repo_root.clone(), view.root.clone())
    };
    AgentStateStore::clear_project_context_assets(&repo_root, &root)
}

/// Agentic chat with function calling — the LLM can read/write project files.
/// Returns the full conversation (including tool calls) and the final response.
/// Emits `agent-event` events to the frontend for real-time streaming.
#[auditaur_command(skip_all, err)]
pub async fn agent_chat_with_tools(
    app: tauri::AppHandle,
    state: tauri::State<'_, AppState>,
    config: ProviderConfig,
    messages: Vec<ChatMessage>,
    context_items: Option<Vec<AgentContextItemConfig>>,
    agent_prompts: Option<std::collections::HashMap<String, String>>,
    agent_id: Option<String>,
    emit_events: Option<bool>,
    allow_mutation_tools: Option<bool>,
    client_run_id: Option<String>,
) -> Result<AgentChatResult, String> {
    use tauri::Emitter;

    let client_run_id = client_run_id.filter(|id| !id.trim().is_empty());
    let cancellation = agentive::CancellationToken::new();
    let _cancellation_guard = match client_run_id.as_ref() {
        Some(client_run_id) => {
            let guard = AgentChatCancellationGuard::register(
                state.agent_chat_cancellations.clone(),
                client_run_id.clone(),
                cancellation.clone(),
            )?;
            Some(guard)
        }
        None => None,
    };

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
    let (repo_root, project_root) = {
        let guard = state.current_project.lock().unwrap();
        let view = guard.as_ref().ok_or("No project open")?;
        (view.repo_root.clone(), view.root.clone())
    };

    let steering = state.steering.clone();

    let prompts = agent_prompts.unwrap_or_default();
    let agent_id = agent_id.unwrap_or_else(|| "planner".into());
    let reported_context = config.context_length;
    let vision_mode = config.vision_mode.clone().unwrap_or_else(|| "off".into());
    let discovered_vision_support = config.model_supports_vision;
    let search_enabled = config.web_access.as_deref() == Some("enabled");
    let max_tool_rounds = config
        .max_tool_rounds
        .unwrap_or(runner::DEFAULT_MAX_TOOL_ROUNDS)
        .clamp(1, 200);
    let mutation_tools_enabled = allow_mutation_tools.unwrap_or(false);
    let provider_name = config.provider.clone();
    let configured_provider_name = config.provider_name.clone();
    let configured_provider_id = config.provider_id.clone();
    let model = config.model.clone();
    let llm_config: LlmConfig = config.into();
    let context_item_configs = context_items.unwrap_or_default();

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
    let run_id = uuid::Uuid::new_v4().to_string();
    let _active_run_guard =
        ActiveAgentRunGuard::register(state.active_agent_runs.clone(), run_id.clone());
    let agent_state = match crate::engine::agent_state::AgentStateStore::for_project(
        &repo_root,
        &project_root,
        run_id.clone(),
    ) {
        Ok(store) => {
            let insert_result = store.insert_run(
                None,
                &provider_name,
                &model,
                serde_json::json!({
                    "messages": message_count,
                    "provider_id": &configured_provider_id,
                    "provider_name": &configured_provider_name,
                    "chars": message_chars,
                    "budget_chars": budget_chars,
                    "reported_context": reported_context,
                    "vision_enabled": vision.enabled,
                    "web_search_enabled": web_access.search_enabled,
                    "mutation_tools_enabled": mutation_tools_enabled,
                    "max_tool_rounds": max_tool_rounds,
                    "agent_prompts": prompts.len(),
                    "agent_id": &agent_id,
                }),
            );
            match insert_result {
                Ok(()) => Some(store),
                Err(err) => {
                    log::warn!("[agent_chat_with_tools] agent state disabled: {err}");
                    crate::util::trace::emit(
                        "agent_state_disabled",
                        "agent",
                        serde_json::json!({ "run_id": &run_id, "error": err }),
                    );
                    None
                }
            }
        }
        Err(err) => {
            log::warn!("[agent_chat_with_tools] agent state disabled: {err}");
            crate::util::trace::emit(
                "agent_state_disabled",
                "agent",
                serde_json::json!({ "run_id": &run_id, "error": err }),
            );
            None
        }
    };
    let mut context_items = context_item_configs
        .into_iter()
        .map(|item| item.into_context_item(agent_state.as_ref()))
        .collect::<Result<Vec<_>, _>>()?;
    context_items.extend(recalled_context_items(&messages, agent_state.as_ref()));
    log::info!(
        "[agent_chat_with_tools] start run_id={} agent={} provider={} model={} messages={} chars={} budget={}chars reported_context={:?} vision={} web_search={} mutation_tools={} max_tool_rounds={} prompts={}",
        run_id,
        agent_id,
        provider_name,
        model,
        message_count,
        message_chars,
        budget_chars,
        reported_context,
        vision.enabled,
        web_access.search_enabled,
        mutation_tools_enabled,
        max_tool_rounds,
        prompts.len()
    );
    crate::util::trace::emit(
        "agent_chat_with_tools_start",
        "agent",
        serde_json::json!({
            "provider": provider_name,
            "provider_id": &configured_provider_id,
            "provider_name": &configured_provider_name,
            "model": model,
            "run_id": &run_id,
            "messages": message_count,
            "chars": message_chars,
            "budget_chars": budget_chars,
            "reported_context": reported_context,
            "vision_enabled": vision.enabled,
            "web_search_enabled": web_access.search_enabled,
            "mutation_tools_enabled": mutation_tools_enabled,
            "max_tool_rounds": max_tool_rounds,
            "agent_prompts": prompts.len(),
            "agent_id": &agent_id,
            "context_items": context_items.len(),
        }),
    );

    let should_emit_events = emit_events.unwrap_or(true);
    let emit_handle = app.clone();
    let runner_future = runner::run(
        provider,
        Some(provider_name.clone()),
        Some(model.clone()),
        messages,
        &repo_root,
        &project_root,
        &agent_id,
        &prompts,
        &steering,
        &vision,
        &web_access,
        mutation_tools_enabled,
        max_tool_rounds,
        context_items,
        Some(run_id.clone()),
        agent_state.clone(),
        cancellation.clone(),
        move |event: AgentEvent| {
            if should_emit_events {
                let payload = agent_event_payload(&event, client_run_id.as_deref());
                let _ = emit_handle.emit("agent-event", payload);
            }
        },
    );
    let runner_result = runner_future.await;
    let runner_result = if cancellation.is_cancelled() {
        Err(AGENT_RUN_CANCELLED_ERROR.into())
    } else {
        runner_result
    };
    let result = match runner_result {
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
                    "run_id": &run_id,
                    "elapsed_ms": elapsed_ms,
                    "response_chars": result.response.len(),
                    "total_messages": result.messages.len(),
                    "total_tokens": result.total_usage.total_tokens,
                }),
            );
            if let Some(agent_state) = &agent_state {
                if let Err(err) = agent_state.finish_run("completed") {
                    log::warn!("[agent_chat_with_tools] failed to finish agent state run: {err}");
                }
            }
            result
        }
        Err(err) => {
            let elapsed_ms = started.elapsed().as_millis();
            let cancelled = err == AGENT_RUN_CANCELLED_ERROR;
            if cancelled {
                log::info!(
                    "[agent_chat_with_tools] cancelled provider={} model={} elapsed={}ms",
                    provider_name,
                    model,
                    elapsed_ms,
                );
            } else {
                log::warn!(
                    "[agent_chat_with_tools] error provider={} model={} elapsed={}ms error={}",
                    provider_name,
                    model,
                    elapsed_ms,
                    err
                );
            }
            crate::util::trace::emit(
                if cancelled {
                    "agent_chat_with_tools_cancelled"
                } else {
                    "agent_chat_with_tools_error"
                },
                "agent",
                serde_json::json!({
                    "provider": provider_name,
                    "model": model,
                    "run_id": &run_id,
                    "elapsed_ms": elapsed_ms,
                    "error": err,
                }),
            );
            if let Some(agent_state) = &agent_state {
                if let Err(state_err) =
                    agent_state.finish_run(if cancelled { "cancelled" } else { "failed" })
                {
                    log::warn!(
                        "[agent_chat_with_tools] failed to finish agent state run: {state_err}"
                    );
                }
            }
            return Err(err);
        }
    };

    Ok(AgentChatResult {
        messages: result.messages,
        response: result.response,
    })
}

/// Request cancellation of the active chat run associated with a frontend client run ID.
#[auditaur_command(skip_all, err)]
pub async fn cancel_agent_chat_run(
    client_run_id: String,
    state: tauri::State<'_, AppState>,
) -> Result<bool, String> {
    let client_run_id = client_run_id.trim();
    if client_run_id.is_empty() {
        return Err("Client run ID is required".into());
    }
    cancel_agent_chat_run_in_registry(&state.agent_chat_cancellations, client_run_id)
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
// Memory system
// ---------------------------------------------------------------------------

/// Get core memories formatted for injection into the system prompt.
#[auditaur_command(skip_all, err)]
pub async fn get_memory_context(state: tauri::State<'_, AppState>) -> Result<String, String> {
    let (repo_root, root) = {
        let guard = state.current_project.lock().unwrap();
        let view = guard.as_ref().ok_or("No project open")?;
        (view.repo_root.clone(), view.root.clone())
    };
    Ok(crate::engine::memory::format_for_system_prompt(
        &repo_root, &root,
    ))
}

/// Save a session summary to archival memory (called when chat session ends).
#[tauri::command]
pub async fn archive_chat_session(
    session_id: String,
    summary: String,
    state: tauri::State<'_, AppState>,
) -> Result<(), String> {
    let (repo_root, root) = {
        let guard = state.current_project.lock().unwrap();
        let view = guard.as_ref().ok_or("No project open")?;
        (view.repo_root.clone(), view.root.clone())
    };
    // Clear the pending summary since we're archiving now
    *state.last_chat_summary.lock().unwrap() = None;
    crate::engine::memory::archive_session(&repo_root, &root, &summary, &session_id)
}

/// Update the current chat summary (called periodically by frontend).
/// Stored in AppState so the Rust-side window close handler can archive it.
#[auditaur_command(skip_all, err)]
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
    let (repo_root, root) = {
        let guard = state.current_project.lock().unwrap();
        let view = guard.as_ref().ok_or("No project open")?;
        (view.repo_root.clone(), view.root.clone())
    };
    Ok(crate::engine::memory::load(&repo_root, &root).memories)
}

/// Delete a memory by index.
#[tauri::command]
pub async fn delete_memory(index: usize, state: tauri::State<'_, AppState>) -> Result<(), String> {
    let (repo_root, root) = {
        let guard = state.current_project.lock().unwrap();
        let view = guard.as_ref().ok_or("No project open")?;
        (view.repo_root.clone(), view.root.clone())
    };
    crate::engine::memory::delete_memory(&repo_root, &root, index)
}

/// Update a memory's content by index.
#[tauri::command]
pub async fn update_memory(
    index: usize,
    content: String,
    state: tauri::State<'_, AppState>,
) -> Result<(), String> {
    let (repo_root, root) = {
        let guard = state.current_project.lock().unwrap();
        let view = guard.as_ref().ok_or("No project open")?;
        (view.repo_root.clone(), view.root.clone())
    };
    crate::engine::memory::update_memory(&repo_root, &root, index, &content)
}

/// Clear memories by category (or all if no category provided).
#[tauri::command]
pub async fn clear_memories(
    category: Option<String>,
    state: tauri::State<'_, AppState>,
) -> Result<usize, String> {
    let (repo_root, root) = {
        let guard = state.current_project.lock().unwrap();
        let view = guard.as_ref().ok_or("No project open")?;
        (view.repo_root.clone(), view.root.clone())
    };
    let cat = category.map(|c| match c.as_str() {
        "core" => crate::engine::memory::MemoryCategory::Core,
        "archival" => crate::engine::memory::MemoryCategory::Archival,
        "insight" => crate::engine::memory::MemoryCategory::Insight,
        _ => crate::engine::memory::MemoryCategory::Archival,
    });
    crate::engine::memory::clear_memories(&repo_root, &root, cat)
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
            provider_id: Some("provider-test".into()),
            provider_name: Some("Provider Test".into()),
            provider: provider.into(),
            endpoint: "https://example.com".into(),
            api_key: "key".into(),
            model: "gpt-4o".into(),
            bearer_token: Some("token".into()),
            context_length: Some(128_000),
            vision_mode: Some("off".into()),
            model_supports_vision: Some(true),
            web_access: Some("disabled".into()),
            max_tool_rounds: Some(runner::DEFAULT_MAX_TOOL_ROUNDS),
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

    #[tokio::test]
    async fn cancellation_registry_cancels_only_the_matching_client_run() {
        let cancellations = Arc::new(Mutex::new(std::collections::HashMap::new()));
        let first_cancellation = agentive::CancellationToken::new();
        let second_cancellation = agentive::CancellationToken::new();
        let _first_guard = AgentChatCancellationGuard::register(
            cancellations.clone(),
            "first".into(),
            first_cancellation.clone(),
        )
        .unwrap();
        let _second_guard = AgentChatCancellationGuard::register(
            cancellations.clone(),
            "second".into(),
            second_cancellation.clone(),
        )
        .unwrap();

        assert!(cancel_agent_chat_run_in_registry(&cancellations, "first").unwrap());
        assert!(first_cancellation.is_cancelled());
        assert!(!second_cancellation.is_cancelled());
        assert!(!cancel_agent_chat_run_in_registry(&cancellations, "first").unwrap());
        assert!(cancel_agent_chat_run_in_registry(&cancellations, "second").unwrap());
        assert!(second_cancellation.is_cancelled());
    }

    #[test]
    fn cancellation_registry_rejects_duplicate_client_run_ids() {
        let cancellations = Arc::new(Mutex::new(std::collections::HashMap::new()));
        let _guard = AgentChatCancellationGuard::register(
            cancellations.clone(),
            "same-run".into(),
            agentive::CancellationToken::new(),
        )
        .unwrap();

        assert!(matches!(
            AgentChatCancellationGuard::register(
                cancellations,
                "same-run".into(),
                agentive::CancellationToken::new(),
            ),
            Err(error) if error.contains("already active")
        ));
    }

    #[test]
    fn agent_events_keep_original_fields_when_client_run_id_is_added() {
        let payload = agent_event_payload(
            &AgentEvent::Status {
                message: "Thinking…".into(),
            },
            Some("42"),
        );

        assert_eq!(payload["type"], "status");
        assert_eq!(payload["message"], "Thinking…");
        assert_eq!(payload["client_run_id"], "42");
    }
}
