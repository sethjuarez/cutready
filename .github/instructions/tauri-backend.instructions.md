---
name: "Tauri & Rust Backend"
description: "Rust backend conventions, Tauri v2 patterns, and engine architecture for CutReady"
applyTo: "src-tauri/**"
---

# Tauri & Rust Backend Standards

## Framework

- **Tauri v2** — not v1. Use Tauri v2 APIs, command signatures, and plugin system.
- **Rust 2021 edition** with async via **Tokio**.
- Dependencies managed in `src-tauri/Cargo.toml`.

## Tauri Configuration

- App identifier: `com.cutready.app`
- Main window: `decorations: false`, `shadow: true`, 1280×800 default, 800×600 minimum. Desktop builds use the React titlebar for deterministic cross-platform chrome; macOS renders custom traffic lights instead of mixing native controls with `titleBarStyle: "Overlay"` because Tauri documents OS-version-dependent titlebar heights for overlay mode.
- Dev server: Vite on `http://localhost:1420`.
- Frontend dist directory: `../dist` (relative to src-tauri).
- Capabilities defined in `capabilities/default.json`.

## Command Patterns

Tauri commands are the primary IPC mechanism. Follow this pattern:

```rust
#[tauri::command]
async fn command_name(
    param: ParamType,
    state: tauri::State<'_, AppState>,
) -> Result<ReturnType, String> {
    // Implementation
}
```

- Commands go in the `commands/` module (one file per engine domain).
- Commands are thin — they call into `engine/` modules for business logic.
- Use `Result<T, String>` return types (Tauri serializes the error as a string to the frontend).
- Register all commands via `.invoke_handler(tauri::generate_handler![...])` in `lib.rs`.
- Rust `snake_case` params auto-convert from frontend `camelCase` (e.g., `relativePath` → `relative_path`).

## Path Safety

**CRITICAL**: All user-provided relative paths in Tauri commands must go through `project::safe_resolve()` to prevent path traversal attacks. This function rejects `..` and `Prefix` components and verifies canonical paths when files exist on disk.

## Streaming Data (Channels)

For long-running operations (recording progress, agent streaming, render progress):

```rust
#[tauri::command]
async fn long_operation(
    channel: tauri::ipc::Channel<ProgressPayload>,
) -> Result<(), String> {
    channel.send(ProgressPayload { ... }).map_err(|e| e.to_string())?;
    Ok(())
}
```

## Engine Architecture

The backend is organized as independent engines:

| Engine | Module | Status | Responsibility |
| --- | --- | --- | --- |
| Project | `engine/project.rs` | ✅ | Folder-based project I/O, safe_resolve(), file scanning |
| Draftline | `engine/draftline_adapter.rs` + `commands/draftline.rs` | ✅ | Draftline-backed persistence, history, diff, save, restore, remotes, merge/apply flows |
| Agent | `engine/agent/` | ✅ | Multi-agent AI system (runner, tools, LLM client) |
| Import | `engine/import.rs` | ✅ | .docx/.pdf/.pptx import to sketches/notes |
| Memory | `engine/memory.rs` | ✅ | Agent memory system (core, procedural, archival) |
| Recording | `engine/recording.rs` | 🔲 | FFmpeg process management for screen + audio capture |
| Automation | `engine/automation.rs` | 🔲 | Replay actions via Playwright sidecar + windows-rs UIA |
| Interaction | `engine/interaction.rs` | 🔲 | Capture user interactions during demo recording |
| Animation | `engine/animation.rs` | 🔲 | Elucim animation rendering and video export |
| Export | `engine/export.rs` | 🔲 | FCPXML 1.9 generation + output folder assembly |

## Agent Architecture

The agent system in `engine/agent/` has these modules:

- **`runner.rs`** — Agent execution loop: processes tool calls, manages context window, handles compaction.
- **`tools.rs`** — Tool definitions the agent can call (list_project_files, read_sketch, set_planning_rows, web_fetch, create_visual, etc.).
- **`llm.rs`** — LLM API client. Auto-routes between Chat Completions API and Responses API based on model name. Handles SSE streaming, token counting, context compaction.
- **`azure_auth.rs`** — Azure/Foundry OAuth device-code flow authentication.
- **`web.rs`** — Web content fetching for agent `#web:` references.
- **`mod.rs`** — Agent type definitions (Planner, Writer, Editor, Designer) with distinct system prompts.

### LLM API Routing

The LLM client auto-routes based on model name:

- Models containing `codex` or ending with `-pro` (gpt-5 family) → **Responses API** (`/openai/v1/responses`)
- All other models → **Chat Completions API** (`/chat/completions`)

This detection and translation happens entirely in `llm.rs`. The runner and frontend are unaware of which API is used.

## Data Models

Core types are in the `models/` module:

- **`sketch.rs`** — `Sketch`, `PlanningRow`, `SketchState`, `Storyboard`, `StoryboardItem`, `SketchSummary`, `StoryboardSummary`. This is the primary data model.
- **`action.rs`** — `Action` enum for atomic demo steps (browser and native variants).
- **`script.rs`** — `ProjectView` (the active project state), `ScriptRow`.
- **`session.rs`** — `RecordedSession`, `CapturedAction` for raw recording output.

