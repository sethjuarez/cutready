# CutReady — Implementation Plan

> Bite-sized milestones, each buildable and testable independently.

---

## Guiding Principles

- **Each milestone produces something runnable** — no "big bang" integration.
- **Backend-first for engines, frontend follows** — Rust engines get unit/integration tests before UI wiring.
- **Vertical slices over horizontal layers** — e.g., "record one browser click end-to-end" beats "build all data models first."
- **Sidecars are external dependencies** — stub them early, integrate real binaries later.
- **LLM calls are mockable** — the `LlmProvider` trait enables offline testing with canned responses.

---

## Phase 0 — Foundation & Project Infrastructure ✅

> Goal: Solid groundwork that every subsequent milestone builds on.
>
> **Status: COMPLETE** — All sub-phases implemented, 69 Rust tests passing, frontend builds clean, app launches.

### 0.1 Rust Module Skeleton ✅

Created the full directory structure from ARCHITECTURE.md with type definitions and stubs.

| Task | Details | Test | Status |
| --- | --- | --- | --- |
| Create `commands/` module with files: `recording.rs`, `automation.rs`, `interaction.rs`, `agent.rs`, `animation.rs`, `export.rs`, `project.rs` | Empty Tauri command stubs returning `Ok(())` or placeholder data | `cargo build` succeeds | ✅ Done |
| Create `engine/` module with files: `recording.rs`, `automation.rs`, `interaction.rs`, `agent/mod.rs`, `animation.rs`, `export.rs` | Empty structs + trait definitions | `cargo build` succeeds | ✅ Done |
| Create `models/` module with files: `action.rs`, `script.rs`, `recording.rs`, `animation.rs`, `session.rs` | All core types from ARCHITECTURE.md with `Serialize`/`Deserialize` | `cargo test` — round-trip serde tests for every model | ✅ Done — 45+ model tests |
| Create `llm/` module with `mod.rs`, `azure_openai.rs`, `types.rs` | `LlmProvider` trait + types, `AzureOpenAiProvider` struct (no impl yet) | Compiles | ✅ Done |
| Create `util/` module with `ffmpeg.rs`, `screenshot.rs`, `audio.rs` | Empty stubs | Compiles | ✅ Done |

**Deliverable**: Full module tree compiles. All core data types defined and serializable. ✅

### 0.2 Project Storage (JSON Files) ✅

| Task | Details | Test | Status |
| --- | --- | --- | --- |
| Implement `Project` CRUD in `engine/project.rs` | `create_project()`, `load_project()`, `save_project()`, `list_projects()`, `delete_project()` | Unit tests: create → save → load round-trip, list scans a directory | ✅ Done — 7 tests |
| Wire Tauri commands: `create_project`, `open_project`, `save_project`, `list_projects` | Thin wrappers in `commands/project.rs` | Manual test: invoke from browser console in dev mode | ✅ Done |
| Add `AppState` to `lib.rs` | `Mutex<Option<Project>>` for current project state, `projects_dir` path | Unit test: state set/get | ✅ Done |

**Deliverable**: Can create, save, load, and list `.cutready` project JSON files from the frontend. ✅

### 0.3 Tauri Plugin Registration ✅

| Task | Details | Test | Status |
| --- | --- | --- | --- |
| Add required plugins to `Cargo.toml` | `tauri-plugin-fs`, `tauri-plugin-dialog`, `tauri-plugin-shell`, `tauri-plugin-store`, `tauri-plugin-global-shortcut`, `tauri-plugin-window-state`, `tauri-plugin-log`, `tauri-plugin-single-instance`, `tauri-plugin-process` | `cargo build` succeeds | ✅ Done — 9 plugins |
| Register all plugins in `lib.rs` | Builder chain | App launches with plugins active | ✅ Done |
| Configure capabilities in `capabilities/default.json` | File access, dialog, shell, store, global-shortcut permissions | No permission errors at runtime | ✅ Done |

**Deliverable**: All Tauri plugins registered and permitted. App boots cleanly. ✅

### 0.4 Frontend Shell & Navigation ✅

| Task | Details | Test | Status |
| --- | --- | --- | --- |
| Install state management (`zustand`) + routing | Zustand store for app state; simple view routing (panel switching) | `npm run dev` builds | ✅ Done |
| Create `AppLayout` component | Sidebar nav + main content area. Panels: Home, Script Editor, Settings | Visual: panels switch on click | ✅ Done |
| Create `Home` / project picker view | List projects, "New Project" button. Calls `list_projects` / `create_project` commands | Can create a project and see it listed | ✅ Done |
| Create `Settings` panel | Form fields for: output directory, LLM API key (saved via `tauri-plugin-store`) | Settings persist across restart | ✅ Done |
| Add `tauri-plugin-store` JS integration | Helper hook `useSettings()` wrapping `@tauri-apps/plugin-store` via `LazyStore` | Unit test for the hook | ✅ Done |

**Deliverable**: App has navigation, project creation, settings persistence. Foundation for all feature panels. ✅

### 0.5 App Icon & Branding ✅

> Added during Phase 0 — not in original plan.

