import type { ElucimTheme } from "@elucim/core";

/**
 * Shared elucim content theme using CSS var() references.
 * Used by DslRenderer (preview) and ElucimEditor (editing) so both
 * render with identical CutReady colors.
 *
 * Because values are unresolved var() strings, always pass an explicit
 * colorScheme ("light" | "dark") — "auto" luminance detection can't
 * parse CSS variables.
 */
export const ELUCIM_THEME: ElucimTheme = {
  foreground: "var(--color-text)",
  background: "var(--color-surface)",
  accent: "var(--color-accent)",
  muted: "var(--color-text-secondary)",
  surface: "var(--color-surface-alt)",
  border: "var(--color-border)",
  primary: "var(--color-accent)",
  secondary: "var(--color-secondary)",
  tertiary: "var(--color-tertiary)",
  success: "var(--color-success)",
  warning: "var(--color-warning)",
  error: "var(--color-error)",
};
