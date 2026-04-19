import { useCallback, useEffect, useState } from "react";

export type Theme = "light" | "dark";
export type ThemePreference = Theme | "system";

const THEME_CHANGE_EVENT = "cutready-theme-change";

function getSystemTheme(): Theme {
  return window.matchMedia("(prefers-color-scheme: dark)").matches
    ? "dark"
    : "light";
}

function applyTheme(theme: Theme) {
  const root = document.documentElement;
  if (theme === "dark") {
    root.classList.add("dark");
  } else {
    root.classList.remove("dark");
  }
}

export function useTheme() {
  const [preference, setPreferenceState] = useState<ThemePreference>(() => {
    const stored = localStorage.getItem("cutready-theme") as ThemePreference | null;
    return stored === "light" || stored === "dark" || stored === "system" ? stored : "system";
  });
  const [systemTheme, setSystemTheme] = useState<Theme>(getSystemTheme);
  const theme: Theme = preference === "system" ? systemTheme : preference;

  const setTheme = useCallback((next: ThemePreference) => {
    localStorage.setItem("cutready-theme", next);
    setPreferenceState(next);
    window.dispatchEvent(new CustomEvent(THEME_CHANGE_EVENT, { detail: next }));
  }, []);

  const toggle = useCallback(() => {
    setTheme(theme === "dark" ? "light" : "dark");
  }, [theme, setTheme]);

  useEffect(() => {
    applyTheme(theme);
  }, [theme]);

  useEffect(() => {
    const media = window.matchMedia("(prefers-color-scheme: dark)");
    const onSystemChange = () => setSystemTheme(getSystemTheme());
    media.addEventListener("change", onSystemChange);

    const onThemeChange = (event: Event) => {
      const next = (event as CustomEvent<ThemePreference>).detail;
      if (next === "light" || next === "dark" || next === "system") {
        setPreferenceState(next);
      }
    };
    window.addEventListener(THEME_CHANGE_EVENT, onThemeChange);

    return () => {
      media.removeEventListener("change", onSystemChange);
      window.removeEventListener(THEME_CHANGE_EVENT, onThemeChange);
    };
  }, []);

  return { preference, theme, setTheme, toggle };
}
