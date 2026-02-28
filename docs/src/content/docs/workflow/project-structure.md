---
title: Project Structure
description: How CutReady organizes project files on disk.
sidebar:
  order: 2
---

## Directory Layout

CutReady uses a **flat, flexible folder structure**. When you create a project,
it initializes the folder and a `.git` directory for version snapshots.
You're free to organize files however you like — in the root, in subdirectories,
or nested as deep as you want.

```
my-demo-project/
├── intro.sk                   # A sketch (planning table)
├── outro.sk
├── flows/
│   ├── login-flow.sk          # Sketches can live in subdirectories
│   └── checkout-flow.sk
├── full-demo.sb               # A storyboard (sequence of sketches)
├── notes/
│   └── ideas.md               # Markdown notes
├── .cutready-order.json       # Sidebar ordering (auto-managed)
└── .git/                      # Version history (managed by gix)
```

CutReady scans the entire project tree for `.sk`, `.sb`, and `.md` files
and displays them in the sidebar grouped by type.

## File Formats

### Sketches (`.sk`)

Each sketch is a JSON file containing:
- Title and description
- Array of planning rows (time, narrative, actions, screenshot)
- Lifecycle state (Draft, RecordingEnriched, Refined, Final)
- Metadata (created/updated timestamps)

### Storyboards (`.sb`)

Storyboards reference sketches by path and organize them into sections:
- Title and description
- Ordered list of sketch references (relative paths to `.sk` files)
- Optional section groupings

### Notes (`.md`)

Plain markdown files — no special format required.

### Sidebar Order (`.cutready-order.json`)

A JSON file that tracks the display order of items in the sidebar.
Updated automatically when you drag-and-drop to reorder:

```json
{
  "storyboards": ["full-demo.sb"],
  "sketches": ["intro.sk", "flows/login-flow.sk", "outro.sk"],
  "notes": ["notes/ideas.md"]
}
```

Items not in this file appear at the end of their section. Newly created
files are automatically appended.

## Version Control

The `.git/` directory contains a repository managed by **gitoxide (gix)**.
This is completely independent of any source code git repository you might
have. Each version snapshot is a git commit with the document content as
the tree.
