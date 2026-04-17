import { useCallback, useEffect, useRef, useState } from "react";
import { invoke, convertFileSrc } from "@tauri-apps/api/core";
import { open } from "@tauri-apps/plugin-dialog";
import { SafeMarkdown } from "./SafeMarkdown";
import { ChevronLeft, Sparkles, Monitor, Plus, X, Folder, MoreHorizontal } from "lucide-react";
import { useAppStore } from "../stores/appStore";
import { useToastStore } from "../stores/toastStore";
import { ScriptTable } from "./ScriptTable";
import { ScreenCaptureOverlay } from "./ScreenCaptureOverlay";
import { SketchPreview } from "./SketchPreview";
import VisualCell from "./VisualCell";
import { exportSketchToWord } from "../utils/exportToWord";
import { usePopover } from "../hooks/usePopover";
import type { PlanningRow } from "../types/sketch";
import { diffRow, type RowDiff } from "../utils/textDiff";

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
  const [showMonitorPicker, setShowMonitorPicker] = useState(false);
  const [availableMonitors, setAvailableMonitors] = useState<MonitorInfo[]>([]);
  const [editingDesc, setEditingDesc] = useState(false);
  const [aiUpdatedFlash, setAiUpdatedFlash] = useState(false);
  const [highlightedRows, setHighlightedRows] = useState<Set<number>>(new Set());
  const [rowDiffs, setRowDiffs] = useState<RowDiff[]>([]);
  // Last AI diffs are preserved so the user can re-show them after auto-fade
  const lastAiDiffs = useRef<{ rows: Set<number>; diffs: RowDiff[] } | null>(null);
  // Snapshot of rows before an AI edit lands — used for diff computation
  const aiSnapshotRef = useRef<{ rows: PlanningRow[]; changedIndices: number[] } | null>(null);
  const { state: showOverflow, toggle: toggleOverflow, close: closeOverflow, ref: overflowRef } = usePopover();
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
  const sendChatPrompt = useAppStore((s) => s.sendChatPrompt);
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
    setLocalDesc(typeof activeSketch?.description === "string" ? activeSketch.description : "");
    setEditingDesc(false);
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
      : newRows.map((_, i) => i); // empty = all rows (set_planning_rows)

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

  const handleGenerateVisual = useCallback(() => {
    if (visualPromptRow === null) return;
    const row = localRows[visualPromptRow];
    const instructions = visualInstructions.trim();
    let prompt: string;
    if (instructions) {
      prompt = `Generate an animated framing visual for sketch "${activeSketchPath ?? "current"}", row index ${visualPromptRow} (0-based).

**USER INSTRUCTIONS (HIGHEST PRIORITY — follow these exactly):**
${instructions}

Row context:
- **Narrative:** ${row?.narrative || "(empty)"}
- **Actions:** ${row?.demo_actions || "(empty)"}

The Actions describe what happens on screen — use them as visual design hints. Read the sketch with read_sketch for full context, then design_plan, then set_row_visual (960×540 canvas). The user instructions above override any defaults.`;
    } else {
      prompt = `Generate an animated framing visual for sketch "${activeSketchPath ?? "current"}", row index ${visualPromptRow} (0-based).

Row context:
- **Narrative:** ${row?.narrative || "(empty)"}
- **Actions:** ${row?.demo_actions || "(empty)"}

The Actions describe what happens on screen — use them as visual design hints. Read the full sketch first with read_sketch to understand the overall context. Then call design_plan, then generate and save the visual with set_row_visual (960×540 canvas).`;
    }
    sendChatPrompt(prompt, { silent: true, agent: "designer" });
    setVisualPromptRow(null);
    setVisualInstructions("");
  }, [visualPromptRow, localRows, activeSketchPath, visualInstructions, sendChatPrompt]);

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
  const [projectAssets, setProjectAssets] = useState<{ path: string; size: number; assetType: string }[]>([]);

  const handlePickImage = useCallback(async (rowIndex: number) => {
    setImagePickerRowIdx(rowIndex);
    try {
      const images = await invoke<{ path: string; size: number; referencedBy: string[]; assetType: string }[]>("list_project_images");
      setProjectAssets(images.map((i) => ({ path: i.path, size: i.size, assetType: i.assetType })));
    } catch {
      setProjectAssets([]);
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
  const launchPreviewOnMonitor = useCallback(async (monitor: MonitorInfo) => {
    setShowMonitorPicker(false);
    // Serialize sketch data for the preview window to read
    localStorage.setItem(PREVIEW_DATA_KEY, JSON.stringify({
      rows: localRows,
      projectRoot,
      title: localTitle || "Untitled Sketch",
    }));
    try {
      await invoke("open_preview_window", {
        physX: monitor.x,
        physY: monitor.y,
        physW: monitor.width,
        physH: monitor.height,
      });
    } catch (e) {
      console.error("[SketchForm] Failed to open preview window:", e);
    }
  }, [localRows, projectRoot, localTitle]);

  /** Handle preview button click — single monitor launches directly, multi shows picker */
  const handlePreviewClick = useCallback(async () => {
    try {
      const monitors: MonitorInfo[] = await invoke("list_monitors");
      if (monitors.length === 1) {
        await launchPreviewOnMonitor(monitors[0]);
      } else {
        setAvailableMonitors(monitors);
        setShowMonitorPicker(true);
      }
    } catch (e) {
      console.error("[SketchForm] Failed to list monitors:", e);
      // Fallback: open in-window preview
      setShowPreview(true);
    }
  }, [launchPreviewOnMonitor]);

  if (!activeSketch) return null;

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

        {/* Title + overflow menu */}
        <div className="flex items-center gap-3 mb-4">
          <div className="relative flex-1 group/title">
            <input
              type="text"
              value={localTitle}
              onChange={(e) => handleTitleChange(e.target.value)}
              placeholder="Sketch title..."
              className="w-full text-2xl font-semibold bg-transparent text-[rgb(var(--color-text))] placeholder:text-[rgb(var(--color-text-secondary))]/40 outline-none border-none"
            />
            {localTitle && (
              <button
                onClick={() => sendChatPrompt(
                  `Improve the title of sketch "${activeSketchPath ?? "current"}". Current title: "${localTitle}". Suggest a more compelling, concise title. IMPORTANT: Only update the title — do NOT change the description or any rows. Use set_planning_rows with the improved title but keep the existing description and all rows exactly as they are.`,
                  { silent: true }
                )}
                className="absolute right-1 top-1/2 -translate-y-1/2 flex items-center gap-1 opacity-0 group-hover/title:opacity-100 p-1 rounded text-[rgb(var(--color-accent))] hover:bg-[rgb(var(--color-accent))]/10 transition-all"
                title="Improve title with AI"
              >
                <Sparkles className="w-3.5 h-3.5" />
                <span className="text-[10px]">Improve</span>
              </button>
            )}
          </div>
          {localRows.length > 0 && (
            <div className="relative" ref={overflowRef}>
              <button
                onClick={toggleOverflow}
                className="p-1.5 rounded-md text-[rgb(var(--color-text-secondary))] hover:text-[rgb(var(--color-text))] hover:bg-[rgb(var(--color-surface-alt))] transition-colors"
                title="More actions"
              >
                <MoreHorizontal className="w-4 h-4" />
              </button>
              {showOverflow && (
                <div className="absolute right-0 top-full mt-1 z-dropdown w-[180px] py-1 bg-[rgb(var(--color-surface))] border border-[rgb(var(--color-border))] rounded-lg shadow-lg">
                  <button
                    onClick={() => {
                      if (!activeSketch) return;
                      closeOverflow();
                      exportSketchToWord(activeSketch, projectRoot, "landscape").then(() => {
                        useToastStore.getState().show("Export complete");
                        useAppStore.getState().addActivityEntries([{ id: crypto.randomUUID(), timestamp: new Date(), source: "export", content: `Exported "${activeSketch.title}" to Word`, level: "success" }]);
                      }).catch(err => console.error("Word export failed:", err));
                    }}
                    className="w-full px-3 py-2 text-left text-[12px] text-[rgb(var(--color-text))] hover:bg-[rgb(var(--color-surface-alt))] transition-colors flex items-center gap-2"
                  >
                    Export to Word
                  </button>
                  <button
                    onClick={() => { handlePreviewClick(); closeOverflow(); }}
                    className="w-full px-3 py-2 text-left text-[12px] text-[rgb(var(--color-text))] hover:bg-[rgb(var(--color-surface-alt))] transition-colors flex items-center gap-2"
                  >
                    Preview
                  </button>
                </div>
              )}

              {/* Monitor picker dropdown */}
              {showMonitorPicker && (
                <>
                  <div className="fixed inset-0 z-overlay" onClick={() => setShowMonitorPicker(false)} />
                  <div className="absolute right-0 top-full mt-2 z-dropdown bg-[rgb(var(--color-surface))] border border-[rgb(var(--color-border))] rounded-lg shadow-lg py-1 min-w-[200px]">
                    <div className="px-3 py-2 text-xs font-medium text-[rgb(var(--color-text-secondary))] uppercase tracking-wider border-b border-[rgb(var(--color-border))]">
                      Present on
                    </div>
                    {availableMonitors.map((m) => (
                      <button
                        key={m.id}
                        onClick={() => launchPreviewOnMonitor(m)}
                        className="w-full px-3 py-2 text-left text-sm text-[rgb(var(--color-text))] hover:bg-[rgb(var(--color-surface-alt))] transition-colors flex items-center gap-2"
                      >
                        <Monitor className="w-3.5 h-3.5" />
                        <span>{m.name || `Monitor ${m.id}`}</span>
                        {m.is_primary && (
                          <span className="text-[10px] text-[rgb(var(--color-accent))] font-medium ml-auto">Primary</span>
                        )}
                      </button>
                    ))}
                    <div className="border-t border-[rgb(var(--color-border))]">
                      <button
                        onClick={() => { setShowMonitorPicker(false); setShowPreview(true); }}
                        className="w-full px-3 py-2 text-left text-xs text-[rgb(var(--color-text-secondary))] hover:bg-[rgb(var(--color-surface-alt))] transition-colors"
                      >
                        Preview in window instead
                      </button>
                    </div>
                  </div>
                </>
              )}
            </div>
          )}
        </div>

        {/* Description — markdown preview, click to edit */}
        <div className="relative group/desc mb-8">
          {editingDesc ? (
            <textarea
              ref={descRef}
              value={localDesc}
              onChange={(e) => {
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
              onClick={() => setEditingDesc(true)}
              onFocus={() => setEditingDesc(true)}
              className="min-h-[2rem] rounded-lg px-3 py-2 text-sm cursor-text border border-transparent hover:border-[rgb(var(--color-border))] transition-colors"
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
          {!editingDesc && (
            <button
              onClick={() => sendChatPrompt(
                localDesc
                  ? `Improve the description of sketch "${activeSketchPath ?? "current"}". Current description: "${localDesc}". Make it clearer and more informative. IMPORTANT: Only update the description — do NOT change the title or any rows. Use set_planning_rows with the improved description but keep the existing title and all rows exactly as they are.`
                  : `Write a description for sketch "${activeSketchPath ?? "current"}" titled "${localTitle}". Look at the planning rows to understand what the sketch covers and write a concise description. IMPORTANT: Only update the description — do NOT change the title or any rows. Use set_planning_rows with the new description but keep the existing title and all rows exactly as they are.`,
                { silent: true }
              )}
              className="absolute right-2 top-2 flex items-center gap-1 opacity-0 group-hover/desc:opacity-100 p-1 rounded text-[rgb(var(--color-accent))] hover:bg-[rgb(var(--color-accent))]/10 transition-all"
              title={localDesc ? "Improve description with AI" : "Generate description with AI"}
            >
              <Sparkles className="w-3 h-3" />
              <span className="text-[10px]">{localDesc ? "Improve" : "Generate"}</span>
            </button>
          )}
        </div>

        {/* Planning Table */}
        <div>
          <div className="flex items-center justify-end mb-3">
            <button
              onClick={() => sendChatPrompt(
                localRows.length === 0
                  ? `Generate a complete sketch plan for "${activeSketch?.title ?? "this sketch"}". ${activeSketch?.description && typeof activeSketch.description === "string" ? `Description: ${activeSketch.description}. ` : ""}Create well-structured planning rows with time, narrative, and demo_actions.`
                  : `Review and improve the entire sketch "${activeSketchPath ?? "current"}". Refine the narrative flow, tighten timing, and make demo actions more specific. Use set_planning_rows to apply changes.`,
                { silent: true }
              )}
              className="flex items-center gap-1 px-2 py-1 rounded text-[10px] font-medium text-[rgb(var(--color-accent))] hover:bg-[rgb(var(--color-accent))]/10 transition-colors"
              title={localRows.length === 0 ? "Generate plan with AI" : "Improve entire sketch with AI"}
            >
              <Sparkles className="w-3 h-3" />
              {localRows.length === 0 ? "Generate" : "Improve"}
            </button>
          </div>
          <ScriptTable
            rows={localRows}
            onChange={handleRowsChange}
            onCaptureScreenshot={handleCaptureScreenshot}
            onPickImage={handlePickImage}
            onBrowseImage={handleBrowseImage}
            onSparkle={(prompt) => sendChatPrompt(prompt, { silent: true })}
            onGenerateVisual={(rowIndex) => {
              setVisualPromptRow(rowIndex);
              setVisualInstructions("");
            }}
            onNudgeVisual={(rowIndex, instruction) => {
              const row = localRows[rowIndex];
              const prompt = `Modify the existing visual for sketch "${activeSketchPath ?? "current"}", row index ${rowIndex} (0-based).

**USER INSTRUCTIONS (HIGHEST PRIORITY):**
${instruction}

Row context:
- **Narrative:** ${row?.narrative || "(empty)"}
- **Actions:** ${row?.demo_actions || "(empty)"}

The row already has a visual and design_plan. Read the sketch with read_sketch first, then call set_row_visual with the MODIFIED visual. Keep the existing design but apply the requested changes. Do NOT redesign from scratch.`;
              sendChatPrompt(prompt, { silent: true, agent: "designer" });
            }}
            projectRoot={projectRoot}
            sketchPath={activeSketchPath ?? undefined}
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
            className="flex items-center gap-1.5 mt-3 px-3 py-2 text-xs text-[rgb(var(--color-text-secondary))] hover:text-[rgb(var(--color-accent))] border border-dashed border-[rgb(var(--color-border))] hover:border-[rgb(var(--color-accent))]/40 rounded-lg transition-colors w-full justify-center"
          >
            <Plus className="w-3.5 h-3.5" />
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

      {/* Asset picker overlay — screenshots + visuals */}
      {imagePickerRowIdx !== null && (
        <div className="fixed inset-0 z-modal flex items-center justify-center bg-black/40" onClick={() => setImagePickerRowIdx(null)}>
          <div className="bg-[rgb(var(--color-surface))] border border-[rgb(var(--color-border))] rounded-xl shadow-2xl max-w-md w-full max-h-[60vh] flex flex-col" onClick={(e) => e.stopPropagation()}>
            <div className="flex items-center justify-between px-4 py-3 border-b border-[rgb(var(--color-border))]">
              <span className="text-sm font-medium text-[rgb(var(--color-text))]">Pick an image or visual</span>
              <button onClick={() => setImagePickerRowIdx(null)} className="text-[rgb(var(--color-text-secondary))] hover:text-[rgb(var(--color-text))]">
                <X className="w-3.5 h-3.5" />
              </button>
            </div>
            <div className="flex-1 overflow-y-auto p-3">
              {projectAssets.length === 0 ? (
                <div className="text-center text-sm text-[rgb(var(--color-text-secondary))] py-8">No images or visuals in workspace</div>
              ) : (
                <div className="grid grid-cols-3 gap-2">
                  {projectAssets.map((asset) => (
                    <button
                      key={asset.path}
                      onClick={() => handleAssetPicked(asset)}
                      className="rounded-lg border border-[rgb(var(--color-border))] hover:border-[rgb(var(--color-accent))] overflow-hidden transition-colors group"
                      title={asset.path}
                    >
                      {asset.assetType === "visual" ? (
                        <div className="w-full aspect-video">
                          <VisualCell visualPath={asset.path} mode="thumbnail" className="!w-full !h-full !rounded-none" />
                        </div>
                      ) : (
                        <img
                          src={projectRoot ? convertFileSrc(`${projectRoot}/${asset.path}`) : asset.path}
                          alt={asset.path.split("/").pop() ?? ""}
                          className="w-full aspect-video object-cover"
                        />
                      )}
                      <div className="px-1.5 py-1 text-[10px] text-[rgb(var(--color-text-secondary))] group-hover:text-[rgb(var(--color-accent))] truncate">
                        {asset.assetType === "visual" ? "🎬 " : ""}{asset.path.split("/").pop()}
                      </div>
                    </button>
                  ))}
                </div>
              )}
            </div>
            <div className="px-3 pb-3 pt-1 border-t border-[rgb(var(--color-border))]">
              <button
                onClick={async () => {
                  if (imagePickerRowIdx === null) return;
                  setImagePickerRowIdx(null);
                  await handleBrowseImage(imagePickerRowIdx);
                }}
                className="w-full flex items-center justify-center gap-1.5 text-xs text-[rgb(var(--color-text-secondary))] hover:text-[rgb(var(--color-accent))] px-3 py-2 rounded-lg border border-dashed border-[rgb(var(--color-border))] hover:border-[rgb(var(--color-accent))] hover:bg-[rgb(var(--color-accent))]/5 transition-colors"
              >
                <Folder className="w-3 h-3" />
                Browse files...
              </button>
            </div>
          </div>
        </div>
      )}

      {/* Visual generation instructions popup */}
      {visualPromptRow !== null && (
        <div className="fixed inset-0 z-modal flex items-center justify-center bg-black/40" onClick={() => setVisualPromptRow(null)}>
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
                className="px-4 py-1.5 text-xs font-medium text-white bg-[rgb(var(--color-accent))] hover:bg-[rgb(var(--color-accent-hover))] rounded-md transition-colors flex items-center gap-1.5"
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
          onClose={() => setShowPreview(false)}
        />
      )}
    </div>
  );
}
