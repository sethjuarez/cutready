import { useCallback, useEffect, useMemo, useRef, useState, lazy, Suspense, type ReactNode } from "react";
import {
  DndContext,
  closestCenter,
  PointerSensor,
  useSensor,
  useSensors,
  type DragEndEvent,
  DragOverlay,
} from "@dnd-kit/core";
import {
  SortableContext,
  useSortable,
  verticalListSortingStrategy,
} from "@dnd-kit/sortable";
import { CSS } from "@dnd-kit/utilities";
import { convertFileSrc, invoke } from "@tauri-apps/api/core";
import type { PlanningRow } from "../types/sketch";
import type { ElucimDocument } from "@elucim/dsl";

const VisualCell = lazy(() => import("./VisualCell"));
const EditorWrapper = lazy(() => import("./EditorWrapper"));

/* Row accent colors — thin left stripe for visual anchoring */
const ROW_PALETTES: Record<string, string[]> = {
  vivid: [
    "#60a5fa", "#34d399", "#fbbf24", "#a78bfa",
    "#fb7185", "#22d3ee", "#f97316", "#a3e635",
  ],
  pastel: [
    "#93c5fd", "#6ee7b7", "#fde68a", "#c4b5fd",
    "#fda4af", "#67e8f9", "#fdba74", "#d9f99d",
  ],
  neutral: [
    "#9ca3af", "#9ca3af", "#9ca3af", "#9ca3af",
    "#9ca3af", "#9ca3af", "#9ca3af", "#9ca3af",
  ],
};

function getRowColor(idx: number): string {
  const palette = getComputedStyle(document.documentElement).getPropertyValue("--row-color-palette").trim() || "vivid";
  const colors = ROW_PALETTES[palette] ?? ROW_PALETTES.vivid;
  return colors[idx % colors.length];
}

function emptyRow(): PlanningRow {
  return { time: "", narrative: "", demo_actions: "", screenshot: null };
}

import type { RowDiff } from "../utils/textDiff";

interface ScriptTableProps {
  rows: PlanningRow[];
  onChange: (rows: PlanningRow[]) => void;
  readOnly?: boolean;
  onCaptureScreenshot?: (rowIndex: number) => void;
  onPickImage?: (rowIndex: number) => void;
  onBrowseImage?: (rowIndex: number) => void;
  onSparkle?: (prompt: string) => void;
  onGenerateVisual?: (rowIndex: number) => void;
  onNudgeVisual?: (rowIndex: number, instruction: string) => void;
  projectRoot?: string;
  sketchPath?: string;
  highlightedRows?: Set<number>;
  rowDiffs?: RowDiff[];
  aiSnapshotRows?: PlanningRow[] | null;
  onDismissHighlights?: () => void;
  hasLastAiDiffs?: boolean;
  onReShowHighlights?: () => void;
}

