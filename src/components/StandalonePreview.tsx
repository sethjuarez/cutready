/**
 * Standalone preview window — rendered when __IS_PREVIEW flag is set.
 * Reads sketch data from localStorage and renders SketchPreview in fullscreen.
 */
import { useEffect, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { SketchPreview, type PreviewSlide } from "./SketchPreview";
import type { PlanningRow } from "../types/sketch";

const DATA_KEY = "cutready:preview-data";

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
    const theme = localStorage.getItem("cutready-theme");
    if (theme === "dark") {
      document.documentElement.classList.add("dark");
    } else {
      document.documentElement.classList.remove("dark");
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
