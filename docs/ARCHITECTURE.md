# CutReady — Architecture

> _Technical design for the proposed solution using Tauri v2._

---

## High-Level Architecture

```text
┌─────────────────────────────────────────────────────────┐
│                    CutReady Desktop App                  │
│  ┌───────────────────────────────────────────────────┐  │
│  │              Frontend (React + TypeScript)         │  │
│  │                                                   │  │
│  │  ┌──────────┐ ┌────────────┐ ┌────────────────┐  │  │
│  │  │  Sketch   │ │  Script    │ │  Teleprompter  │  │  │
│  │  │  Editor   │ │  Editor    │ │    Panel       │  │  │
│  │  └──────────┘ └────────────┘ └────────────────┘  │  │
│  │  ┌──────────┐ ┌────────────┐ ┌────────────────┐  │  │
│  │  │ Timeline  │ │  Settings  │ │  Diff / Review │  │  │
│  │  │Visualizer │ │   Panel    │ │     Panel      │  │  │
│  │  └──────────┘ └────────────┘ └────────────────┘  │  │
│  │  ┌──────────┐                                    │  │
│  │  │ Preview  │                                    │  │
│  │  │  Panel   │                                    │  │
│  │  └──────────┘                                    │  │
│  └───────────────────┬───────────────────────────────┘  │
│                      │ Tauri IPC (Commands, Channels,   │
│                      │           Events)                │
│  ┌───────────────────┴───────────────────────────────┐  │
│  │               Backend (Rust)                       │  │
│  │                                                   │  │
│  │  ┌──────────┐ ┌──────────┐ ┌──────────────────┐  │  │
│  │  │Recording │ │Automation│ │  Interaction     │  │  │
│  │  │ Engine   │ │ Engine   │ │  Recorder        │  │  │
│  │  └──────────┘ └──────────┘ └──────────────────┘  │  │
│  │  ┌──────────┐ ┌──────────┐ ┌──────────────────┐  │  │
│  │  │  Agent   │ │Animation │ │  Export          │  │  │
│  │  │  Engine  │ │ Engine   │ │  Engine          │  │  │
│  │  └──────────┘ └──────────┘ └──────────────────┘  │  │
│  │  ┌──────────┐ ┌──────────┐                       │  │
│  │  │Versioning│ │ Project  │                       │  │
│  │  │ Engine   │ │ Engine   │                       │  │
│  │  └──────────┘ └──────────┘                       │  │
│  └───────────────────────────────────────────────────┘  │
└──────────┬───────────┬───────────┬──────────────────────┘
           │           │           │
    ┌──────┴──┐  ┌─────┴────┐ ┌───┴──────────┐
    │ FFmpeg  │  │Playwright│ │ Python +     │
    │(sidecar)│  │(Node.js  │ │ ManimCE      │
    │         │  │ sidecar) │ │ (subprocess) │
    └─────────┘  └──────────┘ └──────────────┘
                                     │
                              ┌──────┴───────┐
                              │ Azure OpenAI │
                              │     API      │
                              └──────────────┘
```

---

## Frontend (React + TypeScript)

The UI is a single-window Tauri application with dockable/collapsible panels.

### Panels

| Panel | Purpose |
| ------- | --------- || **Sketch Editor** | Notion-style block editor (Lexical) for authoring demo plans before recording. Structured documents with titled sections containing 4-column planning tables (Time, Narrative Bullets, Demo Action Bullets, Screenshot). Slash commands, floating toolbar, version history via git. Multiple documents per project with lifecycle states (Sketch → RecordingEnriched → Refined → Final). || **Script Editor** | Table-based UI for authoring/viewing the script. Columns: Time, Narrative (rich text), Demo (action list), Screenshot. Supports drag-and-drop reordering, split/merge rows, inline action editing. |
| **Teleprompter** | Large-text display of the current segment's narrative during recording. Auto-advances with automation. Configurable font size, scroll speed, position. |
| **Preview** | Inline video player for recorded footage and rendered animations. Supports frame-by-frame scrubbing. |
| **Timeline Visualizer** | Read-only visual representation of the output package: segments on a timeline with video, audio, and animation tracks. Maps to the FCPXML structure. |
| **Diff / Review** | Side-by-side view of raw recording vs. agent-refined version. Per-item accept/reject/edit controls. |
| **Settings** | Audio device selection, output path, recording quality, LLM API configuration, hotkey configuration. |