export function ScriptTable({ rows, onChange, readOnly = false, onCaptureScreenshot, onPickImage, onBrowseImage, onSparkle, onGenerateVisual, onNudgeVisual, projectRoot, sketchPath, highlightedRows, rowDiffs, aiSnapshotRows, onDismissHighlights, hasLastAiDiffs, onReShowHighlights }: ScriptTableProps) {
  const [activeId, setActiveId] = useState<string | null>(null);
  const [lightboxSrc, setLightboxSrc] = useState<string | null>(null);
  const [visualLightbox, setVisualLightbox] = useState<{ visualPath: string; rowIndex: number } | null>(null);
  const [nudgeInput, setNudgeInput] = useState("");
  const [lightboxMode, setLightboxMode] = useState<"preview" | "edit">("preview");
  const [editorDsl, setEditorDsl] = useState<ElucimDocument | null>(null);
  const [editorDirty, setEditorDirty] = useState(false);
  const focusCellAfterRender = useRef<number | null>(null);
  const [undoToast, setUndoToast] = useState<string | null>(null);
  const undoToastTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

  // ── Undo stack ──
  const undoStack = useRef<PlanningRow[][]>([]);
  const MAX_UNDO = 30;

  const pushUndo = useCallback(() => {
    undoStack.current = [...undoStack.current.slice(-(MAX_UNDO - 1)), structuredClone(rowsRef.current)];
  }, []);

  const popUndo = useCallback(() => {
    if (undoStack.current.length === 0) return;
    const prev = undoStack.current.pop()!;
    onChange(prev);
  }, [onChange]);

  // Ctrl+Z handler
  useEffect(() => {
    if (readOnly) return;
    const handleKey = (e: KeyboardEvent) => {
      if ((e.ctrlKey || e.metaKey) && e.key === "z" && !e.shiftKey) {
        if (undoStack.current.length > 0) {
          e.preventDefault();
          popUndo();
        }
      }
    };
    window.addEventListener("keydown", handleKey);
    return () => window.removeEventListener("keydown", handleKey);
  }, [readOnly, popUndo]);

  const showUndoToast = useCallback((msg: string) => {
    setUndoToast(msg);
    if (undoToastTimer.current) clearTimeout(undoToastTimer.current);
    undoToastTimer.current = setTimeout(() => setUndoToast(null), 6000);
  }, []);

  // Push to undo stack when AI edits arrive
  useEffect(() => {
    if (!aiSnapshotRows || !highlightedRows || highlightedRows.size === 0) return;
    undoStack.current = [...undoStack.current.slice(-(MAX_UNDO - 1)), structuredClone(aiSnapshotRows)];
    const rowNums = Array.from(highlightedRows).map((i) => i + 1).sort((a, b) => a - b);
    const label = rowNums.length <= 3
      ? `row${rowNums.length > 1 ? "s" : ""} ${rowNums.join(", ")}`
      : `${rowNums.length} rows`;
    showUndoToast(`Updated ${label} — Ctrl+Z to undo`);
  }, [aiSnapshotRows, highlightedRows, showUndoToast]);

  useEffect(() => {
    if (!lightboxSrc) return;
    const handleKey = (e: KeyboardEvent) => { if (e.key === "Escape") setLightboxSrc(null); };
    window.addEventListener("keydown", handleKey);
    return () => window.removeEventListener("keydown", handleKey);
  }, [lightboxSrc]);

  useEffect(() => {
    if (!visualLightbox) return;
    const handleKey = (e: KeyboardEvent) => {
      // In edit mode, only close on explicit X button — let editor handle Escape
      if (lightboxMode === "edit") return;
      if (e.key === "Escape") { closeLightbox(); }
    };
    window.addEventListener("keydown", handleKey);
    return () => window.removeEventListener("keydown", handleKey);
  }, [visualLightbox, lightboxMode]);

  // Load DSL when entering edit mode
  useEffect(() => {
    if (!visualLightbox || lightboxMode !== "edit") {
      setEditorDsl(null);
      setEditorDirty(false);
      return;
    }
    invoke<Record<string, unknown>>("get_visual", { relativePath: visualLightbox.visualPath })
      .then((data) => setEditorDsl(data as unknown as ElucimDocument))
      .catch((err) => console.error("[ScriptTable] Failed to load visual for editor:", err));
  }, [visualLightbox?.visualPath, lightboxMode]);

  // Resolve CutReady CSS vars to editor theme overrides.
  // With 0.9.0, color-scheme drives light/dark defaults for unset tokens.
  const editorTheme = useMemo(() => {
    const s = getComputedStyle(document.documentElement);
    const get = (v: string, fb: string) => s.getPropertyValue(v).trim() || fb;
    const isDark = document.documentElement.classList.contains("dark");

    return {
      "color-scheme": isDark ? "dark" : "light",
      accent: get("--color-accent", isDark ? "#a49afa" : "#6b5ce7"),
      bg: get("--color-surface", isDark ? "#2b2926" : "#faf9f7"),
      surface: get("--color-surface-alt", isDark ? "#353230" : "#f0efed"),
      fg: get("--color-text", isDark ? "#e8e4df" : "#2c2925"),
      "text-secondary": get("--color-text-secondary", isDark ? "#a09b93" : "#78756f"),
      border: get("--color-border", isDark ? "#4a4644" : "#e2e0dd"),
      panel: isDark ? "rgba(43,41,38,0.95)" : "rgba(250,249,247,0.95)",
      chrome: isDark ? "rgba(53,50,48,0.85)" : "rgba(240,239,237,0.85)",
      "input-bg": isDark ? "#231f1d" : "#ffffff",
    };
  }, [visualLightbox]);

  // Token map for resolving $foreground, $surface, etc. in DSL documents
  const tokenColors = useMemo(() => {
    const s = getComputedStyle(document.documentElement);
    const get = (v: string, fb: string) => s.getPropertyValue(v).trim() || fb;
    const isDark = document.documentElement.classList.contains("dark");
    const fg = get("--color-text", isDark ? "#e8e4df" : "#2c2925");
    const bg = get("--color-surface", isDark ? "#2b2926" : "#faf9f7");
    const accent = get("--color-accent", isDark ? "#a49afa" : "#6b5ce7");
    return {
      foreground: fg,
      background: bg,
      accent,
      muted: get("--color-text-secondary", isDark ? "#a09b93" : "#78756f"),
      surface: get("--color-surface-alt", isDark ? "#353230" : "#f0efed"),
      border: get("--color-border", isDark ? "#4a4644" : "#e2e0dd"),
      primary: accent,
      secondary: isDark ? "#a78bfa" : "#7c3aed",
      tertiary: isDark ? "#f472b6" : "#db2777",
      success: isDark ? "#34d399" : "#16a34a",
      warning: isDark ? "#fbbf24" : "#d97706",
      error: isDark ? "#f87171" : "#dc2626",
    };
  }, [visualLightbox]);

  const closeLightbox = useCallback(() => {
    setVisualLightbox(null);
    setNudgeInput("");
    setLightboxMode("preview");
    setEditorDsl(null);
    setEditorDirty(false);
  }, []);

  const saveEditorChanges = useCallback(async (doc: ElucimDocument) => {
    if (!visualLightbox) return;
    try {
      await invoke("write_visual_doc", {
        relativePath: visualLightbox.visualPath,
        document: doc,
      });
      setEditorDirty(false);
    } catch (err) {
      console.error("[ScriptTable] Failed to save visual:", err);
    }
  }, [visualLightbox]);

  const sensors = useSensors(
    useSensor(PointerSensor, { activationConstraint: { distance: 5 } }),
  );

  // Ensure at least one row exists (materialize instead of phantom displayRows)
  useEffect(() => {
    if (rows.length === 0 && !readOnly) {
      onChange([emptyRow()]);
    }
  }, [rows.length, readOnly, onChange]);

  // Focus a cell after rows change (e.g. after addRow)
  useEffect(() => {
    if (focusCellAfterRender.current !== null) {
      const cellIdx = focusCellAfterRender.current;
      focusCellAfterRender.current = null;
      requestAnimationFrame(() => {
        const table = document.querySelector(".script-table-wrapper table");
        if (!table) return;
        const cell = table.querySelector<HTMLElement>(`[data-tab-cell="${cellIdx}"]`);
        if (!cell) return;
        const focusable = cell.querySelector<HTMLElement>("input, textarea, [tabindex='0'], [data-cell]");
        if (focusable) focusable.focus();
      });
    }
  }, [rows.length]);

  // Always-current ref to avoid stale closure issues in callbacks
  const rowsRef = useRef(rows);
  rowsRef.current = rows;

  // Stable IDs for each row (index-based, reset when row count changes)
  const rowIds = useMemo(
    () => rows.map((_, i) => `row-${i}`),
    [rows.length],
  );

  const updateRow = useCallback(
    (index: number, field: keyof PlanningRow, value: string) => {
      pushUndo();
      const updated = rowsRef.current.map((r, i) =>
        i === index ? { ...r, [field]: value } : r,
      );
      onChange(updated);
    },
    [onChange, pushUndo],
  );

  const addRow = useCallback(
    (afterIndex: number) => {
      pushUndo();
      const updated = [...rowsRef.current];
      updated.splice(afterIndex + 1, 0, emptyRow());
      // Schedule focus on the new row's Time cell
      focusCellAfterRender.current = (afterIndex + 1) * 3;
      onChange(updated);
    },
    [onChange, pushUndo],
  );

  const deleteRow = useCallback(
    (index: number) => {
      if (rowsRef.current.length <= 1) return;
      pushUndo();
      const updated = rowsRef.current.filter((_, i) => i !== index);
      onChange(updated);
      showUndoToast("Row deleted — Ctrl+Z to undo");
    },
    [onChange, pushUndo, showUndoToast],
  );

  const removeVisual = useCallback(
    (index: number) => {
      pushUndo();
      const updated = rowsRef.current.map((r, i) =>
        i === index ? { ...r, visual: null } : r,
      );
      onChange(updated);
    },
    [onChange, pushUndo],
  );

  const handleDragEnd = useCallback(
    (event: DragEndEvent) => {
      const { active, over } = event;
      setActiveId(null);
      if (!over || active.id === over.id) return;
      const oldIndex = rowIds.indexOf(active.id as string);
      const newIndex = rowIds.indexOf(over.id as string);
      if (oldIndex === -1 || newIndex === -1) return;
      pushUndo();
      const updated = [...rowsRef.current];
      const [moved] = updated.splice(oldIndex, 1);
      updated.splice(newIndex, 0, moved);
      onChange(updated);
    },
    [onChange, rowIds, pushUndo],
  );

  const activeIdx = activeId ? rowIds.indexOf(activeId) : -1;

  // Brief guard while the useEffect materializes the first row
  if (rows.length === 0) return null;

  return (
    <div className={`script-table-wrapper overflow-hidden${readOnly ? "" : " my-4"}`}>
      {/* Re-show last AI changes button */}
      {hasLastAiDiffs && onReShowHighlights && (
        <div className="flex justify-end px-1 pb-1.5">
          <button
            onClick={onReShowHighlights}
            className="inline-flex items-center gap-1.5 px-2.5 py-1 text-[11px] font-medium rounded-md border transition-colors
              bg-[var(--color-accent)]/8 text-[var(--color-accent)] border-[var(--color-accent)]/20
              hover:bg-[var(--color-accent)]/15 hover:border-[var(--color-accent)]/30"
          >
            <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
              <path d="M2 12s3-7 10-7 10 7 10 7-3 7-10 7-10-7-10-7Z" />
              <circle cx="12" cy="12" r="3" />
            </svg>
            Show AI Changes
          </button>
        </div>
      )}
      <DndContext
        sensors={sensors}
        collisionDetection={closestCenter}
        onDragStart={(e) => setActiveId(e.active.id as string)}
        onDragEnd={handleDragEnd}
      >
        <SortableContext items={rowIds} strategy={verticalListSortingStrategy}>
          <table className="w-full" style={{ tableLayout: "fixed", borderSpacing: "0 4px", borderCollapse: "separate" }}>
            <colgroup>
              {!readOnly && <col style={{ width: 28 }} />}
              <col style={{ width: 54 }} />
              <col />
              <col />
              <col style={{ width: 180 }} />
              {!readOnly && <col style={{ width: 36 }} />}
            </colgroup>
            <thead>
              <tr>
                {!readOnly && <th className="script-table-th" />}
                <th className="script-table-th">Time</th>
                <th className="script-table-th">Narrative</th>
                <th className="script-table-th">Actions</th>
                <th className="script-table-th">Screenshot</th>
                {!readOnly && <th className="script-table-th" />}
              </tr>
            </thead>
            <tbody>
              {rows.map((row, idx) => (
                <SortableRow
                  key={rowIds[idx]}
                  id={rowIds[idx]}
                  row={row}
                  idx={idx}
                  readOnly={readOnly}
                  updateRow={updateRow}
                  addRow={addRow}
                  deleteRow={deleteRow}
                  isDragging={activeIdx === idx}
                  isLastRow={idx === rows.length - 1}
                  onCaptureScreenshot={onCaptureScreenshot}
                  onPickImage={onPickImage}
                  onBrowseImage={onBrowseImage}
                  onSparkle={onSparkle}
                  onGenerateVisual={onGenerateVisual}
                  onRemoveVisual={removeVisual}
                  projectRoot={projectRoot}
                  sketchPath={sketchPath}
                  onImageClick={setLightboxSrc}
                  onVisualClick={(visualPath, rowIdx) => setVisualLightbox({ visualPath, rowIndex: rowIdx })}
                  isHighlighted={highlightedRows?.has(idx) ?? false}
                  rowDiff={rowDiffs?.find((d) => d.rowIndex === idx)}
                  onDismissHighlight={onDismissHighlights}
                />
              ))}
            </tbody>
          </table>
        </SortableContext>
        <DragOverlay>
          {activeIdx >= 0 ? (
            <table className="w-full" style={{ borderCollapse: "separate" }}>
              <tbody>
                <tr className="card-row shadow-lg" style={{ backgroundColor: "var(--color-surface-alt)" }}>
                  {!readOnly && <td className="p-1 w-7" style={{ borderLeft: `3px solid ${getRowColor(activeIdx)}` }} />}
                  <td className="script-table-td text-xs" style={{ width: 50 }}>{rows[activeIdx].time}</td>
                  <td className="script-table-td text-xs">
                    {rows[activeIdx].narrative || "—"}
                  </td>
                  <td className="script-table-td text-xs">
                    {rows[activeIdx].demo_actions || "—"}
                  </td>
                  <td className="script-table-td text-xs text-center">—</td>
                  {!readOnly && <td className="script-table-td" />}
                </tr>
              </tbody>
            </table>
          ) : null}
        </DragOverlay>
      </DndContext>

      {/* Lightbox overlay */}
      {lightboxSrc && (
        <div
          className="fixed inset-0 z-[9999] flex items-center justify-center bg-black/80 cursor-pointer"
          onClick={() => setLightboxSrc(null)}
        >
          <img
            src={lightboxSrc}
            alt="Screenshot preview"
            className="max-w-[90vw] max-h-[90vh] object-contain rounded-lg shadow-2xl"
            onClick={(e) => e.stopPropagation()}
          />
          <button
            onClick={() => setLightboxSrc(null)}
            className="absolute top-4 right-4 p-2 rounded-full bg-black/50 text-white/80 hover:text-white transition-colors"
          >
            <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
              <line x1="18" y1="6" x2="6" y2="18" />
              <line x1="6" y1="6" x2="18" y2="18" />
            </svg>
          </button>
        </div>
      )}

      {/* Visual lightbox — near-fullscreen with preview/edit toggle */}
      {visualLightbox && (
        <div
          className="fixed inset-0 z-[9999] flex items-center justify-center bg-black/80"
          onClick={() => {
            if (lightboxMode === "edit" && editorDirty) return; // don't close dirty editor by backdrop click
            closeLightbox();
          }}
        >
          <div
            className="relative flex flex-col rounded-xl overflow-hidden shadow-2xl bg-[var(--color-surface)]"
            style={{ width: "calc(100vw - 60px)", height: "calc(100vh - 60px)" }}
            onClick={(e) => e.stopPropagation()}
          >
            {/* Header bar */}
            <div className="flex items-center justify-between px-4 py-2 border-b border-[var(--color-border)] bg-[var(--color-surface-alt)] shrink-0">
              <div className="flex items-center gap-3">
                <span className="text-[13px] font-medium text-[var(--color-text)]">
                  Row {visualLightbox.rowIndex + 1}
                </span>
                {/* Preview / Edit toggle */}
                {!readOnly && (
                  <div className="flex items-center rounded-lg bg-[var(--color-surface)] border border-[var(--color-border)] p-0.5">
                    <button
                      onClick={() => setLightboxMode("preview")}
                      className={`px-3 py-1 rounded-md text-[12px] font-medium transition-colors ${
                        lightboxMode === "preview"
                          ? "bg-[var(--color-accent)] text-white"
                          : "text-[var(--color-text-secondary)] hover:text-[var(--color-text)]"
                      }`}
                    >
                      Preview
                    </button>
                    <button
                      onClick={() => setLightboxMode("edit")}
                      className={`px-3 py-1 rounded-md text-[12px] font-medium transition-colors ${
                        lightboxMode === "edit"
                          ? "bg-[var(--color-accent)] text-white"
                          : "text-[var(--color-text-secondary)] hover:text-[var(--color-text)]"
                      }`}
                    >
                      Edit
                    </button>
                  </div>
                )}
                {editorDirty && (
                  <span className="text-[11px] text-[var(--color-accent)] font-medium">● Unsaved</span>
                )}
              </div>
              <div className="flex items-center gap-2">
                {/* Save button (edit mode only) */}
                {lightboxMode === "edit" && editorDirty && editorDsl && (
                  <button
                    onClick={() => saveEditorChanges(editorDsl)}
                    className="px-3 py-1.5 rounded-lg bg-[var(--color-accent)] text-white text-[12px] font-medium hover:bg-[var(--color-accent-hover)] transition-colors"
                  >
                    Save
                  </button>
                )}
                {/* Close button */}
                <button
                  onClick={closeLightbox}
                  className="p-1.5 rounded-lg text-[var(--color-text-secondary)] hover:text-[var(--color-text)] hover:bg-[var(--color-surface)] transition-colors"
                >
                  <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                    <line x1="18" y1="6" x2="6" y2="18" />
                    <line x1="6" y1="6" x2="18" y2="18" />
                  </svg>
                </button>
              </div>
            </div>

            {/* Content area */}
            <div className="flex-1 min-h-0 relative">
              {lightboxMode === "preview" ? (
                /* Preview mode — DslRenderer */
                <div className="w-full h-full flex items-center justify-center">
                  <div className="rounded-lg overflow-hidden shadow-lg bg-[var(--color-surface)]" style={{ width: "100%", height: "100%", maxWidth: "1280px", aspectRatio: "960 / 540", margin: "auto" }}>
                    <Suspense fallback={<div className="w-full h-full bg-[var(--color-surface-alt)] animate-pulse" />}>
                      <VisualCell
                        visualPath={visualLightbox.visualPath}
                        mode="full"
                        className="w-full h-full"
                      />
                    </Suspense>
                  </div>
                </div>
              ) : (
                /* Edit mode — ElucimEditor */
                <Suspense fallback={<div className="w-full h-full flex items-center justify-center text-[var(--color-text-secondary)]">Loading editor…</div>}>
                  {editorDsl ? (
                    <EditorWrapper
                      dsl={editorDsl}
                      theme={editorTheme}
                      tokenColors={tokenColors}
                      onDocumentChange={(doc) => { setEditorDsl(doc); setEditorDirty(true); }}
                    />
                  ) : (
                    <div className="w-full h-full flex items-center justify-center text-[var(--color-text-secondary)]">Loading…</div>
                  )}
                </Suspense>
              )}
            </div>

            {/* Nudge bar (preview mode only — editor has its own timeline) */}
            {onNudgeVisual && !readOnly && lightboxMode === "preview" && (
              <div className="flex items-center gap-2 px-4 py-2 border-t border-[var(--color-border)] bg-[var(--color-surface-alt)] shrink-0">
                <input
                  type="text"
                  value={nudgeInput}
                  onChange={(e) => setNudgeInput(e.target.value)}
                  onKeyDown={(e) => {
                    if (e.key === "Enter" && nudgeInput.trim()) {
                      onNudgeVisual(visualLightbox.rowIndex, nudgeInput.trim());
                      setNudgeInput("");
                    }
                    e.stopPropagation(); // prevent editor shortcuts
                  }}
                  placeholder={`"make the title bigger", "change color to blue"…`}
                  className="flex-1 px-3 py-1.5 rounded-lg bg-[var(--color-surface)] border border-[var(--color-border)] text-[var(--color-text)] text-[13px] placeholder:text-[var(--color-text-secondary)]/50 focus:outline-none focus:ring-1 focus:ring-[var(--color-accent)]"
                />
                <button
                  onClick={() => {
                    if (nudgeInput.trim()) {
                      onNudgeVisual(visualLightbox.rowIndex, nudgeInput.trim());
                      setNudgeInput("");
                    }
                  }}
                  disabled={!nudgeInput.trim()}
                  className="p-1.5 rounded-lg text-[var(--color-text-secondary)] hover:text-[var(--color-text)] disabled:opacity-30 transition-colors"
                >
                  <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                    <path d="M12 3l1.912 5.813a2 2 0 0 0 1.275 1.275L21 12l-5.813 1.912a2 2 0 0 0-1.275 1.275L12 21l-1.912-5.813a2 2 0 0 0-1.275-1.275L3 12l5.813-1.912a2 2 0 0 0 1.275-1.275L12 3z" />
                  </svg>
                </button>
              </div>
            )}
          </div>
        </div>
      )}

      {/* Undo toast */}
      {undoToast && (
        <div className="fixed bottom-4 left-1/2 -translate-x-1/2 z-[9999] flex items-center gap-2 px-3 py-2 rounded-lg bg-[var(--color-surface)] border border-[var(--color-border)] shadow-lg text-[12px] text-[var(--color-text)]">
          <span>{undoToast}</span>
          <button
            onClick={() => { popUndo(); setUndoToast(null); }}
            className="px-2 py-0.5 rounded text-[11px] font-medium text-[var(--color-accent)] hover:bg-[var(--color-accent)]/10 transition-colors"
          >
            Undo
          </button>
          <button
            onClick={() => setUndoToast(null)}
            className="p-0.5 text-[var(--color-text-secondary)] hover:text-[var(--color-text)] transition-colors"
          >
            <svg width="10" height="10" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><line x1="18" y1="6" x2="6" y2="18" /><line x1="6" y1="6" x2="18" y2="18" /></svg>
          </button>
        </div>
      )}
    </div>
  );
}

