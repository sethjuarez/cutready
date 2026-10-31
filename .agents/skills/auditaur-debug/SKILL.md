---
name: auditaur-debug
description: Debug Auditaur-enabled Tauri apps. Use when asked to inspect app startup, telemetry readiness, frontend errors, IPC, events, traces, Tauri-native drive bridge targets, or dogfood/smoke-test an Auditaur integration.
license: MIT
---

# Auditaur debug workflow

Use Auditaur as the first diagnostic surface for Tauri app debugging. Prefer machine-readable JSON when acting as an agent. The canonical mental model is: Auditaur observes the app; it does not replace the app's normal dev command.

When starting from an unfamiliar repo or CLI version, ask Auditaur for the current agent contract:

```bash
auditaur agent guide --json
```

## Intent map

Translate common user phrases to the appropriate Auditaur workflow:

| User phrase | Agent interpretation |
| --- | --- |
| "observe the app" | Attach to the already-running app and watch readiness. |
| "start with Auditaur" / "Auditaur start the app" | Run `auditaur start` when `.auditaur/config.json` exists; otherwise start the normal app command under Auditaur observation with `observe -- <normal command>`. |
| "debug the app with Auditaur" | Check readiness first, then inspect logs/timeline/traces/IPC. |
| "drive the app" / "click in the app" | Require the Tauri-native drive bridge, then use `auditaur drive`. |
| "run a drill" / "smoke test the app" | Run `auditaur drill` for the configured default drill, or `auditaur drill <name>` for a named drill. |
| "run the drill tests" / "add a test for this" / "did my change break anything" | Use `auditaur drill test` with suites in `.auditaur/drills/*.drill.json` (see Drill tests). |
| "manual approval" / "human gate" / "OAuth consent" | Use a drill script gate so the app session stays pinned while the human action completes. |

Preserve the app's normal startup command. Prefer the simple repo-configured flow when available:

```bash
auditaur start
auditaur drill
auditaur inspect
auditaur stop
```

These commands read `.auditaur/config.json` and share `.auditaur/session.json` by default so agents do not need custom wrappers for readiness polling, session IDs, database paths, or process cleanup.

Use `auditaur start --json` when an agent needs machine-readable startup output. It emits one final JSON object with the exact app session, process, selectors, session file path, and any generated named ports. `auditaur stop` stops the recorded process tree and removes the session file after cleanup so follow-up commands do not target a dead session.

## Readiness first

Before reading logs or driving the UI, establish what is ready:

```bash
auditaur debug --app <app-name> --json status
```

For a running app, watch until core telemetry is ready:

```bash
auditaur debug --app <app-name> --active --json watch --until-ready --timeout-seconds 120
```

If the task requires frontend telemetry, add `--require-frontend`. This is stricter than default readiness and may wait until a Tauri WebView action emits frontend logs, errors, IPC, events, or spans. If the task requires WebView selector actions, use the Auditaur in-app drive bridge: enable `initAuditaur({ driveBridge: true })` in exactly one debug/test WebView per Auditaur session and add `--require-drive-bridge` to readiness watches.

```bash
npm run tauri dev
auditaur debug --app <app-name> --active --require-frontend --json watch --until-ready --timeout-seconds 120
```

On Windows PowerShell:

```powershell
npm run tauri dev
auditaur debug --app <app-name> --active --require-frontend --json watch --until-ready --timeout-seconds 120
```

Auditaur drive uses the Tauri-native in-app drive bridge. The app must explicitly enable `initAuditaur({ driveBridge: true })` in exactly one debug/test WebView per Auditaur session, then `auditaur drive` sends bounded requests through that bridge.

## Starting the app

Prefer attach mode by default: let the developer, IDE, Tauri dev server, or existing terminal own app startup, then use `auditaur debug watch` to observe readiness. This preserves the user's normal environment, debugger, hot reload, and terminal output.

Use wrapper mode only when the agent or a smoke script needs to own a repeatable run. Wrapper mode should still start the app through its normal command; Auditaur observes that process instead of replacing the app startup system.

| Scenario | Preferred mode |
| --- | --- |
| Human local debugging | Attach to the already-running app |
| IDE/debugger/Tauri dev workflow is already running | Attach |
| Agent needs an end-to-end validation run | Wrapper |
| Dogfood or CI-like local smoke pass | Wrapper |

