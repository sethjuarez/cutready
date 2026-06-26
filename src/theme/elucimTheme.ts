import type { ElucimTheme } from "@elucim/core";
import type { ThemeColorTokens } from "./appThemePalettes";

/**
 * Shared elucim content theme using CSS var() references.
 * Used by DslRenderer (preview) and ElucimEditor (editing) so both
 * render with identical CutReady colors in the live app.
 *
 * Because values are unresolved var() strings, always pass an explicit
 * colorScheme ("light" | "dark") — "auto" luminance detection can't
 * parse CSS variables.
 */
export const ELUCIM_THEME: ElucimTheme = {
  foreground: "rgb(var(--color-text))",
  background: "rgb(var(--color-surface))",
  title: "rgb(var(--color-text))",
  subtitle: "rgb(var(--color-text-secondary))",
  accent: "rgb(var(--color-accent))",
  muted: "rgb(var(--color-text-secondary))",
  surface: "rgb(var(--color-surface-alt))",
  border: "rgb(var(--color-border))",
  primary: "rgb(var(--color-accent))",
  secondary: "rgb(var(--color-secondary))",
  tertiary: "rgb(var(--color-tertiary))",
  success: "rgb(var(--color-success))",
  warning: "rgb(var(--color-warning))",
  error: "rgb(var(--color-error))",
};

/**
 * CutReady's warm dark palette as concrete hex values.
 * Used for AI-generated visuals, PNG/video export, and documents
 * opened outside CutReady where CSS vars won't resolve.
 *
 * Values sourced from index.css `.dark` block.
 */
export const CUTREADY_DARK: ElucimTheme = {
  foreground: "#eee9e2",
  background: "#272421",
  title: "#eee9e2",
  subtitle: "#b4aca2",
  accent: "#aaa0ff",
  muted: "#b4aca2",
  surface: "#312d29",
  border: "#49433d",
  primary: "#aaa0ff",
  secondary: "#a78bfa",
  tertiary: "#f472b6",
  success: "#34d399",
  warning: "#fbbf24",
  error: "#f87171",
};

/**
 * CutReady's warm light palette as concrete hex values.
 * Used for AI-generated visuals, PNG/video export, and documents
 * opened outside CutReady where CSS vars won't resolve.
 *
 * Values sourced from index.css `:root` block.
 */
export const CUTREADY_LIGHT: ElucimTheme = {
  foreground: "#2c2925",
  background: "#fbfaf8",
  title: "#2c2925",
  subtitle: "#706a62",
  accent: "#6f63e8",
  muted: "#706a62",
  surface: "#f3f0ec",
  border: "#ded8cf",
  primary: "#6f63e8",
  secondary: "#7c3aed",
  tertiary: "#db2777",
  success: "#16a34a",
  warning: "#d97706",
  error: "#dc2626",
};

export function elucimThemeFromTokens(tokens: ThemeColorTokens): ElucimTheme {
  return {
    foreground: `rgb(${tokens.text})`,
    background: `rgb(${tokens.surface})`,
    title: `rgb(${tokens.text})`,
    subtitle: `rgb(${tokens.textSecondary})`,
    accent: `rgb(${tokens.accent})`,
    muted: `rgb(${tokens.textSecondary})`,
    surface: `rgb(${tokens.surfaceAlt})`,
    border: `rgb(${tokens.border})`,
    primary: `rgb(${tokens.accent})`,
    secondary: `rgb(${tokens.secondary})`,
    tertiary: `rgb(${tokens.tertiary})`,
    success: `rgb(${tokens.success})`,
    warning: `rgb(${tokens.warning})`,
    error: `rgb(${tokens.error})`,
  };
}

/**
 * Returns the appropriate concrete CutReady theme for the given mode.
 * Use this in contexts where CSS vars won't resolve (export, AI generation).
 */
export function getCutReadyTheme(isDark: boolean): ElucimTheme {
  return isDark ? CUTREADY_DARK : CUTREADY_LIGHT;
}