/* ── Sortable Row ──────────────────────────────────────────── */

function SortableRow({
  id,
  row,
  idx,
  readOnly,
  updateRow,
  addRow,
  deleteRow,
  isDragging,
  isLastRow,
  onCaptureScreenshot,
  onPickImage,
  onBrowseImage,
  onSparkle,
  onGenerateVisual,
  onRemoveVisual,
  projectRoot,
  sketchPath,
  onImageClick,
  onVisualClick,
  isHighlighted,
  rowDiff,
  onDismissHighlight,
}: {
  id: string;
  row: PlanningRow;
  idx: number;
  readOnly: boolean;
  updateRow: (index: number, field: keyof PlanningRow, value: string) => void;
  addRow: (afterIndex: number) => void;
  deleteRow: (index: number) => void;
  isDragging: boolean;
  isLastRow: boolean;
  onCaptureScreenshot?: (rowIndex: number) => void;
  onPickImage?: (rowIndex: number) => void;
  onBrowseImage?: (rowIndex: number) => void;
  onSparkle?: (prompt: string) => void;
  onGenerateVisual?: (rowIndex: number) => void;
  onRemoveVisual?: (rowIndex: number) => void;
  projectRoot?: string;
  sketchPath?: string;
  onImageClick: (src: string) => void;
  onVisualClick: (visualPath: string, rowIndex: number) => void;
  isHighlighted?: boolean;
  rowDiff?: RowDiff;
  onDismissHighlight?: () => void;
}){
  const [diffExpanded, setDiffExpanded] = useState(true);
  const {
    attributes,
    listeners,
    setNodeRef,
    transform,
    transition,
    isSorting,
  } = useSortable({ id });

  const style = {
    transform: CSS.Transform.toString(transform),
    transition,
    opacity: isDragging ? 0.3 : 1,
  };

  const accentColor = getRowColor(idx);
  const rowBg = idx % 2 === 0 ? "var(--color-surface-alt)" : "var(--color-surface-inset)";

  return (
    <>
    <tr
      ref={setNodeRef}
      style={{ ...style, backgroundColor: isHighlighted ? undefined : rowBg }}
      className={`card-row group hover:shadow-sm ${isSorting ? "" : "transition-all"} ${isHighlighted ? "ai-highlight-row" : ""}`}
      onKeyDown={(e) => {
        if (readOnly) return;
        // Ctrl+Enter → add row below
        if (e.key === "Enter" && (e.ctrlKey || e.metaKey)) {
          e.preventDefault();
          e.stopPropagation();
          addRow(idx);
          // Focus first editable cell in new row on next tick
          requestAnimationFrame(() => {
            const tr = (e.target as HTMLElement).closest("tr");
            const nextRow = tr?.nextElementSibling;
            const cell = nextRow?.querySelector<HTMLElement>("input:not([readonly]), [data-cell]");
            cell?.focus();
          });
          return;
        }
        // Ctrl+Backspace → delete current row
        if (e.key === "Backspace" && (e.ctrlKey || e.metaKey)) {
          e.preventDefault();
          e.stopPropagation();
          deleteRow(idx);
          return;
        }
      }}
    >
      {!readOnly && (
        <td className="p-0 align-middle" style={{ borderLeft: `3px solid ${accentColor}` }}>
          <div
            className="cursor-grab active:cursor-grabbing text-[var(--color-text-secondary)] flex items-center justify-center h-full"
            {...attributes}
            {...listeners}
          >
            {/* Row number (visible by default), drag icon on hover */}
            <span className="text-[0.625rem] font-medium opacity-40 group-hover:hidden">{idx + 1}</span>
            <svg className="hidden group-hover:block opacity-50 hover:opacity-100 transition-opacity" width="12" height="12" viewBox="0 0 24 24" fill="currentColor">
              <circle cx="9" cy="5" r="1.5" />
              <circle cx="15" cy="5" r="1.5" />
              <circle cx="9" cy="12" r="1.5" />
              <circle cx="15" cy="12" r="1.5" />
              <circle cx="9" cy="19" r="1.5" />
              <circle cx="15" cy="19" r="1.5" />
            </svg>
          </div>
        </td>
      )}
      <td className="py-2 px-1.5 align-top text-[0.8125rem]" style={readOnly ? { borderLeft: `3px solid ${accentColor}` } : undefined}>
        <div data-tab-cell={idx * 3}>
          <LocalInput
            value={row.time}
            onChange={(v) => updateRow(idx, "time", v)}
            placeholder="~30s"
            readOnly={readOnly}
            onAddRow={isLastRow && !readOnly ? () => addRow(idx) : undefined}
          />
        </div>
      </td>
      <td className="script-table-td align-top overflow-hidden">
        <div data-tab-cell={idx * 3 + 1} className="relative group/cell">
          <MarkdownCell
            value={row.narrative}
            onChange={(v) => updateRow(idx, "narrative", v)}
            placeholder="What to say..."
            readOnly={readOnly}
            onAddRow={isLastRow && !readOnly ? () => addRow(idx) : undefined}
          />
          {onSparkle && !readOnly && (
            <SparkleButton onClick={() => onSparkle(
              `Improve the narrative for row ${idx + 1} of sketch "${sketchPath ?? "current"}". Current text: "${row.narrative}". Make it more engaging and natural for spoken delivery. Use update_planning_row to change only this row.`
            )} />
          )}
        </div>
      </td>
      <td className="script-table-td align-top overflow-hidden">
        <div data-tab-cell={idx * 3 + 2} className="relative group/cell">
          <MarkdownCell
            value={row.demo_actions}
            onChange={(v) => updateRow(idx, "demo_actions", v)}
            placeholder="What to do..."
            readOnly={readOnly}
            onAddRow={isLastRow && !readOnly ? () => addRow(idx) : undefined}
          />
          {onSparkle && !readOnly && (
            <SparkleButton onClick={() => onSparkle(
              `Improve the demo actions for row ${idx + 1} of sketch "${sketchPath ?? "current"}". Current text: "${row.demo_actions}". Make the steps clearer and more specific. Use update_planning_row to change only this row.`
            )} />
          )}
        </div>
      </td>
      <td className="script-table-td align-top text-center">
        {row.visual ? (
          /* ── Elucim animated visual ── */
          <div className="relative group/vis cursor-pointer" onClick={() => onVisualClick(row.visual!, idx)}>
            <Suspense fallback={<div className="w-40 h-24 rounded-md bg-[var(--color-surface-alt)] border border-[var(--color-border)] animate-pulse" />}>
              <VisualCell
                visualPath={row.visual!}
                mode="thumbnail"
              />
            </Suspense>
            {/* Hover overlay with action buttons */}
            <div className="absolute inset-0 bg-black/40 opacity-0 group-hover/vis:opacity-100 transition-opacity flex items-center justify-center gap-1.5 rounded-md" onClick={(e) => e.stopPropagation()}>
              {/* Expand / preview */}
              <button
                onClick={() => onVisualClick(row.visual!, idx)}
                className="p-1 rounded-full bg-white/20 text-white/90 hover:bg-white/40"
                title="Preview visual (click to edit)"
              >
                <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                  <path d="M15 3h6v6" /><path d="M9 21H3v-6" /><path d="M21 3l-7 7" /><path d="M3 21l7-7" />
                </svg>
              </button>
              {/* Regenerate visual */}
              {!readOnly && onGenerateVisual && (
                <button
                  onClick={() => onGenerateVisual(idx)}
                  className="p-1 rounded-full bg-white/20 text-white/90 hover:bg-[var(--color-accent)]/80"
                  title="Regenerate visual with AI"
                >
                  <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                    <path d="M12 3l1.5 4.5L18 9l-4.5 1.5L12 15l-1.5-4.5L6 9l4.5-1.5L12 3z" />
                    <path d="M20 11l.75 2.25L23 14l-2.25.75L20 17l-.75-2.25L17 14l2.25-.75L20 11z" />
                  </svg>
                </button>
              )}
              {/* Remove visual */}
              {!readOnly && (
                <button
                  onClick={() => onRemoveVisual?.(idx)}
                  className="p-1 rounded-full bg-white/20 text-white/90 hover:bg-red-500/80"
                  title="Remove visual"
                >
                  <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                    <line x1="18" y1="6" x2="6" y2="18" /><line x1="6" y1="6" x2="18" y2="18" />
                  </svg>
                </button>
              )}
            </div>
          </div>
        ) : row.screenshot ? (
          <div className="relative group/ss w-40 h-24 rounded-md bg-[var(--color-surface-alt)] border border-[var(--color-border)] overflow-hidden cursor-pointer"
            onClick={() => {
              const src = projectRoot ? convertFileSrc(`${projectRoot}/${row.screenshot}`) : row.screenshot!;
              onImageClick(src);
            }}
          >
            <img
              src={projectRoot ? convertFileSrc(`${projectRoot}/${row.screenshot}`) : row.screenshot}
              alt=""
              className="w-full h-full object-cover"
            />
            {!readOnly && (
              <div className="absolute inset-0 bg-black/50 opacity-0 group-hover/ss:opacity-100 transition-opacity flex items-center justify-center gap-1.5" onClick={(e) => e.stopPropagation()}>
                {/* View */}
                <button
                  onClick={() => {
                    const src = projectRoot ? convertFileSrc(`${projectRoot}/${row.screenshot}`) : row.screenshot!;
                    onImageClick(src);
                  }}
                  className="p-1 rounded-full bg-white/20 text-white/90 hover:bg-white/30"
                  title="View image"
                >
                  <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                    <circle cx="11" cy="11" r="8" /><line x1="21" y1="21" x2="16.65" y2="16.65" />
                  </svg>
                </button>
                {/* Re-capture */}
                <button
                  onClick={() => onCaptureScreenshot?.(idx)}
                  className="p-1 rounded-full bg-white/20 text-white/90 hover:bg-white/30"
                  title="Re-capture screenshot"
                >
                  <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                    <path d="M23 19a2 2 0 01-2 2H3a2 2 0 01-2-2V8a2 2 0 012-2h4l2-3h6l2 3h4a2 2 0 012 2z" />
                    <circle cx="12" cy="13" r="4" />
                  </svg>
                </button>
                {/* Pick from project */}
                {onPickImage && (
                  <button
                    onClick={() => onPickImage(idx)}
                    className="p-1 rounded-full bg-white/20 text-white/90 hover:bg-white/30"
                    title="Pick from workspace images"
                  >
                    <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                      <rect x="3" y="3" width="18" height="18" rx="2" ry="2" /><circle cx="8.5" cy="8.5" r="1.5" /><polyline points="21 15 16 10 5 21" />
                    </svg>
                  </button>
                )}
                {/* Browse filesystem */}
                {onBrowseImage && (
                  <button
                    onClick={() => onBrowseImage(idx)}
                    className="p-1 rounded-full bg-white/20 text-white/90 hover:bg-white/30"
                    title="Browse for image file"
                  >
                    <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                      <path d="M22 19a2 2 0 01-2 2H4a2 2 0 01-2-2V5a2 2 0 012-2h5l2 3h9a2 2 0 012 2z" />
                    </svg>
                  </button>
                )}
                {/* Remove */}
                <button
                  onClick={() => updateRow(idx, "screenshot", "")}
                  className="p-1 rounded-full bg-white/20 text-white/90 hover:bg-red-500/80"
                  title="Remove screenshot"
                >
                  <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                    <line x1="18" y1="6" x2="6" y2="18" /><line x1="6" y1="6" x2="18" y2="18" />
                  </svg>
                </button>
              </div>
            )}
          </div>
        ) : !readOnly ? (
          <div className="flex items-center gap-1">
            <button
              onClick={() => onCaptureScreenshot?.(idx)}
              className="w-7 h-7 rounded-md border border-dashed border-[var(--color-border)] hover:border-[var(--color-accent)] hover:bg-[var(--color-accent)]/5 transition-colors flex items-center justify-center group/cap"
              title="Capture screenshot"
            >
              <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round"
                className="text-[var(--color-text-secondary)] group-hover/cap:text-[var(--color-accent)] transition-colors">
                <path d="M23 19a2 2 0 01-2 2H3a2 2 0 01-2-2V8a2 2 0 012-2h4l2-3h6l2 3h4a2 2 0 012 2z" />
                <circle cx="12" cy="13" r="4" />
              </svg>
            </button>
            {onPickImage && (
              <button
                onClick={() => onPickImage(idx)}
                className="w-7 h-7 rounded-md border border-dashed border-[var(--color-border)] hover:border-[var(--color-accent)] hover:bg-[var(--color-accent)]/5 transition-colors flex items-center justify-center group/pick"
                title="Pick from workspace images"
              >
                <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round"
                  className="text-[var(--color-text-secondary)] group-hover/pick:text-[var(--color-accent)] transition-colors">
                  <rect x="3" y="3" width="18" height="18" rx="2" ry="2" />
                  <circle cx="8.5" cy="8.5" r="1.5" />
                  <polyline points="21 15 16 10 5 21" />
                </svg>
              </button>
            )}
            {onBrowseImage && (
              <button
                onClick={() => onBrowseImage(idx)}
                className="w-7 h-7 rounded-md border border-dashed border-[var(--color-border)] hover:border-[var(--color-accent)] hover:bg-[var(--color-accent)]/5 transition-colors flex items-center justify-center group/browse"
                title="Browse for image file"
              >
                <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round"
                  className="text-[var(--color-text-secondary)] group-hover/browse:text-[var(--color-accent)] transition-colors">
                  <path d="M22 19a2 2 0 01-2 2H4a2 2 0 01-2-2V5a2 2 0 012-2h5l2 3h9a2 2 0 012 2z" />
                </svg>
              </button>
            )}
            {onGenerateVisual && (
              <button
                onClick={() => onGenerateVisual(idx)}
                className="w-7 h-7 rounded-md border border-dashed border-[var(--color-border)] hover:border-[var(--color-accent)] hover:bg-[var(--color-accent)]/5 transition-colors flex items-center justify-center group/gen"
                title="Generate visual with AI"
              >
                <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round"
                  className="text-[var(--color-text-secondary)] group-hover/gen:text-[var(--color-accent)] transition-colors">
                  <path d="M12 3l1.5 4.5L18 9l-4.5 1.5L12 15l-1.5-4.5L6 9l4.5-1.5L12 3z" />
                  <path d="M20 11l.75 2.25L23 14l-2.25.75L20 17l-.75-2.25L17 14l2.25-.75L20 11z" />
                </svg>
              </button>
            )}
          </div>
        ) : (
          <span className="text-[10px] text-[var(--color-text-secondary)]">—</span>
        )}
      </td>
      {!readOnly && (
        <td className="p-1 align-top">
          <div className="flex flex-col gap-0.5 opacity-0 group-hover:opacity-100 transition-opacity">
            <button
              onClick={() => addRow(idx)}
              className="p-0.5 rounded text-[var(--color-text-secondary)] hover:text-[var(--color-accent)] transition-colors"
              title="Add row below"
            >
              <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                <line x1="12" y1="5" x2="12" y2="19" />
                <line x1="5" y1="12" x2="19" y2="12" />
              </svg>
            </button>
            <button
              onClick={() => deleteRow(idx)}
              className="p-0.5 rounded text-[var(--color-text-secondary)] hover:text-red-500 transition-colors"
              title="Delete row"
            >
              <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                <line x1="18" y1="6" x2="6" y2="18" />
                <line x1="6" y1="6" x2="18" y2="18" />
              </svg>
            </button>
          </div>
        </td>
      )}
    </tr>
    {/* AI diff strip — shows inline diffs below changed rows */}
    {isHighlighted && rowDiff && diffExpanded && (
      <tr>
        <td colSpan={readOnly ? 4 : 6} className="p-0">
          <div className="ai-diff-strip mx-2 mb-1 px-3 py-2 rounded-b-lg text-xs">
            <div className="flex items-center justify-between mb-1">
              <span className="font-medium text-[var(--color-accent)] flex items-center gap-1.5">
                <svg width="11" height="11" viewBox="0 0 24 24" fill="currentColor"><path d="M12 2l2.09 6.26L20.18 10l-6.09 1.74L12 18l-2.09-6.26L3.82 10l6.09-1.74L12 2z" /></svg>
                Row {idx + 1} changed
              </span>
              <button
                onClick={() => { setDiffExpanded(false); onDismissHighlight?.(); }}
                className="p-0.5 rounded hover:bg-[var(--color-border)]/30 text-[var(--color-text-secondary)]"
              >
                <svg width="10" height="10" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5"><path d="M18 6L6 18M6 6l12 12" /></svg>
              </button>
            </div>
            {rowDiff.fields.map((f) => (
              <div key={f.field} className="mb-0.5">
                <span className="text-[var(--color-text-secondary)] font-medium">{f.field}: </span>
                {f.segments.map((seg, si) => (
                  <span key={si} className={
                    seg.type === "added" ? "ai-diff-added" :
                    seg.type === "removed" ? "ai-diff-removed" : ""
                  }>{seg.text}</span>
                ))}
              </div>
            ))}
          </div>
        </td>
      </tr>
    )}
    </>
  );
}

