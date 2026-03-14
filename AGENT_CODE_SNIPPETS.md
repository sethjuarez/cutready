# CODE SNIPPETS: Agent System Implementation

## 1. AGENT DEFINITIONS (Frontend)
### File: src/components/ChatPanel.tsx (lines 49-120)

const BUILT_IN_AGENTS: AgentPreset[] = [
  {
    id: "planner",
    name: "Planner",
    prompt: \You are CutReady AI — Planner mode. You help users plan demo videos.
## Your Role
Help users create and refine sketches — planning tables with columns:
- time: Duration (e.g. "~30s", "1:00")
- narrative: Voiceover/narration script
- demo_actions: On-screen actions to perform

## Guidelines
- Use set_planning_rows to create sketches (full generation)
- Use update_planning_row for surgical edits
- Keep narrative concise
- Time estimates should be realistic for live demos (~15-60s per row)\
  },
  {
    id: "writer",
    name: "Writer",
    prompt: \You are CutReady AI — Writer mode. Focus on narrative refinement...
- Write for spoken delivery — short sentences, natural rhythm
- Use update_planning_row for targeted narrative edits\
  },
  {
    id: "editor",
    name: "Editor",
    prompt: \You are CutReady AI — Editor mode. Make precise, surgical edits...
- Use update_planning_row for single-cell changes (preferred)
- Keep responses brief\
  }
];

export function resolveAgentPrompt(agentId: string, customAgents: AgentPreset[]): string {
  const custom = customAgents.find((a) => a.id === agentId);
  if (custom) return custom.prompt;
  const builtin = BUILT_IN_AGENTS.find((a) => a.id === agentId);
  return builtin?.prompt ?? BUILT_IN_AGENTS[0].prompt;
}

---

## 2. AGENT INVOCATION (Frontend)
### File: src/components/ChatPanel.tsx (lines 870-1050)

// Select agent based on settings
const selectedAgent = useMemo(() => {
  const agentId = settings.aiSelectedAgent || "planner";
  let prompt = resolveAgentPrompt(agentId, customAgents);
  return allAgents.find(a => a.id === agentId) || BUILT_IN_AGENTS[0];
}, [settings.aiSelectedAgent, allAgents]);

// Build system prompt
let prompt = resolveAgentPrompt(agentId, customAgents);

// Send to backend
const result = await invoke<AgentChatResult>("agent_chat_with_tools", {
  messages: fullMessages,  // [system, user, context...]
  agent_prompts: agentPromptsMap,
  config: providerConfig,
  ...otherConfig
});

// Listen for real-time events
const unlisten = listen<AgentEvent>("agent-event", (event) => {
  const ev = event.payload;
  switch (ev.type) {
    case "tool_call":
      // Tool is being executed
      setStreamingStatus(\Calling \...\);
      break;
      
    case "tool_result":
      // Tool finished - auto-refresh if sketch changed
      const toolName = ev.name ?? "";
      if (isSuccess && (toolName === "set_planning_rows" || toolName === "update_planning_row")) {
        const args = JSON.parse(pendingToolArgsRef.current[toolName] ?? "{}");
        // Refresh sidebar
        appStore.setCurrentSketch(args.path);
      }
      break;
  }
});

// Process final response
const backendMessages = result.messages;
setChatMessages([...messages, ...backendMessages]);

---

## 3. BACKEND COMMAND (Rust)
### File: src-tauri/src/commands/agent.rs (lines 79-133)

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
    pending.lock().unwrap().clear();

    let prompts = agent_prompts.unwrap_or_default();
    let vision_mode = config.vision_mode.clone().unwrap_or_else(|| "off".into());
    let client = LlmClient::new(config.into());

    let vision = runner::VisionConfig {
        enabled: vision_mode != "off" && client.supports_vision(),
        include_sketches: vision_mode == "notes_and_sketches",
    };

    let emit_handle = app.clone();
    let result = runner::run(
        &client,
        messages,
        &project_root,
        &prompts,
        &pending,
        &vision,
        move |event: AgentEvent| {
            let _ = emit_handle.emit("agent-event", &event);  // Real-time event emission
        },
    )
    .await?;

    Ok(AgentChatResult {
        messages: result.messages,
        response: result.response,
    })
}

---

## 4. AGENTIC LOOP (Rust)
### File: src-tauri/src/engine/agent/runner.rs (lines 174-421)

pub async fn run(
    client: &LlmClient,
    messages: Vec<ChatMessage>,
    project_root: &Path,
    agent_prompts: &HashMap<String, String>,
    pending: &Arc<Mutex<Vec<String>>>,
    vision: &VisionConfig,
    emit: impl Fn(AgentEvent) + Send + Sync + 'static,
) -> Result<AgentResult, String> {
    let emit = Arc::new(emit);
    run_with_depth(client, messages, project_root, agent_prompts, pending, 0, vision, emit).await
}