All models derive `Serialize` + `Deserialize` for JSON IPC and file storage. Use `#[serde(default)]` for backward compatibility on new fields.

## Versioning (gix)

- Uses **gix 0.70** with a tree-building approach (not index manipulation).
- Trees built from filesystem: create blobs with `repo.write_blob()`, assemble sorted `gix::objs::tree::Entry` vectors, write tree, then commit.
- Committer: `CutReady` / `app@cutready.local`.
- Directories starting with `.` (including `.git`) are skipped during scanning.

## Visuals Storage

Visuals (Elucim DSL JSON) are stored as external files in `.cutready/visuals/<sha256-12chars>.json`, referenced by relative path on `PlanningRow.visual` (string field). The `write_visual` and `read_visual` commands handle I/O. Legacy inline JSON objects auto-migrate on `read_sketch_with_migration()`.

## Plugin Store

Uses `tauri-plugin-store` v2 API:

- `app.store("file.json")` returns `Arc<Store<R>>` via the `StoreExt` trait.
- `.get()` returns `Option<JsonValue>`, `.set(key, value)`, `.save()`.
- Used for recent projects list and last parent folder.

## Subprocess Spawning (Console Window Prevention)

**CRITICAL**: Every `Command::new()` call on Windows **must** set `CREATE_NO_WINDOW` (`0x08000000`) to prevent console windows from flashing on screen. This applies to all subprocess spawns — `gh`, `node`, `powershell`, `ffmpeg`, etc.

For `std::process::Command`:

```rust
let mut cmd = std::process::Command::new("gh");
cmd.args(["auth", "token"]);
#[cfg(windows)]
{
    use std::os::windows::process::CommandExt;
    cmd.creation_flags(0x08000000); // CREATE_NO_WINDOW
}
```

For `tokio::process::Command`:

```rust
let mut cmd = tokio::process::Command::new("node");
cmd.arg("index.js");
#[cfg(windows)]
cmd.creation_flags(0x08000000); // CREATE_NO_WINDOW
```

## Error Handling

- Use `anyhow::Result` for internal engine logic.
- Use `thiserror` for typed error enums per engine.
- Convert to `String` at the Tauri command boundary.

## Observability

- Use Auditaur as the backend diagnostics sink via `tauri_plugin_auditaur::tracing_layer()`.
- Keep the `tracing_log::LogTracer` bridge installed so existing `log::*` records flow into Auditaur; initialize the tracing subscriber with `tracing::subscriber::set_global_default()` rather than `SubscriberInitExt::init()` to avoid double-installing the log bridge.
- Filter the Auditaur tracing layer to CutReady/agentive targets plus dependency warnings/errors so framework trace noise does not fill the local session store.
- Commands that should connect frontend `auditaur.invoke()` spans to backend spans should use `#[tauri_plugin_auditaur::auditaur_command(skip_all, err)]`; it wraps `#[tauri::command]` and injects the IPC trace carrier automatically.
- Do not rely on Auditaur's default redaction for IPC result summaries from secret-returning commands. Token commands such as Azure OAuth refresh/complete and GitHub token lookup must either bypass frontend Auditaur invoke instrumentation or return a non-secret envelope; otherwise `resultSummary` can persist credential-shaped values in local diagnostics.
- For app smoke tests, launch the normal Tauri dev command through Auditaur rather than invoking Auditaur as a replacement runtime. Run `npm ci` first when `node_modules` is missing. For repeatable agent-owned confidence validation, prefer `auditaur drill run --app cutready --require-frontend --require-drive-bridge --timeout-seconds 180 --report <artifact-or-report-path> --selector body --expect-text CutReady --json -- cmd /c npm run debug`; drill pins checks to the spawned session, verifies frontend telemetry and Tauri-native drive-bridge responsiveness, checks frontend errors/failed IPC/`explain`, writes a JSON report, and cleans up the process tree. `npm run debug` is the real CutReady Tauri app path; `npm run dev` is Vite/devMock only.
- Stale discovery records are common after repeated smoke runs. Use `auditaur sessions --json` / `auditaur apps --json` and query by concrete selector when `--active` is ambiguous: `debug` and `drive` use `--session-id <id>`, while telemetry readers such as `errors`, `ipc`, `logs`, `timeline`, and `explain` use `--session <id>`. Confirm readiness stages (`heartbeat`, `telemetry_database`, `window`, `backend_telemetry`, and `frontend_telemetry`) before reading telemetry. Auditaur drive is Tauri-native in current debug builds, so do not add CDP/WebView2 flags unless explicitly testing a legacy target.
- Keep packaged-release Auditaur capture opt-in. Full diagnostics can be enabled for a launch with `CUTREADY_DIAGNOSTICS=1` or for the next launch via the persisted Settings > Feedback toggle; do not unconditionally call `.allow_release_builds(true)`.

## Key Crates

`tauri`, `tokio`, `serde`/`serde_json`, `reqwest` (LLM API), `gix` (git), `quick-xml` (FCPXML), `uuid`, `chrono`, `windows` (native automation), `anyhow`, `thiserror`, `tracing`.