/* ── Local-state input (immune to debounced prop lag) ──────── */

function LocalInput({
  value,
  onChange,
  placeholder,
  readOnly,
  onAddRow,
}: {
  value: string;
  onChange: (v: string) => void;
  placeholder: string;
  readOnly: boolean;
  onAddRow?: () => void;
}) {
  const [local, setLocal] = useState(value);
  const isFocusedRef = useRef(false);

  useEffect(() => {
    if (!isFocusedRef.current) setLocal(value);
  }, [value]);

  return (
    <input
      type="text"
      value={local}
      onChange={(e) => {
        setLocal(e.target.value);
        onChange(e.target.value);
      }}
      onFocus={() => { isFocusedRef.current = true; }}
      onBlur={() => { isFocusedRef.current = false; }}
      onKeyDown={(e) => {
        if (e.key === "Tab") {
          e.preventDefault();
          const moved = focusAdjacentCell(e.currentTarget, e.shiftKey);
          if (!moved && !e.shiftKey && onAddRow) onAddRow();
        }
      }}
      placeholder={placeholder}
      readOnly={readOnly}
      className="w-full bg-transparent text-xs px-1 py-0.5 rounded outline-none transition-colors focus:ring-1 focus:ring-[var(--color-accent)]/40 placeholder:text-[var(--color-text-secondary)]/40"
    />
  );
}

