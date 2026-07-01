---
title: Project Structure
description: How CutReady organizes project files on disk.
sidebar:
  order: 2
---

## Workspaces vs. Projects

A **workspace** is the top-level portable folder CutReady opens, versions, and
syncs. A **project** is a demo effort inside that workspace: its sketches,
storyboards, notes, screenshots, and visuals.

CutReady supports two workspace shapes:

| Shape | Folder model | Best for |
| --- | --- | --- |
| **Single-project workspace** | The workspace root is also the project root. `.sk`, `.sb`, `.md`, and `.cutready/` live directly in the opened folder. | One demo, one presentation, or a simple starter workspace. |
| **Multi-project workspace** | The workspace root contains `.cutready/projects.json` plus one subfolder per project. Each project has its own `.sk`, `.sb`, `.md`, screenshots, and visuals. | Related demos, variants, team work, or a reusable demo library. |

Both shapes share one Draftline history at the workspace root. Switching
projects changes the active project view; it does not discard unsaved work or
create a separate git repository.

## Directory Layout

CutReady uses a **flat, flexible folder structure**. When you create a project,
it initializes the folder and a `.git` directory for Draftline-managed version
history.
You're free to organize files however you like — in the root, in subdirectories,
or nested as deep as you want.

```text
my-demo-project/
├── intro.sk                   # A sketch (planning table)
├── outro.sk
├── flows/
│   ├── login-flow.sk          # Sketches can live in subdirectories
│   └── checkout-flow.sk
├── full-demo.sb               # A storyboard (sequence of sketches)
├── notes/
│   └── ideas.md               # Markdown notes
├── .cutready/
│   ├── screenshots/           # Captured and pasted images
│   ├── visuals/               # Elucim DSL visual JSON files
│   └── settings.json          # Workspace settings overrides
└── .git/                      # Version history and local UI state
```

CutReady scans the entire project tree for `.sk`, `.sb`, and `.md` files
and displays them in the sidebar grouped by type.

In a multi-project workspace, each project uses the same internal structure
inside its own subdirectory:

```text
demo-workspace/
├── .cutready/
│   └── projects.json          # Workspace manifest
├── .git/                      # Shared Draftline history
├── build-demo/
│   ├── intro.sk
│   ├── demo.sb
│   └── .cutready/
│       ├── screenshots/
│       └── visuals/
└── start-demo/
    ├── overview.sk
    ├── notes.md
    └── .cutready/
        ├── screenshots/
        └── visuals/
```

## File Formats

### Sketches (`.sk`)

Each sketch is a JSON file containing:

- Title and description
- Array of planning rows (time, narrative, demo actions, screenshot)
- Lifecycle state (Draft, RecordingEnriched, Refined, Final)
- Created/updated timestamps
- Optional row, cell, or whole-sketch lock state
- Optional visual references in `.cutready/visuals/`

### Storyboards (`.sb`)

Storyboards reference sketches by path and organize them into sections:

- Title and description
- Ordered list of sketch references (relative paths to `.sk` files)
- Optional section groupings
- Optional whole-storyboard lock state

### Notes (`.md`)

Plain markdown files — no special format required.

### Sidebar Order (`.git/cutready/order.json`)

A JSON file that tracks the display order of items in the sidebar. It is stored
under `.git/cutready/` as local UI state and updated automatically when you
drag-and-drop to reorder:

```json
{
  "storyboards": ["full-demo.sb"],
  "sketches": ["intro.sk", "flows/login-flow.sk", "outro.sk"],
  "notes": ["notes/ideas.md"]
}
```

Items not in this file appear at the end of their section. Newly created
files are automatically appended. Older workspaces may still contain
`.cutready-order.json`; CutReady migrates that file to `.git/cutready/order.json`
when it reads the order.

## Version Control

The `.git/` directory contains Draftline-managed version history plus local
CutReady runtime state under `.git/cutready/`. This is completely independent
of any source code repository you might have. Each snapshot captures the
versioned project content while chat/run exhaust and local UI state stay out of
the snapshot.

## Smart Copy Between Projects

Multi-project workspaces unlock **Smart Copy**. Right-click a sketch,
storyboard, or note in the Explorer and use **Copy to** to add it to another
project in the same workspace.

Smart Copy copies the document plus the local files it needs:

- Storyboards copy their referenced sketches.
- Sketches copy their referenced screenshots and Elucim visuals.
- Notes copy referenced local screenshots.
- Existing destination files trigger a rename flow instead of being overwritten
  silently.

Use **Move to** when the item should leave the current project. Use **Copy to**
when you want to reuse a sketch, note, storyboard, or asset set as a starting
point in another project.

## Assets

Screenshots and visuals live under `.cutready/` inside each project:

```text
my-demo-project/
└── .cutready/
    ├── screenshots/
    │   └── pasted-001.png
    └── visuals/
        └── a1b2c3d4e5f6.json
```

Sketch rows and notes reference these files by relative path, for example
`.cutready/screenshots/pasted-001.png`. This keeps assets portable with the
project and lets CutReady report which screenshots or visuals are orphaned.