// Main loop (simplified)
for round in 0..MAX_TOOL_ROUNDS {
    // 1. Drain pending messages
    {
        let mut queue = pending.lock().unwrap();
        for msg in queue.drain(..) {
            messages.push(ChatMessage::user(&msg));
        }
    }

    emit(AgentEvent::Status { message: "Thinking…".into() });

    // 2. Trim to context window if needed
    let budget = client.context_char_budget();
    trim_to_context_window(&mut messages, budget);

    // 3. Call LLM with streaming
    let mut stream = client.chat_stream(&messages, Some(&tool_defs)).await?;

    let mut content_acc = String::new();
    let mut tool_calls_acc: Vec<StreamToolCall> = Vec::new();

    // 4. Accumulate streamed response
    while let Some(batch_result) = stream.next().await {
        for choice in &chunk.choices {
            if let Some(text) = choice.delta.content.as_deref() {
                content_acc.push_str(text);
                emit(AgentEvent::Delta { content: text.to_string() });
            }
            if let Some(tcs) = choice.delta.tool_calls.as_ref() {
                // Accumulate tool_calls
                for tc in tcs {
                    // Merge into tool_calls_acc...
                }
            }
        }
    }

    // 5. Check if done
    let tool_calls: Vec<ToolCall> = tool_calls_acc.into_iter()
        .filter_map(|stc| stc.function.map(...))
        .collect();

    if tool_calls.is_empty() {
        messages.push(assistant_msg);
        emit(AgentEvent::Done { response: content_acc.clone() });
        return Ok(AgentResult { messages, response: content_acc });
    }

    // 6. Execute tools
    messages.push(assistant_msg);
    emit(AgentEvent::Status {
        message: format!("Running {} tool call(s)…", tool_calls.len()),
    });

    for call in &tool_calls {
        emit(AgentEvent::ToolCall {
            name: call.function.name.clone(),
            arguments: call.function.arguments.clone(),
        });

        let result = tools::execute_tool(call, project_root, vision.enabled);

        emit(AgentEvent::ToolResult {
            name: call.function.name.clone(),
            result: result.clone(),
        });
        
        messages.push(ChatMessage::tool_result(&call.id, &result));
    }
    
    // Loop back to step 2
}

---

## 5. TOOL REGISTRY (Rust)
### File: src-tauri/src/engine/agent/tools.rs (lines 130-307)

pub fn all_tools() -> Vec<ToolDefinition> {
    vec![
        tool_def(
            "set_planning_rows",
            "Replace ALL planning rows in a sketch, or create a new sketch if it doesn't exist yet. Use this to generate a full plan from scratch.",
            json!({
                "type": "object",
                "properties": {
                    "path": { "type": "string" },
                    "title": { "type": "string" },
                    "rows": {
                        "type": "array",
                        "items": {
                            "type": "object",
                            "properties": {
                                "time": { "type": "string" },
                                "narrative": { "type": "string" },
                                "demo_actions": { "type": "string" },
                                "screenshot": { "type": "string" }
                            },
                            "required": ["time", "narrative", "demo_actions"]
                        }
                    }
                },
                "required": ["path", "rows"]
            }),
        ),
        tool_def(
            "update_planning_row",
            "Update a single planning row by index. Only fields provided are changed.",
            json!({
                "type": "object",
                "properties": {
                    "path": { "type": "string" },
                    "index": { "type": "integer" },
                    "time": { "type": "string" },
                    "narrative": { "type": "string" },
                    "demo_actions": { "type": "string" },
                    "screenshot": { "type": "string" }
                },
                "required": ["path", "index"]
            }),
        ),
        // ... more tools
    ]
}

---

## 6. SET_PLANNING_ROWS IMPLEMENTATION (Rust)
### File: src-tauri/src/engine/agent/tools.rs (lines 461-532)