### IPC with Backend

Tauri v2 provides three IPC mechanisms, used as follows:

| Mechanism | Use Case | Direction |
| ----------- | ---------- | ----------- |
| **Commands** | Discrete request/response: list audio devices, start recording, generate FCPXML, get project metadata | Frontend → Backend → Frontend |
| **Channels** | Streaming data: FFmpeg recording progress, manim render progress, interaction capture events, agent refinement progress | Backend → Frontend (continuous) |
| **Events** | Global state broadcasts: recording started/stopped, project saved, agent task completed | Backend → Frontend (broadcast) |

```typescript
// Example: Start recording with progress streaming
import { invoke, Channel } from '@tauri-apps/api/core';

interface RecordingProgress {
  frame: number;
  elapsed_secs: number;
  file_size_bytes: number;
}

const progress = new Channel<RecordingProgress>();
progress.onmessage = (msg) => updateProgressUI(msg);

await invoke('start_recording', {
  config: recordingConfig,
  channel: progress,
});
```

### Key Frontend Dependencies

| Package | Purpose |
| --------- | --------- |
| `@tauri-apps/api` | Core Tauri JS API (invoke, events, channels) |
| `@tauri-apps/plugin-*` | JS bindings for Tauri plugins (fs, dialog, shell, store, etc.) |
| React 19 + TypeScript | UI framework |
| `lexical` + `@lexical/react` | Block-based rich text editor (sketch documents, script editing) |
| `@lexical/rich-text` / `@lexical/list` / `@lexical/table` | Core Lexical plugins (rich text, lists, tables) |
| `@lexical/markdown` / `@lexical/history` | Markdown shortcuts, undo/redo history |
| TanStack Table | Script table with sorting, filtering, reordering |
| Monaco Editor / CodeMirror | Inline code editor for ManimCE code and raw JSON action editing |
| Zustand or Jotai | Lightweight state management |
| Tailwind CSS | Styling |

---

## Backend (Rust)

The backend is structured as a set of engines, each responsible for a distinct capability. Engines communicate through shared state and Tauri's event system.

### Module Structure

```text
src-tauri/
├── src/
│   ├── main.rs                    # Tauri app setup, plugin registration
│   ├── commands/                  # Tauri command handlers (thin layer)
│   │   ├── recording.rs
│   │   ├── automation.rs
│   │   ├── interaction.rs
│   │   ├── agent.rs
│   │   ├── animation.rs
│   │   ├── export.rs
│   │   ├── document.rs              # CRUD for sketch documents
│   │   └── versioning.rs            # Git commit, log, diff, restore
│   ├── engine/
│   │   ├── recording.rs           # FFmpeg process management
│   │   ├── automation.rs          # Action execution (browser + native)
│   │   ├── interaction.rs         # Interaction recording / capture
│   │   ├── agent/                 # LLM-powered refinement pipeline
│   │   │   ├── mod.rs
│   │   │   ├── cleanup.rs         # Action deduplication, path optimization
│   │   │   ├── narrative.rs       # Voiceover generation
│   │   │   ├── selectors.rs       # Selector stabilization
│   │   │   ├── animations.rs      # Animation suggestion + code gen
│   │   │   └── healing.rs         # Runtime self-heal during replay
│   │   ├── animation.rs           # ManimCE subprocess management
│   │   ├── versioning.rs          # Git operations via gix (init, commit, log, diff, restore)
│   │   └── export.rs              # FCPXML generation, folder assembly
│   ├── models/                    # Core data types
│   │   ├── action.rs              # Action enum, SelectorStrategy
│   │   ├── script.rs              # Project, Script, ScriptRow
│   │   ├── document.rs            # Document, DocumentSection, DocumentState
│   │   ├── recording.rs           # Recording metadata
│   │   ├── animation.rs           # Animation spec + render state
│   │   └── session.rs             # RecordedSession, CapturedAction
│   ├── llm/                       # LLM provider abstraction
│   │   ├── mod.rs                 # LlmProvider trait
│   │   ├── azure_openai.rs        # Azure OpenAI implementation
│   │   └── types.rs               # Shared LLM request/response types
│   └── util/
│       ├── ffmpeg.rs              # FFmpeg command builder + progress parser
│       ├── screenshot.rs          # Screen capture utilities
│       └── audio.rs               # Audio device enumeration
├── Cargo.toml
├── tauri.conf.json
└── binaries/                      # Sidecar binaries
    ├── ffmpeg-x86_64-pc-windows-msvc.exe
    └── playwright-sidecar/        # Node.js Playwright bridge
        ├── index.js
        └── package.json
```

