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

## Phase 0 — Foundation & Project Infrastructure

> Goal: Solid groundwork that every subsequent milestone builds on.

### 0.1 Rust Module Skeleton

Create the directory structure from ARCHITECTURE.md with empty modules and public type stubs. No logic — just compiles.

| Task | Details | Test |
| --- | --- | --- |
| Create `commands/` module with files: `recording.rs`, `automation.rs`, `interaction.rs`, `agent.rs`, `animation.rs`, `export.rs`, `project.rs` | Empty Tauri command stubs returning `Ok(())` or placeholder data | `cargo build` succeeds |
| Create `engine/` module with files: `recording.rs`, `automation.rs`, `interaction.rs`, `agent/mod.rs`, `animation.rs`, `export.rs` | Empty structs + trait definitions | `cargo build` succeeds |
| Create `models/` module with files: `action.rs`, `script.rs`, `recording.rs`, `animation.rs`, `session.rs` | All core types from ARCHITECTURE.md with `Serialize`/`Deserialize` | `cargo test` — round-trip serde tests for every model |
| Create `llm/` module with `mod.rs`, `azure_openai.rs`, `types.rs` | `LlmProvider` trait + types, `AzureOpenAiProvider` struct (no impl yet) | Compiles |
| Create `util/` module with `ffmpeg.rs`, `screenshot.rs`, `audio.rs` | Empty stubs | Compiles |

**Deliverable**: Full module tree compiles. All core data types defined and serializable.

### 0.2 Project Storage (JSON Files)

| Task | Details | Test |
| --- | --- | --- |
| Implement `Project` CRUD in `engine/project.rs` | `create_project()`, `load_project()`, `save_project()`, `list_projects()` | Unit tests: create → save → load round-trip, list scans a directory |
| Wire Tauri commands: `create_project`, `open_project`, `save_project`, `list_projects` | Thin wrappers in `commands/project.rs` | Manual test: invoke from browser console in dev mode |
| Add `AppState` to `lib.rs` | `Mutex<Option<Project>>` for current project state | Unit test: state set/get |

**Deliverable**: Can create, save, load, and list `.cutready` project JSON files from the frontend.

### 0.3 Tauri Plugin Registration

| Task | Details | Test |
| --- | --- | --- |
| Add required plugins to `Cargo.toml` | `tauri-plugin-fs`, `tauri-plugin-dialog`, `tauri-plugin-shell`, `tauri-plugin-store`, `tauri-plugin-global-shortcut`, `tauri-plugin-window-state`, `tauri-plugin-log`, `tauri-plugin-single-instance`, `tauri-plugin-process` | `cargo build` succeeds |
| Register all plugins in `lib.rs` | Builder chain | App launches with plugins active |
| Configure capabilities in `capabilities/default.json` | File access, dialog, shell, store, global-shortcut permissions | No permission errors at runtime |

**Deliverable**: All Tauri plugins registered and permitted. App boots cleanly.

### 0.4 Frontend Shell & Navigation

| Task | Details | Test |
| --- | --- | --- |
| Install state management (`zustand`) + routing | Zustand store for app state; simple view routing (no react-router needed — panel switching) | `npm run dev` builds |
| Create `AppLayout` component | Sidebar nav + main content area. Panels: Home, Script Editor, Settings (placeholders) | Visual: panels switch on click |
| Create `Home` / project picker view | List projects, "New Project" button. Calls `list_projects` / `create_project` commands | Can create a project and see it listed |
| Create `Settings` panel (placeholder) | Form fields for: output directory, LLM API key, audio device (all saved via `tauri-plugin-store`) | Settings persist across restart |
| Add `tauri-plugin-store` JS integration | Helper hook `useSettings()` wrapping `@tauri-apps/plugin-store` | Unit test for the hook |

**Deliverable**: App has navigation, project creation, settings persistence. Foundation for all feature panels.

---

