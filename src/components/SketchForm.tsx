import { useCallback, useEffect, useRef, useState } from "react";
import { invoke, listen } from "../services/tauri";
import { open } from "@tauri-apps/plugin-dialog";
import { SafeMarkdown } from "./SafeMarkdown";
import { ChevronLeft, Sparkles, Monitor, Plus, X, Folder, Check, Film, Image as ImageIcon } from "lucide-react";
import { shouldSuppressEditorFlush, useAppStore } from "../stores/appStore";
import { useToastStore } from "../stores/toastStore";
import { useSettings } from "../hooks/useSettings";
import { useBackgroundAgentAction } from "../hooks/useBackgroundAgentAction";
import { ScriptTable } from "./ScriptTable";
import { ProjectImage } from "./ProjectImage";
import { ScreenCaptureOverlay } from "./ScreenCaptureOverlay";
import { SketchPreview } from "./SketchPreview";
import { DocumentHeader } from "./DocumentHeader";
import { FieldAiButton } from "./FieldAiButton";
import { LockedDocumentBanner } from "./LockedDocumentBanner";
import { DurationBadge, MetadataEditor } from "./MetadataEditor";
import type { PresentationMode } from "./presentation/types";
import VisualCell from "./VisualCell";
import { exportSketchToWord, type WordOrientation } from "../utils/exportToWord";
import type { PlanningRow, Sketch } from "../types/sketch";
import { diffRow, type RowDiff } from "../utils/textDiff";
import { DocumentToolbar, documentToolbarIcons, type DocumentToolbarAction } from "./DocumentToolbar";
import { SketchIcon } from "./Icons";
import type { RecordingTake } from "../types/recording";
import { summarizeSketchDuration, type DurationDisplayMode } from "../utils/documentMetadata";

interface MonitorInfo {
  id: number;
  name: string;
  x: number;
  y: number;
  width: number;
  height: number;
  is_primary: boolean;
}

const PREVIEW_DATA_KEY = "cutready:preview-data";

type ProjectAsset = { path: string; size: number; assetType: string };

interface SketchRowAssetPickerProps {
  assets: ProjectAsset[];
  projectRoot: string | null;
  selectedPath: string | null;
  onSelectedPathChange: (path: string) => void;
  onInsert: (asset: ProjectAsset) => void;
  onBrowse: () => void | Promise<void>;
  onCancel: () => void;
}

