import { useCallback, useEffect, useMemo, useRef, useState, lazy, Suspense, type ReactNode, type KeyboardEvent as ReactKeyboardEvent } from "react";
import { createPortal } from "react-dom";
import { usePopover } from "../hooks/usePopover";
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
import {
  Eye,
  X,
  Sparkles,
  Maximize2,
  Search,
  Image as ImageIcon,
  Folder,
  Plus,
  Camera,
  Check,
  Lock,
  Unlock,
} from "lucide-react";
import type { PlanningCellField, PlanningRow } from "../types/sketch";
import { normalizeDocument } from "@elucim/dsl";
import type { CutReadyElucimDocument } from "../types/elucim";
import { ErrorBoundary } from "./ErrorBoundary";


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

function isCellLocked(row: PlanningRow, field: PlanningCellField): boolean {
  return row.locked === true || row.locks?.[field] === true;
}

function hasAnyLock(row: PlanningRow): boolean {
  return row.locked === true || Object.values(row.locks ?? {}).some(Boolean);
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
  onRowLockChange?: (rowIndex: number, locked: boolean) => void;
  onCellLockChange?: (rowIndex: number, field: PlanningCellField, locked: boolean) => void;
}

export function ScriptTable({ rows, onChange, readOnly = false, onCaptureScreenshot, onPickImage, onBrowseImage, onSparkle, onGenerateVisual, onNudgeVisual, projectRoot, sketchPath, highlightedRows, rowDiffs, aiSnapshotRows, onDismissHighlights, hasLastAiDiffs, onReShowHighlights, onRowLockChange, onCellLockChange }: ScriptTableProps) {
  const [activeId, setActiveId] = useState<string | null>(null);
  const [lightboxSrc, setLightboxSrc] = useState<string | null>(null);
  const [visualLightbox, setVisualLightbox] = useState<{ visualPath: string; rowIndex: number } | null>(null);
  const [nudgeInput, setNudgeInput] = useState("");
  const [lightboxMode, setLightboxMode] = useState<"preview" | "edit">("preview");
  const [editorDsl, setEditorDsl] = useState<CutReadyElucimDocument | null>(null);
  const [editorDirty, setEditorDirty] = useState(false);
  const [visualVersion, setVisualVersion] = useState(0);
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
      .then((data) => setEditorDsl(normalizeDocument(data).document))
      .catch((err) => console.error("[ScriptTable] Failed to load visual for editor:", err));
  }, [visualLightbox?.visualPath, lightboxMode]);

  const closeLightbox = useCallback(() => {
    setVisualLightbox(null);
    setNudgeInput("");
    setLightboxMode("preview");
    setEditorDsl(null);
    setEditorDirty(false);
  }, []);

  const saveEditorChanges = useCallback(async (doc: CutReadyElucimDocument) => {
    if (!visualLightbox) return;
    try {
      await invoke("write_visual_doc", {
        relativePath: visualLightbox.visualPath,
        document: normalizeDocument(doc).document,
      });
      setEditorDirty(false);
      setVisualVersion((v) => v + 1);
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
      if (rowsRef.current[index]?.locked || rowsRef.current[index]?.locks?.[field as PlanningCellField]) return;
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
      if (hasAnyLock(rowsRef.current[index])) return;
      pushUndo();
      const updated = rowsRef.current.filter((_, i) => i !== index);
      onChange(updated);
      showUndoToast("Row deleted — Ctrl+Z to undo");
    },
    [onChange, pushUndo, showUndoToast],
  );

  const removeVisual = useCallback(
    (index: number) => {
      if (isCellLocked(rowsRef.current[index], "visual") || isCellLocked(rowsRef.current[index], "screenshot")) return;
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
      if (rowsRef.current.some(hasAnyLock)) return;
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
              bg-[rgb(var(--color-accent))]/8 text-[rgb(var(--color-accent))] border-[rgb(var(--color-accent))]/20
              hover:bg-[rgb(var(--color-accent))]/15 hover:border-[rgb(var(--color-accent))]/30"
          >
            <Eye className="w-3 h-3" />
            Show AI Changes
          </button>
        </div>
      )}
      {rows.length === 1 && !rows[0].time && !rows[0].narrative && !rows[0].demo_actions && !readOnly && (
        <div className="mb-3 px-4 py-3 rounded-lg bg-[rgb(var(--color-accent))]/5 border border-[rgb(var(--color-accent))]/15 text-xs text-[rgb(var(--color-text-secondary))] leading-relaxed">
          <p className="font-medium text-[rgb(var(--color-text))] mb-1.5">Plan your demo scene</p>
          <div className="flex gap-4">
            <div><span className="font-medium text-[rgb(var(--color-text))]">Time</span> — Duration or timestamp</div>
            <div><span className="font-medium text-[rgb(var(--color-text))]">Narrative</span> — What you&apos;ll say</div>
            <div><span className="font-medium text-[rgb(var(--color-text))]">Actions</span> — What happens on screen</div>
          </div>
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
              <col style={{ width: 72 }} />
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
                  visualVersion={visualVersion}
                  onRowLockChange={onRowLockChange}
                  onCellLockChange={onCellLockChange}
                />
              ))}
            </tbody>
          </table>
        </SortableContext>
        <DragOverlay>
          {activeIdx >= 0 ? (
            <table className="w-full" style={{ borderCollapse: "separate" }}>
              <tbody>
                <tr className="card-row shadow-lg" style={{ backgroundColor: "rgb(var(--color-surface-alt))" }}>
                  {!readOnly && <td className="p-1 w-7" style={{ borderLeft: `3px solid ${getRowColor(activeIdx)}` }} />}
                  <td className="script-table-td text-xs" style={{ width: 72 }}>{rows[activeIdx].time}</td>
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
          className="fixed inset-0 z-modal flex items-center justify-center bg-[rgb(var(--color-overlay-strong)/0.8)] cursor-pointer"
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
            className="absolute top-4 right-4 p-2 rounded-full bg-[rgb(var(--color-media-control-bg)/0.5)] text-[rgb(var(--color-media-control-fg)/0.8)] hover:text-[rgb(var(--color-media-control-fg))] transition-colors"
          >
            <X className="w-5 h-5" />
          </button>
        </div>
      )}

      {/* Visual lightbox — near-fullscreen with preview/edit toggle */}
      {visualLightbox && (
        <div
          className="fixed inset-0 z-modal flex items-center justify-center bg-[rgb(var(--color-overlay-strong)/0.8)]"
          onClick={() => {
            if (lightboxMode === "edit" && editorDirty) return; // don't close dirty editor by backdrop click
            closeLightbox();
          }}
        >
          <div
            className="relative flex flex-col rounded-xl overflow-hidden shadow-2xl bg-[rgb(var(--color-surface))]"
            style={{ width: "calc(100vw - 60px)", height: "calc(100vh - 60px)" }}
            onClick={(e) => e.stopPropagation()}
          >
            {/* Header bar */}
            <div className="flex items-center justify-between px-4 py-2 border-b border-[rgb(var(--color-border))] bg-[rgb(var(--color-surface-alt))] shrink-0">
              <div className="flex items-center gap-3">
                <span className="text-[13px] font-medium text-[rgb(var(--color-text))]">
                  Row {visualLightbox.rowIndex + 1}
                </span>
                {/* Preview / Edit toggle */}
                {!readOnly && (
                  <div className="flex items-center rounded-lg bg-[rgb(var(--color-surface))] border border-[rgb(var(--color-border))] p-0.5">
                    <button
                      onClick={() => setLightboxMode("preview")}
                      className={`px-3 py-1 rounded-md text-[12px] font-medium transition-colors ${
                        lightboxMode === "preview"
                          ? "bg-[rgb(var(--color-accent))] text-[rgb(var(--color-accent-fg))]"
                          : "text-[rgb(var(--color-text-secondary))] hover:text-[rgb(var(--color-text))]"
                      }`}
                    >
                      Preview
                    </button>
                    <button
                      onClick={() => setLightboxMode("edit")}
                      className={`px-3 py-1 rounded-md text-[12px] font-medium transition-colors ${
                        lightboxMode === "edit"
                          ? "bg-[rgb(var(--color-accent))] text-[rgb(var(--color-accent-fg))]"
                          : "text-[rgb(var(--color-text-secondary))] hover:text-[rgb(var(--color-text))]"
                      }`}
                    >
                      Edit
                    </button>
                  </div>
                )}
                {editorDirty && (
                  <span className="text-[11px] text-[rgb(var(--color-accent))] font-medium">● Unsaved</span>
                )}
              </div>
              <div className="flex items-center gap-2">
                {/* Save button (edit mode only) */}
                {lightboxMode === "edit" && editorDirty && editorDsl && (
                  <button
                    onClick={() => saveEditorChanges(editorDsl)}
                    title="Save changes"
                    className="p-1.5 rounded-lg text-[rgb(var(--color-accent))] hover:text-[rgb(var(--color-accent-hover))] hover:bg-[rgb(var(--color-surface))] transition-colors"
                  >
                    <Check className="w-4 h-4" />
                  </button>
                )}
                {/* Close button */}
                <button
                  onClick={closeLightbox}
                  className="p-1.5 rounded-lg text-[rgb(var(--color-text-secondary))] hover:text-[rgb(var(--color-text))] hover:bg-[rgb(var(--color-surface))] transition-colors"
                >
                  <X className="w-5 h-5" />
                </button>
              </div>
            </div>

            {/* Content area */}
            <div className="flex-1 min-h-0 relative overflow-hidden">
              {lightboxMode === "preview" ? (
                /* Preview mode — DslRenderer */
                <div className="absolute inset-0 flex items-center justify-center p-4">
                  <Suspense fallback={<div className="w-full h-full bg-[rgb(var(--color-surface-alt))] animate-pulse rounded-lg" />}>
                    <VisualCell
                      visualPath={visualLightbox.visualPath}
                      mode="full"
                      className="w-full h-full"
                      key={`${visualLightbox.visualPath}-v${visualVersion}`}
                    />
                  </Suspense>
                </div>
              ) : (
                /* Edit mode — ElucimEditor */
                <ErrorBoundary
                  resetKey={`${visualLightbox.visualPath}-${lightboxMode}`}
                  fallback={
                    <div className="w-full h-full flex items-center justify-center p-6 text-sm text-[rgb(var(--color-error))] text-center">
                      Editor failed to load. Close this panel and try again.
                    </div>
                  }
                >
                  <Suspense fallback={<div className="w-full h-full flex items-center justify-center text-[rgb(var(--color-text-secondary))]">Loading editor…</div>}>
                    {editorDsl ? (
                      <EditorWrapper
                        dsl={editorDsl}
                        onDocumentChange={(doc) => { setEditorDsl(doc); setEditorDirty(true); }}
                      />
                    ) : (
                      <div className="w-full h-full flex items-center justify-center text-[rgb(var(--color-text-secondary))]">Loading…</div>
                    )}
                  </Suspense>
                </ErrorBoundary>
              )}
            </div>

            {/* Nudge bar (preview mode only — editor has its own timeline) */}
            {onNudgeVisual && !readOnly && lightboxMode === "preview" && (
              <div className="flex items-center gap-2 px-4 py-2 border-t border-[rgb(var(--color-border))] bg-[rgb(var(--color-surface-alt))] shrink-0">
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
                  className="flex-1 px-3 py-1.5 rounded-lg bg-[rgb(var(--color-surface))] border border-[rgb(var(--color-border))] text-[rgb(var(--color-text))] text-[13px] placeholder:text-[rgb(var(--color-text-secondary))]/50 focus:outline-none focus:ring-1 focus:ring-[rgb(var(--color-accent))]"
                />
                <button
                  onClick={() => {
                    if (nudgeInput.trim()) {
                      onNudgeVisual(visualLightbox.rowIndex, nudgeInput.trim());
                      setNudgeInput("");
                    }
                  }}
                  disabled={!nudgeInput.trim()}
                  className="p-1.5 rounded-lg text-[rgb(var(--color-text-secondary))] hover:text-[rgb(var(--color-text))] disabled:opacity-30 transition-colors"
                >
                  <Sparkles className="w-4 h-4" />
                </button>
              </div>
            )}
          </div>
        </div>
      )}

      {/* Undo toast */}
      {undoToast && (
        <div className="fixed bottom-4 left-1/2 -translate-x-1/2 z-dropdown flex items-center gap-2 px-3 py-2 rounded-lg bg-[rgb(var(--color-surface))] border border-[rgb(var(--color-border))] shadow-lg text-[12px] text-[rgb(var(--color-text))]">
          <span>{undoToast}</span>
          <button
            onClick={() => { popUndo(); setUndoToast(null); }}
            className="px-2 py-0.5 rounded text-[11px] font-medium text-[rgb(var(--color-accent))] hover:bg-[rgb(var(--color-accent))]/10 transition-colors"
          >
            Undo
          </button>
          <button
            onClick={() => setUndoToast(null)}
            className="p-0.5 text-[rgb(var(--color-text-secondary))] hover:text-[rgb(var(--color-text))] transition-colors"
          >
            <X className="w-2.5 h-2.5" />
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
  visualVersion,
  onRowLockChange,
  onCellLockChange,
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
  visualVersion: number;
  onRowLockChange?: (rowIndex: number, locked: boolean) => void;
  onCellLockChange?: (rowIndex: number, field: PlanningCellField, locked: boolean) => void;
}){
  const [diffExpanded, setDiffExpanded] = useState(true);
  const rowLocked = row.locked === true;
  const timeLocked = isCellLocked(row, "time");
  const narrativeLocked = isCellLocked(row, "narrative");
  const actionsLocked = isCellLocked(row, "demo_actions");
  const mediaLocked = isCellLocked(row, "screenshot") || isCellLocked(row, "visual");
  const {
    attributes,
    listeners,
    setNodeRef,
    transform,
    transition,
    isSorting,
  } = useSortable({ id, disabled: readOnly || hasAnyLock(row) });

  const style = {
    transform: CSS.Transform.toString(transform),
    transition,
    opacity: isDragging ? 0.3 : 1,
  };

  const accentColor = getRowColor(idx);
  const rowBg = idx % 2 === 0 ? "rgb(var(--color-surface-alt))" : "rgb(var(--color-surface-inset))";

  return (
    <>
    <tr
      ref={setNodeRef}
      style={{ ...style, backgroundColor: isHighlighted ? undefined : rowBg }}
      className={`card-row group hover:shadow-sm ${isSorting ? "" : "transition-all"} ${isHighlighted ? "ai-highlight-row" : ""} ${rowLocked ? "ring-1 ring-[rgb(var(--color-warning))]/25" : ""}`}
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
            className={`${hasAnyLock(row) ? "cursor-default text-[rgb(var(--color-warning))]" : "cursor-grab active:cursor-grabbing text-[rgb(var(--color-text-secondary))]"} flex items-center justify-center h-full`}
            {...attributes}
            {...listeners}
          >
            {/* Row number (visible by default), drag icon on hover */}
            <span className="text-[0.625rem] font-medium opacity-40 group-hover:hidden">{rowLocked ? <Lock className="w-3 h-3" /> : idx + 1}</span>
            {!hasAnyLock(row) && <svg className="hidden group-hover:block opacity-50 hover:opacity-100 transition-opacity" width="12" height="12" viewBox="0 0 24 24" fill="currentColor">
              <circle cx="9" cy="5" r="1.5" />
              <circle cx="15" cy="5" r="1.5" />
              <circle cx="9" cy="12" r="1.5" />
              <circle cx="15" cy="12" r="1.5" />
              <circle cx="9" cy="19" r="1.5" />
              <circle cx="15" cy="19" r="1.5" />
            </svg>}
          </div>
        </td>
      )}
      <td className="py-2 px-1.5 align-top text-[0.8125rem]" style={readOnly ? { borderLeft: `3px solid ${accentColor}` } : undefined}>
        <div data-tab-cell={idx * 3} className="relative group/cell">
          <LocalInput
            value={row.time}
            onChange={(v) => updateRow(idx, "time", v)}
            placeholder="~30s"
            readOnly={readOnly || timeLocked}
            onAddRow={isLastRow && !readOnly && !hasAnyLock(row) ? () => addRow(idx) : undefined}
            hasActionRail={!readOnly && !rowLocked && !!onCellLockChange}
          />
          {!readOnly && !rowLocked && onCellLockChange && (
            <CellActionRail persistent={timeLocked}>
              <CellLockButton locked={timeLocked} onClick={() => onCellLockChange(idx, "time", !timeLocked)} />
            </CellActionRail>
          )}
        </div>
      </td>
      <td className="script-table-td align-top overflow-hidden">
        <div data-tab-cell={idx * 3 + 1} className="relative group/cell">
          <MarkdownCell
            value={row.narrative}
            onChange={(v) => updateRow(idx, "narrative", v)}
            placeholder="What to say..."
            readOnly={readOnly || narrativeLocked}
            onAddRow={isLastRow && !readOnly && !hasAnyLock(row) ? () => addRow(idx) : undefined}
            hasActionRail={!readOnly && (!!onCellLockChange || !!onSparkle)}
          />
          {!readOnly && (
            <CellActionRail persistent={narrativeLocked}>
              {onSparkle && !narrativeLocked && (
                <SparkleButton onClick={() => onSparkle(
                  `Improve the narrative for row ${idx + 1} of sketch "${sketchPath ?? "current"}". Current text: "${row.narrative}". Make it more engaging and natural for spoken delivery. Use update_planning_row to change only this row.`
                )} />
              )}
              {!rowLocked && onCellLockChange && (
                <CellLockButton locked={narrativeLocked} onClick={() => onCellLockChange(idx, "narrative", !narrativeLocked)} />
              )}
            </CellActionRail>
          )}
        </div>
      </td>
      <td className="script-table-td align-top overflow-hidden">
        <div data-tab-cell={idx * 3 + 2} className="relative group/cell">
          <MarkdownCell
            value={row.demo_actions}
            onChange={(v) => updateRow(idx, "demo_actions", v)}
            placeholder="What to do..."
            readOnly={readOnly || actionsLocked}
            onAddRow={isLastRow && !readOnly && !hasAnyLock(row) ? () => addRow(idx) : undefined}
            hasActionRail={!readOnly && (!!onCellLockChange || !!onSparkle)}
          />
          {!readOnly && (
            <CellActionRail persistent={actionsLocked}>
              {onSparkle && !actionsLocked && (
                <SparkleButton onClick={() => onSparkle(
                  `Improve the demo actions for row ${idx + 1} of sketch "${sketchPath ?? "current"}". Current text: "${row.demo_actions}". Make the steps clearer and more specific. Use update_planning_row to change only this row.`
                )} />
              )}
              {!rowLocked && onCellLockChange && (
                <CellLockButton locked={actionsLocked} onClick={() => onCellLockChange(idx, "demo_actions", !actionsLocked)} />
              )}
            </CellActionRail>
          )}
        </div>
      </td>
      <td className="script-table-td align-top text-center">
        {row.visual ? (
          /* ── Elucim animated visual ── */
          <div className="relative group/vis cursor-pointer" onClick={() => onVisualClick(row.visual!, idx)}>
            {!readOnly && !rowLocked && onCellLockChange && (
              <div className="absolute right-1 top-1 z-10">
                <CellLockButton locked={mediaLocked} onClick={() => onCellLockChange(idx, "screenshot", !mediaLocked)} className="bg-[rgb(var(--color-media-control-bg)/0.2)] text-[rgb(var(--color-media-control-fg))] hover:bg-[rgb(var(--color-media-control-bg)/0.4)]" />
              </div>
            )}
            <Suspense fallback={<div className="w-40 h-24 rounded-md bg-[rgb(var(--color-surface-alt))] border border-[rgb(var(--color-border))] animate-pulse" />}>
              <VisualCell
                visualPath={row.visual!}
                mode="thumbnail"
                key={`${row.visual}-v${visualVersion}`}
              />
            </Suspense>
            {/* Hover overlay with action buttons */}
            {!mediaLocked && <div className="absolute inset-0 bg-[rgb(var(--color-media-control-bg)/0.4)] opacity-0 group-hover/vis:opacity-100 transition-opacity flex items-center justify-center gap-1.5 rounded-md" onClick={(e) => e.stopPropagation()}>
              {/* Expand / preview */}
              <button
                onClick={() => onVisualClick(row.visual!, idx)}
                className="p-1 rounded-full bg-[rgb(var(--color-media-control-bg)/0.2)] text-[rgb(var(--color-media-control-fg))] hover:bg-[rgb(var(--color-media-control-bg)/0.4)]"
                title="Preview visual (click to edit)"
              >
                <Maximize2 className="w-3.5 h-3.5" />
              </button>
              {/* Regenerate visual */}
              {!readOnly && onGenerateVisual && (
                <button
                  onClick={() => onGenerateVisual(idx)}
                  className="p-1 rounded-full bg-[rgb(var(--color-media-control-bg)/0.2)] text-[rgb(var(--color-media-control-fg))] hover:bg-[rgb(var(--color-accent)/0.8)]"
                  title="Regenerate visual with AI"
                >
                  <Sparkles className="w-3.5 h-3.5" />
                </button>
              )}
              {/* Remove visual */}
              {!readOnly && (
                <button
                  onClick={() => onRemoveVisual?.(idx)}
                  className="p-1 rounded-full bg-[rgb(var(--color-media-control-bg)/0.2)] text-[rgb(var(--color-media-control-fg))] hover:bg-[rgb(var(--color-error)/0.8)]"
                  title="Remove visual"
                >
                  <X className="w-3.5 h-3.5" />
                </button>
              )}
            </div>}
          </div>
        ) : row.screenshot ? (
          <div className="relative group/ss w-40 h-24 rounded-md bg-[rgb(var(--color-surface-alt))] border border-[rgb(var(--color-border))] overflow-hidden cursor-pointer"
            onClick={() => {
              const src = projectRoot ? convertFileSrc(`${projectRoot}/${row.screenshot}`) : row.screenshot!;
              onImageClick(src);
            }}
          >
            {!readOnly && !rowLocked && onCellLockChange && (
              <div className="absolute right-1 top-1 z-10">
                <CellLockButton locked={mediaLocked} onClick={() => onCellLockChange(idx, "screenshot", !mediaLocked)} className="bg-[rgb(var(--color-media-control-bg)/0.2)] text-[rgb(var(--color-media-control-fg))] hover:bg-[rgb(var(--color-media-control-bg)/0.4)]" />
              </div>
            )}
            <img
              src={projectRoot ? convertFileSrc(`${projectRoot}/${row.screenshot}`) : row.screenshot}
              alt=""
              className="w-full h-full object-cover"
            />
            {!readOnly && !mediaLocked && (
              <div className="absolute inset-0 bg-[rgb(var(--color-media-control-bg)/0.5)] opacity-0 group-hover/ss:opacity-100 transition-opacity flex items-center justify-center gap-1.5" onClick={(e) => e.stopPropagation()}>
                {/* View */}
                <button
                  onClick={() => {
                    const src = projectRoot ? convertFileSrc(`${projectRoot}/${row.screenshot}`) : row.screenshot!;
                    onImageClick(src);
                  }}
                  className="p-1 rounded-full bg-[rgb(var(--color-media-control-bg)/0.2)] text-[rgb(var(--color-media-control-fg))] hover:bg-[rgb(var(--color-media-control-bg)/0.3)]"
                  title="View image"
                >
                  <Search className="w-3.5 h-3.5" />
                </button>
                {/* Re-capture */}
                <button
                  onClick={() => onCaptureScreenshot?.(idx)}
                  className="p-1 rounded-full bg-[rgb(var(--color-media-control-bg)/0.2)] text-[rgb(var(--color-media-control-fg))] hover:bg-[rgb(var(--color-media-control-bg)/0.3)]"
                  title="Re-capture screenshot"
                >
                  <Camera className="w-3.5 h-3.5" />
                </button>
                {/* Pick from project */}
                {onPickImage && (
                  <button
                    onClick={() => onPickImage(idx)}
                    className="p-1 rounded-full bg-[rgb(var(--color-media-control-bg)/0.2)] text-[rgb(var(--color-media-control-fg))] hover:bg-[rgb(var(--color-media-control-bg)/0.3)]"
                    title="Pick from workspace images"
                  >
                    <ImageIcon className="w-3.5 h-3.5" />
                  </button>
                )}
                {/* Browse filesystem */}
                {onBrowseImage && (
                  <button
                    onClick={() => onBrowseImage(idx)}
                    className="p-1 rounded-full bg-[rgb(var(--color-media-control-bg)/0.2)] text-[rgb(var(--color-media-control-fg))] hover:bg-[rgb(var(--color-media-control-bg)/0.3)]"
                    title="Browse for image file"
                  >
                    <Folder className="w-3.5 h-3.5" />
                  </button>
                )}
                {/* Remove */}
                <button
                  onClick={() => updateRow(idx, "screenshot", "")}
                  className="p-1 rounded-full bg-[rgb(var(--color-media-control-bg)/0.2)] text-[rgb(var(--color-media-control-fg))] hover:bg-[rgb(var(--color-error)/0.8)]"
                  title="Remove screenshot"
                >
                  <X className="w-3.5 h-3.5" />
                </button>
              </div>
            )}
          </div>
        ) : !readOnly && !mediaLocked ? (
          <MediaAddPopover
            idx={idx}
            onCaptureScreenshot={onCaptureScreenshot}
            onPickImage={onPickImage}
            onBrowseImage={onBrowseImage}
            onGenerateVisual={onGenerateVisual}
          />
        ) : (
          <div className="relative min-h-8 flex items-center justify-center">
            <span className="text-[10px] text-[rgb(var(--color-text-secondary))]">{mediaLocked ? "Locked" : "—"}</span>
            {!readOnly && !rowLocked && onCellLockChange && (
              <CellActionRail persistent={mediaLocked}>
                <CellLockButton locked={mediaLocked} onClick={() => onCellLockChange(idx, "screenshot", !mediaLocked)} />
              </CellActionRail>
            )}
          </div>
        )}
      </td>
      {!readOnly && (
        <td className="p-1 align-top">
          <div className={`flex flex-col gap-0.5 transition-opacity ${rowLocked ? "opacity-100" : "opacity-0 group-hover:opacity-100"}`}>
            {onRowLockChange && (
              <button
                onClick={() => onRowLockChange(idx, !rowLocked)}
                className={`p-0.5 rounded transition-colors ${rowLocked ? "text-[rgb(var(--color-warning))] hover:bg-[rgb(var(--color-warning))]/10" : "text-[rgb(var(--color-text-secondary))] hover:text-[rgb(var(--color-accent))]"}`}
                title={rowLocked ? "Unlock row" : "Lock row"}
              >
                {rowLocked ? <Lock className="w-3 h-3" /> : <Unlock className="w-3 h-3" />}
              </button>
            )}
            {!hasAnyLock(row) && <button
              onClick={() => addRow(idx)}
              className="p-0.5 rounded text-[rgb(var(--color-text-secondary))] hover:text-[rgb(var(--color-accent))] transition-colors"
              title="Add row below"
            >
              <Plus className="w-3 h-3" />
            </button>}
            {!hasAnyLock(row) && <button
              onClick={() => deleteRow(idx)}
              className="p-0.5 rounded text-[rgb(var(--color-text-secondary))] hover:text-error transition-colors"
              title="Delete row"
            >
              <X className="w-3 h-3" />
            </button>}
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
              <span className="font-medium text-[rgb(var(--color-accent))] flex items-center gap-1.5">
                <Sparkles className="w-3 h-3" />
                Row {idx + 1} changed
              </span>
              <button
                onClick={() => { setDiffExpanded(false); onDismissHighlight?.(); }}
                className="p-0.5 rounded hover:bg-[rgb(var(--color-border))]/30 text-[rgb(var(--color-text-secondary))]"
              >
                <X className="w-2.5 h-2.5" />
              </button>
            </div>
            {rowDiff.fields.map((f) => (
              <div key={f.field} className="mb-0.5">
                <span className="text-[rgb(var(--color-text-secondary))] font-medium">{f.field}: </span>
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
  hasActionRail = false,
}: {
  value: string;
  onChange: (v: string) => void;
  placeholder: string;
  readOnly: boolean;
  onAddRow?: () => void;
  hasActionRail?: boolean;
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
      className={`w-full bg-transparent text-xs py-0.5 rounded outline-none transition-colors focus:ring-1 focus:ring-[rgb(var(--color-accent))]/40 placeholder:text-[rgb(var(--color-text-secondary))]/40 ${hasActionRail ? "pl-1 pr-5" : "px-1"}`}
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
  hasActionRail = false,
}: {
  value: string;
  onChange: (v: string) => void;
  placeholder: string;
  readOnly: boolean;
  onAddRow?: () => void;
  hasActionRail?: boolean;
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
        className={`md-cell-preview min-h-[1.5rem] rounded outline-none transition-colors ${hasActionRail ? "pr-7" : ""} ${!readOnly ? "cursor-text focus:ring-1 focus:ring-[rgb(var(--color-accent))]/40" : ""}`}
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
          <span className="text-[rgb(var(--color-text-secondary))] opacity-40">
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
      rows={1}
      className={`md-cell-editor w-full bg-transparent p-0 rounded outline-none resize-none ring-1 ring-[rgb(var(--color-accent))]/40 placeholder:text-[rgb(var(--color-text-secondary))]/40 ${hasActionRail ? "pr-7" : "pr-0"}`}
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

function CellActionRail({ children, persistent = false }: { children: ReactNode; persistent?: boolean }) {
  return (
    <div className={`absolute right-0.5 top-0.5 z-[1] flex w-4 flex-col items-center gap-0.5 transition-opacity group-hover/cell:opacity-100 focus-within:opacity-100 ${persistent ? "opacity-100" : "opacity-0"}`}>
      {children}
    </div>
  );
}

function SparkleButton({ onClick }: { onClick: () => void }) {
  return (
    <button
      onClick={(e) => { e.stopPropagation(); onClick(); }}
      className="p-0.5 rounded text-[rgb(var(--color-accent))] hover:bg-[rgb(var(--color-accent))]/10"
      title="Improve with AI"
    >
      <Sparkles className="w-3 h-3" />
    </button>
  );
}

function CellLockButton({ locked, onClick, className = "" }: { locked: boolean; onClick: () => void; className?: string }) {
  return (
    <button
      onClick={(e) => { e.stopPropagation(); onClick(); }}
      className={`p-0.5 rounded ${locked ? "text-[rgb(var(--color-warning))]" : "text-[rgb(var(--color-text-secondary))] hover:text-[rgb(var(--color-accent))] hover:bg-[rgb(var(--color-accent))]/10"} ${className}`}
      title={locked ? "Unlock cell" : "Lock cell"}
    >
      {locked ? <Lock className="w-3 h-3" /> : <Unlock className="w-3 h-3" />}
    </button>
  );
}

/* ── Media add popover — single "+" button expands to action list ── */

interface MediaAddPopoverProps {
  idx: number;
  onCaptureScreenshot?: (idx: number) => void;
  onPickImage?: (idx: number) => void;
  onBrowseImage?: (idx: number) => void;
  onGenerateVisual?: (idx: number) => void;
}

function MediaAddPopover({ idx, onCaptureScreenshot, onPickImage, onBrowseImage, onGenerateVisual }: MediaAddPopoverProps) {
  const { state, ref, addRef, toggle, close } = usePopover();
  const itemsRef = useRef<(HTMLButtonElement | null)[]>([]);
  const buttonRef = useRef<HTMLButtonElement>(null);
  const portalRef = useRef<HTMLDivElement>(null);
  const [pos, setPos] = useState<{ top: number; left: number } | null>(null);

  // Register the portaled menu container so clicks inside don't trigger close
  useEffect(() => { addRef(portalRef); }, [addRef]);

  const items = useMemo(() => {
    const list: { icon: typeof Camera; label: string; action: () => void }[] = [
      { icon: Camera, label: "Capture screenshot", action: () => onCaptureScreenshot?.(idx) },
    ];
    if (onPickImage) list.push({ icon: ImageIcon, label: "Pick from workspace", action: () => onPickImage(idx) });
    if (onBrowseImage) list.push({ icon: Folder, label: "Browse for file", action: () => onBrowseImage(idx) });
    if (onGenerateVisual) list.push({ icon: Sparkles, label: "Generate visual", action: () => onGenerateVisual(idx) });
    return list;
  }, [idx, onCaptureScreenshot, onPickImage, onBrowseImage, onGenerateVisual]);

  const handleItemClick = (action: () => void) => {
    close();
    action();
  };

  const handleKeyDown = (e: ReactKeyboardEvent, index: number) => {
    if (e.key === "ArrowDown") {
      e.preventDefault();
      const next = (index + 1) % items.length;
      itemsRef.current[next]?.focus();
    } else if (e.key === "ArrowUp") {
      e.preventDefault();
      const prev = (index - 1 + items.length) % items.length;
      itemsRef.current[prev]?.focus();
    }
  };

  // Compute position when popover opens
  useEffect(() => {
    if (state !== null && buttonRef.current) {
      const rect = buttonRef.current.getBoundingClientRect();
      setPos({ top: rect.top, left: rect.left });
    } else {
      setPos(null);
    }
  }, [state]);

  // Close on scroll
  useEffect(() => {
    if (state === null) return;
    const handleScroll = () => close();
    window.addEventListener("scroll", handleScroll, true);
    return () => window.removeEventListener("scroll", handleScroll, true);
  }, [state, close]);

  // Focus first item when popover opens
  useEffect(() => {
    if (state !== null) {
      requestAnimationFrame(() => itemsRef.current[0]?.focus());
    }
  }, [state]);

  return (
    <div ref={ref} className="relative inline-flex">
      <button
        ref={buttonRef}
        onClick={toggle}
        className="w-8 h-8 rounded-md border border-dashed border-[rgb(var(--color-border))] hover:border-[rgb(var(--color-accent))] hover:bg-[rgb(var(--color-accent))]/5 transition-colors flex items-center justify-center"
        title="Add media"
        aria-expanded={state !== null}
        aria-haspopup="true"
      >
        <Plus className="w-4 h-4 text-[rgb(var(--color-text-secondary))]" />
      </button>
      {state !== null && pos && createPortal(
        <div
          ref={portalRef}
          className="fixed z-dropdown min-w-[170px] py-1 bg-[rgb(var(--color-surface))] border border-[rgb(var(--color-border))] rounded-lg shadow-lg"
          style={{ top: pos.top, left: pos.left, transform: "translateY(-100%) translateY(-4px)" }}
          role="menu"
        >
          {items.map((item, i) => {
            const Icon = item.icon;
            return (
              <button
                key={item.label}
                ref={(el) => { itemsRef.current[i] = el; }}
                role="menuitem"
                tabIndex={0}
                onClick={() => handleItemClick(item.action)}
                onKeyDown={(e) => handleKeyDown(e, i)}
                className="w-full flex items-center gap-2 px-3 py-1.5 text-xs text-[rgb(var(--color-text-secondary))] hover:text-[rgb(var(--color-accent))] hover:bg-[rgb(var(--color-accent))]/5 transition-colors text-left"
              >
                <Icon className="w-3.5 h-3.5 flex-shrink-0" />
                {item.label}
              </button>
            );
          })}
        </div>,
        document.body,
      )}
    </div>
  );
}