/** Move focus to the next (or previous) editable cell in the table.
 *  Returns true if focus moved, false if there was no cell to move to. */
function focusAdjacentCell(from: HTMLElement, reverse = false): boolean {
  const table = from.closest("table");
  if (!table) return false;
  // Use data-tab-order for explicit tab sequence
  const cells = Array.from(
    table.querySelectorAll<HTMLElement>("[data-tab-cell]"),
  );
  // Sort by data-tab-cell numeric value for correct order
  cells.sort((a, b) => {
    const ai = parseInt(a.getAttribute("data-tab-cell") || "0", 10);
    const bi = parseInt(b.getAttribute("data-tab-cell") || "0", 10);
    return ai - bi;
  });
  const td = from.closest("td");
  const idx = cells.findIndex((el) => td?.contains(el));
  if (idx === -1) return false;
  const next = cells[reverse ? idx - 1 : idx + 1];
  if (next) {
    // Find the first focusable element inside the wrapper
    const focusable = next.querySelector<HTMLElement>(
      "input, textarea, [tabindex='0'], [data-cell]"
    );
    if (focusable) { focusable.focus(); } else { next.focus(); }
    return true;
  }
  return false;
}

/* ── Inline formatting: **bold** and *italic* ──────────────── */

function formatInline(text: string): ReactNode {
  const parts: ReactNode[] = [];
  const regex = /(\*\*(.+?)\*\*|\*(.+?)\*)/g;
  let lastIndex = 0;
  let match;
  let key = 0;

  while ((match = regex.exec(text)) !== null) {
    if (match.index > lastIndex) {
      parts.push(text.slice(lastIndex, match.index));
    }
    if (match[2]) {
      parts.push(<strong key={key++}>{match[2]}</strong>);
    } else if (match[3]) {
      parts.push(<em key={key++}>{match[3]}</em>);
    }
    lastIndex = regex.lastIndex;
  }

  if (lastIndex === 0) return text;
  if (lastIndex < text.length) parts.push(text.slice(lastIndex));
  return <>{parts}</>;
}

