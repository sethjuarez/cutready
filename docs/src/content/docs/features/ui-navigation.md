---
title: UI & Navigation
description: Command palette, keyboard shortcuts, and the CutReady interface layout.
sidebar:
  order: 7
---

import { Badge } from '@astrojs/starlight/components';

<Badge text="Available" variant="success" />

CutReady uses a modern, VS Code-inspired interface with a sidebar, tabbed
editors, resizable panels, and a command palette.

## Layout

```
┌──────────────────────────────────────────────────┐
│  Title Bar (window controls, panel toggles)      │
├────────┬─────────────────────────────────────────┤
│ Side-  │  Tab Bar (open documents)               │
│ bar    ├─────────────────────────────────────────┤
│ (5     │  Main Content                           │
│ icons) │  (Sketch / Record / Script / Settings)  │
│        ├─────────────────────────────────────────┤
│        │  Output Panel (activity log)            │
└────────┴─────────────────────────────────────────┘
```

## Sidebar

The sidebar has 5 navigation icons:

| Icon | View | Description |
|------|------|-------------|
| 🏠 | Home | Project selection and creation |
| ✏️ | Sketch | Edit sketches and planning tables |
| 🔴 | Record | Browser profile selection and recording |
| 📄 | Script | Edit recorded scripts (coming soon) |
| ⚙️ | Settings | API keys, output directory configuration |

- **Toggle visibility**: `Ctrl+B`
- **Move sidebar**: Right-click for left/right positioning
- The sidebar remembers its width across sessions

## Command Palette

Press **`Ctrl+Shift+P`** to open the command palette — a searchable list of
all available commands. Start typing to filter.

## Title Bar

CutReady uses a **frameless window** with a custom title bar that includes:
- Window controls (minimize, maximize, close)
- Toggle buttons for sidebar and output panel
- Drag area for moving the window

## Output Panel

Toggle with **`Ctrl+\``** — a resizable bottom panel showing activity logs,
system messages, and command output.

## Keyboard Shortcuts

| Shortcut | Action |
|----------|--------|
| `Ctrl+Shift+P` | Open Command Palette |
| `Ctrl+B` | Toggle Sidebar |
| `` Ctrl+` `` | Toggle Output Panel |
| `Ctrl+S` | Save Version |
| `Escape` | Close overlays/modals |

## Theme

CutReady includes both light and dark themes, toggled from the status bar at
the bottom of the window.
