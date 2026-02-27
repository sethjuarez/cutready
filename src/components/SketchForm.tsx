import { useCallback, useEffect, useRef, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { useAppStore } from "../stores/appStore";
import { ScriptTable } from "./ScriptTable";
import { ScreenCaptureOverlay } from "./ScreenCaptureOverlay";
import { SketchPreview } from "./SketchPreview";
import type { PlanningRow } from "../types/sketch";

/**
 * SketchForm — structured editor for a single sketch.
 * Title input + description textarea + planning table.
 */
export function SketchForm() {
  const activeSketch = useAppStore((s) => s.activeSketch);
  const activeSketchPath = useAppStore((s) => s.activeSketchPath);
  const activeStoryboard = useAppStore((s) => s.activeStoryboard);
  const updateSketch = useAppStore((s) => s.updateSketch);
  const updateSketchTitle = useAppStore((s) => s.updateSketchTitle);
  const closeSketch = useAppStore((s) => s.closeSketch);

  const [localTitle, setLocalTitle] = useState(activeSketch?.title ?? "");
  const [localRows, setLocalRows] = useState<PlanningRow[]>(activeSketch?.rows ?? []);
  const [captureRowIdx, setCaptureRowIdx] = useState<number | null>(null);
  const [showPreview, setShowPreview] = useState(false);
  const titleTimeoutRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const rowsTimeoutRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  const currentProject = useAppStore((s) => s.currentProject);
  const projectRoot = currentProject?.root ?? "";

  // Pending data + path captured at edit time for flush-on-unmount
  const pendingRowsRef = useRef<PlanningRow[] | null>(null);
  const pendingTitleRef = useRef<string | null>(null);
  const pendingPathRef = useRef<string | null>(null);

  // Reset local state when switching to a different sketch
  // Cancel any pending debounced saves so stale data isn't written over the new file
  useEffect(() => {
    setLocalTitle(activeSketch?.title ?? "");
    setLocalRows(activeSketch?.rows ?? []);
    // Cancel pending debounced writes — they belong to the previous sketch/version
    if (titleTimeoutRef.current) {
      clearTimeout(titleTimeoutRef.current);
      titleTimeoutRef.current = null;
    }
    if (rowsTimeoutRef.current) {
      clearTimeout(rowsTimeoutRef.current);
      rowsTimeoutRef.current = null;
    }
    pendingRowsRef.current = null;
    pendingTitleRef.current = null;
  }, [activeSketchPath, activeSketch]);

  const handleTitleChange = useCallback(
    (value: string) => {
      setLocalTitle(value);
      if (!activeSketch || !activeSketchPath) return;
      pendingTitleRef.current = value;
      pendingPathRef.current = activeSketchPath;
      if (titleTimeoutRef.current) clearTimeout(titleTimeoutRef.current);
      titleTimeoutRef.current = setTimeout(() => {
        pendingTitleRef.current = null;
        updateSketchTitle(activeSketchPath, value);
      }, 500);
    },
    [activeSketch, activeSketchPath, updateSketchTitle],
  );

  const handleRowsChange = useCallback(
    (rows: PlanningRow[]) => {
      setLocalRows(rows);
      pendingRowsRef.current = rows;
      pendingPathRef.current = activeSketchPath;
      if (rowsTimeoutRef.current) clearTimeout(rowsTimeoutRef.current);
      rowsTimeoutRef.current = setTimeout(() => {
        pendingRowsRef.current = null;
        updateSketch({ rows });
      }, 500);
    },
    [updateSketch, activeSketchPath],
  );

  // Flush pending debounced saves on unmount (e.g., tab close)
  // Skip flush if navigation cleared the active sketch (path is null in store)
  useEffect(() => {
    return () => {
      // If navigation cleared the active sketch, don't flush stale data
      if (!useAppStore.getState().activeSketchPath) return;
      const path = pendingPathRef.current;
      if (titleTimeoutRef.current) {
        clearTimeout(titleTimeoutRef.current);
        if (pendingTitleRef.current !== null && path) {
          invoke("update_sketch_title", { relativePath: path, title: pendingTitleRef.current }).catch(() => {});
        }
      }
      if (rowsTimeoutRef.current) {
        clearTimeout(rowsTimeoutRef.current);
        if (pendingRowsRef.current !== null && path) {
          invoke("update_sketch", { relativePath: path, rows: pendingRowsRef.current }).catch(() => {});
        }
      }
    };
  }, []);

  const handleCaptureScreenshot = useCallback((rowIndex: number) => {
    setCaptureRowIdx(rowIndex);
  }, []);

  const handleCaptureComplete = useCallback(
    (screenshotPath: string) => {
      if (captureRowIdx === null) return;
      const updated = [...localRows];
      updated[captureRowIdx] = { ...updated[captureRowIdx], screenshot: screenshotPath };
      handleRowsChange(updated);
      setCaptureRowIdx(null);
    },
    [captureRowIdx, localRows, handleRowsChange],
  );

  const handleCaptureCancel = useCallback(() => {
    setCaptureRowIdx(null);
  }, []);

  if (!activeSketch) return null;

  return (
    <div className="flex-1 overflow-y-auto">
      <div className="max-w-4xl mx-auto px-6 py-8">
        {/* Back button — only show when inside a storyboard */}
        {activeStoryboard && (
          <button
            onClick={closeSketch}
            className="flex items-center gap-1.5 text-xs text-[var(--color-text-secondary)] hover:text-[var(--color-text)] transition-colors mb-6"
          >
            <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
              <polyline points="15 18 9 12 15 6" />
            </svg>
            Back to storyboard
          </button>
        )}

        {/* Title + Preview button */}
        <div className="flex items-center gap-3 mb-4">
          <input
            type="text"
            value={localTitle}
            onChange={(e) => handleTitleChange(e.target.value)}
            placeholder="Sketch title..."
            className="flex-1 text-2xl font-semibold bg-transparent text-[var(--color-text)] placeholder:text-[var(--color-text-secondary)]/40 outline-none border-none"
          />
          {localRows.length > 0 && (
            <button
              onClick={() => setShowPreview(true)}
              className="flex items-center gap-1.5 shrink-0 text-xs text-[var(--color-text-secondary)] hover:text-[var(--color-accent)] px-3 py-1.5 rounded-lg border border-[var(--color-border)] hover:border-[var(--color-accent)]/40 hover:bg-[var(--color-accent)]/5 transition-colors"
              title="Preview sketch (presentation mode)"
            >
              <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round">
                <polygon points="5 3 19 12 5 21 5 3" />
              </svg>
              Preview
            </button>
          )}
        </div>

        {/* Description */}
        <textarea
          defaultValue={
            typeof activeSketch.description === "string"
              ? activeSketch.description
              : ""
          }
          onChange={(e) => {
            updateSketch({ description: e.target.value });
          }}
          placeholder="Describe what this sketch covers..."
          rows={3}
          className="w-full text-sm bg-transparent text-[var(--color-text)] placeholder:text-[var(--color-text-secondary)]/40 outline-none border border-[var(--color-border)] rounded-lg px-3 py-2 resize-none focus:ring-1 focus:ring-[var(--color-accent)]/40 transition-colors mb-8"
        />

        {/* Planning Table */}
        <div>
          <div className="flex items-center justify-between mb-3">
            <h3 className="text-xs font-medium text-[var(--color-text-secondary)] uppercase tracking-wider">
              Planning Table
            </h3>
          </div>
          <ScriptTable
            rows={localRows}
            onChange={handleRowsChange}
            onCaptureScreenshot={handleCaptureScreenshot}
            projectRoot={projectRoot}
          />
          {/* Always-visible add row button */}
          <button
            onClick={() => {
              const newRow: PlanningRow = {
                time: "",
                narrative: "",
                demo_actions: "",
                screenshot: null,
              };
              const updated = [...localRows, newRow];
              handleRowsChange(updated);
            }}
            className="flex items-center gap-1.5 mt-3 px-3 py-2 text-xs text-[var(--color-text-secondary)] hover:text-[var(--color-accent)] border border-dashed border-[var(--color-border)] hover:border-[var(--color-accent)]/40 rounded-lg transition-colors w-full justify-center"
          >
            <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
              <line x1="12" y1="5" x2="12" y2="19" />
              <line x1="5" y1="12" x2="19" y2="12" />
            </svg>
            Add Row
          </button>
        </div>
      </div>

      {/* Screen capture overlay */}
      {captureRowIdx !== null && (
        <ScreenCaptureOverlay
          onCapture={handleCaptureComplete}
          onCancel={handleCaptureCancel}
        />
      )}

      {/* Presentation preview */}
      {showPreview && (
        <SketchPreview
          rows={localRows}
          projectRoot={projectRoot}
          title={localTitle || "Untitled Sketch"}
          onClose={() => setShowPreview(false)}
        />
      )}
    </div>
  );
}