If the agent should start the app, wrap the existing command:

```bash
auditaur start
```

`auditaur start` uses `.auditaur/config.json`, reports readiness, writes `.auditaur/session.json`, and intentionally leaves the app running after it becomes ready. If the config declares named ports, `start` reserves random local ports, expands `{{port:name}}` placeholders in the command, sets configured port environment variables, and records the chosen ports in the session file and JSON output. If no config exists yet, use the no-config form:

```bash
auditaur observe --app <app-name> -- npm run tauri dev
```

`observe` reports core readiness and intentionally leaves the app running after it becomes ready. It starts the command directly as argv, so package-manager and tool shims such as `npm`, `pnpm`, `yarn`, and `cargo tauri` should work naturally across Windows/macOS/Linux without manually wrapping in PowerShell/bash unless shell syntax is needed. When `--app` is supplied, it ignores matching discovery records that existed before spawn, waits for the new Auditaur session, and writes `.auditaur/session.json` with `sessionId`, `instanceId`, `pid`, `databasePath`, and generated selector argument arrays instead of guessing with `--active` or `--latest`. Prefer read commands with `--session-file .auditaur/session.json` for follow-up telemetry, including postmortem reads after the app exits or crashes. Clean up the spawned app process with `auditaur stop --session-file .auditaur/session.json` when the validation is done.

Useful pinned follow-up commands:

```bash
auditaur logs --session-file .auditaur/session.json
auditaur ipc --session-file .auditaur/session.json --failed
auditaur timeline --session-file .auditaur/session.json
auditaur explain --session-file .auditaur/session.json
auditaur diagnose --session-file .auditaur/session.json
auditaur tail --session-file .auditaur/session.json --signal failures --replay
```

Use `--require-frontend` only when the task explicitly needs frontend telemetry readiness:

```bash
auditaur observe --app <app-name> --require-frontend -- npm run tauri dev
```

When multiple apps or agents may run concurrently, reserve named ports and wire them into the dev command:

```bash
auditaur observe --app <app-name> --port web -- npm run dev -- --port {{port:web}}
auditaur observe --app <app-name> --port-env web=VITE_PORT -- npm run tauri dev
auditaur observe --app <app-name> --port web=5177 -- npm run dev -- --port {{port:web}}
```

Prefer random named ports (`--port web` or `--port-env web=VITE_PORT`) for agent-owned runs. Use explicit ports only when required. Auditaur records chosen ports in `.auditaur/session.json`, but the app's Vite/Tauri setup must consume the placeholder or environment variable.

## Interpreting readiness

Inspect the `stages` array:

- `app_discovery`: Auditaur discovery file exists.
- `heartbeat`: app heartbeat is fresh.
- `telemetry_database`: SQLite database exists and schema validates.
- `session`: a session row is queryable.
- `window`: Tauri window telemetry exists.
- `backend_telemetry`: backend/plugin logs, spans, or window rows exist.
- `frontend_telemetry`: frontend logs/errors/IPC/events exist; required only with `--require-frontend`.
- `drive_bridge`: Tauri-native in-app drive bridge status exists and has a fresh heartbeat; required only with `--require-drive-bridge`.
- `cdp_endpoint`: legacy browser-debug endpoint readiness; checked only when explicitly requested.

If readiness is false, follow the stage messages and `hints` instead of guessing from terminal output.

## Driving the WebView

Inspect the Tauri-native drive bridge before mutating the app:

```bash
auditaur drive --app <app-name> --active --json inspect
```

If target selection is needed, use the bridge target:

```bash
auditaur drive --app <app-name> --active --json click --target auditaur-bridge --selector '<css>'
```

Use read-only actions first when possible:

```bash
auditaur drive --app <app-name> --active --json exists --selector '<css>'
auditaur drive --app <app-name> --active --json text --selector '<css>'
auditaur drive --app <app-name> --active --json snapshot --selector body --output failure.json
auditaur drive --app <app-name> --active --json screenshot --selector body --output failure.png --snapshot-output failure.json
```

Review snapshot artifacts before sharing them; they may contain DOM text, URLs, or other sensitive content.

