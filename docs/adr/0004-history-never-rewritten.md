# 0004: Shared history is never rewritten

- **Status:** Accepted
- **Date:** 2026-05-19

## Context

Every save is a deliberate user action. Squashing, compacting or milestone-merging history before sharing erases those saves and breaks collaborators who already have them.

## Decision

- CutReady never squashes, compacts or rewrites shared history.
- **Standalone projects:** Send is a plain push of the current branch. It is refused when the remote has incoming changes; the user gets updates first.
- **Hybrid projects** (a CutReady folder inside a code repo): Send for review pushes a `cutready/<slug>` branch without force and opens or reuses a GitHub pull request. Direct publish to the base branch is refused.

## Consequences

- History stays complete and safe to share.
- Busy projects accumulate many small saves; history views group them rather than rewriting them.

## Enforcement

Partial; the invariant is mostly upheld by having no rewrite code path at all.

- `publish_refuses_when_remote_has_incoming_changes` in `crates/cutready-versioning` covers the standalone refusal.
- The `send_for_review_*` tests in `src-tauri/src/commands/draftline.rs` cover the `cutready/*` branch and pull request, refusing standalone projects, and LFS.
- Not yet tested: non-force pushes, reusing an existing pull request, and ancestry preservation across Send.