## Phase 1 — Interaction Recording (Browser)

> Goal: Record a sequence of browser interactions and save them as `CapturedAction` objects.

### 1.1 Playwright Sidecar Protocol

| Task | Details | Test |
| --- | --- | --- |
| Create `playwright-sidecar/` Node.js project | `index.js` with JSON-RPC stdin/stdout protocol. Initial commands: `browser.launch`, `browser.close`, `ping` | Run standalone: `echo '{"id":1,"method":"ping"}'  \| node index.js` returns a pong |
| Define the sidecar protocol types in Rust | `SidecarRequest`, `SidecarResponse` types in `util/sidecar.rs` | Serde round-trip tests |
| Implement sidecar process manager in Rust | `SidecarManager` — spawn Node process, send JSON via stdin, read JSON from stdout, handle lifecycle | Integration test: spawn sidecar, ping, shut down |

**Deliverable**: Rust can start the Playwright sidecar and exchange JSON messages.

### 1.2 Browser Observation Mode

| Task | Details | Test |
| --- | --- | --- |
| Add CDP event listeners in Playwright sidecar | Listen for click, type, navigate, scroll events via CDP + injected JS observer | Manual test: launch browser, click around, see events logged to stdout |
| Map CDP events to `Action` variants | In sidecar: transform raw events into CutReady `Action` JSON (with selectors, metadata) | Unit tests for event → Action mapping |
| Stream captured actions to Rust | Sidecar emits `{"event":"action_captured","data":{...}}` on stdout; Rust parses and stores | Integration test: launch browser via sidecar, click a link, receive `BrowserClick` action in Rust |

**Deliverable**: User can browse a website while CutReady captures every interaction as structured `Action` data.

### 1.3 Screenshot Capture Per Action

| Task | Details | Test |
| --- | --- | --- |
| Add `page.screenshot()` in sidecar on each captured action | Save PNG to project's `screenshots/` dir, return path in action metadata | File exists after capture |
| Implement `util/screenshot.rs` for fallback (Windows `BitBlt`) | Screen region capture via Win32 GDI | Unit test: captures a screenshot, file is valid PNG |

**Deliverable**: Every captured interaction has an associated screenshot.

### 1.4 Recording Session Management

| Task | Details | Test |
| --- | --- | --- |
| Implement `engine/interaction.rs` — `start_session()`, `capture_action()`, `end_session()` | Manages `RecordedSession`, accumulates `CapturedAction` list | Unit tests for session lifecycle |
| Wire commands: `start_recording_session`, `stop_recording_session` | Tauri commands that manage the sidecar + session | Manual: start session → browse → stop → inspect saved session JSON |
| Stream captured actions to frontend via Channel | As each action is captured, send it to the frontend for live display | Frontend console shows actions appearing in real time |

**Deliverable**: Complete browser recording session — start, capture, stop, save.

### 1.5 Recording UI

| Task | Details | Test |
| --- | --- | --- |
| Create `RecordingPanel` component | "Start Recording" / "Stop" buttons, live action list showing captured steps with thumbnails | Visual: actions appear as user browses |
| Create `ActionCard` component | Displays one captured action: icon, description, selector, screenshot thumbnail | Visual inspection |
| Wire to session commands | Button clicks → invoke start/stop, Channel updates → append to action list | End-to-end: click Start, browse a site, click Stop, see full action list |

**Deliverable**: User can visually record a browser demo and see every captured step.

---

## Phase 2 — Script Table & Editing

> Goal: Transform captured actions into an editable script table.

### 2.1 Session-to-Script Conversion

| Task | Details | Test |
| --- | --- | --- |
| Implement `engine/interaction.rs` — `session_to_script()` | Takes `RecordedSession`, groups actions into `ScriptRow` segments (one row per logical step). Basic heuristic: one row per action, with timing from timestamps | Unit test: 5 raw actions → 5 script rows with correct timing |
| Wire command: `convert_session_to_script` | Returns a `Script` from a session ID | Integration test |

