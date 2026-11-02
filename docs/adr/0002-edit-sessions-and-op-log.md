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

## App saves

Architecture v3 §4.13: the app's editors save with the version they last saw, so a CLI, agent or canvas edit made while a document is open is never silently overwritten.

- **Expected version.** Every app save of a sketch, storyboard or note (`update_*`, the lock commands and the storyboard item commands) sends `expectedVersion`, the `document_version` (SHA-256 of the file bytes) of its **base**, and `base`, the exact file text the editor was last synced to. Reads for editors (`get_*_versioned`) return the document, its text and its version, hashed from the bytes as persisted after any migration, so a document is never stale right after it loads. Every save returns the committed document and its version. Rust keeps no per-document cache.
- **Three-way merge.** Under one write-lock hold, `document_writer::save` rejects a base whose hash isn't `expectedVersion`. If the file is still at that version, the ops apply as before (the fast path). Otherwise it computes the save's own document `L = edit_document(base, ops)` (positional ops resolve against the base) and merges it onto the file `D` as `undo_document(D, [write(L, base)])`: an undo of the save's own change. It commits exactly that result with `Expected::Version(hash(D))`, validating locks on `D → M`, and returns `merged: true` plus the save's own document (`synced`). A conflict or lock violation is `stale_document` with the conflicts and `current_version`, and writes nothing.
- **Merge granularity.** The initial contract is `undo_document`'s: top-level fields, planning rows by id, storyboard `items` as one entity, and a note as one entity. The same change on both sides is not a conflict. Nothing finer is merged.
- **Frontend.** `services/documentSaves.ts` queues saves per document (one in flight) and keeps the base per document in `stores/documentVersionStore.ts`. After a save the base is the save's own document, never the merged one, so it may lag the file but never runs ahead of the editor. A merged document, or a newer file, is shown only when the document is clean (no save queued or in flight and pending editor edits written first), and becomes the base only once the editor has rendered it.
- **Conflict copy.** On `stale_document` the app writes its base to `<name> (conflict YYYYMMDD-HHMMSS[-n]).<ext>` (UTC, `Expected::Absent`, numbered on collision) and replays the save there. Saves already queued, and pending editor edits, follow into the copy. Then it reloads the document and shows a warning toast naming the copy. The copy is ordinary project content.
- **Refresh, not a watcher.** Open documents refresh when the window regains focus or becomes visible and on Draftline workspace events, single-flighted. A clean document whose version differs from its base reloads. This deviates from a file watcher; no `notify` dependency was added.

## Consequences

- The app, CLI and MCP share one write path and one review model.
- An agent can edit with the app closed, and the app shows those runs for review on open.
- Every write pays for a lock, a hash and an op-log row.
- An app save made while the document changed elsewhere merges, or lands in a conflict copy, instead of overwriting.

## Enforcement

- `npm run check:documents` (`scripts/check-document-writes.mjs`) scans `src-tauri/src`. It rejects the legacy document write helpers and raw filesystem writes in the desktop document commands and `engine/project.rs` helpers. It does not scan other crates. `Expected::Unchecked` may appear only in `document_writer::import_document`, and only the import entry points (`commands/import.rs`, `engine/video_import.rs`) may call it. Creates use `Expected::Absent`; agent tools, recording narration, migrations and cleanups pass the version read under the lock.
- Core and desktop-io tests cover locking, stale versions and recovery; `edit_session.rs` and CLI tests cover run review, Keep and Undo.
- Typra contract vectors in `contracts/vectors/` pin document decode and save, edits, stale versions (`stale_document`) and low-level undo (`undo_conflict`), including the rebase shape of an app save.
