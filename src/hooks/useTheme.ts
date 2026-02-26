import { useCallback, useEffect, useState } from "react";

export type Theme = "light" | "dark";

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
  const [theme, setThemeState] = useState<Theme>(() => {
    const stored = localStorage.getItem("cutready-theme") as Theme | null;
    // First launch: detect system preference
    return stored === "light" || stored === "dark" ? stored : getSystemTheme();
  });

  const setTheme = useCallback((next: Theme) => {
    localStorage.setItem("cutready-theme", next);
    setThemeState(next);
  }, []);

  const toggle = useCallback(() => {
    setTheme(theme === "dark" ? "light" : "dark");
  }, [theme, setTheme]);

  useEffect(() => {
    applyTheme(theme);
  }, [theme]);

  return { theme, setTheme, toggle };
}
