# CutReady — Copilot Project Instructions

## What Is CutReady

CutReady is a **desktop application** that collapses the entire product demo video production process into a single intelligent workflow. The user sketches a structured demo plan in a Notion-style editor, optionally records a rough demo walkthrough guided by the plan, an AI agent refines it into a production-ready script, then automation replays the polished demo while the user reads a teleprompter. Output is an organized folder with lossless video, clean audio, and an FCPXML timeline ready for DaVinci Resolve.

## Core Philosophy

- **Sketch-first**: The promoted primary entry point is authoring a structured plan (sketch document) with sections, planning tables, and reference screenshots. The sketch guides the recording and evolves through the workflow.
- **Record-first (alternative)**: Users can also jump straight into recording without a sketch. The script is an _output_ of recording + AI refinement, not just an input.
- **Agentic refinement**: The AI doesn't just transcribe. It cleans accidental clicks, stabilizes selectors, drafts narration, estimates timing, and suggests motion animations.
- **Self-healing replay**: When UI changes break a replay action, the agent inspects the current state and auto-heals the selector.
- **Edit-ready output**: Not just footage. An FCPXML 1.9 timeline with video, narration, system audio, and animations on separate tracks.

## Workflow Phases

0. **Sketch** — Plan the demo in a Notion-style block editor (Lexical). Structured sections with 4-column planning tables. Reference screenshots captured from browser. Automatic version history via git (gix).
1. **Record** — Walk through the demo (browser or native app), guided by the sketch. CutReady captures every interaction as a replayable action sequence with screenshots.
2. **Refine** — AI agent cleans actions, stabilizes selectors, generates voiceover narration, estimates timing, suggests animations.
3. **Review & Edit** — Side-by-side diff of raw vs. refined. Script table with Time, Narrative, Demo Actions, Screenshot columns. Full editing.
4. **Produce** — Automation replays the demo. Teleprompter displays narration. Lossless FFmpeg recording captures video + audio as separate tracks.
5. **Export** — Organized folder + FCPXML timeline for DaVinci Resolve.

## Tech Stack

| Layer               | Technology                       | Notes                                                |
| ------------------- | -------------------------------- | ---------------------------------------------------- |
| Desktop framework   | **Tauri v2**                     | Frameless window, Rust backend, web frontend         |
| Frontend            | **React 19 + TypeScript**        | Vite 6 bundler, Tailwind CSS 3.4                     |
| Backend             | **Rust** (2021 edition)          | Async via Tokio, native Windows API via windows-rs   |
| Rich text editor    | **Lexical** (Meta)               | Block editor for sketch documents, extensible nodes  |
| Document versioning | **gix** (gitoxide)               | Pure-Rust git: commit, log, diff, restore            |
| Screen recording    | **FFmpeg** (sidecar)             | FFV1 lossless codec in MKV, multi-track audio        |
| Browser automation  | **Playwright** (Node.js sidecar) | Headful mode, CDP event observation for recording    |
| Native automation   | **windows-rs + UI Automation**   | SetWinEventHook, input hooks, UIA tree queries       |
| Motion graphics     | **ManimCE** (Python subprocess)  | Sandboxed execution, AST validation                  |
| LLM                 | **Azure OpenAI** (pluggable)     | LlmProvider trait allows swapping providers          |
| Timeline export     | **FCPXML 1.9**                   | Multi-track, markers, DaVinci Resolve 17+ compatible |
| Project storage     | **Git-backed directories**       | Per-project dirs with .git, JSON docs, screenshots   |

## Project Structure