export function SketchRowAssetPicker({
  assets,
  projectRoot,
  selectedPath,
  onSelectedPathChange,
  onInsert,
  onBrowse,
  onCancel,
}: SketchRowAssetPickerProps) {
  const selectedAsset = assets.find((asset) => asset.path === selectedPath) ?? assets[0] ?? null;

  useEffect(() => {
    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") onCancel();
      if ((event.metaKey || event.ctrlKey) && event.key === "Enter" && selectedAsset) {
        event.preventDefault();
        onInsert(selectedAsset);
      }
    };

    window.addEventListener("keydown", handleKeyDown);
    return () => window.removeEventListener("keydown", handleKeyDown);
  }, [onCancel, onInsert, selectedAsset]);

  return (
    <div
      className="fixed inset-0 z-modal flex items-center justify-center p-4 bg-[rgb(var(--color-overlay-scrim)/0.55)]"
      onClick={onCancel}
    >
      <div
        role="dialog"
        aria-modal="true"
        aria-labelledby="sketch-row-asset-picker-title"
        className="bg-[rgb(var(--color-surface))] border border-[rgb(var(--color-border))] rounded-2xl shadow-2xl w-full max-h-[calc(100vh-32px)] flex flex-col overflow-hidden"
        style={{ width: "min(1180px, calc(100vw - 32px))" }}
        onClick={(event) => event.stopPropagation()}
      >
        <div className="flex items-start justify-between gap-4 px-5 py-4 border-b border-[rgb(var(--color-border))]">
          <div>
            <h2 id="sketch-row-asset-picker-title" className="text-sm font-semibold text-[rgb(var(--color-text))]">
              Pick an image or visual
            </h2>
            <p className="mt-1 text-xs text-[rgb(var(--color-text-secondary))]">
              Preview workspace media at demo scale before inserting it into the row.
            </p>
          </div>
          <button
            type="button"
            onClick={onCancel}
            className="rounded-lg p-1.5 text-[rgb(var(--color-text-secondary))] hover:bg-[rgb(var(--color-surface-alt))] hover:text-[rgb(var(--color-text))] transition-colors"
            aria-label="Cancel"
          >
            <X className="w-4 h-4" />
          </button>
        </div>

        <div className="grid min-h-0 flex-1 grid-cols-1 lg:grid-cols-[minmax(0,1fr)_320px]">
          <section className="min-h-0 border-b lg:border-b-0 lg:border-r border-[rgb(var(--color-border))] bg-[rgb(var(--color-surface-alt))]/45 p-4">
            {selectedAsset ? (
              <div className="flex h-full min-h-[360px] flex-col rounded-xl border border-[rgb(var(--color-border))] bg-[rgb(var(--color-surface))] overflow-hidden">
                <div className="flex items-center justify-between gap-3 px-4 py-3 border-b border-[rgb(var(--color-border))]">
                  <div className="min-w-0">
                    <div className="text-xs font-medium text-[rgb(var(--color-text-secondary))]">
                      Previewing selected {selectedAsset.assetType === "visual" ? "visual" : "image"}
                    </div>
                    <div className="truncate text-sm font-medium text-[rgb(var(--color-text))]">{selectedAsset.path}</div>
                  </div>
                  <span className="shrink-0 rounded-full border border-[rgb(var(--color-border))] px-2 py-1 text-[10px] uppercase tracking-wide text-[rgb(var(--color-text-secondary))]">
                    {selectedAsset.assetType === "visual" ? "Visual" : "Image"}
                  </span>
                </div>
                <div className="flex min-h-0 flex-1 items-center justify-center p-4">
                  {selectedAsset.assetType === "visual" ? (
                    <div className="h-full max-h-[62vh] min-h-[300px] w-full">
                      <VisualCell visualPath={selectedAsset.path} mode="full" className="rounded-lg" />
                    </div>
                  ) : (
                    <ProjectImage
                      relativePath={selectedAsset.path}
                      projectRoot={projectRoot}
                      alt={selectedAsset.path.split("/").pop() ?? "Selected workspace image"}
                      className="max-h-[62vh] w-full rounded-lg object-contain"
                    />
                  )}
                </div>
              </div>
            ) : (
              <div className="flex h-full min-h-[360px] items-center justify-center rounded-xl border border-dashed border-[rgb(var(--color-border))] bg-[rgb(var(--color-surface))] p-8 text-center">
                <div>
                  <ImageIcon className="mx-auto h-8 w-8 text-[rgb(var(--color-text-secondary))]" />
                  <div className="mt-3 text-sm font-medium text-[rgb(var(--color-text))]">No images or visuals in workspace</div>
                  <div className="mt-1 text-xs text-[rgb(var(--color-text-secondary))]">
                    Browse files to import a screenshot from outside the project.
                  </div>
                </div>
              </div>
            )}
          </section>

          <aside className="flex min-h-0 flex-col">
            <div className="px-4 py-3 border-b border-[rgb(var(--color-border))]">
              <div className="text-xs font-medium text-[rgb(var(--color-text))]">Workspace assets</div>
              <div className="text-[11px] text-[rgb(var(--color-text-secondary))]">{assets.length} available</div>
            </div>
            <div className="min-h-0 flex-1 overflow-y-auto p-3">
              {assets.length > 0 ? (
                <div className="grid grid-cols-2 gap-2 lg:grid-cols-1">
                  {assets.map((asset) => {
                    const isSelected = asset.path === selectedAsset?.path;
                    const assetName = asset.path.split("/").pop() ?? asset.path;

                    return (
                      <button
                        type="button"
                        key={asset.path}
                        onClick={() => onSelectedPathChange(asset.path)}
                        onDoubleClick={() => onInsert(asset)}
                        className={`group rounded-xl border text-left overflow-hidden transition-colors ${
                          isSelected
                            ? "border-[rgb(var(--color-accent))] bg-[rgb(var(--color-accent))]/10"
                            : "border-[rgb(var(--color-border))] hover:border-[rgb(var(--color-accent))]/70 hover:bg-[rgb(var(--color-surface-alt))]"
                        }`}
                        aria-pressed={isSelected}
                        aria-label={`Preview ${assetName}`}
                        title={asset.path}
                      >
                        <div className="aspect-video bg-[rgb(var(--color-surface-alt))]">
                          {asset.assetType === "visual" ? (
                            <VisualCell visualPath={asset.path} mode="thumbnail" className="!w-full !h-full !rounded-none !border-0" />
                          ) : (
                            <ProjectImage
                              relativePath={asset.path}
                              projectRoot={projectRoot}
                              alt=""
                              className="h-full w-full object-cover"
                            />
                          )}
                        </div>
                        <div className="flex items-center gap-2 px-2.5 py-2">
                          {asset.assetType === "visual" ? (
                            <Film className="h-3.5 w-3.5 shrink-0 text-[rgb(var(--color-accent))]" />
                          ) : (
                            <ImageIcon className="h-3.5 w-3.5 shrink-0 text-[rgb(var(--color-text-secondary))] group-hover:text-[rgb(var(--color-accent))]" />
                          )}
                          <span className="min-w-0 flex-1 truncate text-[11px] text-[rgb(var(--color-text))]">{assetName}</span>
                        </div>
                      </button>
                    );
                  })}
                </div>
              ) : (
                <div className="rounded-xl border border-dashed border-[rgb(var(--color-border))] p-4 text-center text-xs text-[rgb(var(--color-text-secondary))]">
                  No workspace media yet.
                </div>
              )}
            </div>
          </aside>
        </div>

        <div className="flex flex-col-reverse gap-2 border-t border-[rgb(var(--color-border))] px-4 py-3 sm:flex-row sm:items-center sm:justify-between">
          <button
            type="button"
            onClick={() => void onBrowse()}
            className="inline-flex items-center justify-center gap-1.5 text-xs text-[rgb(var(--color-text-secondary))] hover:text-[rgb(var(--color-accent))] px-3 py-2 rounded-lg border border-dashed border-[rgb(var(--color-border))] hover:border-[rgb(var(--color-accent))] hover:bg-[rgb(var(--color-accent))]/5 transition-colors"
          >
            <Folder className="w-3.5 h-3.5" />
            Browse files...
          </button>
          <div className="flex items-center justify-end gap-2">
            <button
              type="button"
              onClick={onCancel}
              className="rounded-lg border border-[rgb(var(--color-border))] px-3 py-2 text-xs font-medium text-[rgb(var(--color-text-secondary))] hover:bg-[rgb(var(--color-surface-alt))] hover:text-[rgb(var(--color-text))] transition-colors"
            >
              Cancel
            </button>
            <button
              type="button"
              onClick={() => selectedAsset && onInsert(selectedAsset)}
              disabled={!selectedAsset}
              className="inline-flex items-center gap-1.5 rounded-lg bg-[rgb(var(--color-accent))] px-3 py-2 text-xs font-medium text-[rgb(var(--color-accent-fg))] transition-colors hover:bg-[rgb(var(--color-accent-hover))] disabled:cursor-not-allowed disabled:opacity-50"
            >
              <Check className="w-3.5 h-3.5" />
              Insert
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}

/**
 * SketchForm — structured editor for a single sketch.
 * Title input + description textarea + planning table.
 */
