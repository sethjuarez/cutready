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

## Color & Theming Rules

**CRITICAL**: Never use hardcoded Tailwind color classes like `bg-zinc-950`, `dark:bg-zinc-900`, `text-zinc-400`, etc. The entire color system flows through CSS custom properties.

Use these patterns instead:

| Need                | Use                                         | NOT                                    |
| ------------------- | ------------------------------------------- | -------------------------------------- |
| Background surface  | `bg-[var(--color-surface)]` or `bg-surface` | `bg-white dark:bg-zinc-950`            |
| Alt surface (cards) | `bg-[var(--color-surface-alt)]`             | `bg-zinc-50 dark:bg-zinc-900`          |
| Border              | `border-[var(--color-border)]`              | `border-zinc-200 dark:border-zinc-800` |
| Text                | `text-[var(--color-text)]`                  | `text-zinc-900 dark:text-zinc-100`     |
| Secondary text      | `text-[var(--color-text-secondary)]`        | `text-zinc-500 dark:text-zinc-400`     |
| Accent color        | `text-[var(--color-accent)]`                | `text-indigo-500 dark:text-indigo-400` |

The CSS variables are defined in `src/index.css` under `:root` (light) and `.dark` (dark). They automatically switch when the `.dark` class is on `<html>`.

Available Tailwind tokens (from `tailwind.config.ts`):

- `surface` / `surface-alt` — background colors
- `accent` / `accent-hover` — brand/accent colors
- `border` / `border-subtle` — border colors

## Font

- **Geist Sans** loaded via `@fontsource/geist-sans` (weights 400, 500, 600).
- Imported in `src/main.tsx`. Font stack defined in both `src/index.css` and `tailwind.config.ts`.
- Global `letter-spacing: -0.011em` for the tighter Geist aesthetic.

## Component Patterns

- Use `.tsx` extension for all components.
- Place components in `src/components/`.
- Place hooks in `src/hooks/`.
- One component per file, named export matching the filename.
- Keep component files under ~200 lines. Extract sub-components or hooks when they grow.

## Tauri IPC

- Import from `@tauri-apps/api/core` (invoke, Channel) and `@tauri-apps/api/window` (getCurrentWindow).
- Use `invoke()` for Commands, `Channel` for streaming data, `listen()` for events.
- Type all IPC payloads with TypeScript interfaces.

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