```text
cutready/
├── docs/                          # North star documentation
│   ├── NORTH_STAR.md              # Press release (the vision)
│   ├── GUIDANCE.md                # Feature catalog by workflow phase
│   ├── ARCHITECTURE.md            # Full technical design
│   └── IMPLEMENTATION_PLAN.md     # Phased implementation plan
├── src/                           # React + TypeScript frontend
│   ├── main.tsx                   # Entry point (loads Geist Sans font)
│   ├── index.css                  # CSS variables, theme tokens, global styles
│   ├── App.tsx                    # Root component
│   ├── hooks/
│   │   ├── useTheme.ts            # Light/dark/system theme management
│   │   ├── useSettings.ts         # Settings persistence
│   │   └── useGlobalHotkeys.ts    # Global keyboard shortcuts
│   ├── stores/
│   │   └── appStore.ts            # Zustand app state (navigation, project)
│   ├── types/
│   │   ├── project.ts             # Project, Document types
│   │   └── recording.ts           # Recording types
│   └── components/
│       ├── TitleBar.tsx            # Frameless window title bar + window controls
│       ├── StatusBar.tsx           # Bottom bar with status + theme toggle
│       ├── Sidebar.tsx             # Navigation sidebar
│       ├── AppLayout.tsx           # Main layout shell
│       ├── HomePanel.tsx           # Project home / dashboard
│       ├── SettingsPanel.tsx       # Settings management
│       ├── ScriptEditorPanel.tsx   # Script table editor
│       ├── RecordingPanel.tsx      # Recording controls
│       └── ActionCard.tsx          # Action display component
├── src-tauri/                     # Rust / Tauri backend
│   ├── Cargo.toml
│   ├── tauri.conf.json            # Tauri config (frameless, 1280×800, shadow)
│   ├── src/
│   │   ├── main.rs
│   │   ├── lib.rs                 # Tauri commands + plugin registration
│   │   ├── commands/              # Tauri command handlers (thin layer)
│   │   │   ├── recording.rs
│   │   │   ├── automation.rs
│   │   │   ├── interaction.rs
│   │   │   ├── agent.rs
│   │   │   ├── animation.rs
│   │   │   ├── export.rs
│   │   │   ├── project.rs
│   │   │   ├── document.rs        # CRUD for sketch documents (planned)
│   │   │   └── versioning.rs      # Git operations (planned)
│   │   ├── engine/                # Backend engines
│   │   │   ├── recording.rs
│   │   │   ├── automation.rs
│   │   │   ├── interaction.rs
│   │   │   ├── animation.rs
│   │   │   ├── export.rs
│   │   │   ├── project.rs
│   │   │   ├── versioning.rs      # Git via gix (planned)
│   │   │   └── agent/
│   │   ├── models/
│   │   │   ├── action.rs
│   │   │   ├── script.rs
│   │   │   ├── document.rs        # Document, DocumentState (planned)
│   │   │   ├── recording.rs
│   │   │   ├── animation.rs
│   │   │   └── session.rs
│   │   ├── llm/
│   │   └── util/
│   └── capabilities/default.json
├── tailwind.config.ts             # Tailwind with custom color/font tokens
├── vite.config.ts                 # Vite dev server on port 1420
├── package.json
└── README.md
```

## Current Status

The project is in **active development**:

- North star documents are complete (NORTH_STAR.md, GUIDANCE.md, ARCHITECTURE.md, IMPLEMENTATION_PLAN.md)
- Tauri v2 app scaffolded with frameless window, dark/light/system theme, title bar, status bar
- Sidebar navigation, home panel, settings panel, and app store (Zustand) implemented
- Implementation Phase 0 (project scaffold) and Phase 1 (app shell + navigation) complete
- **Next: Implementation Phase 2** — Script Sketch Editor & Document Versioning (Lexical + gix)
- Backend engines are placeholder modules — no recording, automation, agent, or export functionality yet

## Design Decisions Already Made

- **Frameless window**: `decorations: false` with custom TitleBar component (drag region + window controls)
- **Theme**: CSS custom properties in `:root` / `.dark`, toggled by adding `.dark` class to `<html>`. Uses `localStorage` key `cutready-theme`. Three modes: light, dark, system.
- **Color palette**: Warm, soft tones (not cold zinc). Dark mode uses warm browns (#2b2926), light mode uses warm off-whites (#faf9f7). Inspired by Claude desktop app's warm aesthetic.
- **Font**: Geist Sans via `@fontsource/geist-sans` (weights 400, 500, 600). Letter-spacing: -0.011em.
- **Color architecture**: All colors flow through CSS variables (`--color-surface`, `--color-surface-alt`, `--color-accent`, `--color-border`, `--color-text`, `--color-text-secondary`). Components use `var(--color-*)` or Tailwind tokens (`bg-surface`, `text-accent`) instead of hardcoded color classes. This makes palette changes a single-file edit in index.css.
- **Accent color**: Soft purple/violet in both modes (light: #6b5ce7, dark: #a49afa).
- **IPC pattern**: Tauri Commands for request/response, Channels for streaming data, Events for broadcasts.
- **LLM abstraction**: Pluggable `LlmProvider` trait — Azure OpenAI is the default, but the trait allows swapping to other providers.

## Key Documentation

For detailed information, read these docs:

- [docs/NORTH_STAR.md](docs/NORTH_STAR.md) — The press release / vision
- [docs/GUIDANCE.md](docs/GUIDANCE.md) — Complete feature catalog (what CutReady can do)
- [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md) — Technical design (engines, data models, Rust module structure, IPC patterns, sidecar architecture)