---

## Core Data Model

### Action Model

The `Action` enum is the fundamental abstraction — it represents a single atomic step in a demo. Both the interaction recorder and the automation engine operate on Actions.

```rust
/// A single atomic demo step.
enum Action {
    // ── Browser Actions ──
    BrowserNavigate {
        url: String,
    },
    BrowserClick {
        selectors: Vec<SelectorStrategy>,
    },
    BrowserType {
        selectors: Vec<SelectorStrategy>,
        text: String,
        clear_first: bool,
    },
    BrowserSelect {
        selectors: Vec<SelectorStrategy>,
        value: String,
    },
    BrowserScroll {
        direction: ScrollDirection,
        amount: i32,
    },
    BrowserWaitForElement {
        selectors: Vec<SelectorStrategy>,
        timeout_ms: u64,
    },

    // ── Native App Actions ──
    NativeLaunch {
        executable: String,
        args: Vec<String>,
    },
    NativeClick {
        selectors: Vec<SelectorStrategy>,
    },
    NativeType {
        text: String,
    },
    NativeSelect {
        selectors: Vec<SelectorStrategy>,
        value: String,
    },
    NativeInvoke {
        selectors: Vec<SelectorStrategy>,
    },

    // ── Common Actions ──
    Wait {
        duration_ms: u64,
    },
    Screenshot {
        region: Option<ScreenRegion>,
        output_path: PathBuf,
    },
    Annotation {
        text: String, // Human-readable note, not executed
    },
}

/// Selector targeting strategies, ordered by priority during replay.
enum SelectorStrategy {
    CssSelector(String),
    XPath(String),
    AccessibilityId(String),
    AccessibilityName(String),
    DataTestId(String),
    TextContent(String),
    UiaTreePath(Vec<UiaPathSegment>),
}

/// Metadata attached to every action after recording.
struct ActionMetadata {
    captured_screenshot: Option<PathBuf>,
    selector_strategies: Vec<SelectorStrategy>,
    timestamp_ms: u64,
    confidence: f32,           // How confident the recorder is in the captured target
    context_snapshot: Option<String>, // DOM snippet or UIA subtree JSON
}
```

### Script Model

```rust
struct Project {
    id: Uuid,
    name: String,
    settings: ProjectSettings,
    script: Script,
    recordings: Vec<Recording>,
    animations: Vec<Animation>,
    created_at: DateTime<Utc>,
    updated_at: DateTime<Utc>,
}

struct Script {
    rows: Vec<ScriptRow>,
}

struct ScriptRow {
    id: Uuid,
    time: Duration,           // Segment duration
    narrative: String,        // Voiceover text (Markdown)
    actions: Vec<Action>,     // Ordered demo steps
    screenshot: Option<PathBuf>,
    metadata: RowMetadata,    // Source (recorded/manual/agent), refinement state
}
```

### Document Model

Documents are the primary authoring artifact in CutReady. Each project contains multiple documents that progress through lifecycle states. Document content is stored as Lexical editor JSON state, and all changes are versioned via git (gix).

