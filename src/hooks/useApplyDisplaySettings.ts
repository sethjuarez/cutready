import { useEffect } from "react";
import type { AppSettings } from "./useSettings";
import { getThemePalette } from "../theme/appThemePalettes";
import { applyThemeColorTokens, cacheThemePaletteForBootstrap } from "../theme/applyThemePalette";
import { DENSITY_ROW_VARS, normalizeDensity } from "../theme/designTokens";

const FONT_FAMILIES: Record<string, string> = {
  system: '"Geist Sans", -apple-system, BlinkMacSystemFont, "Segoe UI", system-ui, sans-serif',
  sans: '"Inter", "Helvetica Neue", Helvetica, Arial, sans-serif',
  serif: '"Lora", "Georgia", "Times New Roman", serif',
  mono: '"Geist Mono", "Cascadia Code", "Fira Code", ui-monospace, monospace',
};

/** Applies palette, density and typography settings to the document root. */
export function useApplyDisplaySettings(
  settings: AppSettings,
  loaded: boolean,
  resolvedTheme: "light" | "dark",
) {
  useEffect(() => {
    if (!loaded) return;
    const root = document.documentElement;
    const palette = getThemePalette(settings.displayThemePalette);
    localStorage.setItem("cutready-theme-palette", palette.id);
    cacheThemePaletteForBootstrap(palette);
    applyThemeColorTokens(root, palette[resolvedTheme]);
    root.dataset.themeReady = "true";
    root.style.setProperty("--editor-font-size", `${settings.displayFontSize}px`);
    root.style.setProperty("--chat-font-size", `${settings.displayChatFontSize}px`);
    const density = normalizeDensity(settings.displayRowDensity);
    root.dataset.density = density;
    root.style.setProperty("--row-padding", DENSITY_ROW_VARS[density].padding);
    root.style.setProperty("--row-line-height", DENSITY_ROW_VARS[density].lineHeight);
    root.style.setProperty("--row-color-palette", settings.displayRowColors);
    root.style.setProperty("--editor-max-width", settings.displayEditorWidth === "full" ? "100%" : "56rem");
    root.style.setProperty("--app-font-family", FONT_FAMILIES[settings.displayFontFamily] ?? FONT_FAMILIES.system);
  }, [settings, loaded, resolvedTheme]);
}
