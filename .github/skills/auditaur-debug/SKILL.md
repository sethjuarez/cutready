---
name: auditaur-debug
description: Debug Auditaur-enabled Tauri apps. Use when asked to inspect app startup, telemetry readiness, frontend errors, IPC, events, traces, Tauri-native drive bridge targets, or dogfood/smoke-test an Auditaur integration.
license: MIT
---

# Auditaur debug workflow

Use Auditaur as the first diagnostic surface for Tauri app debugging. Prefer machine-readable JSON when acting as an agent.

## Repeatable CutReady confidence validation

For repeatable CutReady confidence validation, prefer the first-class
Auditaur drill runner from Auditaur v0.4.0+:

```powershell
auditaur drill run --app cutready --require-frontend --require-drive-bridge --timeout-seconds 180 --report <artifact-or-report-path> --selector body --expect-text CutReady --json -- cmd /c npm run debug
```

`npm run debug` is the real CutReady Tauri app path and expands to the
normal Tauri dev runner. `npm run dev` is the Vite/devMock web-shim path
only; do not use it for validating Tauri IPC, backend traces, native windows,
or drive-bridge behavior.

Use `auditaur drill run` when an agent, CI-like smoke script, or dogfood pass
needs a reproducible app confidence check. Drill is expected to:

1. Pin checks to the session spawned and owned by the drill run.
2. Require exact readiness phases for the spawned session, including heartbeat,
   telemetry database, window, backend telemetry, and frontend telemetry.
3. Confirm the Tauri-native drive bridge is present and selector actions are
   responsive.
4. Check frontend errors, failed IPC, and `auditaur explain` output.
5. Write a JSON report to `--report`.
6. Clean up the spawned process tree after the run.

Do not use Playwright or Chrome DevTools Protocol (CDP) for this user's
Auditaur validation. CutReady debug builds enable Auditaur's Tauri-native drive
bridge, so drive through `auditaur drill run` or `auditaur drive` without
CDP/WebView2 flags.

## Readiness first

Before reading logs or driving the UI, establish what is ready:

```bash
auditaur debug --app <app-name> --json status
```

For a running app, watch until core telemetry is ready:

```bash
auditaur debug --app <app-name> --active --json watch --until-ready --timeout-seconds 120
```

If the task requires frontend telemetry, add `--require-frontend`. If the task requires WebView selector actions, use the Auditaur in-app drive bridge: enable `initAuditaur({ driveBridge: true })` in exactly one debug/test WebView per Auditaur session and add `--require-drive-bridge` to readiness watches.

```bash
npm run tauri dev
auditaur debug --app <app-name> --active --require-frontend --json watch --until-ready --timeout-seconds 120
```

On Windows PowerShell:

```powershell
npm run tauri dev
auditaur debug --app <app-name> --active --require-frontend --json watch --until-ready --timeout-seconds 120
```

Auditaur drive is Tauri-native and does not require Chrome DevTools Protocol/WebView2 targets on any platform. The app must explicitly enable `initAuditaur({ driveBridge: true })` in exactly one debug/test WebView per Auditaur session, then `auditaur drive` commands run without `--cdp-port`.

## Starting the app

Prefer attach mode by default: let the developer, IDE, Tauri dev server, or existing terminal own app startup, then use `auditaur debug watch` to observe readiness. This preserves the user's normal environment, debugger, hot reload, and terminal output.

Use wrapper mode only when the agent or a smoke script needs to own a repeatable run. Wrapper mode should still start the app through its normal command; Auditaur observes that process instead of replacing the app startup system.

| Scenario | Preferred mode |
| --- | --- |
| Human local debugging | Attach to the already-running app |
| IDE/debugger/Tauri dev workflow is already running | Attach |
| Agent needs a repeatable end-to-end validation run | `auditaur drill run` |
| Dogfood or CI-like local smoke pass | `auditaur drill run` |
| Agent needs startup ownership without a full drill | `auditaur debug run` |

If the agent only needs to start and observe the app without the full drill checks, wrap the existing command:

```bash
auditaur debug --app <app-name> --active --json run --timeout-seconds 180 -- npm run tauri dev
```

`debug run` reports readiness and intentionally leaves the app running after it becomes ready. Clean up the spawned app process when the validation is done.

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
- `cdp_endpoint`: Chrome DevTools Protocol is reachable; checked only with `--cdp-port`.

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

If `drive inspect` reports `bridge.status` inactive, do not retry WebView2/CDP flags. Enable `driveBridge`, then use `wait`, `exists`, `text`, `click`, `fill`, `type`, `press`, `hover`, `select`, `check`, `uncheck`, `evaluate`, `snapshot`, and `screenshot` without `--cdp-port`. Bridge screenshots first try native window capture (`screenshotBackend=tauri_native_window_xcap`) for real app-window pixels, then fall back to the DOM text summary PNG (`screenshotBackend=bridge_dom_summary_canvas`) with `nativeScreenshotError` when OS permissions or window matching prevent native capture. `evaluate` runs arbitrary JavaScript in the WebView, so keep the bridge restricted to development/test sessions. If the bridge is inactive, use Auditaur telemetry (`timeline`, `ipc`, `traces`, `explain`) for truth and pair it with Accessibility automation only when manual UI input must be simulated.

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

## Common failure patterns

- No discovery file: app is still compiling, has not launched, or the Auditaur plugin is not registered.
- Database not readable/schema invalid: app initialized partially or data directory is wrong.
- No frontend telemetry: frontend API did not initialize, no frontend action has fired, or export failed in the UI.
- Drive bridge inactive: enable `initAuditaur({ driveBridge: true })` in exactly one debug/test WebView, otherwise use telemetry plus Accessibility fallback.
- Target ambiguity: use `--target auditaur-bridge`; if multiple sessions match, disambiguate with `--session-id`, `--instance-id`, `--pid`, `--latest`, or `--active`.
- JSON output contamination: use `debug run --json` from a current Auditaur CLI; child startup output should not appear in JSON lines.

## Validation loop

For high-confidence changes:

1. Run the relevant tests/builds.
2. Launch or attach with `auditaur debug`.
3. Drive a representative UI path through the Tauri-native bridge when UI coverage is needed.
4. Re-check `debug status --require-frontend` when frontend telemetry matters.
5. Inspect `timeline` and `explain`.
6. Clean up spawned app processes and temporary telemetry directories.