```rust
/// A sketch/planning document within a project.
struct Document {
    id: Uuid,
    title: String,
    description: String,
    sections: Vec<DocumentSection>,
    content: serde_json::Value,  // Lexical editor JSON state
    state: DocumentState,
    created_at: DateTime<Utc>,
    updated_at: DateTime<Utc>,
}

/// A named section within a document, containing planning tables.
struct DocumentSection {
    id: Uuid,
    title: String,
    table: Option<PlanningTable>,
}

/// The 4-column planning table used in sketch documents.
struct PlanningTable {
    rows: Vec<PlanningRow>,
}

struct PlanningRow {
    id: Uuid,
    time: Option<String>,           // Estimated duration
    narrative_bullets: Vec<String>,  // Voiceover talking points
    demo_action_bullets: Vec<String>,// What to demonstrate
    screenshot: Option<PathBuf>,     // Reference screenshot
}

/// Document lifecycle states.
enum DocumentState {
    Sketch,              // Initial authoring — user-written plan
    RecordingEnriched,   // After recording enriches with captured data
    Refined,             // After agent refinement pass
    Final,               // Locked for production
}

/// Lightweight summary for listing documents without loading full content.
struct DocumentSummary {
    id: Uuid,
    title: String,
    state: DocumentState,
    updated_at: DateTime<Utc>,
}
```

### Project Storage

Projects are stored as git-backed directories. Each project lives in `projects/{uuid}/` with the following structure:

```text
projects/{uuid}/
├── project.json              # Project metadata, settings
├── documents/
│   ├── {doc-uuid-1}.json     # Document content (Lexical JSON state)
│   └── {doc-uuid-2}.json
├── screenshots/
│   ├── {uuid}.png
│   └── ...
├── recordings/               # Recording metadata + media paths
├── animations/               # Rendered animation files
└── .git/                     # gix-managed version history
```

All changes (document edits, screenshot additions, setting changes) are committed automatically. Users can browse the commit timeline, preview any version, diff between versions, and restore previous states.

```rust
struct Recording {
    id: Uuid,
    video_path: PathBuf,
    narration_path: Option<PathBuf>,
    system_audio_path: Option<PathBuf>,
    duration: Duration,
    tracks: Vec<TrackInfo>,
}

struct Animation {
    id: Uuid,
    name: String,
    description: String,      // Natural language description
    source_code: String,      // ManimCE Python code
    rendered_path: Option<PathBuf>,
    duration: Option<Duration>,
}
```

### Recorded Session Model

```rust
/// Raw output from the interaction recorder.
struct RecordedSession {
    id: Uuid,
    mode: RecordingMode,      // FreeForm or StepByStep
    started_at: DateTime<Utc>,
    actions: Vec<CapturedAction>,
}

enum RecordingMode {
    FreeForm,
    StepByStep,
}

/// A single captured interaction with full context.
struct CapturedAction {
    action: Action,
    metadata: ActionMetadata,
    raw_event: Option<RawEvent>, // Low-level event data for debugging
}
```

---

## Engine Details

### 1. Interaction Recorder

Captures user interactions during a demo walkthrough.

**Browser capture** (via Playwright sidecar):

