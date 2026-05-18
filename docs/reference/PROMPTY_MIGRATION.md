# Agentive → Prompty Migration Plan

This document captures the plan to replace CutReady's `agentive` dependency
with [Prompty](https://prompty.ai): a declarative `.prompty` file format and
runtime for LLM prompts, tool-calling turns, structured outputs, tracing, and
provider execution.

The goal is to **fully remove `agentive` from `src-tauri/Cargo.toml`** while
preserving CutReady's product-specific control over project tools, safe file
access, memory, visual validation, and UI event semantics.

> **Status**: Prompty is the preferred strategic direction. Do not do a big-bang
> swap. Migrate in phases, keeping `agentive` during the transition until the
> Prompty Rust runtime can preserve CutReady's current rich tool outputs,
> streaming events, provider behavior, and Azure/Foundry auth flows.

## Recommendation

Prompty is a better fit than the GitHub Copilot SDK for replacing `agentive`.
The Copilot SDK is valuable, but its core model is to run a Copilot CLI server
over JSON-RPC. That would hand CutReady's core AI UX to an external agent
runtime and introduce packaging, lifecycle, auth, and quota coupling.

Prompty has the better boundary for CutReady:

- `.prompty` files own prompt text, tool declarations, schemas, and prompt
  composition.
- CutReady owns runtime policy, project state, domain tools, safe path
  resolution, memory, visual quality gates, and side-effect authorization.
- Prompty's agentic controls are runtime options, not frontmatter magic. That
  keeps enforcement in Rust where the app can test and govern it.

## Why Migrate

- **Declarative agents**: Planner, Writer, Editor, and Designer prompts move
  from TypeScript/Rust strings into `.prompty` files that can be reviewed,
  versioned, tested, and tuned without recompiling the app.
- **File-first prompt assets**: Prompts become first-class artifacts with model
  config, inputs, outputs, tools, and templates in one markdown file.
- **Structured outputs**: Prompty `outputs` blocks can turn sketch drafts,
  visual plans, import extraction, critiques, and summaries into typed JSON
  contracts instead of prose that must be parsed or trusted.
- **Runtime control**: `turn()` supports events, cancellation, steering,
  context budgets, compaction, guardrails, parallel tool execution controls, and
  retry policy.
- **Tracing**: Prompty traces load, render, parse, execute, process, and tool
  stages. `.tracy` and OpenTelemetry backends can make agent behavior easier to
  debug than today's custom logs alone.
- **Provider reuse**: Prompty's provider crates give CutReady a shared
  OpenAI/Foundry/Anthropic substrate without routing through the Copilot CLI.
- **Cleaner app code**: The custom `runner.rs` to `agentive::run()` bridge can
  shrink once Prompty owns the common loop mechanics.

## What We Learned From Prompty Agentic Concepts

Prompty separates prompt preparation from agent execution:

1. `prepare()` renders a `.prompty` template and parses role-marked markdown
   into messages.
2. `turn()` runs one external user turn.
3. Tool-loop iterations do **not** re-render the template.
4. Tool calls append assistant/tool messages to the prepared message array.
5. External chat turns call `turn()` again with prior history supplied by the
   host app, usually through a `kind: thread` input.

This maps well to CutReady's chat model. The frontend already owns saved chat
sessions, and Rust already owns project tool execution. Prompty would own the
per-turn loop while CutReady continues to own durable session persistence.

### Runtime Controls That Matter to CutReady

| Prompty concept | CutReady use |
| --- | --- |
| `on_event` / `AgentEvent` | Drive ChatPanel status, tool-call display, token streaming, and activity logs. |
| Cancellation | Back the stop button and prevent the next safe loop step from continuing. |
| Steering | Add user/operator guidance while a long visual or edit turn is running. |
| Context budget | Prevent oversized prompt/tool-result loops from hitting provider limits. |
| Compaction | Summarize dropped messages inside one long `turn()`; not a persistence mechanism. |
| Guardrails | Enforce path safety, write authorization, web access, visual constraints, and tool argument policy. |
| Parallel tools | Keep disabled for mutating project tools; allow only for independent read-only tools after audit. |
| LLM retries | Preserve accumulated messages across transient provider failures. |

### What Prompty Does Not Do Automatically

- It does not implement CutReady's tools. `.prompty` files declare schemas, but
  Rust still provides handlers.
- It does not persist memory or chat history. CutReady must keep `.chats/` and
  project-scoped memory.
- It does not know CutReady's `@sketch-name` reference semantics.
- It does not decide whether a sketch write, visual save, or web request is
  allowed. Guardrails and tool authorization must enforce that.

## Structured Outputs Strategy

Prompty structured output is one of the strongest reasons to migrate. Defining
`outputs` in frontmatter lets the runtime convert the schema to provider
`response_format` JSON Schema and parse the result into a structured value.

Use structured outputs for **typed artifacts and decisions**:

| Use case | Suggested output contract |
| --- | --- |
| New sketch draft | `SketchDraft { title, description, rows[] }` |
| Storyboard draft | `StoryboardDraft { title, description, items[] }` |
| Document import extraction | `ImportPlan { notes[], sketches[], unresolved[] }` |
| Visual design plan | `VisualPlan { goal, heroMetaphor, elements[], motionBeats[] }` |
| Recording analysis | `RecordingAnalysis { actions[], timings[], cleanupSuggestions[] }` |
| Chat summary | `SessionSummary { decisions[], memoryCandidates[], unresolvedQuestions[] }` |
| Critique/eval | `ReviewResult { findings[], severity, suggestedFixes[] }` |

Do **not** use structured outputs as a replacement for controlled side effects.
For file writes and project mutations, the safer pattern is:

1. The model returns a structured draft.
2. Rust validates the draft against CutReady types and policies.
3. A domain tool applies the validated change.
4. The tool result is fed back into the agent loop.

This keeps deterministic data contracts separate from authorized execution.

## Key Design Decisions

### 1. Agentic Orchestration Is App-Level

Prompty supports `kind: prompty` tools for prompt composition, but CutReady
should not use them as the primary mechanism for Planner/Writer/Editor/Designer
delegation.

Use `kind: prompty` for simple one-shot child prompts, such as summarizers,
classifiers, or extraction helpers. Keep agentic sub-agent delegation in
CutReady because the app must decide:

- which tools flow to a child agent;
- whether child events surface in the parent chat;
- how steering and cancellation propagate;
- whether a child may mutate files;
- how depth limits, guardrails, and visual validation are enforced.

Preferred pattern:

```rust
// CutReady registers this as a domain function tool handler.
let child = prompty::load("./writer.prompty")?;
let result = prompty::turn(&child, Some(&args), Some(child_turn_options)).await?;
```

The `.prompty` file can declare the delegation tool. The policy stays in Rust.

### 2. Reference Resolution Is App-Level

CutReady resolves `@sketch-name`, `@note-name`, and project-relative references
against the open project. This should remain pre-processing before `turn()`.

Prompty thread inputs are useful for chat history, but they are not a replacement
for CutReady's project reference resolver.

### 3. Connections Are Runtime-Registered

Provider configuration should use Prompty connection references:

```yaml
model:
  id: gpt-4o
  provider: foundry
  connection:
    kind: reference
    name: cutready-default
```

CutReady registers or updates `cutready-default` when settings change or tokens
refresh. The loaded `Prompty` model provider and model ID can still be adjusted
programmatically before each `turn()` so the Settings UI remains dynamic.

### 4. Guardrails Enforce Policy

Prompt instructions are advisory. Guardrails and tool authorization enforce app
policy.

CutReady should add guardrails for:

- path traversal and project root containment;
- write access to locked cells or protected files;
- web access feature flags;
- visual schema and renderability requirements;
- maximum image/tool-result size;
- dangerous or mutating tool calls during read-only agents.

Tool denials should return useful synthetic tool-result text when recovery is
possible. Hard policy violations should fail the turn.

### 5. Conversation History Stays in CutReady

Prompty is stateless between external turns. CutReady should keep using saved
chat sessions and pass prior messages as a `kind: thread` input.

Prompty compaction is only for long loops inside one `turn()`. It should not be
used as durable memory or chat persistence.

### 6. Memory and Web Fetch Stay in CutReady

The project memory system is file-backed and project-scoped. It belongs in
CutReady.

Web fetch behavior is also app-specific: feature flags, timeout, scraping
policy, link formatting, and future auth requirements belong in CutReady.

## Current Prompty Readiness

Prompty v2 has the right architecture, but the Rust runtime still needs careful
verification against CutReady requirements.

| Area | Current assessment |
| --- | --- |
| `.prompty` file format | Strong fit. |
| Rust `turn()` agent loop | Strong fit conceptually; verify event parity and errors. |
| Runtime controls | Strong fit: events, cancellation, steering, guardrails, context, compaction, retries. |
| Structured outputs | Strong fit for typed artifacts and validation-first workflows. |
| Model discovery | Partially present in provider crates; verify capability fields needed by CutReady. |
| Foundry/OpenAI/Anthropic providers | Good direction; verify Responses API, vision, and streaming behavior. |
| Entra/Foundry auth | Prompty has Foundry/connection concepts and `entra_id` direction; CutReady browser/device flows may still need local wrappers. |
| Rich tool results | Main blocker. CutReady needs structured text plus images from tool results. |
| Tool handler return type | Verify/extend beyond string-only returns before switching vision workflows. |
| MCP/OpenAPI tools | Useful later, not required for the migration. |

## Prompty-Side Changes or Verifications Required

These items must be completed or explicitly worked around before removing
`agentive`.

### GAP 1: Rich Tool Results

**Current concern**: Prompty Rust tool handlers appear to return strings in the
core dispatch path.

**Needed**: A `ToolOutput`-style type with `Vec<ContentPart>` for text, image,
file, and audio parts, while preserving `From<String>` for simple tools.

**Why**: CutReady's `read_sketch` and related tools can return screenshots for
vision-capable models. Serializing images into plain strings would lose the
provider-native structured content format and increase prompt fragility.

### GAP 2: Provider-Specific Multi-Part Tool Message Formatting

**Needed**: Provider executors must format multi-part tool results correctly for
OpenAI Chat Completions, OpenAI Responses API, Foundry, and Anthropic.

**Why**: Prompty's agent loop intentionally delegates tool-result message
formatting to the provider. That is correct, but CutReady needs parity with the
current agentive behavior before switching.

### GAP 3: Model Capability API

**Current state**: Provider model listing exists in current Prompty Rust provider
crates, but CutReady needs a stable capability shape.

**Needed**: A typed capability API that covers:

- context window;
- input modalities, especially image support;
- output modalities;
- streaming;
- tool use;
- structured JSON output;
- Responses API requirement.

CutReady should not rely on ad hoc provider payloads in UI code.

### GAP 4: Azure/Foundry Auth and Discovery

**Needed**: Preserve CutReady's existing Azure/Foundry UX:

- browser auth with PKCE;
- device code flow;
- token refresh;
- resource/project/deployment discovery;
- dynamic token use without storing secrets in `.prompty` files.

Prompty connection references are the right target, but CutReady may keep local
Tauri command wrappers while moving shared OAuth/discovery internals into
Prompty provider crates.

### GAP 5: Event Parity

**Needed**: Map Prompty Rust `AgentEvent` variants to CutReady's existing
frontend event stream:

- token deltas;
- thinking deltas;
- status;
- tool call start;
- tool result;
- messages updated;
- compaction lifecycle;
- done;
- error;
- cancelled.

The ChatPanel should not regress while the backend runtime changes.

### GAP 6: Structured Output Support in Rust

**Needed**: Verify Rust can:

- define nested `outputs` schemas from `.prompty`;
- invoke with structured output enabled;
- cast or deserialize output to CutReady Rust structs;
- surface validation/provider errors clearly.

This is especially important for sketch drafts, storyboard drafts, import
plans, visual plans, and memory summaries.

## Phased Migration Plan

### Phase 0: Prove the Contract

Before touching the production chat path:

- Create tiny Rust spikes outside the main app flow for `invoke()`, `turn()`,
  streaming, structured output, tool calls, guardrails, steering, cancellation,
  and model listing.
- Test OpenAI, Azure/Foundry, and Anthropic if credentials are available.
- Verify Windows behavior and that no external console windows flash.
- Record exact Prompty versions and missing upstream changes.

Exit criteria:

- A Prompty Rust spike can run one tool-calling turn with events and structured
  output.
- Known gaps are documented as upstream PRs, local wrappers, or blockers.

### Phase 1: Introduce `.prompty` Assets Behind `agentive`

Add `.prompty` files without changing the runtime yet.

Suggested location:

```text
src-tauri/
└── agents/
    ├── planner.prompty
    ├── writer.prompty
    ├── editor.prompty
    ├── designer.prompty
    ├── summarize-chat.prompty
    ├── draft-sketch.prompty
    └── visual-plan.prompty
```

Move the built-in prompts from `src/agents/builtInAgents.ts` into these files or
generate the frontend agent presets from the same source to avoid drift.

Exit criteria:

- The app can load agent prompt text from `.prompty` files.
- Existing chat behavior remains backed by `agentive`.
- Frontend tests cover that built-in agents still exist with the expected IDs.

### Phase 2: Add Structured Output Workflows

Use Prompty `invoke()` for isolated typed tasks before replacing the full agent
loop.

Good first candidates:

- chat/session summary generation;
- memory candidate extraction;
- import-to-sketch extraction;
- visual design brief generation;
- sketch draft generation before calling `write_sketch`.

Exit criteria:

- At least one production workflow uses a `.prompty` `outputs` schema and
  deserializes to a Rust struct.
- Validation happens before any file mutation.
- Failures are surfaced clearly in the UI.

### Phase 3: Add Prompty Dependencies and Provider Bridge

Add Prompty crates while keeping `agentive`:

```toml
prompty = "2.0.0-beta.1"
prompty-openai = "2.0.0-beta.1"
prompty-foundry = { version = "2.0.0-beta.1", features = ["entra_id"] }
prompty-anthropic = "2.0.0-beta.1"
```

Exact versions may change. Prefer pinned versions or git SHAs during migration.

Build a provider bridge that maps CutReady settings to:

- Prompty registered connections;
- model provider and model ID;
- model capability discovery;
- context budget selection;
- vision availability;
- structured output support.

Exit criteria:

- `list_models` can use Prompty provider discovery where supported.
- Current Settings UI behavior remains unchanged.
- Azure/Foundry OAuth flows still work.

### Phase 4: Port Tool Declarations and Handlers

Move tool schemas into `.prompty` frontmatter where possible, but keep execution
in Rust.

Tool categories:

| Category | Tools |
| --- | --- |
| Project reads | `list_project_files`, `read_note`, `read_sketch`, `read_storyboard` |
| Project writes | `write_note`, `write_sketch`, `update_planning_row`, `write_storyboard` |
| Visuals | `design_plan`, `set_row_visual`, `review_row_visual`, visual nudge/command tools |
| Web | `fetch_url`, `search_web` |
| Memory | `recall_memory`, `save_memory` |
| Delegation | `delegate_to_agent` as a CutReady function tool |

Use guardrails and tool metadata to distinguish read-only and mutating tools.

Exit criteria:

- Tool schemas are declared in `.prompty` or generated from a shared schema.
- Rust handlers preserve existing validation and error messages.
- Mutating tools remain serial by default.

### Phase 5: Run Prompty `turn()` Behind a Feature Flag

Add a feature flag such as `promptyAgentRuntime` in the Experimental settings.

When enabled:

- load the selected `.prompty` agent;
- inject conversation history as a `kind: thread` input;
- pre-process CutReady `@` references;
- register runtime tools;
- pass `TurnOptions` for events, cancellation, steering, context budget,
  compaction, guardrails, retries, and serial tool execution;
- map Prompty events to existing `agent-event` payloads.

Exit criteria:

- Planner, Writer, Editor, and Designer can each complete representative tasks.
- ChatPanel streaming and tool display do not regress.
- Existing agentive runtime remains available as fallback.

### Phase 6: Migrate Delegation and Visual Workflows

Port `delegate_to_agent` to call child `.prompty` files through app-owned
`turn()` calls.

For Designer:

- keep Elucim bridge behavior app-specific;
- use structured `VisualPlan` outputs before JSON generation when useful;
- keep `set_row_visual` as the only persistence path;
- keep review/nudge/validation loops as tools and guardrails.

Exit criteria:

- Designer can create, validate, save, review, and nudge visuals through the
  Prompty-backed runtime.
- Delegated child turns propagate events, cancellation, and guardrails according
  to CutReady policy.

### Phase 7: Remove Agentive-Owned Utilities

Move or replace the remaining `agentive` re-exports:

- memory helpers move fully into `engine/memory.rs`;
- web fetch moves into `engine/agent/web.rs` or another CutReady module;
- OAuth/discovery moves to Prompty provider crates or local wrappers;
- context/model heuristics move to Prompty capability APIs or local shims.

Exit criteria:

- `rg "agentive" src-tauri/src` only finds temporary compatibility code.
- No user-visible behavior depends on the agentive runtime.

### Phase 8: Remove Agentive

Remove:

- `agentive` from `src-tauri/Cargo.toml`;
- compatibility imports and wrappers;
- dead tests and mocks.

Run:

```bash
npm run build
npx vitest run
cd src-tauri && cargo test
```

Also run targeted manual checks for:

- model discovery;
- simple sparkle actions;
- full chat with tools;
- Writer edits;
- Editor targeted row updates;
- Designer visual generation and review;
- web access disabled/enabled;
- Azure/Foundry OAuth refresh.

## What Stays in CutReady

| Concern | Location | Reason |
| --- | --- | --- |
| Agent delegation policy | Rust tool handlers / runner wrapper | Steering, cancellation, depth, tools, and events are app-specific. |
| Project reference resolution | Pre-processing before `turn()` | CutReady-specific `@sketch` and project path semantics. |
| Chat persistence | `.chats/` and project engine | Prompty is stateless across external turns. |
| Memory system | `engine/memory.rs` | Project-scoped and file-backed. |
| Web fetch/search policy | CutReady tools | Feature flags, scraping, timeout, and auth are app-specific. |
| Project tools | Rust handlers | Must use `project::safe_resolve()` and domain validation. |
| Visual validation | Elucim/CutReady tools | Requires renderability, critique, nudge, and save semantics. |
| Authorization | Guardrails + tool handlers | Prompt instructions are not enforcement. |
| Vision image extraction | `tools.rs` or successor module | Resize, encode, and budget logic is app-specific. |

## What Moves to Prompty

| Concern | Prompty location | Replaces |
| --- | --- | --- |
| Prompt files | `.prompty` assets | Built-in prompt strings |
| Agent loop | `prompty::turn()` | `agentive::run()` |
| Simple prompt calls | `prompty::invoke()` | `agentive::simple_chat()` |
| Structured outputs | `.prompty` `outputs` + processor | Manual JSON prompting/parsing |
| Provider execution | `prompty-openai`, `prompty-foundry`, `prompty-anthropic` | Agentive providers |
| Tool schema projection | `.prompty` tools | Hand-built tool declarations where practical |
| Streaming processing | Prompty stream/processors | Agentive stream parsing |
| Tracing | Prompty tracer backends | Ad hoc trace/log-only visibility |
| Context trimming | `TurnOptions.context_budget` | Agentive runner config |
| Compaction | `TurnOptions.compaction` | Agentive compaction config |
| Guardrails | `TurnOptions.guardrails` | Agentive guardrails / custom checks |
| Steering | `prompty::Steering` | `agentive::Steering` |
| Cancellation | Prompty cancellation token | `agentive::CancellationToken` |

## Testing Strategy

Add tests at each phase rather than waiting for the final swap.

| Layer | Tests |
| --- | --- |
| Prompt assets | Load every `.prompty`, validate inputs/tools/outputs, ensure no missing connection refs. |
| Structured outputs | Golden tests for sketch draft, visual plan, import plan, and summary schemas. |
| Tool handlers | Existing Rust unit tests should pass unchanged after handler return type changes. |
| Guardrails | Deny path traversal, locked-cell writes, disabled web access, and invalid visuals. |
| Event mapping | Prompty events map to existing `AgentEvent` JSON expected by ChatPanel. |
| Provider bridge | Model listing, capability normalization, vision gating, Responses API routing. |
| E2E | Planner/Writer/Editor/Designer smoke tests through the web shim where possible. |

## Rollout Plan

1. Ship `.prompty` assets with agentive still active.
2. Ship structured-output helpers for low-risk one-shot tasks.
3. Add Prompty runtime behind an Experimental setting.
4. Dogfood Prompty runtime for non-mutating Planner flows first.
5. Enable Writer/Editor with guardrails and serial mutating tools.
6. Enable Designer only after rich tool results and visual validation parity.
7. Make Prompty default once telemetry and tests show parity.
8. Remove agentive after at least one release with Prompty as the default and no
   fallback usage required.

## Open Questions

- Should `.prompty` agent files live in `src-tauri/agents/` or a shared
  top-level `agents/` directory that frontend tooling can read directly?
- Should CutReady generate TypeScript agent presets from `.prompty` metadata?
- Should project-local custom agents also be stored as `.prompty` files?
- Which Prompty traces should be persisted into `.cutready/` versus only debug
  logs?
- How should structured-output prompts be versioned as CutReady data models
  evolve?
- Should Prompty runtime selection be per-project, global, or only an
  Experimental setting during migration?