export function SketchForm() {
  const activeSketch = useAppStore((s) => s.activeSketch);
  const activeSketchPath = useAppStore((s) => s.activeSketchPath);
  const activeStoryboard = useAppStore((s) => s.activeStoryboard);
  const updateSketch = useAppStore((s) => s.updateSketch);
  const closeSketch = useAppStore((s) => s.closeSketch);
  const { settings } = useSettings();

  const [localTitle, setLocalTitle] = useState(activeSketch?.title ?? "");
  const [localRows, setLocalRows] = useState<PlanningRow[]>(activeSketch?.rows ?? []);
  const [captureRowIdx, setCaptureRowIdx] = useState<number | null>(null);
  const [showPreview, setShowPreview] = useState(false);
  const [previewMode, setPreviewMode] = useState<PresentationMode>("slides");
  const [showMonitorPicker, setShowMonitorPicker] = useState(false);
  const [durationDisplayMode, setDurationDisplayMode] = useState<DurationDisplayMode>("minutes");
  const [availableMonitors, setAvailableMonitors] = useState<MonitorInfo[]>([]);
  const [editingDesc, setEditingDesc] = useState(false);
  const [aiUpdatedFlash, setAiUpdatedFlash] = useState(false);
  const [highlightedRows, setHighlightedRows] = useState<Set<number>>(new Set());
  const [rowDiffs, setRowDiffs] = useState<RowDiff[]>([]);
  // Last AI diffs are preserved so the user can re-show them after auto-fade
  const lastAiDiffs = useRef<{ rows: Set<number>; diffs: RowDiff[] } | null>(null);
  // Snapshot of rows before an AI edit lands — used for diff computation
  const aiSnapshotRef = useRef<{ rows: PlanningRow[]; changedIndices: number[] } | null>(null);
  const [visualPromptRow, setVisualPromptRow] = useState<number | null>(null);
  const [visualInstructions, setVisualInstructions] = useState("");
  const [localDesc, setLocalDesc] = useState(
    typeof activeSketch?.description === "string" ? activeSketch.description : ""
  );
  const descRef = useRef<HTMLTextAreaElement>(null);
  useEffect(() => {
    if (editingDesc && descRef.current) {
      descRef.current.focus();
      descRef.current.selectionStart = descRef.current.value.length;
    }
  }, [editingDesc]);
  const titleTimeoutRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const rowsTimeoutRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  const currentProject = useAppStore((s) => s.currentProject);
  const runBackgroundAgentAction = useBackgroundAgentAction();
  const projectRoot = currentProject?.root ?? "";
  const sketchLocked = activeSketch?.locked ?? false;

  // Pending data + path captured at edit time for flush-on-unmount
  const pendingRowsRef = useRef<PlanningRow[] | null>(null);
  const pendingTitleRef = useRef<string | null>(null);
  const pendingPathRef = useRef<string | null>(null);

  const saveSketchEditsForPath = useCallback(
    async (
      path: string,
      title: string | null,
      rows: PlanningRow[] | null,
      reason: string,
    ) => {
      if (shouldSuppressEditorFlush(path)) return;
      try {
        if (title !== null) {
          await invoke("update_sketch_title", { relativePath: path, title });
        }
        if (rows !== null) {
          await invoke("update_sketch", { relativePath: path, rows });
        }
        const store = useAppStore.getState();
        await store.loadSketches();
        if (store.activeSketchPath === path) {
          const sketch = await invoke<Sketch>("get_sketch", { relativePath: path });
          useAppStore.setState({ activeSketch: sketch });
        }
        await store.checkDirty();
        await store.refreshChangedFiles();
      } catch (err) {
        console.error(`[SketchForm] Failed to save pending sketch edits (${reason}):`, err);
        useToastStore.getState().show("Failed to save pending sketch changes", 5000, "error");
      }
    },
    [],
  );

  const flushPendingSketchEdits = useCallback(
    (reason: string) => {
      const path = pendingPathRef.current;
      const title = pendingTitleRef.current;
      const rows = pendingRowsRef.current;
      if (titleTimeoutRef.current) {
        clearTimeout(titleTimeoutRef.current);
        titleTimeoutRef.current = null;
      }
      if (rowsTimeoutRef.current) {
        clearTimeout(rowsTimeoutRef.current);
        rowsTimeoutRef.current = null;
      }
      pendingPathRef.current = null;
      pendingTitleRef.current = null;
      pendingRowsRef.current = null;
      if (!path || (title === null && rows === null)) return;
      void saveSketchEditsForPath(path, title, rows, reason);
    },
    [saveSketchEditsForPath],
  );

  // Reset local state when switching to a different sketch
  // Flush pending debounced saves by their captured path before showing another sketch.
  useEffect(() => {
    flushPendingSketchEdits("sketch switch");
    setLocalTitle(activeSketch?.title ?? "");
    setLocalRows(activeSketch?.rows ?? []);
    setLocalDesc(typeof activeSketch?.description === "string" ? activeSketch.description : "");
    setEditingDesc(false);
  }, [activeSketchPath, activeSketch, flushPendingSketchEdits]);

  // Listen for AI sketch updates — snapshot current rows for diffing
  useEffect(() => {
    const handler = (e: Event) => {
      const detail = (e as CustomEvent).detail as { rows?: number[]; toolName?: string } | undefined;
      const changedIndices = detail?.rows ?? [];
      // Snapshot current rows BEFORE openSketch() refreshes them
      aiSnapshotRef.current = {
        rows: structuredClone(localRows),
        changedIndices,
      };
      setAiUpdatedFlash(true);
      setTimeout(() => setAiUpdatedFlash(false), 3000);
    };
    window.addEventListener("cutready:ai-sketch-updated", handler);
    return () => window.removeEventListener("cutready:ai-sketch-updated", handler);
  }, [localRows]);

  // After activeSketch updates, compute diffs against snapshot
  useEffect(() => {
    const snap = aiSnapshotRef.current;
    if (!snap || !activeSketch) return;
    aiSnapshotRef.current = null;

    const oldRows = snap.rows;
    const newRows = activeSketch.rows ?? [];
    const indices = snap.changedIndices.length > 0
      ? snap.changedIndices
      : newRows.map((_, i) => i); // empty = all rows (write_sketch)

    const diffs: RowDiff[] = [];
    const highlighted = new Set<number>();

    for (const idx of indices) {
      const oldRow = oldRows[idx];
      const newRow = newRows[idx];
      if (!newRow) continue;
      if (!oldRow) {
        // New row added
        highlighted.add(idx);
        diffs.push({
          rowIndex: idx,
          fields: [{ field: "row", segments: [{ type: "added", text: "New row added" }] }],
        });
        continue;
      }
      const diff = diffRow(oldRow as unknown as Record<string, unknown>, newRow as unknown as Record<string, unknown>, idx);
      if (diff) {
        highlighted.add(idx);
        diffs.push(diff);
      }
    }

    // Also detect if total row count changed (rows added/removed at end)
    if (newRows.length > oldRows.length) {
      for (let i = oldRows.length; i < newRows.length; i++) {
        if (!highlighted.has(i)) {
          highlighted.add(i);
          diffs.push({
            rowIndex: i,
            fields: [{ field: "row", segments: [{ type: "added", text: "New row added" }] }],
          });
        }
      }
    }

    setHighlightedRows(highlighted);
    setRowDiffs(diffs);
    // Preserve for re-show
    if (highlighted.size > 0) {
      lastAiDiffs.current = { rows: new Set(highlighted), diffs: [...diffs] };
    }

    // Auto-clear highlights after 10 seconds
    const timer = setTimeout(() => {
      setHighlightedRows(new Set());
      setRowDiffs([]);
    }, 10_000);
    return () => clearTimeout(timer);
  }, [activeSketch]);

  // Keep localStorage in sync so the standalone preview window can pick up changes
  useEffect(() => {
    localStorage.setItem(PREVIEW_DATA_KEY, JSON.stringify({
      rows: localRows,
      projectRoot,
      title: localTitle || "Untitled Sketch",
    }));
  }, [localRows, projectRoot, localTitle]);

  const handleTitleChange = useCallback(
    (value: string) => {
      if (sketchLocked) return;
      setLocalTitle(value);
      if (!activeSketch || !activeSketchPath) return;
      const path = activeSketchPath;
      pendingTitleRef.current = value;
      pendingPathRef.current = path;
      if (titleTimeoutRef.current) clearTimeout(titleTimeoutRef.current);
      titleTimeoutRef.current = setTimeout(() => {
        pendingTitleRef.current = null;
        titleTimeoutRef.current = null;
        void saveSketchEditsForPath(path, value, null, "title debounce");
      }, 500);
    },
    [activeSketch, activeSketchPath, saveSketchEditsForPath, sketchLocked],
  );

  const handleRowsChange = useCallback(
    (rows: PlanningRow[]) => {
      if (sketchLocked) return;
      setLocalRows(rows);
      const path = activeSketchPath;
      pendingRowsRef.current = rows;
      pendingPathRef.current = path;
      if (rowsTimeoutRef.current) clearTimeout(rowsTimeoutRef.current);
      rowsTimeoutRef.current = setTimeout(() => {
        pendingRowsRef.current = null;
        rowsTimeoutRef.current = null;
        if (!path) return;
        void saveSketchEditsForPath(path, null, rows, "rows debounce");
      }, 500);
    },
    [activeSketchPath, saveSketchEditsForPath, sketchLocked],
  );

  const applySketchFromLockCommand = useCallback((sketch: Sketch) => {
    if (!sketch) return;
    useAppStore.setState({ activeSketch: sketch });
    setLocalRows(sketch.rows ?? []);
    setLocalTitle(sketch.title ?? "");
    setLocalDesc(typeof sketch.description === "string" ? sketch.description : "");
  }, []);

  const handleSketchLockChange = useCallback(async (locked: boolean) => {
    if (!activeSketchPath) return;
    try {
      const sketch = await invoke<Sketch>("set_sketch_lock", { relativePath: activeSketchPath, locked });
      applySketchFromLockCommand(sketch);
      const { loadSketches, refreshChangedFiles, checkDirty } = useAppStore.getState();
      await loadSketches();
      await checkDirty();
      await refreshChangedFiles();
    } catch (err) {
      console.error("[SketchForm] Failed to update sketch lock:", err);
    }
  }, [activeSketchPath, applySketchFromLockCommand]);

  const handleRowLockChange = useCallback(async (index: number, locked: boolean) => {
    if (!activeSketchPath) return;
    try {
      const sketch = await invoke<Sketch>("set_planning_row_lock", { relativePath: activeSketchPath, index, locked });
      applySketchFromLockCommand(sketch);
      const { refreshChangedFiles, checkDirty } = useAppStore.getState();
      await checkDirty();
      await refreshChangedFiles();
    } catch (err) {
      console.error("[SketchForm] Failed to update row lock:", err);
    }
  }, [activeSketchPath, applySketchFromLockCommand]);

  const handleCellLockChange = useCallback(async (index: number, field: string, locked: boolean) => {
    if (!activeSketchPath) return;
    try {
      const sketch = await invoke<Sketch>("set_planning_cell_lock", { relativePath: activeSketchPath, index, field, locked });
      applySketchFromLockCommand(sketch);
      const { refreshChangedFiles, checkDirty } = useAppStore.getState();
      await checkDirty();
      await refreshChangedFiles();
    } catch (err) {
      console.error("[SketchForm] Failed to update cell lock:", err);
    }
  }, [activeSketchPath, applySketchFromLockCommand]);

  // Flush pending debounced saves on unmount (e.g., tab close)
  useEffect(() => {
    return () => {
      flushPendingSketchEdits("unmount");
    };
  }, [flushPendingSketchEdits]);

  const handleCaptureScreenshot = useCallback((rowIndex: number) => {
    setCaptureRowIdx(rowIndex);
  }, []);

  const handleGenerateVisual = useCallback(() => {
    if (visualPromptRow === null) return;
    const row = localRows[visualPromptRow];
    const instructions = visualInstructions.trim();
    let prompt: string;
    if (instructions) {
      prompt = `Generate an animated framing visual ONLY for sketch "${activeSketchPath ?? "current"}", row index ${visualPromptRow} (0-based).

**USER INSTRUCTIONS (HIGHEST PRIORITY — follow these exactly):**
${instructions}

Row context:
- **Narrative:** ${row?.narrative || "(empty)"}
- **Actions:** ${row?.demo_actions || "(empty)"}

The Actions describe what happens on screen — use them as visual design hints. You may read the sketch for context, but the only persistent edit allowed is set_row_visual for row index ${visualPromptRow}. Do not call design_plan, write_sketch, update_planning_row, write_storyboard, or set_row_visual for any other row. Do not create, remove, reorder, or rewrite rows. If validation fails, fix the visual and retry set_row_visual for this same row only. Use a 960×540 canvas. The user instructions above override any defaults.`;
    } else {
      prompt = `Generate an animated framing visual ONLY for sketch "${activeSketchPath ?? "current"}", row index ${visualPromptRow} (0-based).

Row context:
- **Narrative:** ${row?.narrative || "(empty)"}
- **Actions:** ${row?.demo_actions || "(empty)"}

The Actions describe what happens on screen — use them as visual design hints. You may read the sketch for context, but the only persistent edit allowed is set_row_visual for row index ${visualPromptRow}. Do not call design_plan, write_sketch, update_planning_row, write_storyboard, or set_row_visual for any other row. Do not create, remove, reorder, or rewrite rows. If validation fails, fix the visual and retry set_row_visual for this same row only. Use a 960×540 canvas.`;
    }
    void runBackgroundAgentAction(prompt, { agent: "designer", label: "Generate visual" });
    setVisualPromptRow(null);
    setVisualInstructions("");
  }, [visualPromptRow, localRows, activeSketchPath, visualInstructions, runBackgroundAgentAction]);

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

  // Image/visual picker state
  const [imagePickerRowIdx, setImagePickerRowIdx] = useState<number | null>(null);
  const [projectAssets, setProjectAssets] = useState<ProjectAsset[]>([]);
  const [selectedAssetPath, setSelectedAssetPath] = useState<string | null>(null);

  const handlePickImage = useCallback(async (rowIndex: number) => {
    setImagePickerRowIdx(rowIndex);
    try {
      const images = await invoke<{ path: string; size: number; referencedBy: string[]; assetType: string }[]>("list_project_images");
      const assets = images.map((i) => ({ path: i.path, size: i.size, assetType: i.assetType }));
      setProjectAssets(assets);
      setSelectedAssetPath(assets[0]?.path ?? null);
    } catch {
      setProjectAssets([]);
      setSelectedAssetPath(null);
    }
  }, []);

  const handleAssetPicked = useCallback((asset: { path: string; assetType: string }) => {
    if (imagePickerRowIdx === null) return;
    const updated = [...localRows];
    if (asset.assetType === "visual") {
      updated[imagePickerRowIdx] = { ...updated[imagePickerRowIdx], visual: asset.path, screenshot: null };
    } else {
      updated[imagePickerRowIdx] = { ...updated[imagePickerRowIdx], screenshot: asset.path, visual: null };
    }
    handleRowsChange(updated);
    setImagePickerRowIdx(null);
    setSelectedAssetPath(null);
  }, [imagePickerRowIdx, localRows, handleRowsChange]);

  const handleBrowseImage = useCallback(async (rowIndex: number) => {
    const selected = await open({
      multiple: false,
      filters: [{ name: "Images", extensions: ["png", "jpg", "jpeg", "gif", "webp", "svg"] }],
    });
    if (!selected) return;
    const filePath = typeof selected === "string" ? selected : selected;
    try {
      const relativePath = await invoke<string>("import_image", { sourcePath: filePath });
      const updated = [...localRows];
      updated[rowIndex] = { ...updated[rowIndex], screenshot: relativePath };
      handleRowsChange(updated);
    } catch (err) {
      console.error("Failed to import image:", err);
    }
  }, [localRows, handleRowsChange]);

  /** Launch fullscreen preview on a specific monitor */
  const launchPreviewOnMonitor = useCallback(async (monitor: MonitorInfo | null, mode: PresentationMode = "slides") => {
    setShowMonitorPicker(false);
    // Serialize sketch data for the preview window to read
    localStorage.setItem(PREVIEW_DATA_KEY, JSON.stringify({
      rows: localRows,
      projectRoot,
      title: localTitle || "Untitled Sketch",
      initialMode: mode,
    }));
    try {
      await invoke("open_preview_window", {
        physX: monitor?.x ?? 0,
        physY: monitor?.y ?? 0,
        physW: monitor?.width ?? 0,
        physH: monitor?.height ?? 0,
      });
    } catch (e) {
      console.error("[SketchForm] Failed to open preview window:", e);
      setPreviewMode(mode);
      setShowPreview(true);
    }
  }, [localRows, projectRoot, localTitle]);

  /** Launch presentation in fullscreen — single monitor launches directly, multi shows picker */
  const launchPresentation = useCallback(async (mode: PresentationMode = "slides") => {
    try {
      const monitors: MonitorInfo[] = await invoke("list_monitors");
      if (monitors.length > 1) {
        setPreviewMode(mode);
        setAvailableMonitors(monitors);
        setShowMonitorPicker(true);
      } else {
        // Single or zero monitors — launch directly (Rust will auto-detect)
        await launchPreviewOnMonitor(monitors[0] ?? null, mode);
      }
    } catch (e) {
      console.error("[SketchForm] list_monitors failed, launching directly:", e);
      // list_monitors failed — launch directly without coordinates
      await launchPreviewOnMonitor(null, mode);
    }
  }, [launchPreviewOnMonitor]);

  const handleExportWord = useCallback((orientation: WordOrientation = "landscape") => {
    if (!activeSketch) return;
    exportSketchToWord(activeSketch, projectRoot, orientation).then((exported) => {
      if (!exported) return;
      useToastStore.getState().show("Export complete");
      useAppStore.getState().addActivityEntries([{ id: crypto.randomUUID(), timestamp: new Date(), source: "export", content: `Exported "${activeSketch.title}" to Word`, level: "success" }]);
    }).catch(err => console.error("Word export failed:", err));
  }, [activeSketch, projectRoot]);

  const handleRecord = useCallback(async () => {
    if (!activeSketchPath) return;
    try {
      await invoke("open_recorder_window", {
        scope: { kind: "sketch", path: activeSketchPath },
        documentTitle: localTitle || "Untitled sketch",
      });
    } catch (err) {
      useToastStore.getState().show(`Could not open recorder: ${err}`, 5000, "error");
    }
  }, [activeSketchPath, localTitle]);

  useEffect(() => {
    if (!activeSketchPath) return;
    const unlistenStarted = listen<RecordingTake>("recording-control-started", (event) => {
      if (event.payload.scope.kind !== "sketch" || event.payload.scope.path !== activeSketchPath) return;
      useAppStore.getState().addActivityEntries([{ id: crypto.randomUUID(), timestamp: new Date(), source: "recording", content: `Started recording take ${event.payload.id} for "${localTitle || "Untitled sketch"}"`, level: "info" }]);
    });
    const unlistenStopped = listen<RecordingTake>("recording-control-stopped", (event) => {
      if (event.payload.scope.kind !== "sketch" || event.payload.scope.path !== activeSketchPath) return;
      useAppStore.getState().addActivityEntries([{ id: crypto.randomUUID(), timestamp: new Date(), source: "recording", content: `Saved recording take ${event.payload.id} for "${localTitle || "Untitled sketch"}"`, level: event.payload.status === "finalized" ? "success" : "error" }]);
    });
    const unlistenDiscarded = listen<RecordingTake>("recording-control-discarded", (event) => {
      if (event.payload.scope.kind !== "sketch" || event.payload.scope.path !== activeSketchPath) return;
      useAppStore.getState().addActivityEntries([{ id: crypto.randomUUID(), timestamp: new Date(), source: "recording", content: `Discarded recording take ${event.payload.id} for "${localTitle || "Untitled sketch"}"`, level: "info" }]);
    });
    return () => {
      unlistenStarted.then((fn) => fn());
      unlistenStopped.then((fn) => fn());
      unlistenDiscarded.then((fn) => fn());
    };
  }, [activeSketchPath, localTitle]);

  if (!activeSketch) return null;

  const hasRows = localRows.length > 0;
  const canRecord = hasRows && !!activeSketchPath;
  const durationSummary = summarizeSketchDuration(localRows);
  const presentActions: DocumentToolbarAction[] = hasRows ? [
    {
      id: "slide-only",
      label: "Slide-only view",
      icon: documentToolbarIcons.playCircle,
      onSelect: () => launchPresentation("slide-only"),
    },
    {
      id: "teleprompter",
      label: "Teleprompter",
      icon: documentToolbarIcons.monitorPlay,
      onSelect: () => launchPresentation("teleprompter"),
    },
    {
      id: "preview",
      label: "Preview",
      icon: documentToolbarIcons.monitor,
      onSelect: () => launchPresentation("slides"),
    },
  ] : [];
  const aiActions: DocumentToolbarAction[] = !sketchLocked ? [
    {
      id: "improve-sketch",
      label: localRows.length === 0 ? "Generate plan" : "Improve sketch",
      icon: documentToolbarIcons.sparkles,
      onSelect: () => void runBackgroundAgentAction(
        localRows.length === 0
          ? `Generate a complete sketch plan for "${activeSketch?.title ?? "this sketch"}". ${activeSketch?.description && typeof activeSketch.description === "string" ? `Description: ${activeSketch.description}. ` : ""}Create well-structured planning rows with time, narrative, and demo_actions.`
          : `Review and improve the entire sketch "${activeSketchPath ?? "current"}". Refine the narrative flow, tighten timing, and make demo actions more specific. Use write_sketch to apply changes.`,
        { label: localRows.length === 0 ? "Generate plan" : "Improve sketch" },
      ),
    },
  ] : [];
  const exportActions: DocumentToolbarAction[] = hasRows ? [
    {
      id: "word-landscape",
      label: "Word - Landscape",
      icon: documentToolbarIcons.fileText,
      onSelect: () => handleExportWord("landscape"),
    },
    {
      id: "word-portrait",
      label: "Word - Portrait",
      icon: documentToolbarIcons.fileText,
      onSelect: () => handleExportWord("portrait"),
    },
  ] : [];

  return (
    <div className="flex-1 overflow-y-auto">
      <div className="mx-auto px-6 py-8" style={{ maxWidth: "var(--editor-max-width, 56rem)" }}>
        {/* Back button — only show when inside a storyboard */}
        {activeStoryboard && (
          <button
            onClick={closeSketch}
            className="flex items-center gap-1.5 text-xs text-[rgb(var(--color-text-secondary))] hover:text-[rgb(var(--color-text))] transition-colors mb-6"
          >
            <ChevronLeft className="w-3.5 h-3.5" />
            Back to storyboard
          </button>
        )}

        {/* AI updated indicator */}
        {aiUpdatedFlash && (
          <div className="mb-4 flex items-center gap-2 px-3 py-1.5 rounded-lg bg-[rgb(var(--color-accent))]/10 border border-[rgb(var(--color-accent))]/20 text-xs text-[rgb(var(--color-accent))] animate-pulse">
            <Sparkles className="w-3 h-3" />
            Updated by AI
          </div>
        )}

        <DocumentHeader
          icon={<SketchIcon size={20} />}
          badge={
            <DurationBadge
              summary={durationSummary}
              mode={durationDisplayMode}
              onModeChange={setDurationDisplayMode}
            />
          }
          toolbar={
            <div className="relative">
              <DocumentToolbar
                canRecord={canRecord}
                onRecord={handleRecord}
                showRecord={settings.featureRecording}
                presentActions={presentActions}
                aiActions={aiActions}
                exportActions={exportActions}
                locked={sketchLocked}
                onToggleLock={() => handleSketchLockChange(!sketchLocked)}
                lockLabel="Lock sketch"
                unlockLabel="Unlock sketch"
              />
              {showMonitorPicker && (
                <>
                  <div className="fixed inset-0 z-dropdown" onClick={() => setShowMonitorPicker(false)} />
                  <div className="absolute right-0 top-full mt-2 z-modal min-w-[200px] rounded-lg border border-[rgb(var(--color-border))] bg-[rgb(var(--color-surface))] py-1 shadow-lg">
                    <div className="border-b border-[rgb(var(--color-border))] px-3 py-2 text-xs font-medium uppercase tracking-wider text-[rgb(var(--color-text-secondary))]">
                      Present on
                    </div>
                    {availableMonitors.map((m) => (
                      <button
                        key={m.id}
                        onClick={() => launchPreviewOnMonitor(m, previewMode)}
                        className="flex w-full items-center gap-2 px-3 py-2 text-left text-sm text-[rgb(var(--color-text))] transition-colors hover:bg-[rgb(var(--color-surface-alt))]"
                      >
                        <Monitor className="h-3.5 w-3.5" />
                        <span>{m.name || `Monitor ${m.id}`}</span>
                        {m.is_primary && (
                          <span className="ml-auto text-[10px] font-medium text-[rgb(var(--color-accent))]">Primary</span>
                        )}
                      </button>
                    ))}
                    <div className="border-t border-[rgb(var(--color-border))]">
                      <button
                        onClick={() => { setShowMonitorPicker(false); setShowPreview(true); }}
                        className="w-full px-3 py-2 text-left text-xs text-[rgb(var(--color-text-secondary))] transition-colors hover:bg-[rgb(var(--color-surface-alt))]"
                      >
                        Preview in window instead
                      </button>
                    </div>
                  </div>
                </>
              )}
            </div>
          }
          title={
            <div className="relative min-w-0 group/title">
            <input
              type="text"
              value={localTitle}
              onChange={(e) => handleTitleChange(e.target.value)}
              readOnly={sketchLocked}
              placeholder="Sketch title..."
              title={localTitle}
              className={`min-w-0 w-full truncate border-none bg-transparent text-2xl font-semibold text-[rgb(var(--color-text))] outline-none placeholder:text-[rgb(var(--color-text-secondary))]/40 ${localTitle && !sketchLocked ? "pr-8" : ""} ${sketchLocked ? "cursor-default" : ""}`}
            />
            {localTitle && !sketchLocked && (
              <FieldAiButton
                onClick={() => void runBackgroundAgentAction(
                  `Improve the title of sketch "${activeSketchPath ?? "current"}". Current title: "${localTitle}". Suggest a more compelling, concise title. IMPORTANT: Only update the title — do NOT change the description or any rows. Use write_sketch with the improved title but keep the existing description and all rows exactly as they are.`,
                  { label: "Improve sketch title" }
                )}
                className="absolute right-0 top-1/2 -translate-y-1/2 group-hover/title:opacity-100"
                label="Improve title with AI"
                title="Improve title with AI"
              />
            )}
            </div>
          }
        />

        {sketchLocked && (
          <LockedDocumentBanner message="Sketch is locked. Unlock it to edit fields, rows, media, or AI suggestions." />
        )}

        {/* Description — markdown preview, click to edit */}
        <div className="relative group/desc my-8">
          {editingDesc ? (
            <textarea
              ref={descRef}
              value={localDesc}
              onChange={(e) => {
                if (sketchLocked) return;
                setLocalDesc(e.target.value);
                updateSketch({ description: e.target.value });
              }}
              onBlur={() => setEditingDesc(false)}
              placeholder="Describe what this sketch covers..."
              rows={4}
              className="w-full text-sm bg-transparent text-[rgb(var(--color-text))] placeholder:text-[rgb(var(--color-text-secondary))]/40 outline-none border border-[rgb(var(--color-border))] rounded-lg px-3 py-2 resize-none focus:ring-1 focus:ring-[rgb(var(--color-accent))]/40 transition-colors"
              autoFocus
            />
          ) : (
            <div
              tabIndex={0}
              onClick={() => { if (!sketchLocked) setEditingDesc(true); }}
              onFocus={() => { if (!sketchLocked) setEditingDesc(true); }}
              className={`min-h-[2rem] rounded-lg px-3 py-2 text-sm border border-transparent hover:border-[rgb(var(--color-border))] transition-colors ${!sketchLocked ? "pr-10" : ""} ${sketchLocked ? "cursor-default" : "cursor-text"}`}
            >
              {localDesc ? (
                <div className="prose-desc text-[rgb(var(--color-text))] leading-relaxed">
                  <SafeMarkdown>{localDesc}</SafeMarkdown>
                </div>
              ) : (
                <span className="text-[rgb(var(--color-text-secondary))]/40">
                  Describe what this sketch covers...
                </span>
              )}
            </div>
          )}
          {!editingDesc && !sketchLocked && (
            <FieldAiButton
              onClick={() => void runBackgroundAgentAction(
                localDesc
                  ? `Improve the description of sketch "${activeSketchPath ?? "current"}". Current description: "${localDesc}". Make it clearer and more informative. IMPORTANT: Only update the description — do NOT change the title or any rows. Use write_sketch with the improved description but keep the existing title and all rows exactly as they are.`
                  : `Write a description for sketch "${activeSketchPath ?? "current"}" titled "${localTitle}". Look at the planning rows to understand what the sketch covers and write a concise description. IMPORTANT: Only update the description — do NOT change the title or any rows. Use write_sketch with the new description but keep the existing title and all rows exactly as they are.`,
                { label: localDesc ? "Improve sketch description" : "Generate sketch description" }
              )}
              className="absolute right-2 top-2 group-hover/desc:opacity-100 group-focus-within/desc:opacity-100"
              label={localDesc ? "Improve description with AI" : "Generate description with AI"}
              title={localDesc ? "Improve description with AI" : "Generate description with AI"}
              iconClassName="h-3 w-3"
            />
          )}
        </div>

        <div className="mb-6">
          <MetadataEditor
            metadata={activeSketch.metadata}
            disabled={sketchLocked}
            onChange={(metadata) => updateSketch({ metadata })}
          />
        </div>

        {/* Planning Table */}
        <div>
          <div className="mb-3" />
          <ScriptTable
            rows={localRows}
            onChange={handleRowsChange}
            readOnly={sketchLocked}
            onCaptureScreenshot={handleCaptureScreenshot}
            onPickImage={handlePickImage}
            onBrowseImage={handleBrowseImage}
            onSparkle={(prompt) => void runBackgroundAgentAction(prompt, { label: "Improve row" })}
            onGenerateVisual={(rowIndex) => {
              setVisualPromptRow(rowIndex);
              setVisualInstructions("");
            }}
            onNudgeVisual={(rowIndex, instruction) => {
              const row = localRows[rowIndex];
              const prompt = `Modify the existing visual ONLY for sketch "${activeSketchPath ?? "current"}", row index ${rowIndex} (0-based).

**USER INSTRUCTIONS (HIGHEST PRIORITY):**
${instruction}

Row context:
- **Narrative:** ${row?.narrative || "(empty)"}
- **Actions:** ${row?.demo_actions || "(empty)"}

The row already has a visual and design_plan. You may read the sketch for context, but the only persistent edit allowed is set_row_visual for row index ${rowIndex}. Do not call write_sketch, update_planning_row, write_storyboard, or set_row_visual for any other row. Do not create, remove, reorder, or rewrite rows. Keep the existing design but apply the requested changes. Do NOT redesign from scratch.`;
              void runBackgroundAgentAction(prompt, { agent: "designer", label: "Modify visual" });
            }}
            projectRoot={projectRoot}
            sketchPath={activeSketchPath ?? undefined}
            onRowLockChange={handleRowLockChange}
            onCellLockChange={handleCellLockChange}
            highlightedRows={highlightedRows}
            rowDiffs={rowDiffs}
            aiSnapshotRows={aiSnapshotRef.current?.rows ?? null}
            onDismissHighlights={() => { setHighlightedRows(new Set()); setRowDiffs([]); }}
            hasLastAiDiffs={highlightedRows.size === 0 && lastAiDiffs.current !== null}
            onReShowHighlights={() => {
              const saved = lastAiDiffs.current;
              if (!saved) return;
              setHighlightedRows(new Set(saved.rows));
              setRowDiffs([...saved.diffs]);
              // Auto-clear again after 10s
              setTimeout(() => { setHighlightedRows(new Set()); setRowDiffs([]); }, 10_000);
            }}
          />
          {!sketchLocked && (
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
              className="flex items-center gap-1.5 mt-3 px-3 py-2 text-xs text-[rgb(var(--color-text-secondary))] hover:text-[rgb(var(--color-accent))] border border-dashed border-[rgb(var(--color-border))] hover:border-[rgb(var(--color-accent))]/40 rounded-lg transition-colors w-full justify-center"
            >
              <Plus className="w-3.5 h-3.5" />
              Add Row
            </button>
          )}
        </div>
      </div>

      {/* Screen capture overlay */}
      {captureRowIdx !== null && (
        <ScreenCaptureOverlay
          onCapture={handleCaptureComplete}
          onCancel={handleCaptureCancel}
        />
      )}

      {/* Asset picker overlay — screenshots + visuals */}
      {imagePickerRowIdx !== null && (
        <SketchRowAssetPicker
          assets={projectAssets}
          projectRoot={projectRoot}
          selectedPath={selectedAssetPath}
          onSelectedPathChange={setSelectedAssetPath}
          onInsert={handleAssetPicked}
          onCancel={() => {
            setImagePickerRowIdx(null);
            setSelectedAssetPath(null);
          }}
          onBrowse={async () => {
            if (imagePickerRowIdx === null) return;
            const rowIndex = imagePickerRowIdx;
            setImagePickerRowIdx(null);
            setSelectedAssetPath(null);
            await handleBrowseImage(rowIndex);
          }}
        />
      )}

      {/* Visual generation instructions popup */}
      {visualPromptRow !== null && (
        <div className="fixed inset-0 z-modal flex items-center justify-center bg-[rgb(var(--color-overlay-scrim)/0.4)]" onClick={() => setVisualPromptRow(null)}>
          <div className="bg-[rgb(var(--color-surface))] border border-[rgb(var(--color-border))] rounded-xl shadow-2xl w-full max-w-md flex flex-col" onClick={(e) => e.stopPropagation()}>
            <div className="flex items-center justify-between px-4 py-3 border-b border-[rgb(var(--color-border))]">
              <span className="text-sm font-medium text-[rgb(var(--color-text))]">
                Generate Visual — Row {visualPromptRow + 1}
              </span>
              <button onClick={() => setVisualPromptRow(null)} className="text-[rgb(var(--color-text-secondary))] hover:text-[rgb(var(--color-text))]">
                <X className="w-3.5 h-3.5" />
              </button>
            </div>
            <div className="px-4 py-3 flex flex-col gap-3">
              <div className="text-xs text-[rgb(var(--color-text-secondary))]">
                {localRows[visualPromptRow]?.narrative
                  ? `"${localRows[visualPromptRow].narrative.slice(0, 120)}${localRows[visualPromptRow].narrative.length > 120 ? "…" : ""}"`
                  : "No narrative for this row yet."}
              </div>
              <textarea
                autoFocus
                value={visualInstructions}
                onChange={(e) => setVisualInstructions(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) {
                    e.preventDefault();
                    handleGenerateVisual();
                  }
                }}
                placeholder="Additional instructions for the AI (optional)&#10;e.g. &quot;Use blue tones&quot;, &quot;Show a flowchart&quot;, &quot;Minimalist style&quot;"
                className="w-full h-24 px-3 py-2 text-sm bg-[rgb(var(--color-surface-alt))] border border-[rgb(var(--color-border))] rounded-lg text-[rgb(var(--color-text))] placeholder:text-[rgb(var(--color-text-secondary))]/50 resize-none focus:outline-none focus:border-[rgb(var(--color-accent))]"
              />
            </div>
            <div className="flex items-center justify-end gap-2 px-4 py-3 border-t border-[rgb(var(--color-border))]">
              <button
                onClick={() => setVisualPromptRow(null)}
                className="px-3 py-1.5 text-xs text-[rgb(var(--color-text-secondary))] hover:text-[rgb(var(--color-text))] rounded-md transition-colors"
              >
                Cancel
              </button>
              <button
                onClick={handleGenerateVisual}
                className="px-4 py-1.5 text-xs font-medium text-[rgb(var(--color-accent-fg))] bg-[rgb(var(--color-accent))] hover:bg-[rgb(var(--color-accent-hover))] rounded-md transition-colors flex items-center gap-1.5"
              >
                <Sparkles className="w-3 h-3" />
                Generate
                <span className="text-[10px] opacity-60 ml-1">⌘↵</span>
              </button>
            </div>
          </div>
        </div>
      )}

      {/* Presentation preview */}
      {showPreview && (
        <SketchPreview
          rows={localRows}
          projectRoot={projectRoot}
          title={localTitle || "Untitled Sketch"}
          initialMode={previewMode}
          onClose={() => { setShowPreview(false); setPreviewMode("slides"); }}
        />
      )}
    </div>
  );
}
