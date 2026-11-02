# 0003: Typed error envelope

- **Status:** Accepted
- **Date:** 2026-05-19

## Context

Commands used to fail with free-form strings, so clients matched on message text and broke when wording changed. The CLI, MCP and the app need the same machine-readable failures.

## Decision

- Failures use `CmdError { code, message, details? }`, defined in `contracts/errors.tsp` and generated for Rust and TypeScript. The shape matches Draftline's `TauriCommandError`.
- `code` is a stable `CmdErrorCode` (for example `stale_document`, `locked_row`, `undo_conflict`). Clients branch on `code`, never on `message`; `details` carries structured data such as `current_version` or `conflicts`.
- The CLI's commands and MCP's tool calls wrap it in `CommandFailure`, so those failures are JSON in the generated types. Usage, startup and transport errors stay plain stderr text.

## Consequences

- New failure modes should add a named code and test cases to the contract. Unknown codes still deserialize (`CmdErrorCode::Other`) for forward compatibility.
- Many existing app commands still return `String`. They move to `CmdError` as their modules are touched. `project.rs` and `agent.rs` moved in F7, keeping each old string as `message` under `command_failed`. Their sign-in/token commands followed in F7b the same way: `command_failed` with the text unchanged, and no auth-flow changes. Typed auth codes (such as an expired or denied sign-in) are tracked in [a follow-up issue](ISSUE_URL_PLACEHOLDER).

## Enforcement

- Typra vectors assert `expectedError.code` and `details` for each failure they cover.
- CLI tests deserialize the discovery failure into the generated `CommandFailure`; other CLI failure tests check `code` on the JSON. The CLI output ratchet (F2) extends this to every CLI and MCP output.
- `npm run check:command-errors` caps the app commands per module that still return `Result<_, String>` (`scripts/command-errors.json`). Caps only go down.