For text entry, use `fill` when a direct DOM value setter plus `input`/`change` events is enough. Use `type` when a framework-controlled input or textarea needs focused text insertion:

```bash
auditaur drive --app <app-name> --active --json type --selector 'textarea' --value 'hello' --visible-only
```

Prefer `--visible-only` (or `--visible`) with selector actions (`wait`, `exists`, `text`, `click`, `fill`, `type`, `hover`, `select`, `check`, and `uncheck`) when validating modals, focus overlays, or fullscreen shells that leave duplicate hidden DOM behind.

If `drive inspect` reports `bridge.status` inactive, enable `driveBridge` in the frontend. Once active, use `wait`, `exists`, `text`, `click`, `fill`, `type`, `press`, `hover`, `select`, `check`, `uncheck`, `evaluate`, `snapshot`, and `screenshot` through the Tauri-native bridge. Bridge screenshots first try native WebView capture (`screenshotBackend=tauri_native_webview_snapshot`) for occlusion-free WebView pixels; selector screenshots crop that WebView image and report `screenshotScope=selector` plus `selectorRect`. If WebView capture fails, Auditaur falls back to native window capture (`screenshotBackend=tauri_native_window_xcap`) and then to the DOM text summary PNG (`screenshotBackend=bridge_dom_summary_canvas`) with error metadata. `evaluate` runs arbitrary JavaScript in the WebView, so keep the bridge restricted to development/test sessions. If the bridge is inactive, use Auditaur telemetry (`timeline`, `ipc`, `traces`, `explain`) for truth and pair it with Accessibility automation only when manual UI input must be simulated.

Legacy compatibility: `--cdp-port` may appear in older commands, but `auditaur drive` ignores it. Use positive wording for drive commands: say they use the Tauri-native drive bridge.

## Inspecting telemetry

After readiness, use structured read commands:

```bash
auditaur apps --json
auditaur sessions --json
auditaur logs --json
auditaur errors --json
auditaur ipc --json
auditaur events --json
auditaur traces --json
auditaur timeline --json
auditaur explain --json
```

Prefer `--session <id>`, `--db <path>`, `--active`, `--latest`, `--pid`, or `--instance-id` when there are stale or multiple sessions.

## Drill tests

For repeatable checks, write Playwright-style suites in `.auditaur/drills/<name>.drill.json` and run them with `auditaur drill test`. Each test is a list of steps: actions (`click`, `fill`, `press`, `select`, `check`, ...), auto-retrying UI assertions (`expect` with `toBeVisible`, `toHaveText`, `toMatchAriaSnapshot`, `toHaveScreenshot`, ...), polled JavaScript value assertions (`expectValue` with `toEqual`, `toContain`, `toMatch`), and telemetry assertions (`expectIpc`, `expectEvent`, `expectLog`, `expectSpan`, `expectNoTelemetry`, `expectNoErrors`) scoped to that test. A `run` step runs a command mid-test and checks its exit code and output. Suite `env` (plus `KEY=VALUE` lines setup hooks append to `$AUDITAUR_DRILL_ENV_FILE`) reaches the app launch, hooks, and `run` steps.

```bash
auditaur drill validate                      # schema check with "did you mean" hints
auditaur drill test --app <app> -- npm run tauri dev
auditaur drill test --last-failed -x         # rerun failures, stop at the first
auditaur drill show                          # latest run and its failures
auditaur drill locate 'li button' --app <app>  # suggest role/label/test-id locators for a running app
```

- Prefer role/label/text locators (`{ "role": "button", "name": "Save" }`) over brittle CSS. When writing a step, run `auditaur drill locate <css>` against the running app and paste the locator it suggests.
- Assert telemetry, not just UI: a passing click whose IPC failed is still a bug.
- Snapshot baselines go in `__snapshots__/` beside the suite. A missing baseline is written and fails; review it before committing. Use `--update-snapshots=changed` (the `=` is required) only for intended UI changes.
- Read failures from `.auditaur/drill-runs/<runId>/` (`run.json`, `tests/<id>/attempt-<n>/attempt.json`), not by rerunning blindly.
- When the user wants to see drills, open the `auditaur-drills` canvas (from the Auditaur Copilot plugin or `auditaur init extension`) instead of pasting result tables, and use its `navigate` action to switch pages: `tests`, `run` (watch a run and answer its `gate` steps), `trace`, `snapshots`, `coverage`. To debug a failed test step by step, rerun with `--trace on` (or MCP `trace: "on"`) and navigate to `trace`.
- A `gate` step in a drill test pauses for a human. `drill test` never reads the terminal: surface the gate on the `run` page of `auditaur-drills` (or answer with `respond_human_gate` when the user tells you to). Gate waits are off the test clock; the gate's own `timeoutMs` (default 5 minutes) bounds them.