/* ── Markdown block renderer ───────────────────────────────── */

function renderMarkdown(text: string): ReactNode {
  if (!text.trim()) return null;

  const lines = text.split("\n");
  const blocks: ReactNode[] = [];
  let i = 0;
  let bk = 0;

  // Build a nested list structure from indented bullet/number lines
  function parseList(startIdx: number, baseIndent: number, ordered: boolean): { node: ReactNode; nextIdx: number } {
    const items: { text: string; children: ReactNode | null }[] = [];
    let idx = startIdx;

    while (idx < lines.length) {
      const line = lines[idx];
      const indentMatch = line.match(/^(\s*)/);
      const indent = indentMatch ? indentMatch[1].length : 0;

      // Check if this is a list item at our level
      const bulletMatch = line.match(/^(\s*)[-*]\s(.*)/);
      const numberMatch = line.match(/^(\s*)\d+\.\s(.*)/);
      const match = ordered ? numberMatch : bulletMatch;

      if (match && indent === baseIndent) {
        items.push({ text: match[2], children: null });
        idx++;

        // Check for sub-list (indented further)
        if (idx < lines.length) {
          const nextIndentMatch = lines[idx].match(/^(\s*)/);
          const nextIndent = nextIndentMatch ? nextIndentMatch[1].length : 0;
          const nextIsBullet = /^\s*[-*]\s/.test(lines[idx]);
          const nextIsNumber = /^\s*\d+\.\s/.test(lines[idx]);
          if (nextIndent > baseIndent && (nextIsBullet || nextIsNumber)) {
            const sub = parseList(idx, nextIndent, nextIsNumber);
            items[items.length - 1].children = sub.node;
            idx = sub.nextIdx;
          }
        }
      } else if (indent > baseIndent && (bulletMatch || numberMatch)) {
        // Deeper indent than expected — sub-list of the last item
        const isSubOrdered = !!numberMatch;
        const sub = parseList(idx, indent, isSubOrdered);
        if (items.length > 0) {
          items[items.length - 1].children = sub.node;
        }
        idx = sub.nextIdx;
      } else {
        break;
      }
    }

    const ListTag = ordered ? "ol" : "ul";
    const className = ordered ? "md-cell-ol" : "md-cell-ul";
    const node = (
      <ListTag key={bk++} className={className}>
        {items.map((item, j) => (
          <li key={j}>
            {formatInline(item.text)}
            {item.children}
          </li>
        ))}
      </ListTag>
    );
    return { node, nextIdx: idx };
  }

  while (i < lines.length) {
    const line = lines[i];

    // Bullet list (- or *) at any indent level
    if (/^\s*[-*]\s/.test(line)) {
      const indentMatch = line.match(/^(\s*)/);
      const indent = indentMatch ? indentMatch[1].length : 0;
      const result = parseList(i, indent, false);
      blocks.push(result.node);
      i = result.nextIdx;
      continue;
    }

    // Numbered list
    if (/^\s*\d+\.\s/.test(line)) {
      const indentMatch = line.match(/^(\s*)/);
      const indent = indentMatch ? indentMatch[1].length : 0;
      const result = parseList(i, indent, true);
      blocks.push(result.node);
      i = result.nextIdx;
      continue;
    }

    // Empty line
    if (!line.trim()) {
      i++;
      continue;
    }

    // Paragraph
    blocks.push(
      <p key={bk++} className="md-cell-p">
        {formatInline(line)}
      </p>,
    );
    i++;
  }

  return <>{blocks}</>;
}

