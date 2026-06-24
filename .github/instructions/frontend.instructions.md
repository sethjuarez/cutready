---
name: "Frontend Standards"
description: "React, TypeScript, and Tailwind conventions for the CutReady frontend"
applyTo: "src/**"
---

# Frontend Coding Standards

## Framework & Tooling

- **React 19** with functional components and hooks only — no class components.
- **TypeScript** in strict mode with `bundler` module resolution.
- **Vite 6** for dev server (port 1420, strict port) and production builds.
- **Tailwind CSS 3.4** with `darkMode: "class"` — never use `@media (prefers-color-scheme)` directly.
- **Zustand** for state management (appStore, toastStore, updateStore).
- **dnd-kit** for drag-and-drop (sketch reordering, tab reordering).

## Color & Theming Rules

**CRITICAL**: Never use hardcoded Tailwind color classes like `bg-zinc-950`, `dark:bg-zinc-900`, `text-zinc-400`, etc. The entire color system flows through CSS custom properties.

Use these patterns instead:

| Need | Use | NOT |
| --- | --- | --- |
| Background surface | `bg-[var(--color-surface)]` or `bg-surface` | `bg-white dark:bg-zinc-950` |
| Alt surface (cards) | `bg-[var(--color-surface-alt)]` | `bg-zinc-50 dark:bg-zinc-900` |
| Border | `border-[var(--color-border)]` | `border-zinc-200 dark:border-zinc-800` |
| Text | `text-[var(--color-text)]` | `text-zinc-900 dark:text-zinc-100` |
| Secondary text | `text-[var(--color-text-secondary)]` | `text-zinc-500 dark:text-zinc-400` |
| Accent color | `text-[var(--color-accent)]` | `text-indigo-500 dark:text-indigo-400` |

The CSS variables are defined in `src/index.css` under `:root` (light) and `.dark` (dark). They automatically switch when the `.dark` class is on `<html>`.

Available Tailwind tokens (from `tailwind.config.ts`):

- `surface` / `surface-alt` — background colors
- `accent` / `accent-hover` — brand/accent colors
- `border` / `border-subtle` — border colors

## Font

- **Geist Sans** loaded via `@fontsource/geist-sans` (weights 400, 500, 600).
- Imported in `src/main.tsx`. Font stack defined in both `src/index.css` and `tailwind.config.ts`.
- Global `letter-spacing: -0.011em` for the tighter Geist aesthetic.

## Layout Architecture

The app uses a **VS Code-inspired** layout:

- **Activity bar** — Vertical icon strip (left edge). Switches between views.
- **Primary sidebar** — Project explorer with storyboards, sketches, notes tree.
- **Editor area** — Multi-tab editor with reorderable tabs (dnd-kit). TabBar component.
- **Secondary panel** — Version history, chat, or other contextual panels. Can be toggled left/right.
- **Status bar** — Bottom bar with status info + theme toggle.
- **Command palette** — Ctrl+Shift+P, VS Code-style. Commands registered via `commandRegistry.registerMany()` in AppLayout's `useEffect`.

## Component Patterns

- Use `.tsx` extension for all components.
- Place components in `src/components/`.
- Place hooks in `src/hooks/`.
- Place services in `src/services/` (commandRegistry, richPaste).
- Place utilities in `src/utils/` (exportToWord).
- One component per file, named export matching the filename.
- Keep component files under ~200 lines. Extract sub-components or hooks when they grow.

## State Management (Zustand)

- **appStore** (`stores/appStore.ts`) — Main app state: navigation, project, open tabs, active editors, panel sizes, sidebar state. This is the primary store.
- **toastStore** (`stores/toastStore.ts`) — Toast notification queue.
- **updateStore** (`stores/updateStore.ts`) — Auto-update state.

## Web Shim (devMock)

`src/devMock.ts` fakes the Tauri backend when running in a browser. Activated when `import.meta.env.DEV && !__TAURI_INTERNALS__`. This is a secondary browser-only path for Playwright and documentation screenshots, not the default validation path for app work. Use `npm run dev` only when intentionally testing the web shim without Tauri.