| Task | Details | Status |
| --- | --- | --- |
| Design app icon | Open clapperboard with play button — board (#3d3480), arm (#7c6fdb/#a49afa) hinged left and rotated open, hinge dot, play triangle | ✅ Done |
| Apply to `public/cutready.svg` | SVG with rounded-rect background, clapper + play motif in purple palette with white accents | ✅ Done |
| Generate platform icons | `npx @tauri-apps/cli icon` — ICO, ICNS, PNG (all sizes), iOS, Android, Appx | ✅ Done |
| Title bar icon in `TitleBar.tsx` | Inline SVG matching the clapper design, using solid accent colors (`#574bb8`, `#7c6fdb`, `var(--color-accent)`) | ✅ Done |
| Taskbar icon via `bundle.icon` in `tauri.conf.json` | Added `bundle.icon` array pointing to generated icon files | ✅ Done |

**Deliverable**: Consistent clapper+play icon across title bar, taskbar, and all platform targets. ✅

---

## Phase 1 — Interaction Recording (Browser)

> Goal: Record a sequence of browser interactions and save them as `CapturedAction` objects.
>
> **Status: COMPLETE** — All sub-phases implemented, sidecar protocol working, DOM observer captures clicks/typing/navigation/scrolls with screenshots, session management wired to frontend with live streaming.

### 1.1 Playwright Sidecar Protocol ✅

| Task | Details | Test | Status |
| --- | --- | --- | --- |
| Create `playwright-sidecar/` Node.js project | `index.js` with JSON-RPC stdin/stdout protocol. Initial commands: `browser.launch`, `browser.close`, `ping` | Run standalone: `echo '{"id":1,"method":"ping"}'  \| node index.js` returns a pong | ✅ Done |
| Define the sidecar protocol types in Rust | `SidecarRequest`, `SidecarResponse`, `SidecarEvent` types in `util/sidecar.rs` | Serde round-trip tests | ✅ Done — 5 tests |
| Implement sidecar process manager in Rust | `SidecarManager` — spawn Node process, send JSON via stdin, read JSON from stdout, handle lifecycle | Integration test: spawn sidecar, ping, shut down | ✅ Done |

**Deliverable**: Rust can start the Playwright sidecar and exchange JSON messages. ✅

### 1.2 Browser Observation Mode ✅

| Task | Details | Test | Status |
| --- | --- | --- | --- |
| Add DOM observer in Playwright sidecar | Injected JS captures click, type, navigate, scroll via `addInitScript` + `exposeFunction` bridge | Manual test: launch browser, click around, see events logged to stdout | ✅ Done |
| Map DOM events to `Action` variants | In sidecar: transform interactions into CutReady `Action` JSON with multiple `SelectorStrategy` entries (DataTestId, CssSelector, AccessibilityName, TextContent, CSS path) | Events match Rust serde format | ✅ Done |
| Stream captured actions to Rust | Sidecar emits `{"event":"action_captured","data":{...}}` on stdout; Rust `SidecarManager` reader task parses and forwards via mpsc channel | Sidecar event deserialization test | ✅ Done |
| Debounced input capture | Typing batched into single `BrowserType` action (800ms debounce), flushed on blur | Prevents keystroke flooding | ✅ Done |
| Debounced scroll capture | Scroll events combined into single `BrowserScroll` (500ms debounce, 50px threshold) | Only significant scrolls reported | ✅ Done |

**Deliverable**: User can browse a website while CutReady captures every interaction as structured `Action` data. ✅

### 1.3 Screenshot Capture Per Action ✅

| Task | Details | Test | Status |
| --- | --- | --- | --- |
| Add `page.screenshot()` in sidecar on each captured action | Save PNG to project's `screenshots/` dir, return path in action metadata | File exists after capture | ✅ Done |
| Implement `util/screenshot.rs` for fallback (Windows `BitBlt`) | Screen region capture via Win32 GDI | Deferred to Phase 7 (native recording) | — Deferred |

**Deliverable**: Every captured interaction has an associated screenshot. ✅

### 1.4 Recording Session Management ✅

| Task | Details | Test | Status |
| --- | --- | --- | --- |
| Implement `engine/interaction.rs` — `start_recording_session()`, `stop_recording_session()`, `save_session()` | Manages `RecordedSession`, spawns sidecar, accumulates `CapturedAction` list, saves to JSON | Unit tests for path resolution and session save round-trip | ✅ Done — 3 tests |
| Wire commands: `start_recording_session`, `stop_recording_session`, `get_session_actions` | Tauri commands that manage the sidecar + session, with `ActiveSession` in `AppState` | Manual: start session → browse → stop → inspect saved session JSON | ✅ Done |
| Stream captured actions to frontend via Channel | Background task forwards sidecar events to Tauri `Channel<CapturedAction>` for live display | Frontend receives actions in real time | ✅ Done |

**Deliverable**: Complete browser recording session — start, capture, stop, save. ✅

### 1.5 Recording UI ✅

| Task | Details | Test | Status |
| --- | --- | --- | --- |
| Create `RecordingPanel` component | URL input, "Start Recording" / "Stop" buttons, live action list with auto-scroll, recording status indicator, completion summary | Visual: actions appear as user browses | ✅ Done |
| Create `ActionCard` component | Type badge (color-coded), description, selector info, timestamp, screenshot thumbnail via `convertFileSrc`, confidence indicator | Visual inspection | ✅ Done |
| Wire to session commands | Zustand store with `startRecording`/`stopRecording` actions, `Channel` for live streaming, sidebar "Record" nav with recording indicator dot | End-to-end: click Start, browse a site, click Stop, see full action list | ✅ Done |

**Deliverable**: User can visually record a browser demo and see every captured step. ✅

---

## Phase 2 — Script Sketch Editor & Document Versioning

> Goal: A Notion-style block editor for authoring structured demo plans before (or instead of) recording, backed by git-based document versioning. Users can start here to sketch out what a recording _might_ look like — time estimates, narrative bullets, demo action bullets, and captured screenshots — then iterate with feedback before committing to a recording session.
>
> Each project can hold **multiple documents**, each representing a segment, take, or alternative approach. Documents evolve through states: Sketch → RecordingEnriched → Refined → Final.
>
> **Status: COMPLETE** — All sub-phases implemented. Document data model, git-backed versioning via gix, Lexical editor with slash commands, custom ScriptTable node, version history UI, navigation/store updates, and sketch-to-recording bridge.

### 2.1 Data Model — Documents ✅

| Task | Details | Test | Status |
| --- | --- | --- | --- |
| Create `models/document.rs` | `Document` struct: `id: Uuid`, `title: String`, `description: String`, `sections: Vec<DocumentSection>`, `content: serde_json::Value` (Lexical editor state JSON), `state: DocumentState`, `created_at`, `updated_at`. `DocumentSection` struct wrapping section title, description, and the script planning table rows. `DocumentState` enum: `Sketch`, `RecordingEnriched`, `Refined`, `Final`. `DocumentSummary` for listing | Serde round-trip tests for all types | ✅ Done — 12 tests |
| Update `Project` model | Add `documents: Vec<Document>` alongside existing `script: Script`. Keep `Script`/`ScriptRow` as the derived execution plan for replay phases. Add optional `document_id: Option<Uuid>` link on `RecordedSession` | Backward-compatible deserialization test | ✅ Done |
| Mirror in TypeScript | `Document`, `DocumentSection`, `DocumentState`, `DocumentSummary` types in `types/document.ts`. Update `Project` type in `types/project.ts` | TypeScript compiles | ✅ Done |
| Register in `models/mod.rs` | Add `pub mod document;` | `cargo build` succeeds | ✅ Done |

**Deliverable**: Multi-document project model where each document has its own lifecycle state. ✅

### 2.2 Project Storage with Git Versioning ✅

| Task | Details | Test | Status |
| --- | --- | --- | --- |
| Add `gix` dependency | `gix` crate (pure Rust git implementation, no C/cmake deps) with minimal features for init, add, commit, log, diff. Pin version for stability | `cargo build` succeeds on Windows without cmake | ✅ Done — gix 0.70 |
| Create `engine/versioning.rs` | `init_project_repo(project_dir)` — git init. `commit_snapshot(project_dir, message)` — stage all, commit. `list_versions(project_dir)` — walk commit log, return `Vec<VersionEntry>` with id, message, timestamp, summary. `get_version(project_dir, commit_id)` — read content at commit. `diff_versions(project_dir, from, to)` — generate diff between two commits. `restore_version(project_dir, commit_id)` — checkout historical state, commit as new version | Unit tests with temp repos: init → commit → log → diff → restore round-trip | ✅ Done — 6 tests |
| Migrate project storage format | Move from flat `{uuid}.cutready` JSON files to directory-per-project: `projects/{uuid}/` containing `project.json`, `documents/`, `screenshots/`, `.git/`. Auto-migrate old flat files on first open | Migration test: old `.cutready` file opens correctly in new format | ✅ Done |
| Update `engine/project.rs` | `create_project` creates directory + calls `init_project_repo` + initial commit. `save_project` writes JSON + auto-commits with generated message. `load_project` reads from working directory. `save_with_label` commits with user-provided message | CRUD round-trip test with git history verification | ✅ Done — 8 tests |

**Deliverable**: Projects stored as git-backed directories with automatic versioning on every save. ✅

### 2.3 Versioning & Document Commands ✅

| Task | Details | Test | Status |
| --- | --- | --- | --- |
| Create `commands/versioning.rs` | Tauri commands: `save_with_label(label)`, `list_versions()`, `preview_version(commit_id)`, `restore_version(commit_id)` | Integration tests: call each command, verify responses | ✅ Done |
| Create `commands/document.rs` | Tauri commands: `create_document(title)`, `update_document(id, content)`, `update_document_title(id, title)`, `delete_document(id)`, `list_documents()`, `get_document(id)` | Integration tests: CRUD cycle | ✅ Done |
| Register commands in `lib.rs` | Add all new commands to `tauri::generate_handler![]` | App compiles and commands are callable from frontend | ✅ Done |

**Deliverable**: Frontend can manage documents and navigate version history via Tauri IPC. ✅

### 2.4 Lexical Editor Integration ✅

| Task | Details | Test | Status |
| --- | --- | --- | --- |
| Install Lexical packages | `lexical`, `@lexical/react`, `@lexical/rich-text`, `@lexical/list`, `@lexical/table`, `@lexical/markdown`, `@lexical/history`, `@lexical/selection`, `@lexical/utils`, `@lexical/code`, `@lexical/link` | `npm run dev` builds | ✅ Done |
| Create `SketchEditor` component | Mount `LexicalComposer` with `RichTextPlugin`, `ListPlugin`, `HistoryPlugin`, `MarkdownShortcutPlugin`. Load document content from Lexical JSON state. Auto-save via debounced `update_document` command (500ms). Serialize editor state as JSON for persistence | Editor renders, typing works, content round-trips through save/load | ✅ Done |
| Apply CutReady theme | Override Lexical's default node styles with CSS variables (`--color-surface`, `--color-text`, `--color-border`, `--color-accent`). Warm palette, Geist Sans font, `-0.011em` letter spacing. Use `bg-[var(--color-surface)]` pattern per frontend conventions | Visual: editor matches app aesthetic in both light and dark modes | ✅ Done |
| Slash command plugin | Custom plugin that shows a command palette on `/` keystroke: insert heading (H1/H2/H3), bullet list, numbered list, script table, divider. Styled with warm accent colors, `rounded-xl`, `backdrop-blur-md` | Type `/` → menu appears → select block type → block inserted | ✅ Done |

**Deliverable**: Notion-style Lexical block editor with slash commands, themed to CutReady's warm design system. ✅

### 2.5 Custom Script Table Node ✅

| Task | Details | Test | Status |
| --- | --- | --- | --- |
| Create `ScriptTableNode` | Custom Lexical `DecoratorNode` that renders a 4-column planning table: Time, Narrative Bullets, Demo Action Bullets, Screenshot. Each cell is editable inline. Time column accepts approximate durations (`~30s`, `1:00`, `2m`). Narrative and Demo columns support multi-line editing. Node serializes to/from Lexical JSON | Insert via slash command → table appears → edit cells → save → reload → content preserved | ✅ Done |
| Row operations | Buttons to add row below, delete row within the script table | Row ops work; serialization is stable | ✅ Done |

**Deliverable**: Custom script planning table embedded as a Lexical block. ✅

### 2.6 Version History UI ✅

| Task | Details | Test | Status |
| --- | --- | --- | --- |
| Create `VersionHistory` panel | Slide-out right sidebar showing commit timeline. Each entry: label/message, timestamp (relative date). Visual vertical timeline with dots + connecting lines in accent color. "Save Version" button at top for labeled commits | Visual: timeline renders with version entries | ✅ Done |
| Version restore | "Restore this version" button on historical entries → calls `restore_version` → creates new commit with restored content → editor shows restored state | Restore works, new version appears in history | ✅ Done |

**Deliverable**: User-friendly version history with restore — no git knowledge required. ✅

### 2.7 Navigation & Store Updates ✅

| Task | Details | Test | Status |
| --- | --- | --- | --- |
| Add `"sketch"` to `AppView` | New view variant in Zustand store. New state fields: `activeDocumentId: string \| null`, `documents: DocumentSummary[]`, `versions: VersionEntry[]` | TypeScript compiles | ✅ Done |
| Add document store actions | `createDocument`, `openDocument`, `updateDocumentContent`, `updateDocumentTitle`, `deleteDocument`, `loadDocuments` | Actions mutate state correctly, call backend commands | ✅ Done |
| Add versioning store actions | `loadVersions`, `saveVersion`, `restoreVersion`, `toggleVersionHistory` | Actions call backend, update `versions` state | ✅ Done |
| Update `Sidebar` | Add "Sketch" nav item (pencil icon) between Home and Record. Requires project open | Visual: nav item appears in correct position | ✅ Done |
| Create `SketchPanel` | Three-column layout: document list (left, 240px) + sketch editor (center, flex) + version history (right, toggled, 280px). Document list shows cards with title, state badge (`Sketch`/`Recording`/`Refined`/`Final`), relative date. "New Document" button at top | Visual: panel renders with all three sub-panels | ✅ Done |
| Update `HomePanel` | After opening a project, navigate to sketch view. Document loading on project open | Navigation flow works correctly | ✅ Done |
| Update `AppLayout` | Add `"sketch"` case rendering `SketchPanel` | Panel renders when view switches to sketch | ✅ Done |

**Deliverable**: Complete sketch workflow accessible from sidebar — create documents, edit in Lexical, manage versions, navigate between documents. ✅

### 2.8 Sketch-to-Recording Bridge ✅

| Task | Details | Test | Status |
| --- | --- | --- | --- |
| Post-recording linkage | `RecordedSession.document_id` field set when recording from a sketch context. Session JSON contains document reference | Session JSON contains document reference | ✅ Done |
| Document state advancement | When a sketch document has linked recordings, its state can advance `Sketch` → `RecordingEnriched`. UI badge updates automatically | State transition works, reflected in document list | ✅ Done |

**Deliverable**: Sketch documents feed into the recording phase with full traceability. ✅

---

## Phase 3 — Script Table & Editing

> Goal: Transform captured actions into an editable script table, using sketch documents as scaffolding when available.

### 3.1 Session-to-Script Conversion

| Task | Details | Test |
| --- | --- | --- |
| Implement `engine/interaction.rs` — `session_to_script()` | Takes `RecordedSession`, groups actions into `ScriptRow` segments (one row per logical step). Basic heuristic: one row per action, with timing from timestamps. If a sketch document is linked (`document_id`), use its section structure and narrative bullets as scaffolding for the generated rows | Unit test: 5 raw actions → 5 script rows with correct timing. Test with sketch: rows inherit sketch narrative |
| Wire command: `convert_session_to_script` | Returns a `Script` from a session ID | Integration test |

**Deliverable**: Raw recordings become structured script tables, pre-populated from sketch outlines when available.

### 3.2 Script Editor Panel

| Task | Details | Test |
| --- | --- | --- |
| Install TanStack Table | For the precise script execution table | `npm run dev` builds |
| Create `ScriptEditor` component | Table with columns: #, Time, Narrative, Actions, Screenshot. Renders `ScriptRow` data | Visual: table renders with mock data |
| Editable cells | Time: duration picker. Narrative: inline text editor. Actions: read-only summary (for now) | Can edit time and narrative, changes reflect in state |
| Row operations | Add row, delete row, drag-and-drop reorder | Visual + state: reorder persists |
| Wire to backend | Load script from current project, save on edit via `save_project` | Changes survive app restart |

**Deliverable**: Full script table editor connected to project storage.

### 3.3 Action Detail Editor

| Task | Details | Test |
| --- | --- | --- |
| Create `ActionEditor` component | Modal/panel for editing a single action: change selectors, edit typed text, adjust waits | Visual inspection |
| Create `ActionList` sub-component | Inline in script row — reorderable list of actions within a segment | Drag-reorder actions within a row |
| Split / merge script rows | Split: one row becomes two at a chosen action. Merge: two adjacent rows combine | Unit test for split/merge logic |

**Deliverable**: Full script editing — row-level and action-level.

---

## Phase 4 — LLM Integration & Agent Refinement

> Goal: AI cleans up recordings and generates narration.

### 4.1 LLM Provider Implementation

| Task | Details | Test |
| --- | --- | --- |
| Implement `AzureOpenAiProvider` | HTTP calls to Azure OpenAI chat completions endpoint. Support `complete()` and `complete_structured()` | Integration test with a real (or mocked) API key: send a message, get a response |
| Create `MockLlmProvider` for tests | Returns canned JSON responses matching expected schemas | Unit tests use this for deterministic results |
| Wire settings: API endpoint, key, deployment | Read from `tauri-plugin-store`, inject into provider at startup | Settings panel → provider picks up new config |

**Deliverable**: Working LLM provider with mock alternative for testing.

### 4.2 Action Cleanup Pipeline

| Task | Details | Test |
| --- | --- | --- |
| Implement `engine/agent/cleanup.rs` | Takes `Vec<CapturedAction>`, sends to LLM with prompt: classify each as intentional/accidental/redundant. Returns cleaned `Vec<Action>` | Unit test with mock LLM: 10 actions with 3 accidental → returns 7 |
| Wire command: `refine_cleanup` | Takes session ID, returns cleaned actions | Integration test |
| Add cleanup progress streaming | Channel updates: "Processing action 3/10..." | Frontend receives progress |

**Deliverable**: AI removes accidental/redundant actions from recordings.

### 4.3 Selector Stabilization

| Task | Details | Test |
| --- | --- | --- |
| Implement `engine/agent/selectors.rs` | Sends action + DOM context snapshot to LLM, requests more robust selector alternatives | Unit test: fragile CSS selector → gets `data-testid` alternative |
| Update `SelectorStrategy` ordering | Agent response reorders strategies by robustness | Verified in output |

**Deliverable**: Selectors upgraded from fragile positional to robust semantic.

### 4.4 Narrative Generation

| Task | Details | Test |
| --- | --- | --- |
| Implement `engine/agent/narrative.rs` | Takes `Vec<Action>` + screenshot paths, generates voiceover text per segment | Unit test: 5 actions → 5 narrative strings, each ≤ 3 sentences |
| Estimate timing from word count | `word_count / words_per_minute * 60` → suggested `Duration` | Unit test: 150 words at 150 WPM → 60s |

**Deliverable**: AI-generated narration text and timing for every script row.

### 4.5 Full Refinement Pipeline

| Task | Details | Test |
| --- | --- | --- |
| Implement `engine/agent/mod.rs` — `refine_session()` | Orchestrates: cleanup → selectors → narrative → timing. Returns a complete `Script` | Unit test with mock LLM: raw session → refined script |
| Wire command: `refine_session` with channel progress | Progress events: "Cleaning actions...", "Stabilizing selectors...", "Generating narration..." | Frontend shows refinement progress |
| Create `RefinementPanel` UI | "Refine" button on recording, progress bar, result preview | Visual: click refine, watch progress, see result |

**Deliverable**: One-click refinement from raw recording to polished script.

### 4.6 Diff / Review Panel

| Task | Details | Test |
| --- | --- | --- |
| Create `DiffPanel` component | Side-by-side: raw actions vs. refined. Per-item accept/reject/edit | Visual inspection |
| Implement accept/reject logic | Accept → keep refined. Reject → keep original. Edit → open in ActionEditor | State: mixed accept/reject produces correct merged script |

**Deliverable**: User reviews AI suggestions with full control.

---

## Phase 5 — Automation Replay

> Goal: Execute a script's actions automatically in a browser.

### 5.1 Browser Action Execution

| Task | Details | Test |
| --- | --- | --- |
| Add execution commands to Playwright sidecar | `browser.click`, `browser.type`, `browser.navigate`, `browser.scroll`, `browser.select`, `browser.waitForElement` | Unit tests per action type against a local test page |
| Implement `engine/automation.rs` — `execute_action()` | Sends action to sidecar, handles response, retries with fallback selectors on failure | Integration test: execute a click on a known element |
| Implement `execute_script()` | Iterates over `ScriptRow` list, executes each row's actions with timing delays | Integration test: 3-step script executes in sequence |

**Deliverable**: Scripts replay automatically in a real browser.

### 5.2 Self-Healing on Failure

| Task | Details | Test |
| --- | --- | --- |
| Implement `engine/agent/healing.rs` | On action failure: capture current DOM/screenshot, send to LLM: "element not found, here's the page, find the target" | Unit test with mock LLM: returns alternative selector |
| Integrate healing into `execute_action()` | Fail → heal → retry. If healed selector works, update the script's selector strategies | Integration test: action fails, healing finds new selector, retry succeeds |
| Add user prompt on unrecoverable failure | Pause automation, show dialog: "Action failed. Skip / Retry / Edit" | Manual test |

**Deliverable**: Replay recovers gracefully from UI changes.

### 5.3 Replay Controls UI

| Task | Details | Test |
| --- | --- | --- |
| Create `ReplayPanel` component | Play / Pause / Stop buttons, current step indicator, progress bar | Visual |
| Highlight current script row during replay | Active row scrolls into view, highlighted | Visual |
| Per-segment retake | Right-click row → "Retake this segment" re-executes just that row | Manual test |

**Deliverable**: Full replay control from the UI.

---

## Phase 6 — Recording Engine (FFmpeg)

> Goal: Capture lossless screen video + audio during replay.

### 6.1 FFmpeg Integration

| Task | Details | Test |
| --- | --- | --- |
| Bundle FFmpeg as Tauri sidecar binary | Add to `tauri.conf.json` `externalBin`, place binary in `binaries/` | FFmpeg runs from Tauri shell |
| Implement `util/ffmpeg.rs` — command builder | `FfmpegCommandBuilder` — fluent API to construct FFmpeg args for various capture scenarios | Unit test: builder produces correct arg arrays |
| Implement `util/audio.rs` — device enumeration | List audio input devices via FFmpeg `list_devices` or Win32 API | Returns at least one device on dev machine |

### 6.2 Screen + Audio Recording

| Task | Details | Test |
| --- | --- | --- |
| Implement `engine/recording.rs` — `start_recording()` | Spawn FFmpeg with gdigrab + dshow args, store process handle | FFmpeg process running, writing to file |
| Implement `stop_recording()` | Send `q` to stdin, wait for exit, return `Recording` with file paths | Output MKV file is playable |
| Implement progress parsing | Parse FFmpeg stderr for frame count, time, file size. Stream via Channel | Frontend receives frame updates |
| Implement `RecordingConfig` | Resolution, frame rate, audio devices, output path, capture region | Different configs produce different FFmpeg commands |

**Deliverable**: Lossless screen + audio recording with progress feedback.

### 6.3 Recording Controls

| Task | Details | Test |
| --- | --- | --- |
| Wire global hotkeys | `Ctrl+Shift+R` start/stop recording via `tauri-plugin-global-shortcut` | Hotkey works while app is not focused |
| Audio monitoring | Expose mic level data via FFmpeg filter or Win32 API, render VU meter in UI | Visual: meter moves when speaking |
| Pause/resume | FFmpeg doesn't natively pause — implement by stopping and starting new segments, then concatenating | Pause → resume produces continuous output |

**Deliverable**: Hands-free recording with audio monitoring.

### 6.4 Coordinated Produce Mode

| Task | Details | Test |
| --- | --- | --- |
| Implement `commands/produce.rs` — `start_production()` | Starts FFmpeg recording + automation replay simultaneously. Coordinates timing | Video file contains the automated demo |
| Add segment markers | Log timestamps at each script row boundary for FCPXML export | Marker timestamps align with actual segment starts |

**Deliverable**: "Hit Play and it all happens" — the core CutReady experience.

---

## Phase 7 — Teleprompter

> Goal: Display narration text synchronized with replay.

### 7.1 Teleprompter Panel

| Task | Details | Test |
| --- | --- | --- |
| Create `TeleprompterPanel` component | Large text display, current segment highlighted, smooth auto-scroll | Visual with mock data |
| Sync with replay | Listen for replay progress events, advance to current segment's narrative | Text advances as replay progresses |
| Configurable display | Font size slider, scroll speed, line spacing. Settings persisted | Settings apply immediately |

### 7.2 Detachable Teleprompter Window

| Task | Details | Test |
| --- | --- | --- |
| Create secondary Tauri window for teleprompter | `WebviewWindow::new()` — separate window the user can move to a second monitor | Window opens, displays same content |
| Sync between windows | Main window replay events → teleprompter window updates via Tauri events | Both windows stay in sync |

**Deliverable**: Professional teleprompter that syncs with automation replay.

---

## Phase 8 — Native App Recording & Replay

> Goal: Extend recording and replay to Windows native applications.

### 8.1 Native Interaction Capture

| Task | Details | Test |
| --- | --- | --- |
| Implement `SetWinEventHook` listener | Hook into UI Automation events: focus, invoke, value change | Callback fires on native app interactions |
| Implement input hooks | `SetWindowsHookEx` for `WH_MOUSE_LL`, `WH_KEYBOARD_LL` | Mouse clicks and keystrokes captured |
| Correlate inputs with UIA elements | On click/key, query UIA tree for the focused element. Build `SelectorStrategy` entries | `NativeClick` action has correct AutomationId/Name |
| Map to `Action` variants | Raw events → `NativeClick`, `NativeType`, `NativeSelect`, `NativeInvoke` | Unit test for all native action types |

### 8.2 Native Action Replay

| Task | Details | Test |
| --- | --- | --- |
| Implement UIA element lookup | Walk UIA tree to find element matching `SelectorStrategy` (AutomationId → Name → ControlType → tree path) | Finds Notepad's "File" menu item |
| Implement `NativeClick` via Invoke pattern | `IInvokeProvider::Invoke()` | Button clicks in a test app |
| Implement `NativeType` | `SendInput()` or `IValueProvider::SetValue()` | Text appears in target field |
| Integrate with `engine/automation.rs` | Unified `execute_action()` handles both browser and native actions | Mixed script (browser + native) executes correctly |

**Deliverable**: CutReady records and replays native Windows app demos.

---

## Phase 9 — Motion Animations (ManimCE)

> Goal: Generate and render concept animations from natural language.

### 9.1 ManimCE Integration

| Task | Details | Test |
| --- | --- | --- |
| Implement `engine/animation.rs` — `render_animation()` | Write Python to temp file, spawn `manim render`, parse progress, return video path | Integration test: render a simple scene, output MP4 exists |
| AST validation | Parse Python AST, reject dangerous imports (`os`, `subprocess`, `sys`, etc.) | Unit test: safe code passes, unsafe code rejected |
| Resource limits | Render timeout (5 min default), memory limit via subprocess constraints | Test: infinite loop scene times out |

### 9.2 LLM Animation Code Generation

| Task | Details | Test |
| --- | --- | --- |
| Implement `engine/agent/animations.rs` | Natural language → ManimCE code via LLM. Validate → render → return | Unit test with mock: description → valid ManimCE code |
| Animation suggestion during refinement | Agent identifies steps that could benefit from animations, generates descriptions | Suggestions appear in refined script |

### 9.3 Animation UI

| Task | Details | Test |
| --- | --- | --- |
| Create `AnimationPanel` component | Text input for description, "Generate" button, code editor (CodeMirror/Monaco), preview player | Visual: type description → see code → preview video |
| Inline animation placement | Drag rendered animation into script table at desired position | Animation appears as script row with video |

**Deliverable**: Natural language → rendered animation → placed in timeline.

---

## Phase 10 — Export Engine

> Goal: Produce the final output package with FCPXML timeline.

### 10.1 Output Folder Assembly

| Task | Details | Test |
| --- | --- | --- |
| Implement `engine/export.rs` — `assemble_output()` | Create output folder structure: `video/`, `audio/`, `animations/`, `screenshots/`. Copy/move files | Output folder has expected structure |
| Generate `script.json` | Serialize the `Script` to formatted JSON | Valid JSON, matches schema |
| Generate `script.md` | Render script as Markdown table | Readable Markdown |

### 10.2 FCPXML Generation

| Task | Details | Test |
| --- | --- | --- |
| Implement FCPXML 1.9 writer using `quick-xml` | Generate `<fcpxml>` → `<resources>` → `<library>` → `<event>` → `<project>` → `<sequence>` with spine tracks | Unit test: output is valid XML |
| Video track (V1) | Split screen recording at segment boundaries, create clip refs | Clips reference correct time ranges |
| Audio tracks (A1, A2) | Narration on lane 1, system audio on lane 2 | Tracks aligned with video segments |
| Animation track (V2) | Animation clips placed at designated positions | Correct in-point and duration |
| Segment markers | Marker at each `ScriptRow` boundary with the row's title/narrative preview | Markers appear in DaVinci Resolve |
| Import test | Open in DaVinci Resolve, verify timeline structure | Manual: timeline looks correct |

### 10.3 Export UI

| Task | Details | Test |
| --- | --- | --- |
| Create `ExportPanel` component | "Export" button, output path selector, quality settings, progress bar | Visual |
| Post-export: open folder | Button to open the output folder in Explorer | Folder opens |

**Deliverable**: Complete, organized output package ready for DaVinci Resolve.

---

## Phase 11 — Polish & Advanced Features

> Goal: Production readiness and quality-of-life improvements.

### 11.1 Step-by-Step Capture Mode

| Task | Details | Test |
| --- | --- | --- |
| Implement step-by-step recording | Capture one action at a time with confirmation popup between steps | Each step produces an annotated `ScriptRow` |

### 11.2 Partial Re-record

| Task | Details | Test |
| --- | --- | --- |
| Re-record individual script rows | Select a row → "Re-record" → capture new actions for just that segment | Only the selected row's actions change |

### 11.3 Preview / Dry-Run

| Task | Details | Test |
| --- | --- | --- |
| Dry-run a segment | Execute one row's actions without recording | Actions execute, no video file produced |

### 11.4 Error Recovery & Resilience

| Task | Details | Test |
| --- | --- | --- |
| FFmpeg crash recovery | Detect FFmpeg exit, save partial output, notify user | Partial MKV is recoverable |
| Sidecar crash recovery | Detect Playwright sidecar exit, restart, resume from last action | Replay resumes after sidecar restart |
| Autosave | Save project every 30s and on significant state changes | Crash → restart → project recovered |

### 11.5 Packaging & Distribution

| Task | Details | Test |
| --- | --- | --- |
| Bundle FFmpeg binary | Include in Tauri `externalBin` | Installer includes FFmpeg |
| Bundle Playwright sidecar | Package Node.js script (via `pkg` or embedded Node) | Sidecar runs from installed app |
| NSIS/MSI installer | Tauri bundler configuration | Clean install on fresh machine |
| Auto-update | `tauri-plugin-updater` configuration | App detects and installs update |

---

## Dependency Graph

```text
Phase 0 (Foundation)
  │
  ├─► Phase 1 (Browser Recording) ─► Phase 2 (Sketch Editor + Versioning)
  │                                       │
  │                                       ├─► Phase 3 (Script Table)
  │                                       │       │
  │                                       │       ├─► Phase 4 (Agent/LLM)
  │                                       │       │       │
  │                                       │       │       ▼
  │                                       │       ├─► Phase 5 (Automation Replay)
  │                                       │       │       │
  │                                       │       │       ▼
  │                                       │       ├─► Phase 6 (FFmpeg Recording)
  │                                       │       │       │
  │                                       │       │       ▼
  │                                       │       └─► Phase 7 (Teleprompter)
  │                                       │
  │                                       └─► (Sketch can also feed directly into Phase 5 for recording)
  │
  ├─► Phase 8 (Native Recording) ─── can start after Phase 1
  │
  ├─► Phase 9 (Animations) ────────── can start after Phase 4.1
  │
  └─► Phase 10 (Export) ───────────── needs Phases 6 + 9

Phase 11 (Polish) ─── runs continuously alongside later phases
```

### Key Dependencies

- **Phase 2 doesn't block on Phase 1** — users can sketch without recording first. Phase 2 uses Phase 1's browser automation only for the optional screenshot capture feature.
- **Phase 3 uses Phase 2** — sketch documents provide scaffolding for session-to-script conversion.
- **Phase 2 → Phase 5 shortcut** — a sketch document alone (without Phase 3's script table) can serve as the basis for a manual replay session.

### Parallelization Opportunities

These phases can be worked on simultaneously:

- **Phase 2** (Sketch Editor) + **Phase 8** (Native Recording) — independent feature tracks
- **Phase 4** (Agent) + **Phase 6** (FFmpeg) — independent engines
- **Phase 8** (Native) + **Phase 9** (Animations) — independent engines
- **Phase 7** (Teleprompter) is purely frontend and decoupled from backend work
- **Phase 2.2** (git versioning backend) can be developed in parallel with **Phase 2.4** (Lexical editor frontend)

---

## Estimated Complexity

| Phase | Scope | Relative Effort |
| --- | --- | --- |
| 0 — Foundation | Scaffold + CRUD + plugins + shell | Small |
| 1 — Browser Recording | Sidecar + CDP + session mgmt | Medium-Large |
| 2 — Sketch Editor + Versioning | Lexical editor + custom blocks + gix versioning + document model + version UI | Large |
| 3 — Script Table | Session-to-script + TanStack Table + action editor | Medium |
| 4 — Agent/LLM | Provider + 4 pipeline stages + diff UI | Large |
| 5 — Automation Replay | Sidecar execution + healing + controls | Medium |
| 6 — FFmpeg Recording | Process mgmt + audio + progress | Medium |
| 7 — Teleprompter | UI panel + sync + detachable window | Small |
| 8 — Native Recording | Win32 hooks + UIA + replay | Large |
| 9 — Animations | ManimCE subprocess + LLM codegen + UI | Medium |
| 10 — Export | Folder assembly + FCPXML generation | Medium |
| 11 — Polish | Re-record, recovery, packaging | Medium |

---

## What to Build First

**Recommended starting order for a single developer:**

1. **Phase 0** — ~2-3 days. Get the foundation solid. ✅
2. **Phase 1** — ~1 week. Browser recording is the app's core capability. ✅
3. **Phase 2** — ~2-3 weeks. Sketch editor + versioning. This is the new primary entry point — users sketch before they record.
4. **Phase 3** — ~1 week. Script table lets recorded data become visible and editable, using sketch structure as scaffolding.
5. **Phase 4.1** — ~2 days. LLM provider working (needed for everything AI).
6. **Phase 5** — ~1 week. Replay is the payoff — you can see the pipeline work.
7. **Phase 6** — ~1 week. Add actual video capture during replay.
8. **Phase 4.2–4.6** — ~1 week. Full agent refinement pipeline.
9. **Phase 7** — ~2-3 days. Teleprompter completes the produce experience.
10. **Phase 10** — ~1 week. Export makes output usable in DaVinci Resolve.
11. **Phase 8** — ~1-2 weeks. Native app support (defer if browser-only is enough initially).
12. **Phase 9** — ~1 week. Animations are impressive but not on the critical path.
13. **Phase 11** — Ongoing throughout and at the end.

**First demo-able milestone**: After Phases 0–2, you can create a project, sketch a structured demo plan with narrative and screenshots, and version your work. After Phase 3, recorded sessions populate the script table using your sketch as scaffolding. After Phase 5, it replays automatically. That's the "wow" moment.
