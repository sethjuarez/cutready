/**
 * Standalone preview window — rendered when __IS_PREVIEW flag is set.
 * Reads sketch data from localStorage and renders SketchPreview in fullscreen.
 */
import { useEffect, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { SketchPreview, type PreviewSlide } from "./SketchPreview";
import type { PlanningRow } from "../types/sketch";
import { getThemePalette } from "../theme/appThemePalettes";

const DATA_KEY = "cutready:preview-data";
const COLOR_TOKEN_MAP = {
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
} as const;

interface PreviewData {
  rows: PlanningRow[];
  projectRoot: string;
  title: string;
  slides?: PreviewSlide[];
}

export function StandalonePreview() {
  const [data, setData] = useState<PreviewData | null>(null);

  useEffect(() => {
    // Apply theme from main window (shared localStorage)
    const preference = localStorage.getItem("cutready-theme");
    const theme = preference === "system"
      ? (window.matchMedia("(prefers-color-scheme: dark)").matches ? "dark" : "light")
      : preference;
    if (theme === "dark") {
      document.documentElement.classList.add("dark");
    } else {
      document.documentElement.classList.remove("dark");
    }
    const palette = getThemePalette(localStorage.getItem("cutready-theme-palette") ?? "cutready");
    const colors = palette[theme === "dark" ? "dark" : "light"];
    for (const [key, token] of Object.entries(COLOR_TOKEN_MAP)) {
      document.documentElement.style.setProperty(token, colors[key as keyof typeof COLOR_TOKEN_MAP]);
    }

    try {
      const raw = localStorage.getItem(DATA_KEY);
      if (raw) {
        setData(JSON.parse(raw));
      }
    } catch (e) {
      console.error("[StandalonePreview] Failed to load preview data:", e);
    }

    // Listen for live updates from the main window
    const onStorage = (e: StorageEvent) => {
      if (e.key === DATA_KEY && e.newValue) {
        try {
          setData(JSON.parse(e.newValue));
        } catch { /* ignore */ }
      }
    };
    window.addEventListener("storage", onStorage);
    return () => window.removeEventListener("storage", onStorage);
  }, []);

  const handleClose = async () => {
    try {
      await invoke("close_preview_window");
    } catch (e) {
      console.error("[StandalonePreview] Failed to close window:", e);
    }
  };

  if (!data) {
    return (
      <div className="fixed inset-0 flex items-center justify-center bg-[rgb(var(--color-surface))] text-[rgb(var(--color-text-secondary))]">
        No preview data available.
      </div>
    );
  }

  return (
    <SketchPreview
      rows={data.rows}
      projectRoot={data.projectRoot}
      title={data.title}
      onClose={handleClose}
      slides={data.slides}
    />
  );
}
