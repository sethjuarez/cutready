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
- Frameless window: `decorations: false`, `shadow: true`, 1280×800 default, 800×600 minimum.
- Dev server: Vite on `http://localhost:1420`.
- Frontend dist directory: `../dist` (relative to src-tauri).

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

## Streaming Data (Channels)

For long-running operations (recording progress, render progress, agent refinement):

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

| Engine | Module | Responsibility |
|---|---|---|
| Recording | `engine/recording.rs` | FFmpeg process management for screen + audio capture |
| Automation | `engine/automation.rs` | Replay actions via Playwright sidecar + windows-rs UIA |
| Interaction | `engine/interaction.rs` | Capture user interactions during demo recording |
| Agent | `engine/agent/` | LLM-powered refinement pipeline (cleanup, narrative, selectors, healing) |
| Animation | `engine/animation.rs` | ManimCE Python subprocess for motion graphics |
| Export | `engine/export.rs` | FCPXML 1.9 generation + output folder assembly |

None of these engines are implemented yet — the project is in early scaffold phase.

## Data Models

Core types are in the `models/` module:
- `Action` enum — atomic demo steps (browser and native variants)
- `SelectorStrategy` enum — multiple selector approaches for resilient targeting
- `Project`, `Script`, `ScriptRow` — the script table data model
- `RecordedSession`, `CapturedAction` — raw recording output

All models derive `Serialize` + `Deserialize` for JSON IPC and file storage.

## LLM Abstraction

```rust
#[async_trait]
trait LlmProvider: Send + Sync {
    async fn complete(&self, messages: &[Message]) -> Result<String>;
    async fn complete_structured<T: DeserializeOwned>(
        &self, messages: &[Message], schema: &JsonSchema
    ) -> Result<T>;
}
```

- Azure OpenAI is the default provider.
- Use structured output (`response_format: json_schema`) for all agent pipeline calls.
- The trait is designed to also support a GitHub Copilot SDK backend in the future.

## Sidecar Binaries

- **FFmpeg**: Bundled as Tauri external binary. Spawned via `tokio::process::Command`. Graceful stop via stdin `q`.
- **Playwright sidecar**: Node.js process communicating over JSON stdin/stdout protocol.
- Declared in `tauri.conf.json` under `bundle.externalBin`.

## Error Handling

- Use `anyhow::Result` for internal engine logic.
- Use `thiserror` for typed error enums per engine.
- Convert to `String` at the Tauri command boundary.

## Key Crates

`tauri`, `tokio`, `serde`/`serde_json`, `reqwest` (LLM API), `quick-xml` (FCPXML), `uuid`, `chrono`, `windows` (native automation), `anyhow`, `thiserror`, `tracing`.
