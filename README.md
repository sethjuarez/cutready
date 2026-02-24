# CutReady

**From Script to Screen in One Click.**

CutReady is a desktop application that turns rough demo walkthroughs into production-ready video packages. Record a demo, let an AI agent refine it, replay it perfectly, and export an edit-ready package for DaVinci Resolve.

Built with [Tauri v2](https://tauri.app/) (Rust + React/TypeScript).

## How It Works

1. **Record** — Walk through the demo in a browser or native app. CutReady captures every interaction.
2. **Refine** — An AI agent cleans the action sequence, generates narration, stabilizes selectors, and suggests animations.
3. **Review** — Edit the script table. Accept, tweak, or re-record individual steps.
4. **Produce** — Automation replays the demo while you read the teleprompter. Lossless video + clean audio captured.
5. **Export** — Organized folder + FCPXML timeline, ready for DaVinci Resolve.

## Documentation

| Document | Description |
| ---------- | ------------- |
| [North Star](docs/NORTH_STAR.md) | The press release — the vision and "why" for CutReady |
| [Feature Guidance](docs/GUIDANCE.md) | Everything CutReady can do, organized by workflow phase |
| [Architecture](docs/ARCHITECTURE.md) | Technical design: Tauri, Rust backend, React frontend, engines, data model |

## Tech Stack

| Component | Technology |
| ----------- | ----------- |
| Desktop framework | Tauri v2 |
| Frontend | React + TypeScript |
| Backend | Rust |
| Screen recording | FFmpeg (FFV1 lossless in MKV) |
| Browser automation | Playwright (Node.js sidecar) |
| Native app automation | windows-rs + UI Automation |
| Motion graphics | ManimCE (Community Edition) |
| LLM | Azure OpenAI API (pluggable) |
| Video editor export | FCPXML 1.9 → DaVinci Resolve |

## Status

🚧 **Early design phase** — North star documentation in place, implementation not yet started.
