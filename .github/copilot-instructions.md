# CutReady — Copilot Project Instructions

## What Is CutReady

CutReady is a **desktop application** for product demo video production. Users create structured demo plans (sketches) with planning tables and reference screenshots, optionally record a rough demo walkthrough, then an AI agent refines it into a production-ready script. Automation replays the polished demo while the user reads a teleprompter. Output is an organized folder with lossless video, clean audio, and an FCPXML timeline ready for DaVinci Resolve.

## Core Philosophy

- **Sketch-first**: The primary entry point is authoring a structured plan (sketch) with sections, planning tables, screenshots, and optional visuals. The sketch guides the recording and evolves through the workflow.
- **Record-first (alternative)**: Users can jump straight into recording without a sketch.
- **Agentic refinement**: AI cleans accidental clicks, stabilizes selectors, drafts narration, estimates timing, suggests animations, and generates framing visuals.
- **Self-healing replay**: When UI changes break a replay action, the agent auto-heals the selector.
- **Edit-ready output**: FCPXML 1.9 timeline with video, narration, system audio, and animations on separate tracks.

## Data Model

CutReady uses a **Storyboard → Sketch** hierarchy:

- **Sketch** (`.sk` files): A scene with title, description, and a planning table. Each planning table row has: Time, Narrative, Actions, Screenshot, and an optional Visual (Elucim DSL JSON stored externally in `.cutready/visuals/`).
- **Storyboard** (`.sb` files): Sequences sketches with optional named sections. References sketches by path.
- **Notes** (`.md` files): Markdown documents for planning, context, and AI-generated content.
- **Sessions** (`.chats/` directory): Saved AI chat sessions with full message history.

## Project Storage

Projects are **portable folders**. A CutReady project IS a user-chosen folder:

```text
my-demo-project/
├── intro.sk                    # Sketch files (JSON)
├── setup-walkthrough.sk
├── demo-storyboard.sb          # Storyboard files (JSON)
├── planning-notes.md           # Markdown notes
├── screenshots/                # Captured screenshots (PNG/JPEG)
├── .cutready/                  # CutReady metadata
│   ├── visuals/                # Elucim DSL visual JSON files
│   └── settings.json           # Per-project settings
├── .chats/                     # Saved AI chat sessions
└── .git/                       # Git versioning (managed by gix)
```

- No central project registry — projects are opened by folder path.
- Recent projects stored via `tauri-plugin-store` in app data.
- All user-provided relative paths go through `project::safe_resolve()` to prevent path traversal.

## Tech Stack

| Layer | Technology | Notes |
| --- | --- | --- |
| Desktop framework | **Tauri v2** | Frameless window, Rust backend, web frontend |
| Frontend | **React 19 + TypeScript** | Vite 6 bundler, Tailwind CSS 3.4 |
| Backend | **Rust** (2021 edition) | Async via Tokio, native Windows API via windows-rs |
| State management | **Zustand** | appStore, toastStore, updateStore |
| Drag-and-drop | **dnd-kit** | Sketch reordering in storyboards, tab reordering |
| Versioning | **gix** (gitoxide) 0.70 | Pure-Rust git: commit, log, diff, restore, branch, merge |
| Screen recording | **FFmpeg** (sidecar) | FFV1 lossless codec in MKV, multi-track audio |
| Browser automation | **Playwright** (Node.js sidecar) | Headful mode, CDP event observation, E2E testing |
| LLM | **Microsoft Foundry** | Chat Completions + Responses API, multi-agent system |
| Visuals | **Elucim DSL** (`@elucim/dsl`) | SVG-based framing visuals with semantic color tokens |
| Word export | **docx** | Export sketches/storyboards/notes to .docx |
| History graph | **d3.js** | Git branch/commit visualization |
| Timeline export | **FCPXML 1.9** | Multi-track, markers, DaVinci Resolve 17+ compatible |
| Docs site | **Astro Starlight** | Published to GitHub Pages |
| Versioning | **release-please** | Conventional Commits → automated semver + CHANGELOG |

