# 0001: Host-neutral core behind ports

- **Status:** Accepted
- **Date:** 2026-05-19

## Context

Document rules (edits, locks, saves, review, undo) used to live inside the Tauri app. The CLI, the MCP server and the iOS companion need the same rules without the desktop shell, and duplicating them drifts.

## Decision

`cutready-core` owns the document rules and touches the outside world only through ports in `crates/cutready-core/src/ports/`:

| Port | Purpose |
| --- | --- |
| `Files` | Read, write, list and replace project files |
| `Clock` | Current time |
| `Lock` | Cross-process document lock |
| `OpLogStore` | Edit runs and their writes |
| `Secrets` | Credentials (desktop: `StrongholdSecrets` in `cutready-desktop-io`, over the same vault the app's Stronghold plugin uses) |
| `Log` | Diagnostics |

Hosts supply the adapters:

| Crate | Role |
| --- | --- |
| `cutready-core` | Document rules and ports; no I/O |
| `cutready-contracts` | Types generated from `contracts/*.tsp` |
| `cutready-desktop-io` | Desktop adapters: files, file lock, SQLite op log, state dir, Stronghold secrets and vault location |
| `cutready-versioning` | Draftline-backed history, save, send |
| `cutready-cli` | `cutready-cli` and its MCP server, runnable with the app closed |
| `src-tauri` (`cutready`) | Desktop shell: Tauri commands, UI events |

Core has no dependency on Tauri, Draftline, git, SQLite, the network or platform APIs.

## Consequences

- One implementation of each rule serves the app, the CLI, MCP and iOS.
- Core tests run against in-memory ports with no temp folders or clocks.
- New I/O needs a port or a host-side adapter, which costs a little ceremony.
- The app's frontend still reads and writes credentials through the Stronghold plugin; `StrongholdSecrets` opens the same vault (same path, Argon2 salt, password and client) for Rust callers such as the CLI or agent. The vault is one encrypted snapshot, so only one process may write it at a time. `existing_vaults_still_open` in `src-tauri/src/commands/secrets.rs` pins that a committed plugin-written vault opens through today's path resolution and through the port, and that the plugin reads what the port writes.

## Enforcement

- `npm run check:core` runs `scripts/check-core-deps.mjs`, which fails when core's resolved dependency tree contains `tauri*`, `windows*`, `git2`/`libgit2-sys`, `rusqlite`/`libsqlite3-sys`, `reqwest`, `draftline`, the app crate, or `tokio`'s `process` feature. It also keeps `cutready-versioning` and `cutready-cli` free of Tauri and the app crate.
- `check:core` builds core for `aarch64-apple-ios`.
- `crates/cutready-core/clippy.toml` bans the common process, filesystem (`std::fs`, `Path` metadata), clock (`SystemTime`, `Instant::now`) and environment (`std::env`) APIs in core.
