# Architecture decision records

Short records of decisions that shape CutReady's architecture. Each one says what was decided, why, and what enforces it.

| ADR | Decision | Status |
| --- | --- | --- |
| [0001](0001-core-boundary.md) | `cutready-core` is host-neutral and reaches the world only through ports | Accepted |
| [0002](0002-edit-sessions-and-op-log.md) | Every document write goes through an edit session recorded in the op log | Accepted |
| [0003](0003-error-envelope.md) | Commands fail with a typed `CmdError` envelope; clients branch on `code` | Accepted |
| [0004](0004-history-never-rewritten.md) | Shared history is never rewritten; Send pushes saves as they are | Accepted |
| [0005](0005-agent-hosts-use-cli-mcp.md) | Agent hosts edit only through `cutready-cli mcp`, found by registration; contract mismatch fails closed | Accepted |

## Rules

- **Supersede, don't rewrite.** When a decision changes, add a new ADR and set the old one's status to `Superseded by NNNN`.
- **Name the enforcement.** A decision without a check, test or lint that fails when it's broken is a wish.
- Keep each record short. Link to code and contracts rather than copying them.

## Template

```markdown
# NNNN: Title

- **Status:** Proposed | Accepted | Superseded by NNNN
- **Date:** YYYY-MM-DD

## Context

What forces the decision.

## Decision

What we do.

## Consequences

What gets easier, what gets harder.

## Enforcement

The checks, tests or lints that fail when the decision is broken.
```
