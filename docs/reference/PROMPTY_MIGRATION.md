# Agentive → Prompty Migration Plan

This document captures the plan to replace CutReady's `agentive` dependency with
[Prompty](https://prompty.ai) — a declarative `.prompty` file format + runtime for
LLM interactions. The goal is to **fully remove agentive** from `Cargo.toml`.

> **Status**: Planning complete. Blocked on Prompty runtime enhancements (see
> [Prompty-Side Changes](#prompty-side-changes-required)). Implementation will
> begin once those land.

## Why Migrate

- **Declarative agents**: System prompts, model config, and tool declarations
  move from Rust code to `.prompty` files — editable without recompilation.
- **Prompt composition**: Simple sub-agent calls (`kind: prompty`) use
  `invoke()` automatically. No Rust plumbing for single-shot delegation.
- **Shared runtime**: Prompty is a cross-language spec with Rust, Python, TS,
  C#, and Go runtimes. CutReady benefits from upstream improvements.
- **Simpler codebase**: The custom `runner.rs` → `agentive::run()` bridge
  (~480 lines) reduces to direct `prompty::turn()` calls with `TurnOptions`.

## Key Design Decisions

### 1. Agentic Orchestration Is App-Level

Prompty's `kind: prompty` tools support `mode: single` (one-shot `invoke()`).
**Agentic sub-agent delegation stays in CutReady code** — not in the Prompty
runtime. The reasoning:

- Every app has different orchestration policy (steering, guardrails,
  cancellation, event forwarding, tool inheritance).
- A factory/callback pattern in Prompty core would relocate complexity without
  eliminating it — every runtime would need to implement the factory interface,
  parent context struct, and registration mechanism.
- CutReady's delegation handler is ~20 lines using Prompty's public API:

```rust
// CutReady registers this as a kind: function tool handler
let child = prompty::load("./writer.prompty")?;
let result = prompty::turn(&child, Some(&args), Some(my_opts)).await?;
```

The `.prompty` file declares delegations as `kind: function` tools. The app
registers handlers that call `prompty::turn()` with exactly the `TurnOptions`
it wants. The agent topology is visible in the YAML; the policy lives in code.

### 2. @-Reference Resolution Is App-Level

CutReady resolves `@sketch-name` references in user messages by looking up
project files. This is pre-processing before calling `turn()` — not a Prompty
feature. Different apps have wildly different reference semantics.

### 3. Connections for Provider Config

Provider configuration uses Prompty's connection registry:

```rust
prompty::register_connection("default", connection_config);
```

`.prompty` files reference connections by name:

```yaml
model:
  connection:
    kind: reference
    name: default
```

CutReady updates the registered connection when settings change or tokens
refresh. The `model.provider` and `model.id` fields on the loaded `Prompty`
struct are set programmatically before each `turn()` to support dynamic
provider/model switching from the settings UI.

### 4. Memory System Vendored into CutReady

The agent memory system (~130 lines of types + scoring) moves from agentive
into CutReady's `engine/memory.rs`. It's app-specific (file-backed,
project-scoped) and small enough to vendor.

### 5. Web Fetch Vendored into CutReady

The `fetch_and_clean()` utility (~30 lines of `reqwest` + HTML-to-text) moves
into CutReady. Too opinion-heavy (which scraper? timeout? auth?) to be a
Prompty built-in.

## Prompty-Side Changes Required

These enhancements must land in the Prompty Rust runtime before CutReady can
migrate. Tracked in the Prompty repo.

### GAP 1: Rich Tool Results

**Current state**: Tool handlers return `Result<String, ...>` everywhere —
`ToolHandler::Sync/Async`, `ToolHandlerTrait::execute_tool()`,
`format_tool_messages()`.

**Needed**: A `ToolOutput` type with `Vec<ContentPart>` (text, image, file,
audio). Backward-compatible via `impl From<String> for ToolOutput`.

**Why**: CutReady's tools return screenshots (images) from sketch reads.
Without typed multi-part results, images must be serialized as base64 strings
losing the structured format that providers expect.

**Scope**: `ToolOutput` struct, update `ToolHandler` return types, update
`dispatch_tool()` → `format_tool_messages()` chain. Providers format multi-part
results into their wire format (e.g., OpenAI's
`content: [{type: "image_url", ...}]`).

### GAP 2: Remove `mode` from PromptyToolHandler

**Current state**: `kind: prompty` supports `mode: "single"` (`invoke()`) and
`mode: "agentic"` (`turn()`). The agentic mode calls
`turn(&child, Some(&args), None)` — passing `None` for `TurnOptions`, so no
events, steering, tools, or cancellation flows to the child.

**Needed**: Remove `mode` entirely. `kind: prompty` always calls `invoke()`
(single-shot composition). Apps that want agentic sub-agents use
`kind: function` tools and call `turn()` themselves with full control over
`TurnOptions`.

**Why**: Agentic orchestration policy is app-level (see Decision 1 above).
Keeping `mode: agentic` in the spec forces the runtime to make policy decisions
about what to propagate to children — decisions that differ per app.

### GAP 3: Model Discovery in Provider Crates

**Current state**: No model listing capability in any Prompty provider crate.
CutReady uses `agentive::discovery::list_models()`.

**Needed**: Each provider crate exports a discovery function:

- `prompty_foundry::list_models(connection)` — Azure deployments + catalog
- `prompty_openai::list_models(connection)` — OpenAI `/v1/models`
- `prompty_anthropic::list_models()` — hardcoded (no discovery API)

Returns `Vec<ModelInfo>` with typed capabilities (not `HashMap<String, String>`):

```rust
pub struct ModelInfo {
    pub id: String,
    pub owned_by: Option<String>,
    pub context_window: Option<usize>,
    pub capabilities: ModelCapabilities,
}

pub struct ModelCapabilities {
    pub vision: bool,
    pub streaming: bool,
    pub tool_use: bool,
    pub json_mode: bool,
    pub responses_api: bool,
}
```

**Additionally**: A `prompty::model_capabilities(model_id)` heuristic function
in core for apps that already know the model and need capabilities without a
REST call. Provider `list_models()` calls this internally to fill in any fields
the API didn't report.

**Why**: Every app using Prompty needs model dropdowns, context budget
estimation, and vision/tool-use checks. Without this, each app vendors its own
REST calls and heuristic tables.

### GAP 4: OAuth + ARM Discovery in prompty-foundry

**Current state**: Not in Prompty. Currently in agentive as `azure_oauth` and
`arm_discovery` modules (~500 lines).

**Needed**: Add to `prompty-foundry` behind feature flags:

- `features = ["oauth"]` — Device code flow, browser auth (PKCE), token refresh
- `features = ["discovery"]` — `list_subscriptions()`,
  `list_ai_resources()`, `list_foundry_projects()`

**Why**: These are Azure Foundry authentication and resource discovery. They
belong with the Foundry provider. Without them, CutReady would vendor ~500
lines of OAuth + ARM REST code.

## CutReady Migration Steps

Once the Prompty gaps are resolved, the CutReady-side migration proceeds in
phases.

### Phase 1: Add Prompty Dependency

- Add `prompty`, `prompty-openai`, `prompty-foundry`, `prompty-anthropic` to
  `src-tauri/Cargo.toml`.
- Keep `agentive` temporarily during the transition.

### Phase 2: Create .prompty Agent Files

Create `.prompty` files for each agent in a new `src-tauri/agents/` directory:

| File | Purpose |
| --- | --- |
| `planner.prompty` | Planning and task decomposition |
| `writer.prompty` | Narrative drafting for sketches |
| `editor.prompty` | Refinement and polish |
| `designer.prompty` | Elucim visual generation |

Each file declares: system prompt, model config (with `connection: { kind:
reference, name: default }`), and tool definitions.

### Phase 3: Replace llm.rs

- Replace `build_provider()` with connection registration at startup.
- Replace `list_models()` with provider-crate discovery functions.
- Replace `context_budget()` / `supports_vision()` / `needs_responses_api()`
  with `prompty::model_capabilities()`.
- Map CutReady's `LlmConfig` to Prompty connection + model config.

### Phase 4: Replace runner.rs

- Replace `agentive::run()` calls with `prompty::turn()`.
- Map `TurnOptions` fields: `on_event`, `cancelled`, `steering`,
  `context_budget`, `guardrails`, `compaction`.
- Map `AgentEvent` variants from Prompty's event enum.
- Replace `exec_delegation()` (~140 lines) with `kind: function` tool handlers
  that call `prompty::turn()` directly (~20 lines each).
- Replace `build_reference_resolver()` with pre-processing before `turn()`.

### Phase 5: Replace tools.rs

- Convert `all_tools()` from `Vec<agentive::Tool>` to Prompty tool
  declarations (in `.prompty` files + `TurnOptions.tools` handlers).
- Convert `execute_tool()` return type from `agentive::ToolOutput` to
  `prompty::ToolOutput`.
- Vision image extraction stays in CutReady (uses `ToolOutput::with_images()`
  equivalent).

### Phase 6: Vendor Memory + Web Fetch

- Move memory types and scoring from agentive re-exports to local types in
  `engine/memory.rs`.
- Move `fetch_and_clean()` into CutReady (or inline the ~30 lines).
- Update `commands/agent.rs` to use local types.

### Phase 7: Replace OAuth + ARM Discovery

- Replace `agentive::azure_oauth::*` imports with `prompty_foundry::oauth::*`.
- Replace `agentive::arm_discovery::*` with `prompty_foundry::discovery::*`.
- Update Tauri command wrappers in `commands/agent.rs`.

### Phase 8: Remove Agentive

- Remove `agentive` from `Cargo.toml`.
- Delete `engine/agent/azure_auth.rs` (6-line re-export, no longer needed).
- Run `cargo test`, `npx vitest run`, `npx tsc --noEmit` to verify.

## What Stays in CutReady

| Concern | Location | Reason |
| --- | --- | --- |
| Agent delegation policy | `runner.rs` tool handlers | Steering/event/tool propagation is app-specific |
| @-Reference resolution | Pre-processing before `turn()` | Reference semantics are app-specific |
| Memory system | `engine/memory.rs` | File-backed, project-scoped, ~130 lines |
| Web fetch | `engine/agent/web.rs` | Opinion-heavy (scraper choice, timeout) |
| Tool definitions | `.prompty` files + `tools.rs` handlers | Domain-specific (sketch/storyboard/visual tools) |
| Vision image extraction | `tools.rs` | App-specific resize/encode logic |

## What Moves to Prompty

| Concern | Prompty Location | Replaces |
| --- | --- | --- |
| Agent loop | `prompty::turn()` | `agentive::run()` |
| Providers | `prompty-openai/foundry/anthropic` | `agentive::OpenAiProvider` etc. |
| Steering | `prompty::Steering` | `agentive::Steering` |
| Cancellation | `TurnOptions.cancelled` | `agentive::CancellationToken` |
| Context trimming | `TurnOptions.context_budget` | `agentive::RunnerConfig` |
| Guardrails | `TurnOptions.guardrails` | `agentive::Guardrails` |
| Compaction | `TurnOptions.compaction` | `agentive::RunnerConfig` |
| Tool dispatch | `prompty::tool_dispatch` | Custom tool executor closure |
| Rich tool results | `prompty::ToolOutput` | `agentive::ToolOutput` |
| Model discovery | Provider crates | `agentive::discovery` |
| Model capabilities | `prompty::model_capabilities()` | `agentive::factory::*` |
| OAuth | `prompty-foundry` (feature flag) | `agentive::azure_oauth` |
| ARM discovery | `prompty-foundry` (feature flag) | `agentive::arm_discovery` |
| Simple chat | `prompty::invoke()` | `agentive::simple_chat()` |
