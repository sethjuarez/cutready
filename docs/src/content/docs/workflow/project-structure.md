---
title: Project Structure
description: How CutReady organizes project files on disk.
sidebar:
  order: 2
---

## Directory Layout

When you create a CutReady project, the following structure is created:

```
my-demo-project/
├── .storyboards/          # Storyboard definition files
│   └── storyboard-1.json
├── sketches/              # Sketch documents (planning tables)
│   └── sketch-1.json
├── notes/                 # Markdown note files
│   └── notes.md
├── recordings/            # Captured recording sessions
│   └── session-1.json
├── snapshots/             # Version history (git via gix)
│   └── [internal git data]
└── .manifest              # Sidebar ordering metadata
```

## File Formats

### Sketches (`.json`)

Each sketch is a JSON file containing:
- Title and description
- Array of planning rows (time, narrative, actions, screenshot)
- Lifecycle state (Draft, RecordingEnriched, Refined, Final)
- Metadata (created/updated timestamps)

### Storyboards (`.json`)

Storyboards reference sketches and organize them into sections:
- Title and description
- Ordered list of sketch references
- Section groupings

### Notes (`.md`)

Plain markdown files — no special format required.

### Recording Sessions (`.json`)

Each session contains:
- Browser profile used
- Array of captured actions (type, selector, value, timestamp, screenshot)
- Session metadata (start/end time, duration)

### Manifest (`.manifest`)

A JSON file that tracks the display order of items in the storyboard
list sidebar. Updated automatically when you drag-and-drop to reorder.

## Version Control

The `snapshots/` directory contains a bare git repository managed by
**gitoxide (gix)**. This is completely independent of any source code git
repository. Each version snapshot is a git commit with the document content
as the tree.