**Deliverable**: Raw recordings become structured script tables.

### 2.2 Script Editor Panel

| Task | Details | Test |
| --- | --- | --- |
| Install TanStack Table | For the script table | `npm run dev` builds |
| Create `ScriptEditor` component | Table with columns: #, Time, Narrative, Actions, Screenshot. Renders `ScriptRow` data | Visual: table renders with mock data |
| Editable cells | Time: duration picker. Narrative: inline text editor. Actions: read-only summary (for now) | Can edit time and narrative, changes reflect in state |
| Row operations | Add row, delete row, drag-and-drop reorder | Visual + state: reorder persists |
| Wire to backend | Load script from current project, save on edit via `save_project` | Changes survive app restart |

**Deliverable**: Full script table editor connected to project storage.

### 2.3 Action Detail Editor

| Task | Details | Test |
| --- | --- | --- |
| Create `ActionEditor` component | Modal/panel for editing a single action: change selectors, edit typed text, adjust waits | Visual inspection |
| Create `ActionList` sub-component | Inline in script row — reorderable list of actions within a segment | Drag-reorder actions within a row |
| Split / merge script rows | Split: one row becomes two at a chosen action. Merge: two adjacent rows combine | Unit test for split/merge logic |

**Deliverable**: Full script editing — row-level and action-level.

---

## Phase 3 — LLM Integration & Agent Refinement

> Goal: AI cleans up recordings and generates narration.

### 3.1 LLM Provider Implementation

| Task | Details | Test |
| --- | --- | --- |
| Implement `AzureOpenAiProvider` | HTTP calls to Azure OpenAI chat completions endpoint. Support `complete()` and `complete_structured()` | Integration test with a real (or mocked) API key: send a message, get a response |
| Create `MockLlmProvider` for tests | Returns canned JSON responses matching expected schemas | Unit tests use this for deterministic results |
| Wire settings: API endpoint, key, deployment | Read from `tauri-plugin-store`, inject into provider at startup | Settings panel → provider picks up new config |

**Deliverable**: Working LLM provider with mock alternative for testing.

### 3.2 Action Cleanup Pipeline

| Task | Details | Test |
| --- | --- | --- |
| Implement `engine/agent/cleanup.rs` | Takes `Vec<CapturedAction>`, sends to LLM with prompt: classify each as intentional/accidental/redundant. Returns cleaned `Vec<Action>` | Unit test with mock LLM: 10 actions with 3 accidental → returns 7 |
| Wire command: `refine_cleanup` | Takes session ID, returns cleaned actions | Integration test |
| Add cleanup progress streaming | Channel updates: "Processing action 3/10..." | Frontend receives progress |

**Deliverable**: AI removes accidental/redundant actions from recordings.

### 3.3 Selector Stabilization

| Task | Details | Test |
| --- | --- | --- |
| Implement `engine/agent/selectors.rs` | Sends action + DOM context snapshot to LLM, requests more robust selector alternatives | Unit test: fragile CSS selector → gets `data-testid` alternative |
| Update `SelectorStrategy` ordering | Agent response reorders strategies by robustness | Verified in output |

**Deliverable**: Selectors upgraded from fragile positional to robust semantic.

### 3.4 Narrative Generation

| Task | Details | Test |
| --- | --- | --- |
| Implement `engine/agent/narrative.rs` | Takes `Vec<Action>` + screenshot paths, generates voiceover text per segment | Unit test: 5 actions → 5 narrative strings, each ≤ 3 sentences |
| Estimate timing from word count | `word_count / words_per_minute * 60` → suggested `Duration` | Unit test: 150 words at 150 WPM → 60s |

**Deliverable**: AI-generated narration text and timing for every script row.

### 3.5 Full Refinement Pipeline

