---
name: "Git Conventions"
description: "Commit message format and versioning conventions"
applyTo: "**/*"
---

# Git Conventions

## Conventional Commits

All commit messages **must** follow the [Conventional Commits](https://www.conventionalcommits.org/) format. This drives automated version bumps and changelog generation via release-please.

### Format

```text
<type>(<optional scope>): <description>

[optional body]

[optional footer(s)]
```

### Types

| Type | Version Bump | When to Use |
| --- | --- | --- |
| `feat` | minor | New feature or user-facing capability |
| `fix` | patch | Bug fix |
| `perf` | patch | Performance improvement |
| `refactor` | — | Code change that neither fixes a bug nor adds a feature |
| `docs` | — | Documentation only |
| `style` | — | Formatting, missing semicolons, etc. |
| `test` | — | Adding or correcting tests |
| `build` | — | Build system or external dependencies |
| `ci` | — | CI configuration changes |
| `chore` | — | Other changes that don't modify src or test files |

### Breaking Changes

Append `!` after the type or add a `BREAKING CHANGE:` footer to trigger a **major** version bump:

```text
feat!: remove legacy import format

BREAKING CHANGE: The .cutready file format is no longer supported.
```

### Examples

```text
feat: add storyboard reordering via drag-and-drop
fix: persist note preview mode across tab switches
feat(editor): support image paste in sketch blocks
fix(versioning): handle merge conflicts in concurrent edits
docs: update architecture diagram for agent pipeline
chore: bump Tauri to v2.3
```

### Scopes (Optional)

Use short lowercase scopes to narrow context: `editor`, `sidebar`, `versioning`, `agent`, `export`, `recording`, `settings`.

## Versioning

CutReady uses [release-please](https://github.com/googleapis/release-please) for automated semver:

1. Push commits to `main` with conventional commit messages
2. Release-please opens a PR bumping version + updating `CHANGELOG.md`
3. Merge the PR → release-please creates a GitHub Release + `v*` tag
4. Build workflows produce platform artifacts (Windows, Linux, macOS)

Version is tracked in three files (all updated automatically):

- `package.json` — primary (bumped by release-please `node` strategy)
- `src-tauri/Cargo.toml` — Rust crate version (extra-file)
- `src-tauri/tauri.conf.json` — Tauri app version (extra-file)