/* ── Markdown Cell: edit raw markdown, preview formatted ───── */

function MarkdownCell({
  value,
  onChange,
  placeholder,
  readOnly,
  onAddRow,
}: {
  value: string;
  onChange: (v: string) => void;
  placeholder: string;
  readOnly: boolean;
  onAddRow?: () => void;
}){
  const [isEditing, setIsEditing] = useState(false);
  const [localValue, setLocalValue] = useState(value);
  const textareaRef = useRef<HTMLTextAreaElement>(null);
  const cursorRef = useRef<number | null>(null);
  const isEditingRef = useRef(false);
  isEditingRef.current = isEditing;

  // Sync from parent when value changes externally (not while editing)
  useEffect(() => {
    if (!isEditingRef.current) setLocalValue(value);
  }, [value]);

  // Auto-resize textarea
  useEffect(() => {
    if (isEditing && textareaRef.current) {
      const el = textareaRef.current;
      el.style.height = "auto";
      el.style.height = el.scrollHeight + "px";
    }
  }, [localValue, isEditing]);

  // Restore cursor after programmatic value changes
  useEffect(() => {
    if (cursorRef.current !== null && textareaRef.current) {
      textareaRef.current.selectionStart = textareaRef.current.selectionEnd =
        cursorRef.current;
      cursorRef.current = null;
    }
  }, [localValue]);

  // Focus when entering edit mode
  useEffect(() => {
    if (isEditing && textareaRef.current) {
      textareaRef.current.focus();
      const len = textareaRef.current.value.length;
      textareaRef.current.selectionStart = textareaRef.current.selectionEnd = len;
    }
  }, [isEditing]);

  const handleChange = (newValue: string) => {
    setLocalValue(newValue);
    onChange(newValue);
  };

  // Preview mode — use localValue to preserve edits before debounce saves
  if (readOnly || !isEditing) {
    const rendered = renderMarkdown(localValue);
    return (
      <div
        data-cell
        tabIndex={readOnly ? undefined : 0}
        className={`md-cell-preview min-h-[1.5rem] rounded outline-none transition-colors ${!readOnly ? "cursor-text focus:ring-1 focus:ring-[var(--color-accent)]/40" : ""}`}
        onClick={() => {
          if (!readOnly) setIsEditing(true);
        }}
        onFocus={() => {
          if (!readOnly) setIsEditing(true);
        }}
        onKeyDown={(e) => {
          if (readOnly) return;
          if (e.key === "Tab") {
            e.preventDefault();
            const td = (e.target as HTMLElement).closest("td");
            if (td) {
              const moved = focusAdjacentCell(td, e.shiftKey);
              if (!moved && !e.shiftKey && onAddRow) onAddRow();
            }
            return;
          }
          if (e.key === "Enter" || e.key === " ") {
            e.preventDefault();
            setIsEditing(true);
          }
        }}
      >
        {rendered || (
          <span className="text-xs text-[var(--color-text-secondary)] opacity-40">
            {placeholder}
          </span>
        )}
      </div>
    );
  }

  // Edit mode
  return (
    <textarea
      ref={textareaRef}
      value={localValue}
      onChange={(e) => handleChange(e.target.value)}
      onBlur={() => setIsEditing(false)}
      placeholder={placeholder}
      className="w-full bg-transparent text-xs px-1 py-0.5 rounded outline-none resize-none ring-1 ring-[var(--color-accent)]/40 placeholder:text-[var(--color-text-secondary)]/40"
      onKeyDown={(e) => {
        // Tab / Shift+Tab → move to adjacent cell
        if (e.key === "Tab") {
          e.preventDefault();
          // Capture td before setIsEditing removes textarea from DOM
          const td = (e.target as HTMLElement).closest("td");
          setIsEditing(false);
          requestAnimationFrame(() => {
            if (td) {
              const moved = focusAdjacentCell(td, e.shiftKey);
              if (!moved && !e.shiftKey && onAddRow) onAddRow();
            }
          });
          return;
        }
        // Escape → exit edit mode
        if (e.key === "Escape") {
          e.preventDefault();
          setIsEditing(false);
          return;
        }
        if (e.key !== "Enter") return;
        const pos = e.currentTarget.selectionStart;
        const before = localValue.slice(0, pos);
        const after = localValue.slice(pos);
        const lastLine = before.split("\n").pop() || "";

        // Auto-continue bullet lists
        const bulletMatch = lastLine.match(/^([-*])\s(.*)/);
        if (bulletMatch) {
          e.preventDefault();
          if (!bulletMatch[2].trim()) {
            // Empty bullet → end the list
            const lineStart = before.lastIndexOf("\n") + 1;
            handleChange(localValue.slice(0, lineStart) + after);
            cursorRef.current = lineStart;
            return;
          }
          const prefix = bulletMatch[1] + " ";
          handleChange(before + "\n" + prefix + after);
          cursorRef.current = pos + 1 + prefix.length;
          return;
        }

        // Auto-continue numbered lists
        const numMatch = lastLine.match(/^(\d+)\.\s(.*)/);
        if (numMatch) {
          e.preventDefault();
          if (!numMatch[2].trim()) {
            // Empty numbered item → end the list
            const lineStart = before.lastIndexOf("\n") + 1;
            handleChange(localValue.slice(0, lineStart) + after);
            cursorRef.current = lineStart;
            return;
          }
          const prefix = parseInt(numMatch[1]) + 1 + ". ";
          handleChange(before + "\n" + prefix + after);
          cursorRef.current = pos + 1 + prefix.length;
          return;
        }
      }}
    />
  );
}

/* ── Sparkle button — appears on hover for AI-assisted editing ── */

function SparkleButton({ onClick }: { onClick: () => void }) {
  return (
    <button
      onClick={(e) => { e.stopPropagation(); onClick(); }}
      className="absolute top-0.5 right-0.5 p-0.5 rounded opacity-50 hover:opacity-100 transition-opacity text-[var(--color-accent)] hover:bg-[var(--color-accent)]/10"
      title="Improve with AI"
    >
      <svg width="12" height="12" viewBox="0 0 24 24" fill="currentColor">
        <path d="M12 2l2.09 6.26L20.18 10l-6.09 1.74L12 18l-2.09-6.26L3.82 10l6.09-1.74L12 2z" />
        <path d="M19 15l1.04 3.13L23.18 19l-3.14.87L19 23l-1.04-3.13L14.82 19l3.14-.87L19 15z" opacity="0.6" />
      </svg>
    </button>
  );
}
