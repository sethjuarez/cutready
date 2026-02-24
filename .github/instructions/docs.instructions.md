---
name: "Documentation Standards"
description: "Markdown conventions and documentation structure for CutReady docs"
applyTo: "**/*.md"
---

# Documentation Standards

## Project Documentation

CutReady has three north star documents in `docs/`:

- **NORTH_STAR.md** — Press release written from the future. Describes the vision and "why." Edit carefully — tone is aspirational PR copy.
- **GUIDANCE.md** — Complete feature catalog by workflow phase. Describes everything CutReady can do. Reference this when implementing features.
- **ARCHITECTURE.md** — Full technical design. Rust module structure, data models, engine designs, IPC patterns, sidecar architecture, crate list. Reference this when writing backend code.

## Markdown Rules

- Use ATX headers (`#`, `##`, etc.), not setext (underlines).
- Fenced code blocks must always have a language identifier (`rust`, `typescript`, `json`, `bash`, `text`, `toml`, `css`). Use `text` for ASCII art, directory trees, and plain diagrams.
- Table separator rows must have spaces around dashes: `| --- |` not `|---|`.
- One blank line before and after headings, code blocks, and tables.
- Use `**bold**` for emphasis on key terms, `_italic_` for quoted/example text.
- No trailing whitespace.

## Linting

After creating or editing any Markdown file, always run markdownlint on the changed files and fix all violations before considering the task complete. Use the VS Code diagnostics (errors/warnings panel) or the `markdownlint` CLI to check. Common issues to watch for:

- MD040: Fenced code blocks without a language identifier.
- MD060: Table separator rows missing spaces around dashes.
- MD009: Trailing spaces.
- MD012: Multiple consecutive blank lines.
- MD022/MD032: Missing blank lines around headings or lists.

Do not leave markdownlint warnings unresolved.

## README.md

The root README.md gives a brief overview, links to the three docs, and shows the tech stack. Keep it concise — detail lives in the docs/ files.