- Playwright E2E testing without the Tauri shell.
- Browser-based development for UI work.
- Screenshots of the app for documentation.

## Tauri IPC

- Import `invoke`, `Channel`, `listen`, `emit`, `emitTo`, and `convertFileSrc` from `src/services/tauri` so Auditaur captures IPC spans, events, and trace context.
- Import window-specific APIs such as `getCurrentWindow`, `LogicalPosition`, and `LogicalSize` directly from `@tauri-apps/api/window`.
- Use `invoke()` for Commands, `Channel` for streaming data, `listen()` for events, and the telemetry-aware wrappers for frontend Tauri events.
- Type all IPC payloads with TypeScript interfaces.
- Do not send token-returning or secret-returning commands through Auditaur invoke instrumentation. Route them through raw Tauri invoke in `src/services/tauri.ts` so IPC `resultSummary` cannot capture credential-shaped values. Current sensitive commands include `azure_browser_auth_complete`, `azure_device_code_poll`, `azure_token_refresh`, and `get_github_token`.

## Telemetry

- Use Auditaur as the canonical diagnostics substrate. Frontend Activity entries remain curated user-facing breadcrumbs, but `appStore.addActivityEntries()` also records structured `cutready.activity` console logs for Auditaur.
- Default to running the real Tauri app with `npm run debug` for UI, IPC, and workflow validation. Debug builds enable Auditaur end-to-end observability across frontend console/errors, Tauri IPC/events, and backend tracing; inspect the Debug output panel or `get_auditaur_diagnostics` instead of relying only on browser console output.
- Auditaur wraps the normal Tauri runner; it does not replace it. Ensure dependencies are installed (`npm ci`) before wrapper mode, then start via `auditaur debug --app cutready --active --cdp-port 9222 --require-frontend --json run --timeout-seconds 180 -- $env:ComSpec /c npm run debug` from PowerShell. `npm run debug` expands to `tauri dev`; `npm run tauri -- dev` is the explicit equivalent.
- When multiple or stale Auditaur discovery records exist, prefer concrete selectors over a bare `--active`: `debug` and `drive` use `--session-id <id>`, while telemetry readers such as `ipc`, `errors`, `logs`, and `timeline` use `--session <id>`. Always check readiness with `auditaur debug --app cutready --latest --cdp-port 9222 --require-frontend --json status` before interpreting logs.
- For smoke tests, inspect IPC summaries without printing raw `resultSummary` fields. Summarize counts, command names, failed IPC, and whether sensitive commands appear; do not dump token-returning IPC records.
- Full Auditaur diagnostics are controlled from Settings > Feedback. Packaged builds should default to diagnostics off unless the persisted Feedback setting is enabled for the next launch or the app is started with `CUTREADY_DIAGNOSTICS=1`.
- The Debug output panel should summarize Auditaur data (exceptions, failed IPC, failed traces, warn/error logs) instead of maintaining a separate in-memory debug log.
- Feedback and Export Logs should include compact Auditaur diagnostics and scoped current-session Auditaur data, not the shared global Auditaur root.

## Theme System

- Three modes: `"light"`, `"dark"`, `"system"` — managed by `src/hooks/useTheme.ts`.
- Theme persisted in `localStorage` under key `cutready-theme`.
- Theme applied by toggling `.dark` class on `document.documentElement`.
- System mode listens for `prefers-color-scheme` media query changes.

## Styling Guidelines

- Prefer warm, soft visual feel — avoid harsh contrasts.
- Use `backdrop-blur-md` with semi-transparent backgrounds for frosted-glass panels (TitleBar, StatusBar).
- Use `rounded-xl` or `rounded-2xl` for cards and containers.
- Transitions: `transition-colors` on interactive elements.
- The `no-select` CSS class prevents text selection on UI chrome (title bar, status bar, buttons).
- Use icons instead of text buttons where possible — match the rest of the app's icon style.
- Minimize unnecessary UI chrome — no redundant headers or decorative elements.
- Purple/violet is the brand accent color — avoid using other strong colors for primary UI elements.
