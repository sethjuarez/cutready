# CutReady Documentation — Table of Contents

> **Purpose**: Skeleton for a cloud agent to flesh out. Each bullet is a page or section.
> Existing pages that need updates are marked with ✏️. New pages are marked with 🆕.

---

## 1. Landing / Welcome

- ✏️ `index.mdx` — Splash page (hero, tagline, feature highlights)
- ✏️ `welcome.mdx` — What is CutReady, who is it for, high-level value prop

## 2. Getting Started

- ✏️ `getting-started/installation.mdx` — Download, prerequisites (Rust, Node, Tauri v2), platform notes (Windows/macOS/Linux)
- ✏️ `getting-started/quick-start.mdx` — Create your first project, add a sketch, add notes, preview
- 🆕 `getting-started/projects.mdx` — Creating / opening / switching projects, `.cutready/` folder structure, `project.json`

## 3. Core Features

### 3.1 Sketches & Planning

- ✏️ `features/sketch-editor.mdx` — Sketch editor overview
  - Creating a sketch, naming, description
  - Planning table: columns (Step, Visual, Script, Duration)
  - Adding / reordering / deleting rows
  - Inline editing and cell-level interactions
  - Markdown support in cells
  - Screenshot field and thumbnail previews

### 3.2 AI-Assisted Editing

- 🆕 `features/ai-assistant.mdx` — The AI chat + assistant
  - Chat panel: sending messages, streaming responses, message history
  - Tool calls: how the AI reads/modifies sketches (compact display, expand to see details)
  - Agent selector: choosing between AI models/agents
  - Activity panel: real-time log of AI actions (newest-on-top, color-coded errors/warnings)
  - Session persistence: chat history saved per project
- 🆕 `features/sparkle-buttons.mdx` — One-click AI improvements
  - Sparkle (✨) buttons on title, description, and individual table cells
  - How it works: silent prompts, scoped updates (field-level, not whole-sketch)
  - Activity panel shows sparkle actions (not cluttering chat)

### 3.3 Notes & Document Import

- ✏️ `features/notes-markdown.mdx` — Notes system
  - Creating / editing markdown notes
  - Syntax highlighting, live preview
  - Notes as reference material for demos
- 🆕 `features/document-import.mdx` — Importing external documents
  - Supported formats: `.docx`, `.doc` (legacy binary), `.pdf`, `.pptx`
  - Import button in Notes section sidebar
  - How each format is converted to markdown:
    - Word (.docx): headings, paragraphs, embedded images extracted
    - Word (.doc): legacy binary text extraction fallback
    - PDF: text extraction via pdf-extract
    - PowerPoint (.pptx): slides → sections with headings, body text, speaker notes, images
  - Image extraction: where images are saved (`.cutready/screenshots/`)
  - DRM-protected documents: detection, clipboard fallback workflow (open in Word → copy → paste)
  - Error handling and troubleshooting

### 3.4 Storyboards

- ✏️ `features/storyboard-management.mdx` — Sequencing sketches into demo flows
  - Creating storyboards
  - Adding / reordering sketches
  - Storyboard view and preview

### 3.5 Screen Capture

- ✏️ `features/screen-capture.mdx` — Multi-monitor screenshot support
  - Capture overlay
  - Assigning screenshots to sketch rows

### 3.6 Version History

- ✏️ `features/version-history.mdx` — Git-backed versioning
  - Timeline view
  - Diffing and restoring

### 3.7 UI & Navigation

- ✏️ `features/ui-navigation.mdx` — General UI and navigation
  - Sidebar: left rail with icon buttons (Home, Sketch, Settings, Chat)
  - Hidden features: Record and Script buttons (not yet implemented)
  - Command palette (Ctrl+K / Cmd+K)
  - Keyboard shortcuts
  - Panel layout: main content + right sidebar (chat/activity)
  - Theming and appearance

### 3.8 Browser Recording *(Experimental)*

- ✏️ `features/browser-recording.mdx` — Playwright-powered automation
  - *(Note: feature is not yet user-facing — mark as coming soon)*

## 4. Workflow Guides

- ✏️ `workflow/demo-production.mdx` — End-to-end demo production workflow
  - Planning → Sketching → Notes/Research → AI Polish → Recording → Export
- 🆕 `workflow/ai-workflow.mdx` — Working with the AI assistant
  - Starting a conversation about your sketch
  - Asking the AI to generate or improve planning rows
  - Using sparkle buttons for quick improvements
  - Reviewing AI changes in the activity panel
  - Importing reference docs and asking AI to incorporate them
- 🆕 `workflow/import-workflow.mdx` — Importing existing materials
  - Importing a slide deck as reference notes
  - Importing a Word doc / PDF as research material
  - Handling protected / DRM documents
  - Using imported notes alongside sketches

## 5. Architecture & Technical Reference

- ✏️ `architecture/overview.mdx` — Application architecture
  - Tauri v2 (Rust backend + WebView frontend)
  - React + TypeScript + Zustand (frontend)
  - Rust engine: sketch operations, file I/O, document import
  - Tauri commands: how frontend invokes backend
- 🆕 `architecture/ai-integration.mdx` — AI / LLM integration
  - Azure Foundry API (OAuth, streaming)
  - Function calling / tool use (read_sketch, set_planning_rows, update_planning_row, etc.)
  - Prompt design: system prompts, tool definitions
  - Silent mode for sparkle actions
- 🆕 `architecture/file-format.mdx` — Project file format
  - `.cutready/` directory layout
  - `project.json` schema
  - `.sk` sketch file format
  - `.md` notes storage
  - `screenshots/` folder and naming conventions

## 6. Settings & Configuration

- 🆕 `settings/overview.mdx` — Settings panel
  - General settings
  - AI / agent configuration (model selection, API settings)
  - Appearance / theme

## 7. Roadmap

- ✏️ `roadmap/upcoming.mdx` — What's next
  - Recording & automation (Playwright-based)
  - Script generation from sketches
  - Export / render pipeline
  - Collaboration features

---

## File-to-Section Map (for the agent)

| Existing File | Section | Action |
|---|---|---|
| `index.mdx` | 1 | Update feature highlights |
| `welcome.mdx` | 1 | Update value prop |
| `getting-started/installation.mdx` | 2 | Minor updates |
| `getting-started/quick-start.mdx` | 2 | Add notes + import steps |
| `features/sketch-editor.mdx` | 3.1 | Add sparkle buttons, AI details |
| `features/notes-markdown.mdx` | 3.3 | Add import section |
| `features/storyboard-management.mdx` | 3.4 | Review |
| `features/screen-capture.mdx` | 3.5 | Review |
| `features/version-history.mdx` | 3.6 | Review |
| `features/ui-navigation.mdx` | 3.7 | Update sidebar description |
| `features/browser-recording.mdx` | 3.8 | Mark as coming soon |
| `architecture/overview.mdx` | 5 | Add import engine, AI layer |
| `workflow/demo-production.mdx` | 4 | Add AI + import steps |
| `roadmap/upcoming.mdx` | 7 | Update with current status |

### New files to create

| New File | Section |
|---|---|
| `getting-started/projects.mdx` | 2 |
| `features/ai-assistant.mdx` | 3.2 |
| `features/sparkle-buttons.mdx` | 3.2 |
| `features/document-import.mdx` | 3.3 |
| `workflow/ai-workflow.mdx` | 4 |
| `workflow/import-workflow.mdx` | 4 |
| `architecture/ai-integration.mdx` | 5 |
| `architecture/file-format.mdx` | 5 |
| `settings/overview.mdx` | 6 |