| Task | Details | Test |
| --- | --- | --- |
| Implement `engine/agent/mod.rs` — `refine_session()` | Orchestrates: cleanup → selectors → narrative → timing. Returns a complete `Script` | Unit test with mock LLM: raw session → refined script |
| Wire command: `refine_session` with channel progress | Progress events: "Cleaning actions...", "Stabilizing selectors...", "Generating narration..." | Frontend shows refinement progress |
| Create `RefinementPanel` UI | "Refine" button on recording, progress bar, result preview | Visual: click refine, watch progress, see result |

**Deliverable**: One-click refinement from raw recording to polished script.

### 3.6 Diff / Review Panel

| Task | Details | Test |
| --- | --- | --- |
| Create `DiffPanel` component | Side-by-side: raw actions vs. refined. Per-item accept/reject/edit | Visual inspection |
| Implement accept/reject logic | Accept → keep refined. Reject → keep original. Edit → open in ActionEditor | State: mixed accept/reject produces correct merged script |

**Deliverable**: User reviews AI suggestions with full control.

---

## Phase 4 — Automation Replay

> Goal: Execute a script's actions automatically in a browser.

### 4.1 Browser Action Execution

| Task | Details | Test |
| --- | --- | --- |
| Add execution commands to Playwright sidecar | `browser.click`, `browser.type`, `browser.navigate`, `browser.scroll`, `browser.select`, `browser.waitForElement` | Unit tests per action type against a local test page |
| Implement `engine/automation.rs` — `execute_action()` | Sends action to sidecar, handles response, retries with fallback selectors on failure | Integration test: execute a click on a known element |
| Implement `execute_script()` | Iterates over `ScriptRow` list, executes each row's actions with timing delays | Integration test: 3-step script executes in sequence |

**Deliverable**: Scripts replay automatically in a real browser.

### 4.2 Self-Healing on Failure

| Task | Details | Test |
| --- | --- | --- |
| Implement `engine/agent/healing.rs` | On action failure: capture current DOM/screenshot, send to LLM: "element not found, here's the page, find the target" | Unit test with mock LLM: returns alternative selector |
| Integrate healing into `execute_action()` | Fail → heal → retry. If healed selector works, update the script's selector strategies | Integration test: action fails, healing finds new selector, retry succeeds |
| Add user prompt on unrecoverable failure | Pause automation, show dialog: "Action failed. Skip / Retry / Edit" | Manual test |

**Deliverable**: Replay recovers gracefully from UI changes.

### 4.3 Replay Controls UI

| Task | Details | Test |
| --- | --- | --- |
| Create `ReplayPanel` component | Play / Pause / Stop buttons, current step indicator, progress bar | Visual |
| Highlight current script row during replay | Active row scrolls into view, highlighted | Visual |
| Per-segment retake | Right-click row → "Retake this segment" re-executes just that row | Manual test |

**Deliverable**: Full replay control from the UI.

---

## Phase 5 — Recording Engine (FFmpeg)

> Goal: Capture lossless screen video + audio during replay.

### 5.1 FFmpeg Integration

| Task | Details | Test |
| --- | --- | --- |
| Bundle FFmpeg as Tauri sidecar binary | Add to `tauri.conf.json` `externalBin`, place binary in `binaries/` | FFmpeg runs from Tauri shell |
| Implement `util/ffmpeg.rs` — command builder | `FfmpegCommandBuilder` — fluent API to construct FFmpeg args for various capture scenarios | Unit test: builder produces correct arg arrays |
| Implement `util/audio.rs` — device enumeration | List audio input devices via FFmpeg `list_devices` or Win32 API | Returns at least one device on dev machine |

### 5.2 Screen + Audio Recording

| Task | Details | Test |
| --- | --- | --- |
| Implement `engine/recording.rs` — `start_recording()` | Spawn FFmpeg with gdigrab + dshow args, store process handle | FFmpeg process running, writing to file |
| Implement `stop_recording()` | Send `q` to stdin, wait for exit, return `Recording` with file paths | Output MKV file is playable |
| Implement progress parsing | Parse FFmpeg stderr for frame count, time, file size. Stream via Channel | Frontend receives frame updates |
| Implement `RecordingConfig` | Resolution, frame rate, audio devices, output path, capture region | Different configs produce different FFmpeg commands |