## Human gates in drills

Use drill human gates for workflows that require real human action while preserving the same pinned app session: OAuth/device-code approval, OS permission prompts, installer elevation, external browser handoffs, camera/mic permissions, hardware security keys, or any flow where an agent should pause instead of simulating trust-sensitive input.

Add gates in a drill script and run the drill with `--script <path>`:

```json
{
  "gates": [
    {
      "name": "Approve GitHub sign-in",
      "instructions": "Complete the GitHub device-code approval in the app or browser, then return here.",
      "selector": "#status-card",
      "expectText": "Signed in",
      "manualContinue": true,
      "timeoutMs": 300000,
      "choices": [
        { "id": "done", "label": "Done", "outcome": "continue" },
        { "id": "blocked", "label": "Blocked", "outcome": "fail" }
      ]
    }
  ]
}
```

Human gates run after Auditaur has spawned and pinned the new app session and reached readiness, but before selector/text/error/IPC/explain evidence collection. Do not restart the app or switch to a different session during the gate; the point is to keep pre-gate and post-gate evidence attached to the same session/database/pid. Gates can be selector-only monitored waits, manual continues, choices with `continue`/`retry`/`skip`/`fail`/`abort` outcomes, inputs, and clipboard hints. Sensitive inputs and clipboard values are redacted in drill reports by default, but local temporary gate response JSON can briefly contain raw input values until the drill consumes and removes it.

When a gate requires a manual response, Auditaur also publishes a session-local request beside the pinned session database. Agents can list and answer these through MCP:

```bash
auditaur mcp
```

Use `list_pending_human_gates` to find pending gates and `respond_human_gate` with the `requestId`, optional `choiceId`, optional `inputs`, and a clear `responder` value. Run the MCP server with the same Auditaur data directory as the drill so it can see the session-local request files. If the `auditaur-drills` canvas is installed (the Auditaur Copilot plugin or `auditaur init extension`), open the `auditaur-drills` canvas with `input.gate` set to the pending gate (or call `show_gate` on an open one) so the user gets an action card on its Gate page and can click a response. Terminal ENTER/choice input remains the fallback when no MCP or canvas client is available.

## Common failure patterns

- No discovery file: app is still compiling, has not launched, or the Auditaur plugin is not registered.
- Database not readable/schema invalid: app initialized partially or data directory is wrong.
- No frontend telemetry: frontend API did not initialize, no frontend action has fired, or export failed in the UI.
- Drive bridge inactive: enable `initAuditaur({ driveBridge: true })` in exactly one debug/test WebView, otherwise use telemetry plus Accessibility fallback.
- Pending human gate: do not bypass it with synthetic app state. Surface the gate instructions to the user, respond through the canvas/MCP/terminal path, then continue evidence collection on the same pinned session.
- Target ambiguity: use `--target auditaur-bridge`; if multiple sessions match, disambiguate with `--session-id`, `--instance-id`, `--pid`, `--latest`, or `--active`.
- JSON output contamination: use `debug run --json` from a current Auditaur CLI; child startup output should not appear in JSON lines.

## Validation loop

For high-confidence changes:

1. Run the relevant tests/builds.
2. Launch or attach with `auditaur debug`.
3. Run the configured `auditaur drill`; if it publishes a human gate, surface it through the canvas/MCP/terminal response path instead of replacing the manual action.
4. Drive a representative UI path through the Tauri-native bridge when UI coverage is needed.
5. Re-check `debug status --require-frontend` when frontend telemetry matters.
6. Inspect `timeline` and `explain`.
7. Clean up spawned app processes and temporary telemetry directories.