## Source Structure

```text
cutready/
├── docs/                          # Astro Starlight docs site + north star docs
├── e2e/                           # Playwright E2E tests (run against web shim)
├── playwright-sidecar/            # Playwright Node.js sidecar for browser automation
├── scripts/                       # Build/release helper scripts
├── src/                           # React + TypeScript frontend
│   ├── main.tsx                   # Entry point (Geist Sans font, devMock detection)
│   ├── devMock.ts                 # Web shim — fakes Tauri backend for browser testing
│   ├── index.css                  # CSS variables, theme tokens, global styles
│   ├── App.tsx                    # Root component
│   ├── hooks/                     # useTheme, useSettings, useGlobalHotkeys, useDebugLog
│   ├── stores/                    # Zustand: appStore, toastStore, updateStore
│   ├── services/                  # commandRegistry, richPaste
│   ├── utils/                     # exportToWord
│   ├── types/                     # project.ts, sketch.ts, recording.ts
│   ├── test/                      # Vitest unit tests
│   └── components/                # 40+ React components (see below)
├── src-tauri/                     # Rust / Tauri backend
│   ├── Cargo.toml
│   ├── tauri.conf.json
│   ├── capabilities/default.json  # Tauri permission capabilities
│   └── src/
│       ├── lib.rs                 # Tauri command registration + plugin setup
│       ├── commands/              # Tauri command handlers (15 modules)
│       ├── engine/                # Backend engines (12 modules + agent/)
│       ├── models/                # Data models: sketch.rs, action.rs, script.rs, session.rs
│       └── util/                  # screenshot.rs, trace.rs
├── tailwind.config.ts
├── vite.config.ts
├── vitest.config.ts
├── playwright.config.ts
└── package.json
```

### Key Frontend Components

| Component | Purpose |
| --- | --- |
| AppLayout | VS Code-inspired shell: activity bar, primary sidebar, editor area, secondary panel |
| TitleBar | Frameless window title bar with drag region + window controls |
| Sidebar / StoryboardList | Primary sidebar with project explorer (storyboards, sketches, notes) |
| TabBar | Multi-tab editor with reorderable tabs (dnd-kit) |
| SketchForm / ScriptTable | Sketch editing with 4-column planning table (inline markdown) |
| ChatPanel | AI chat with multi-agent selection, tool call display, markdown rendering |
| SnapshotGraph / HistoryGraphTab | Git history visualization (d3.js) |
| VisualCell | Elucim DSL visual renderer with semantic color token support |
| CommandPalette | VS Code-style command palette (Ctrl+Shift+P) |
| ScreenCaptureOverlay / CaptureWindow | Screen region/monitor capture |
| NoteEditor / MarkdownEditor | Markdown notes with preview |
| SyncBar / TimelineSelector | Git remote sync and branch/timeline switching |
| MergeConflictPanel | Three-way merge conflict resolution |
| SnapshotDialog / SnapshotDiffPanel | Snapshot naming and diff viewing |

### Key Backend Modules

| Module | Status | Purpose |
| --- | --- | --- |
| engine/project.rs | ✅ Implemented | Folder-based project I/O, safe_resolve(), file scanning |
| engine/versioning.rs | ✅ Implemented | gix snapshots, branch, restore, stash |
| engine/versioning_merge.rs | ✅ Implemented | Three-way merge engine for .sk/.sb/.md |
| engine/versioning_remote.rs | ✅ Implemented | Git remote sync (push/pull/fetch via `gh`) |
| engine/agent/ | ✅ Implemented | Multi-agent AI system (Planner, Writer, Editor, Designer) |
| engine/agent/llm.rs | ⚠️ Replace | Foundry API client — migrate to agentive crate |
| engine/agent/runner.rs | ⚠️ Replace | Agent loop — migrate to agentive crate |
| engine/agent/tools.rs | ✅ Implemented | Agent tool definitions (read/write sketches, web fetch, visuals) |
| engine/import.rs | ✅ Implemented | .docx/.pdf/.pptx import to sketches/notes |
| engine/memory.rs | ✅ Implemented | Agent memory system (core, procedural, archival) |
| engine/recording.rs | 🔲 Placeholder | FFmpeg screen recording |
| engine/automation.rs | 🔲 Placeholder | Playwright replay automation |
| engine/animation.rs | 🔲 Placeholder | ManimCE motion graphics |
| engine/export.rs | 🔲 Placeholder | FCPXML timeline generation |