**Deliverable**: Lossless screen + audio recording with progress feedback.

### 5.3 Recording Controls

| Task | Details | Test |
| --- | --- | --- |
| Wire global hotkeys | `Ctrl+Shift+R` start/stop recording via `tauri-plugin-global-shortcut` | Hotkey works while app is not focused |
| Audio monitoring | Expose mic level data via FFmpeg filter or Win32 API, render VU meter in UI | Visual: meter moves when speaking |
| Pause/resume | FFmpeg doesn't natively pause — implement by stopping and starting new segments, then concatenating | Pause → resume produces continuous output |

**Deliverable**: Hands-free recording with audio monitoring.

### 5.4 Coordinated Produce Mode

| Task | Details | Test |
| --- | --- | --- |
| Implement `commands/produce.rs` — `start_production()` | Starts FFmpeg recording + automation replay simultaneously. Coordinates timing | Video file contains the automated demo |
| Add segment markers | Log timestamps at each script row boundary for FCPXML export | Marker timestamps align with actual segment starts |

**Deliverable**: "Hit Play and it all happens" — the core CutReady experience.

---

## Phase 6 — Teleprompter

> Goal: Display narration text synchronized with replay.

### 6.1 Teleprompter Panel

| Task | Details | Test |
| --- | --- | --- |
| Create `TeleprompterPanel` component | Large text display, current segment highlighted, smooth auto-scroll | Visual with mock data |
| Sync with replay | Listen for replay progress events, advance to current segment's narrative | Text advances as replay progresses |
| Configurable display | Font size slider, scroll speed, line spacing. Settings persisted | Settings apply immediately |

### 6.2 Detachable Teleprompter Window

| Task | Details | Test |
| --- | --- | --- |
| Create secondary Tauri window for teleprompter | `WebviewWindow::new()` — separate window the user can move to a second monitor | Window opens, displays same content |
| Sync between windows | Main window replay events → teleprompter window updates via Tauri events | Both windows stay in sync |

**Deliverable**: Professional teleprompter that syncs with automation replay.

---

## Phase 7 — Native App Recording & Replay

> Goal: Extend recording and replay to Windows native applications.

### 7.1 Native Interaction Capture

| Task | Details | Test |
| --- | --- | --- |
| Implement `SetWinEventHook` listener | Hook into UI Automation events: focus, invoke, value change | Callback fires on native app interactions |
| Implement input hooks | `SetWindowsHookEx` for `WH_MOUSE_LL`, `WH_KEYBOARD_LL` | Mouse clicks and keystrokes captured |
| Correlate inputs with UIA elements | On click/key, query UIA tree for the focused element. Build `SelectorStrategy` entries | `NativeClick` action has correct AutomationId/Name |
| Map to `Action` variants | Raw events → `NativeClick`, `NativeType`, `NativeSelect`, `NativeInvoke` | Unit test for all native action types |

### 7.2 Native Action Replay

| Task | Details | Test |
| --- | --- | --- |
| Implement UIA element lookup | Walk UIA tree to find element matching `SelectorStrategy` (AutomationId → Name → ControlType → tree path) | Finds Notepad's "File" menu item |
| Implement `NativeClick` via Invoke pattern | `IInvokeProvider::Invoke()` | Button clicks in a test app |
| Implement `NativeType` | `SendInput()` or `IValueProvider::SetValue()` | Text appears in target field |
| Integrate with `engine/automation.rs` | Unified `execute_action()` handles both browser and native actions | Mixed script (browser + native) executes correctly |

**Deliverable**: CutReady records and replays native Windows app demos.

---

