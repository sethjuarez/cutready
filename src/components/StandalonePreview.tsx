/**
 * Standalone preview window — rendered when __IS_PREVIEW flag is set.
 * Reads sketch data from localStorage and renders SketchPreview in fullscreen.
 */
import { useEffect, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { SketchPreview } from "./SketchPreview";
import type { PlanningRow } from "../types/sketch";

const DATA_KEY = "cutready:preview-data";

interface PreviewData {
  rows: PlanningRow[];
  projectRoot: string;
  title: string;
}

export function StandalonePreview() {
  const [data, setData] = useState<PreviewData | null>(null);

  useEffect(() => {
    try {
      const raw = localStorage.getItem(DATA_KEY);
      if (raw) {
        setData(JSON.parse(raw));
      }
    } catch (e) {
      console.error("[StandalonePreview] Failed to load preview data:", e);
    }
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
      <div className="fixed inset-0 flex items-center justify-center bg-[var(--color-surface)] text-[var(--color-text-secondary)]">
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
    />
  );
}
