# 0002: Edit sessions and the op log

- **Status:** Accepted
- **Date:** 2026-05-19

## Context

The app, agents, the CLI and MCP all write sketches, storyboards and notes, sometimes at the same time and sometimes with the app closed. Writes need stale-version checks, crash safety and a reviewable record that can be kept or undone.

## Decision

- Every tracked document write goes through an edit session in `cutready-core` (`edit_session.rs`) as part of a **run**.
- Each write states what it expects on disk: `Expected::Version(hash)`, `Expected::Absent` or `Expected::Unchecked`. A mismatch fails with `stale_document` and writes nothing.
- The `Lock` port serializes writers across processes; the desktop adapter is an OS file lock in the state dir.
- A write is a transaction: reconcile earlier runs, record the write as pending (with any images), atomically replace the file, then mark it committed. After a crash, recovery compares file hashes to mark pending writes committed or abandoned.
- Runs are recorded in `op-log.db` in the git-dir state dir (`<gitdir>/cutready/...`), so they never dirty the project.
- Review compares a run against its baseline. **Keep** accepts it; **Undo** reverts it entity by entity and fails with `undo_conflict` if something changed since. The user's own edits form an auto-kept `user` run.

## Consequences

- The app, CLI and MCP share one write path and one review model.
- An agent can edit with the app closed, and the app shows those runs for review on open.
- Every write pays for a lock, a hash and an op-log row.

## Enforcement

- `npm run check:documents` (`scripts/check-document-writes.mjs`) scans `src-tauri/src`. It rejects the legacy document write helpers and raw filesystem writes in the desktop document commands and `engine/project.rs` helpers. It does not scan other crates.
- Core and desktop-io tests cover locking, stale versions and recovery; `edit_session.rs` and CLI tests cover run review, Keep and Undo.
- Typra contract vectors in `contracts/vectors/` pin document decode and save, edits, stale versions (`stale_document`) and low-level undo (`undo_conflict`).
