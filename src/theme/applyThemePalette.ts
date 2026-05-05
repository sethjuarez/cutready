import type { ThemeColorTokens, ThemePalette } from "./appThemePalettes";

export const THEME_BOOTSTRAP_CACHE_KEY = "cutready-theme-bootstrap";

export const THEME_COLOR_TOKEN_MAP: Record<keyof ThemeColorTokens, string> = {
  surface: "--color-surface",
  surfaceAlt: "--color-surface-alt",
  surfaceInset: "--color-surface-inset",
  surfaceToolbar: "--color-surface-toolbar",
  accent: "--color-accent",
  accentHover: "--color-accent-hover",
  border: "--color-border",
  borderSubtle: "--color-border-subtle",
  text: "--color-text",
  textSecondary: "--color-text-secondary",
  secondary: "--color-secondary",
  tertiary: "--color-tertiary",
  success: "--color-success",
  warning: "--color-warning",
  error: "--color-error",
  accentFg: "--color-accent-fg",
  overlayScrim: "--color-overlay-scrim",
  overlayStrong: "--color-overlay-strong",
  mediaControlBg: "--color-media-control-bg",
  mediaControlFg: "--color-media-control-fg",
};

function toCssVariables(colors: ThemeColorTokens): Record<string, string> {
  return Object.fromEntries(
    Object.entries(THEME_COLOR_TOKEN_MAP).map(([key, token]) => [
      token,
      colors[key as keyof ThemeColorTokens],
    ])
  );
}

export function applyThemeColorTokens(root: HTMLElement, colors: ThemeColorTokens) {
  for (const [token, value] of Object.entries(toCssVariables(colors))) {
    root.style.setProperty(token, value);
  }
}

export function cacheThemePaletteForBootstrap(palette: ThemePalette) {
  localStorage.setItem(
    THEME_BOOTSTRAP_CACHE_KEY,
    JSON.stringify({
      version: 1,
      paletteId: palette.id,
      themes: {
        light: toCssVariables(palette.light),
        dark: toCssVariables(palette.dark),
      },
    })
  );
}
