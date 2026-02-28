---
title: Storyboard Management
description: Organize sketches, storyboards, and notes with drag-and-drop reordering.
sidebar:
  order: 4
---

import { Badge } from '@astrojs/starlight/components';

<Badge text="Available" variant="success" />

The **Storyboard List** is CutReady's project navigator. It shows all your
sketches, storyboards, and notes in a single panel with drag-and-drop
reordering and search.

## Document Types

CutReady supports three types of project documents:

### Sketches
Planning documents with the 4-column table (Time, Narrative, Actions,
Screenshot). These are the primary planning tool.

### Storyboards
Higher-level containers that reference multiple sketches and organize them
into sections. Use storyboards when your demo has distinct segments.

### Notes
Free-form markdown documents for project notes, ideas, and references.
Notes use a full CodeMirror markdown editor with syntax highlighting.

## Sidebar Organization

The storyboard list panel shows all documents in your project:

- **Drag and drop** to reorder items
- **Search** to filter by name
- **File tree view** — alternate tree-based navigation
- **Context menu** — right-click for rename, delete, and other actions
- Order is persisted in a `.manifest` file in the project root

## Tabbed Editing

Opening a document adds it as a tab in the main content area. You can have
multiple tabs open simultaneously and switch between them. The tab bar shows:

- Document name and type icon
- Dirty/unsaved state indicator (dot)
- Close button on each tab

## Creating Documents

Use the **+** button at the top of the storyboard list to create new:
- Sketches
- Storyboards
- Notes

Each gets a default name that you can rename immediately.