- Launches a Playwright-controlled browser in **observation mode** (headful, user-driven — Playwright watches but doesn't drive).
- Listens via CDP (Chrome DevTools Protocol) for:
  - `Input.dispatchMouseEvent` — clicks
  - `Input.dispatchKeyEvent` — keystrokes
  - `Page.navigatedWithinDocument`, `Page.frameNavigated` — navigations
- Simultaneously injects a lightweight JS observer via `page.exposeFunction` for DOM-level detail: the exact element clicked, its attributes, surrounding DOM context.
- Maps CDP events + DOM context → `Action` variants with multiple `SelectorStrategy` entries.

**Native app capture** (via windows-rs):

- Uses `SetWinEventHook` from `Win32_UI_Accessibility` to listen for UI Automation events: focus changes, invocations, value changes, structure changes.
- Supplements with low-level input hooks via `SetWindowsHookEx`:
  - `WH_MOUSE_LL` — mouse clicks, position
  - `WH_KEYBOARD_LL` — keystrokes
- Correlates raw input events with the focused UIA element to determine the target.
- Queries the UIA tree for element properties (AutomationId, Name, ControlType, bounding rect) to build `SelectorStrategy` entries.
- Captures a UIA subtree snapshot around the interacted element for agent context.

**Screenshot capture**:

- On each recorded interaction, captures a screenshot via Windows `BitBlt` API or a single-frame FFmpeg `gdigrab` capture.
- Stores as PNG alongside the action metadata.

```rust
// Core dependencies for native interaction capture
// Cargo.toml
[dependencies.windows]
version = "0.62"
features = [
    "Win32_UI_Accessibility",
    "Win32_UI_WindowsAndMessaging",
    "Win32_UI_Input_KeyboardAndMouse",
    "Win32_Graphics_Gdi",
]
```

### 2. Recording Engine

Manages FFmpeg for lossless screen + audio capture.

**FFmpeg command construction**:

```bash
# Full recording: screen + mic + system audio as separate tracks
ffmpeg ^
  -f gdigrab -framerate 30 -i desktop ^
  -f dshow -i audio="Microphone (USB Audio)" ^
  -f dshow -i audio="Stereo Mix (Realtek)" ^
  -map 0:v -map 1:a -map 2:a ^
  -c:v ffv1 -level 3 -slices 12 -slicecrc 1 ^
  -c:a:0 pcm_s16le ^
  -c:a:1 pcm_s16le ^
  -metadata:s:a:0 title="Narration" ^
  -metadata:s:a:1 title="System Audio" ^
  output.mkv
```

**Process lifecycle** (Rust):

```rust
#[tauri::command]
async fn start_recording(
    config: RecordingConfig,
    channel: tauri::ipc::Channel<RecordingProgress>,
    state: tauri::State<'_, AppState>,
) -> Result<(), String> {
    let args = build_ffmpeg_args(&config);
    let mut child = tokio::process::Command::new("ffmpeg")
        .args(&args)
        .stdin(Stdio::piped())
        .stderr(Stdio::piped())
        .spawn()
        .map_err(|e| e.to_string())?;

    // Store handle for stop command
    state.set_recording_process(child.id());

    // Parse stderr for progress, stream to frontend
    let stderr = child.stderr.take().unwrap();
    let reader = BufReader::new(stderr);
    tokio::spawn(async move {
        // Parse "frame=", "time=", "size=" lines
        // Send updates via channel.send(...)
    });

    Ok(())
}

#[tauri::command]
async fn stop_recording(state: tauri::State<'_, AppState>) -> Result<RecordingResult, String> {
    // Send 'q' to FFmpeg stdin to gracefully stop
    state.send_to_recording_stdin(b"q").await?;
    // Wait for process exit, return file paths + metadata
    Ok(recording_result)
}
```

**Sidecar bundling**: `ffmpeg.exe` is bundled as a Tauri sidecar binary. Declared in `tauri.conf.json`:

```json
{
  "bundle": {
    "externalBin": ["binaries/ffmpeg"]
  }
}
```

### 3. Automation Engine

Executes Action sequences to replay a demo.

**Browser actions** → dispatched to the Playwright Node.js sidecar over JSON stdin/stdout:

```text
CutReady Backend (Rust)
    │
    ├── spawn Node.js sidecar process
    ├── stdin  → JSON action commands
    └── stdout ← JSON results / events
```

Sidecar protocol (JSON-RPC-like):

```json
// → Request
{ "id": 1, "method": "browser.click", "params": { "selectors": ["#submit-btn", "[aria-label='Submit']"] } }

// ← Response
{ "id": 1, "result": { "success": true, "matched_selector": "#submit-btn" } }
```

**Native actions** → executed directly in Rust via `windows-rs` UI Automation:

```rust
use windows::Win32::UI::Accessibility::*;

fn native_click(selectors: &[SelectorStrategy]) -> Result<()> {
    let automation: IUIAutomation = CoCreateInstance(
        &CUIAutomation, None, CLSCTX_INPROC_SERVER
    )?;
    let root = automation.GetRootElement()?;

    // Try each selector strategy in priority order
    for selector in selectors {
        if let Some(element) = find_element(&automation, &root, selector)? {
            let invoke: IInvokeProvider = element.GetCurrentPattern(UIA_InvokePatternId)?;
            invoke.Invoke()?;
            return Ok(());
        }
    }

    Err(AutomationError::ElementNotFound)
}
```

**Self-healing** (on action failure):

1. Capture current page/app state (DOM snapshot or UIA tree).
2. Send to LLM with the original action context: _"This action targeted `#submit-btn` but the element wasn't found. Here's the current DOM. What's the most likely matching element?"_
3. LLM returns a suggested alternative selector.
4. Retry with the new selector.
5. If successful, update the action's selector strategies for future replays.

### 4. Agent Engine

LLM-powered refinement pipeline. Operates on a `RecordedSession` and produces a `RefinedScript`.

**Architecture**:

```rust
/// Pluggable LLM provider.
#[async_trait]
trait LlmProvider: Send + Sync {
    async fn complete(&self, messages: &[Message]) -> Result<String>;
    async fn complete_structured<T: DeserializeOwned>(
        &self, messages: &[Message], schema: &JsonSchema
    ) -> Result<T>;
}

/// Azure OpenAI implementation.
struct AzureOpenAiProvider {
    endpoint: String,
    api_key: String,
    deployment: String,
    client: reqwest::Client,
}

#[async_trait]
impl LlmProvider for AzureOpenAiProvider {
    async fn complete(&self, messages: &[Message]) -> Result<String> {
        // POST to /openai/deployments/{deployment}/chat/completions
        // with api-version=2024-10-21
    }

    async fn complete_structured<T: DeserializeOwned>(
        &self, messages: &[Message], schema: &JsonSchema
    ) -> Result<T> {
        // Same endpoint with response_format: { type: "json_schema", ... }
    }
}
```

**Refinement pipeline modules**:

| Module | Input | Output | LLM Usage |
| -------- | ------- | -------- | ----------- |
| `cleanup` | `Vec<CapturedAction>` | `Vec<Action>` (cleaned) | Classifies actions as intentional/accidental/redundant |
| `selectors` | `Vec<Action>` + context snapshots | `Vec<Action>` (upgraded selectors) | Analyzes DOM/UIA context to suggest stable selectors |
| `narrative` | `Vec<Action>` + screenshots | `Vec<NarrativeSegment>` | Generates voiceover text per segment |
| `animations` | `Vec<Action>` + screenshots | `Vec<AnimationSuggestion>` | Identifies concepts, generates ManimCE code |
| `healing` | Failed `Action` + current page state | `Option<Action>` (fixed) | Finds alternative targets in current state |

**Structured output**: All LLM calls use JSON structured output (response_format) so results parse reliably into Rust types.

### 5. Animation Engine

Manages ManimCE Python subprocess for rendering animations.

```rust
async fn render_animation(
    source_code: &str,
    scene_name: &str,
    output_dir: &Path,
    quality: Quality,
    channel: &tauri::ipc::Channel<RenderProgress>,
) -> Result<PathBuf> {
    // 1. Write source to temp file
    let script_path = output_dir.join("scene.py");
    tokio::fs::write(&script_path, source_code).await?;

    // 2. Spawn manim
    let quality_flag = match quality {
        Quality::Low => "-ql",
        Quality::Medium => "-qm",
        Quality::High => "-qh",
        Quality::UltraHigh => "-qk",
    };

    let mut child = tokio::process::Command::new("manim")
        .args(&["render", quality_flag, "--format", "mp4",
                "-o", "output.mp4",
                script_path.to_str().unwrap(), scene_name])
        .stderr(Stdio::piped())
        .spawn()?;

    // 3. Stream progress from stderr
    // 4. Return path to rendered video
    Ok(output_dir.join("output.mp4"))
}
```

**Sandboxing**: Before writing the script file, validate the Python AST:

- Only allow `from manim import *` and standard library imports.
- Block `os`, `subprocess`, `sys`, `shutil`, `pathlib` (write operations), network libraries.
- Enforce a render timeout (default: 5 minutes).

### 6. Export Engine

Generates the final output package.

**FCPXML generation** (via `quick-xml` crate):

```rust
use quick_xml::Writer;
use quick_xml::events::{Event, BytesStart, BytesEnd, BytesText};

fn generate_fcpxml(project: &Project, output_dir: &Path) -> Result<String> {
    let mut writer = Writer::new(Cursor::new(Vec::new()));

    // Write XML declaration + DOCTYPE
    // Write <fcpxml version="1.9">
    //   <resources> — format, asset declarations
    //   <library>
    //     <event>
    //       <project>
    //         <sequence>
    //           <spine> — video clips at segment boundaries
    //           <spine lane="1"> — narration audio
    //           <spine lane="2"> — system audio (optional)
    //           <spine lane="3"> — animation clips
    //           Markers at each segment boundary

    Ok(String::from_utf8(writer.into_inner().into_inner())?)
}
```

### 7. Versioning Engine

Manages document version history via git, using the `gix` (gitoxide) crate for pure-Rust git operations with no C/cmake dependencies.

**Core operations**:

```rust
use gix::Repository;

/// Initialize a git repository for a new project.
fn init_project_repo(project_dir: &Path) -> Result<()> {
    gix::init(project_dir)?;
    Ok(())
}

/// Commit all current changes with an auto-generated message.
fn commit_snapshot(
    repo: &Repository,
    message: &str,
) -> Result<gix::ObjectId> {
    // Stage all changes (documents, screenshots, settings)
    // Create commit with timestamp
    // Return commit hash
}

/// List all commits in reverse chronological order.
fn list_versions(repo: &Repository) -> Result<Vec<VersionEntry>> {
    // Walk the commit graph
    // Return commit hash, message, timestamp, changed files
}

/// Get the content of a specific file at a given commit.
fn get_version(
    repo: &Repository,
    commit_id: &gix::ObjectId,
    file_path: &str,
) -> Result<Vec<u8>> {
    // Resolve tree → blob for the given path
}

/// Diff two commits for a specific file.
fn diff_versions(
    repo: &Repository,
    from: &gix::ObjectId,
    to: &gix::ObjectId,
    file_path: &str,
) -> Result<String> {
    // Compute unified diff between two blob versions
}

/// Restore a file to a previous version by checking out from a commit.
fn restore_version(
    repo: &Repository,
    commit_id: &gix::ObjectId,
    file_path: &str,
    working_dir: &Path,
) -> Result<()> {
    // Read blob at commit, write to working directory
    // Auto-commit the restore as a new version
}
```

**Design notes**:

- Commits are created automatically on every document save, not manually by the user.
- Commit messages are auto-generated with context: _"Update document 'API Walkthrough' — edited section 'Setup'"_.
- The version history UI presents commits as a navigable timeline, not a raw git log.
- `gix` is chosen over `git2-rs` (libgit2 bindings) to avoid cmake and C toolchain dependencies on Windows.

---

## Technology Stack

| Layer | Technology | Version | Rationale |
| ------- | ----------- | --------- | ----------- |
| Desktop framework | Tauri | v2 | Small binary, Rust backend, web UI, native OS access |
| Frontend | React + TypeScript | React 19 | Largest ecosystem, rich component libraries |
| Backend | Rust | 2021 edition | Memory safety, async, native Windows API access |
| Screen recording | FFmpeg (FFV1 / MKV) | 7.x | Lossless, industry standard, multi-track |
| Browser automation | Playwright (Node.js sidecar) | Latest | Cross-browser, headful mode, mature API, CDP access |
| Native automation | windows-rs + UIAutomation | 0.62 | Zero external deps, direct OS integration |
| Motion graphics | ManimCE (Python) | Latest | Programmatic animation, headless Cairo renderer, active community |
| LLM | Azure OpenAI API (pluggable) | 2024-10-21 | Fast to start, enterprise-grade, structured output, swappable |
| Rich text editor | Lexical (Meta) | 0.40+ | Immutable state model, extensible node system, React 19 compatible, MIT license |
| Document versioning | gix (gitoxide) | Latest | Pure-Rust git implementation, no C/cmake deps, commit/log/diff/restore |
| Timeline export | FCPXML 1.9 | — | Multi-track, markers, native DaVinci Resolve 17+ import |
| Project storage | Git-backed directories (gix) | — | Version-controlled, browsable history, diffable, no DB dependency |

### Key Rust Crates

| Crate | Purpose |
| ------- | --------- |
| `tauri` | App framework |
| `tokio` | Async runtime (process management, I/O) |
| `serde` / `serde_json` | Serialization for IPC, project files, LLM communication |
| `reqwest` | HTTP client for Azure OpenAI API |
| `quick-xml` | FCPXML generation |
| `uuid` | Unique IDs for projects, rows, recordings |
| `chrono` | Timestamps |
| `windows` | Native Windows API access (UI Automation, input hooks, GDI) |
| `gix` | Git operations (versioning, commit history, diff, restore) |
| `anyhow` / `thiserror` | Error handling |
| `tracing` | Structured logging |

### Tauri Plugins

| Plugin | Purpose |
| -------- | --------- |
| `tauri-plugin-shell` | Spawn FFmpeg, Playwright sidecar, Python/manim |
| `tauri-plugin-fs` | Read/write project files, temp files, output media |
| `tauri-plugin-dialog` | Open/save file dialogs for projects and exports |
| `tauri-plugin-store` | Persist user preferences (output paths, quality, API keys) |
| `tauri-plugin-notification` | Notify when recording/rendering completes |
| `tauri-plugin-global-shortcut` | Hotkeys for start/stop recording |
| `tauri-plugin-window-state` | Persist window size/position |
| `tauri-plugin-log` | Structured logging across Rust + frontend |
| `tauri-plugin-single-instance` | Prevent multiple app instances |
| `tauri-plugin-process` | App restart, exit handling |
| `tauri-plugin-updater` | Auto-update the app |

---

## Build & Distribution

### Sidecar Binaries

| Binary | Source | Bundled As |
| -------- | -------- | ----------- |
| `ffmpeg.exe` | [gyan.dev static build](https://www.gyan.dev/ffmpeg/builds/) or [BtbN builds](https://github.com/BtbN/FFmpeg-Builds) | Tauri external binary |
| Playwright sidecar | Custom Node.js script (bundled with `pkg` or `node` + script) | Tauri external binary |

### Optional Dependencies (User-Installed)

| Dependency | Required For | Install Method |
| ----------- | ------------- | --------------- |
| Python 3.9+ | Motion animations | System install or embedded Python |
| ManimCE | Motion animations | `pip install manim` |
| LaTeX (MiKTeX) | Math text in animations | MiKTeX installer |
| Virtual audio device | System audio capture | VB-CABLE / VoiceMeeter |

### Installer

Tauri bundler produces a Windows NSIS installer (`.exe`) or MSI:

- Installs the app + sidecar binaries.
- Registers file associations for `.cutready` project files.
- Optional: bundled Python + ManimCE for zero-config animation support.

---

## Security Considerations

| Concern | Mitigation |
| --------- | ----------- |
| LLM-generated Python code execution | AST validation, restricted imports, render timeout, user confirmation before execution |
| API key storage | Tauri plugin-store with OS keychain integration (Windows Credential Manager) |
| FFmpeg process management | Graceful shutdown via stdin `q`; kill on app exit; no user-controlled command injection |
| Playwright browser automation | Isolated browser profile; no access to user's default browser data |
| Windows input hooks | Hooks only active during interaction recording sessions; clearly indicated in UI |
| FCPXML file generation | Template-based XML generation via `quick-xml`; no user-controlled raw XML injection |

---

## Future Architecture Considerations

- **Copilot SDK integration**: The `LlmProvider` trait is designed to accommodate a GitHub Copilot SDK backend alongside Azure OpenAI. Auth flow differences are encapsulated in the provider implementation.
- **macOS support**: Tauri is cross-platform. The native automation layer would swap `windows-rs` for macOS Accessibility APIs (`accessibility` frameworks via `objc2` crate). FFmpeg and Playwright work unchanged.
- **Collaborative editing**: If needed, Lexical’s immutable state model pairs well with CRDT-based merging (e.g., Automerge/Yjs) or a real-time sync protocol. The git-backed storage could layer on top of CRDTs for offline support.
- **Plugin architecture**: The engine module structure supports extracting engines into Tauri plugins for modularity and third-party extension.
- **Document versioning extensions**: The gix-based versioning engine could support branching (e.g., “alternative script take”) and merging, leveraging git’s native capabilities. Semantic diffing of Lexical JSON state (rather than raw text diff) is a future enhancement.
