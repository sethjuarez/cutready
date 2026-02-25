import { useCallback, useRef, useState } from "react";
import { useAppStore } from "../stores/appStore";
import { ScriptTable } from "./ScriptTable";
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
  const titleTimeoutRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const rowsTimeoutRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  const handleTitleChange = useCallback(
    (value: string) => {
      setLocalTitle(value);
      if (!activeSketch) return;
      if (titleTimeoutRef.current) clearTimeout(titleTimeoutRef.current);
      titleTimeoutRef.current = setTimeout(() => {
        if (activeSketchPath) updateSketchTitle(activeSketchPath, value);
      }, 500);
    },
    [activeSketch, activeSketchPath, updateSketchTitle],
  );

  const handleRowsChange = useCallback(
    (rows: PlanningRow[]) => {
      if (rowsTimeoutRef.current) clearTimeout(rowsTimeoutRef.current);
      rowsTimeoutRef.current = setTimeout(() => {
        updateSketch({ rows });
      }, 500);
    },
    [updateSketch],
  );

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

        {/* Title */}
        <input
          type="text"
          value={localTitle}
          onChange={(e) => handleTitleChange(e.target.value)}
          placeholder="Sketch title..."
          className="w-full text-2xl font-semibold bg-transparent text-[var(--color-text)] placeholder:text-[var(--color-text-secondary)]/40 outline-none border-none mb-4"
        />

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
            rows={activeSketch.rows}
            onChange={handleRowsChange}
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
              const updated = [...activeSketch.rows, newRow];
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
    </div>
  );
}