fn exec_set_planning_rows(root: &Path, args: &Value) -> String {
    let path = match args.get("path").and_then(|v| v.as_str()) {
        Some(p) => resolve_path(root, p),
        None => return "Error: missing 'path' argument".into(),
    };

    let new_rows: Vec<PlanningRow> = match args.get("rows").and_then(|v| v.as_array()) {
        Some(arr) => arr
            .iter()
            .map(|r| PlanningRow {
                time: r.get("time").and_then(|v| v.as_str()).unwrap_or("").into(),
                narrative: r.get("narrative").and_then(|v| v.as_str()).unwrap_or("").into(),
                demo_actions: r.get("demo_actions").and_then(|v| v.as_str()).unwrap_or("").into(),
                screenshot: r.get("screenshot").and_then(|v| v.as_str()).map(|s| s.to_string()),
            })
            .collect(),
        None => return "Error: 'rows' must be an array".into(),
    };

    // Load existing sketch or create new one
    let mut sketch = match project::read_sketch(&path) {
        Ok(s) => s,
        Err(_) => {
            let title = args
                .get("title")
                .and_then(|v| v.as_str())
                .map(|s| s.to_string())
                .unwrap_or_else(|| {
                    path.file_stem()
                        .map(|s| s.to_string_lossy().replace('-', " "))
                        .unwrap_or_else(|| "Untitled".into())
                });
            crate::models::sketch::Sketch {
                title,
                description: serde_json::Value::Null,
                rows: vec![],
                state: crate::models::sketch::SketchState::Draft,
                created_at: chrono::Utc::now(),
                updated_at: chrono::Utc::now(),
            }
        }
    };

    // Apply optional title/description updates
    if let Some(t) = args.get("title").and_then(|v| v.as_str()) {
        sketch.title = t.to_string();
    }
    if let Some(d) = args.get("description").and_then(|v| v.as_str()) {
        sketch.description = serde_json::Value::String(d.to_string());
    }

    let count = new_rows.len();
    sketch.rows = new_rows;

    match project::write_sketch(&sketch, &path, root) {
        Ok(()) => format!("Set {count} planning rows in {}", path.display()),
        Err(e) => format!("Error writing sketch: {e}"),
    }
}

---

## 7. UPDATE_PLANNING_ROW IMPLEMENTATION (Rust)
### File: src-tauri/src/engine/agent/tools.rs (lines 534-575)

fn exec_update_planning_row(root: &Path, args: &Value) -> String {
    let path = match args.get("path").and_then(|v| v.as_str()) {
        Some(p) => resolve_path(root, p),
        None => return "Error: missing 'path' argument".into(),
    };
    
    let index = match args.get("index").and_then(|v| v.as_u64()) {
        Some(i) => i as usize,
        None => return "Error: missing 'index' argument".into(),
    };

    let mut sketch = match project::read_sketch(&path) {
        Ok(s) => s,
        Err(e) => return format!("Error reading sketch: {e}"),
    };

    if index >= sketch.rows.len() {
        return format!(
            "Error: index {} out of range (sketch has {} rows)",
            index,
            sketch.rows.len()
        );
    }

    let row = &mut sketch.rows[index];
    if let Some(t) = args.get("time").and_then(|v| v.as_str()) {
        row.time = t.into();
    }
    if let Some(n) = args.get("narrative").and_then(|v| v.as_str()) {
        row.narrative = n.into();
    }
    if let Some(d) = args.get("demo_actions").and_then(|v| v.as_str()) {
        row.demo_actions = d.into();
    }
    if let Some(s) = args.get("screenshot").and_then(|v| v.as_str()) {
        row.screenshot = Some(s.into());
    }

    match project::write_sketch(&sketch, &path, root) {
        Ok(()) => format!("Updated row {} in {}", index, path.display()),
        Err(e) => format!("Error writing sketch: {e}"),
    }
}

---

## 8. TOOL DISPATCHER (Rust)
### File: src-tauri/src/engine/agent/tools.rs (lines 325-347)

pub fn execute_tool(call: &ToolCall, project_root: &Path, vision_enabled: bool) -> String {
    let args: Value = serde_json::from_str(&call.function.arguments).unwrap_or(json!({}));
    let start = std::time::Instant::now();

    let result = match call.function.name.as_str() {
        "list_project_files" => exec_list_project_files(project_root),
        "read_note" => exec_read_note(project_root, &args, vision_enabled),
        "read_sketch" => exec_read_sketch(project_root, &args, vision_enabled),
        "set_planning_rows" => exec_set_planning_rows(project_root, &args),
        "update_planning_row" => exec_update_planning_row(project_root, &args),
        "list_project_images" => exec_list_project_images(project_root),
        "save_feedback" => exec_save_feedback(&args),
        "update_note" => exec_update_note(project_root, &args),
        "create_note" => exec_create_note(project_root, &args),
        "update_storyboard" => exec_update_storyboard(project_root, &args),
        "recall_memory" => exec_recall_memory(project_root, &args),
        "save_memory" => exec_save_memory(project_root, &args),
        other => format!("Unknown tool: {other}"),
    };

    log::debug!("[tool] {} → {}chars in {:?}", call.function.name, result.len(), start.elapsed());
    result
}