## Current Status (v0.9.0)

**Implemented features:**

- VS Code-inspired layout with activity bar, primary/secondary sidebars, multi-tab editor, command palette
- Sketch editor with 4-column planning table, inline markdown, drag-and-drop row reordering
- Storyboard management with sketch sequencing and named sections
- Markdown notes with live preview
- AI chat with 3 built-in agents (Planner, Writer, Editor) + Designer for visuals
- Sparkle (✨) buttons for silent AI improvements on sketches and notes
- Elucim DSL visual generation with semantic color tokens
- Screen capture (region selection or full monitor)
- Git-backed version history with snapshots, branching, merging
- Git remote collaboration (push/pull/fetch via GitHub)
- D3.js history graph visualization
- Document import (.docx, .pdf, .pptx)
- Word export with orientation picker and visual rasterization
- Auto-updater with update banner
- Feedback system
- Docs site (Astro Starlight) published to GitHub Pages
- E2E test suite via Playwright (web shim mode)

**Not yet implemented:** Recording, automation replay, FCPXML export, ManimCE animations.

## Design Decisions

- **Frameless window**: `decorations: false` with custom TitleBar (drag region + window controls).
- **VS Code-inspired layout**: Activity bar → primary sidebar → editor area → secondary panel.
- **Theme**: CSS custom properties in `:root` / `.dark`, toggled by `.dark` class on `<html>`. Three modes: light, dark, system. Persisted in `localStorage` key `cutready-theme`.
- **Color palette**: Warm, soft tones (not cold zinc). Dark: warm browns (#2b2926). Light: warm off-whites (#faf9f7).
- **Color architecture**: All colors flow through CSS variables. Components use `var(--color-*)` or Tailwind tokens — never hardcoded color classes.
- **Accent color**: Soft purple/violet (light: #6b5ce7, dark: #a49afa). Purple is the brand color.
- **Font**: Geist Sans via `@fontsource/geist-sans` (400, 500, 600). Letter-spacing: -0.011em.
- **IPC**: Tauri Commands for request/response, Channels for streaming, Events for broadcasts.
- **Events over polling**: Prefer event-driven patterns (callbacks, `visibilitychange`, Tauri events) over `setInterval`/`setTimeout` polling. Polling timers prevent Windows from sleeping and waste CPU. When polling is unavoidable (e.g., no push mechanism exists), gate the interval on `document.visibilitychange` so it pauses when the app is minimized or the screen is locked.
- **Headless processes**: ALL subprocess spawns (`Command::new`) on Windows MUST include `creation_flags(0x08000000)` (`CREATE_NO_WINDOW`) to prevent console windows from flashing. This applies to CutReady's own code AND any SDK/library forks we maintain. Wrap the flag in `#[cfg(target_os = "windows")]` for cross-platform compatibility.
- **LLM routing**: Auto-routes codex/pro models to Responses API, others to Chat Completions. Detection in `llm.rs`.
- **Path safety**: All user-provided paths go through `safe_resolve()` before filesystem access.
- **Web shim**: `devMock.ts` activated when `import.meta.env.DEV && !__TAURI_INTERNALS__`. Enables Playwright E2E testing and browser development without the Tauri shell.
- **Command palette**: Ctrl+Shift+P — commands registered via `commandRegistry.registerMany()` in AppLayout.

## Shared Agentive Crate

The LLM engine (`src-tauri/src/engine/agent/llm.rs` + `runner.rs`) should be migrated to use the shared **agentive** crate at `D:\projects\agentive` (GitHub: `sethjuarez/agentive`).

### What agentive provides

- `Provider` trait with `OpenAiProvider`, `AnthropicProvider`, `ResponsesProvider`
- `AuthStrategy` enum — `ApiKey`, `Bearer`, `Dynamic(Arc<dyn Fn() -> String>)` for Entra/Foundry tokens
- `run()` agentic loop with streaming, tool execution, retries, cancellation, guardrails, steering
- Core types: `ChatMessage`, `ToolCall`, `ToolResult`, `ChatEvent`, `Usage`
- SSE parser hardened against UTF-8 edge cases
- Context window trimming
- 117 tests including live integration against OpenAI, Azure OpenAI, and Anthropic

### Migration plan

1. Add `agentive` as a git dependency in `src-tauri/Cargo.toml`
2. Replace `LlmClient` / `LlmProvider` with agentive's `OpenAiProvider` / `ResponsesProvider`
3. Replace local chat/message/tool types with `agentive::types::*`
4. Replace the custom runner loop with agentive's `run()` + `RunnerEvent` stream
5. Wire `AuthStrategy::Dynamic` with the existing `azure_auth.rs` token refresh
6. Keep `azure_auth.rs` — OAuth/PKCE/device-code flows are app-specific UX
7. Keep `tools.rs` — sketch/storyboard/web tools are app-specific
8. Keep `web.rs` — web fetch tool implementation
9. Map agentive `RunnerEvent` to existing `AgentEvent` for Tauri channel streaming

### What stays app-specific

- ~~`azure_auth.rs`~~ — **Migrating to agentive** as `azure_oauth` module. OAuth protocol logic (PKCE, token exchange, refresh, device code) is now shared. CutReady keeps only the Tauri command wrappers (`azure_browser_auth_start`, `azure_browser_auth_complete`, `azure_token_refresh`) and the `PendingBrowserAuth` state.
- `tools.rs` — domain tools (read/write sketches, web fetch, visuals, image encoding)
- `web.rs` — web page fetching for agent tools
- `runner.rs` agent orchestration (Planner/Writer/Editor/Designer routing) — may wrap agentive's `run()`
- `engine/memory.rs` — agent memory system (core, procedural, archival)

### TODO: CutReady agentive migration

After the agentive `azure_oauth` module lands, CutReady's migration should also:
- Replace `engine/agent/azure_auth.rs` internals with calls to `agentive::azure_oauth::*`
- Keep the Tauri command wrappers in `commands/agent.rs` (they call agentive functions)
- Replace `LlmClient` / `LlmProvider` with agentive providers (per migration plan above)

## Testing & Validation

- **Build**: `npm run build` (tsc + vite)
- **TypeScript check**: `npx tsc --noEmit`
- **Rust tests**: `cd src-tauri && cargo test`
- **Vitest**: `npx vitest run`
- **E2E tests**: `npx playwright test` (uses web shim, no Tauri needed)
- **Web dev mode**: `npx vite --port 1420` (runs frontend in browser with devMock backend)
- **Docs site**: `cd docs && npm run build`

## Keeping Instructions Current

These instruction files are living documents. **When you notice a pattern repeating** — the user correcting the same mistake, re-explaining a convention, or a new architectural decision becoming established — **update the relevant instruction file and commit the change.** Don't wait for an explicit ask.

Signs an instruction update is needed:

- User corrects the same thing twice (e.g., "don't use that color", "use icons not text buttons").
- A new convention emerges from implementation (e.g., a new data model, a new IPC pattern).
- A section says "planned" or "placeholder" but the feature is now implemented.
- The project structure listing is missing files/modules that exist.

When updating, also use `store_memory` to capture the convention for cross-session recall.

## Key Documentation

- [docs/NORTH_STAR.md](docs/NORTH_STAR.md) — The press release / vision
- [docs/GUIDANCE.md](docs/GUIDANCE.md) — Feature catalog
- [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md) — Technical design
- [User-facing docs site](https://sethjuarez.github.io/cutready) — Astro Starlight

