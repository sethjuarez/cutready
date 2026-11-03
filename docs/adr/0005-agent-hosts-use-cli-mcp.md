# 0005: Agent hosts edit through `cutready-cli mcp`, found by registration

- **Status:** Accepted
- **Date:** 2026-11-02

## Context

Agent hosts outside the app, such as the GitHub Copilot canvas
(`extensions/cutready-canvas`), need to read and edit CutReady projects. They
must not write project files directly or depend on the app running: that would
bypass edit sessions (ADR 0002), the cross-process write lock and the op log.
They also need a CLI that speaks their contract version, wherever it was
installed.

## Decision

- **MCP only.** A host edits through `cutready-cli mcp <project>` over stdio.
  The host never writes files and never talks to the running app.
- **Contract handshake.** `initialize` exchanges `CONTRACT_VERSION`. A mismatch
  fails closed, and the host never falls back to raw writes.
- **Run ownership.** A host passes a stable client id, so after a restart it
  can still see and resolve the runs it began. Other actors' runs are reviewed
  in the app or with `cutready-cli review`.
- **Discovery order:** explicit path, then `CUTREADY_CLI`, then the per-user
  registration (`cli.json`), then the app's install folder. A registration
  whose binary is missing or whose contract differs fails rather than falling
  through to another binary.
- **Bundling.** The app ships the CLI as a Tauri sidecar as well as the
  standalone archives. Release builds register the sidecar on start, so
  installing the app is enough. On Windows and in an AppImage they register a
  per-version copy instead, so a running host never blocks an app update.

## Consequences

- One write path for app, CLI, canvas and any MCP client.
- Hosts and the CLI must be upgraded together when the contract version
  changes; a mismatch is a clear error rather than a silent misapplied edit.
- Release builds run one extra `cargo build` per target. Windows sidecars are
  not Authenticode-signed until Windows signing is configured.

## Enforcement

- `crates/cutready-cli/tests/mcp.rs` covers the handshake, including refusing
  a mismatched contract, and run ownership by client id.
- `npm run check:canvas` runs the canvas tests against the real CLI:
  discovery order and fail-closed cases (`discovery.test.mjs`), handshake
  (`mcpClient.test.mjs`) and a registered sidecar (`sidecar.test.mjs`).
- `src-tauri/src/engine/cli_registration.rs` tests the sidecar lookup and the
  per-version copy.