## Phase 8 — Motion Animations (ManimCE)

> Goal: Generate and render concept animations from natural language.

### 8.1 ManimCE Integration

| Task | Details | Test |
| --- | --- | --- |
| Implement `engine/animation.rs` — `render_animation()` | Write Python to temp file, spawn `manim render`, parse progress, return video path | Integration test: render a simple scene, output MP4 exists |
| AST validation | Parse Python AST, reject dangerous imports (`os`, `subprocess`, `sys`, etc.) | Unit test: safe code passes, unsafe code rejected |
| Resource limits | Render timeout (5 min default), memory limit via subprocess constraints | Test: infinite loop scene times out |

### 8.2 LLM Animation Code Generation

| Task | Details | Test |
| --- | --- | --- |
| Implement `engine/agent/animations.rs` | Natural language → ManimCE code via LLM. Validate → render → return | Unit test with mock: description → valid ManimCE code |
| Animation suggestion during refinement | Agent identifies steps that could benefit from animations, generates descriptions | Suggestions appear in refined script |

### 8.3 Animation UI

| Task | Details | Test |
| --- | --- | --- |
| Create `AnimationPanel` component | Text input for description, "Generate" button, code editor (CodeMirror/Monaco), preview player | Visual: type description → see code → preview video |
| Inline animation placement | Drag rendered animation into script table at desired position | Animation appears as script row with video |

**Deliverable**: Natural language → rendered animation → placed in timeline.

---

## Phase 9 — Export Engine

> Goal: Produce the final output package with FCPXML timeline.

### 9.1 Output Folder Assembly

| Task | Details | Test |
| --- | --- | --- |
| Implement `engine/export.rs` — `assemble_output()` | Create output folder structure: `video/`, `audio/`, `animations/`, `screenshots/`. Copy/move files | Output folder has expected structure |
| Generate `script.json` | Serialize the `Script` to formatted JSON | Valid JSON, matches schema |
| Generate `script.md` | Render script as Markdown table | Readable Markdown |

### 9.2 FCPXML Generation

| Task | Details | Test |
| --- | --- | --- |
| Implement FCPXML 1.9 writer using `quick-xml` | Generate `<fcpxml>` → `<resources>` → `<library>` → `<event>` → `<project>` → `<sequence>` with spine tracks | Unit test: output is valid XML |
| Video track (V1) | Split screen recording at segment boundaries, create clip refs | Clips reference correct time ranges |
| Audio tracks (A1, A2) | Narration on lane 1, system audio on lane 2 | Tracks aligned with video segments |
| Animation track (V2) | Animation clips placed at designated positions | Correct in-point and duration |
| Segment markers | Marker at each `ScriptRow` boundary with the row's title/narrative preview | Markers appear in DaVinci Resolve |
| Import test | Open in DaVinci Resolve, verify timeline structure | Manual: timeline looks correct |

### 9.3 Export UI

| Task | Details | Test |
| --- | --- | --- |
| Create `ExportPanel` component | "Export" button, output path selector, quality settings, progress bar | Visual |
| Post-export: open folder | Button to open the output folder in Explorer | Folder opens |

**Deliverable**: Complete, organized output package ready for DaVinci Resolve.

---

## Phase 10 — Polish & Advanced Features

> Goal: Production readiness and quality-of-life improvements.

### 10.1 Step-by-Step Capture Mode

| Task | Details | Test |
| --- | --- | --- |
| Implement step-by-step recording | Capture one action at a time with confirmation popup between steps | Each step produces an annotated `ScriptRow` |

### 10.2 Partial Re-record

| Task | Details | Test |
| --- | --- | --- |
| Re-record individual script rows | Select a row → "Re-record" → capture new actions for just that segment | Only the selected row's actions change |

### 10.3 Preview / Dry-Run

| Task | Details | Test |
| --- | --- | --- |
| Dry-run a segment | Execute one row's actions without recording | Actions execute, no video file produced |

### 10.4 Error Recovery & Resilience

| Task | Details | Test |
| --- | --- | --- |
| FFmpeg crash recovery | Detect FFmpeg exit, save partial output, notify user | Partial MKV is recoverable |
| Sidecar crash recovery | Detect Playwright sidecar exit, restart, resume from last action | Replay resumes after sidecar restart |
| Autosave | Save project every 30s and on significant state changes | Crash → restart → project recovered |

### 10.5 Packaging & Distribution

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
  ├─► Phase 1 (Browser Recording) ─► Phase 2 (Script Editor)
  │                                       │
  │                                       ├─► Phase 3 (Agent/LLM)
  │                                       │       │
  │                                       │       ▼
  │                                       ├─► Phase 4 (Automation Replay)
  │                                       │       │
  │                                       │       ▼
  │                                       ├─► Phase 5 (FFmpeg Recording)
  │                                       │       │
  │                                       │       ▼
  │                                       └─► Phase 6 (Teleprompter)
  │
  ├─► Phase 7 (Native Recording) ─── can start after Phase 1
  │
  ├─► Phase 8 (Animations) ────────── can start after Phase 3.1
  │
  └─► Phase 9 (Export) ────────────── needs Phases 5 + 8

Phase 10 (Polish) ─── runs continuously alongside later phases
```

### Parallelization Opportunities

These phases can be worked on simultaneously:

- **Phase 1** (Browser Recording) + **Phase 0.4** (Frontend Shell) — different people
- **Phase 3** (Agent) + **Phase 5** (FFmpeg) — independent engines
- **Phase 7** (Native) + **Phase 8** (Animations) — independent engines
- **Phase 6** (Teleprompter) is purely frontend and decoupled from backend work

---

## Estimated Complexity

| Phase | Scope | Relative Effort |
| --- | --- | --- |
| 0 — Foundation | Scaffold + CRUD + plugins + shell | Small |
| 1 — Browser Recording | Sidecar + CDP + session mgmt | Medium-Large |
| 2 — Script Editor | Table UI + editing + persistence | Medium |
| 3 — Agent/LLM | Provider + 4 pipeline stages + diff UI | Large |
| 4 — Automation Replay | Sidecar execution + healing + controls | Medium |
| 5 — FFmpeg Recording | Process mgmt + audio + progress | Medium |
| 6 — Teleprompter | UI panel + sync + detachable window | Small |
| 7 — Native Recording | Win32 hooks + UIA + replay | Large |
| 8 — Animations | ManimCE subprocess + LLM codegen + UI | Medium |
| 9 — Export | Folder assembly + FCPXML generation | Medium |
| 10 — Polish | Re-record, recovery, packaging | Medium |

---

## What to Build First

**Recommended starting order for a single developer:**

1. **Phase 0** — ~2-3 days. Get the foundation solid.
2. **Phase 1** — ~1 week. This is the app's entry point ("record first").
3. **Phase 2** — ~1 week. Now captured data is visible and editable.
4. **Phase 3.1** — ~2 days. LLM provider working (needed for everything AI).
5. **Phase 4** — ~1 week. Replay is the payoff — you can see the pipeline work.
6. **Phase 5** — ~1 week. Add actual video capture during replay.
7. **Phase 3.2–3.6** — ~1 week. Full agent refinement pipeline.
8. **Phase 6** — ~2-3 days. Teleprompter completes the produce experience.
9. **Phase 9** — ~1 week. Export makes output usable in DaVinci Resolve.
10. **Phase 7** — ~1-2 weeks. Native app support (can defer if browser-only is enough initially).
11. **Phase 8** — ~1 week. Animations are impressive but not on the critical path.
12. **Phase 10** — Ongoing throughout and at the end.

**First demo-able milestone**: After Phases 0–2, you can record a browser demo and see it as an editable script. After Phase 4, it replays automatically. That's the "wow" moment.
