import { useCallback, useEffect, useMemo, useRef, useState, lazy, Suspense, type MouseEvent as ReactMouseEvent } from "react";
import {
  DndContext,
  closestCenter,
  KeyboardSensor,
  PointerSensor,
  useSensor,
  useSensors,
  type DragEndEvent,
  DragOverlay,
} from "@dnd-kit/core";
import {
  SortableContext,
  sortableKeyboardCoordinates,
  verticalListSortingStrategy,
} from "@dnd-kit/sortable";
import { invoke } from "../services/tauri";
import {
  Eye,
  X,
  Sparkles,
  Check,
  Crosshair,
  Type,
} from "lucide-react";
import remarkBreaks from "remark-breaks";
import remarkGfm from "remark-gfm";
import type { MotionPoint, PlanningCellField, PlanningRow, TypingSpot } from "../types/sketch";
import { normalizeDocument } from "@elucim/dsl";
import type { CutReadyElucimDocument } from "../types/elucim";
import { ErrorBoundary } from "./ErrorBoundary";
import { setRowTime } from "../utils/documentMetadata";
import { SafeMarkdown } from "./SafeMarkdown";
import { newPlanningRowId } from "../utils/planningRowId";
import { getRowColor, hasAnyLock, isCellLocked } from "./planning/rowState";
import { PlanningRowCard } from "./planning/PlanningRowCard";


const VisualCell = lazy(() => import("./VisualCell"));
const EditorWrapper = lazy(() => import("./EditorWrapper"));

const TYPING_COLOR_PRESETS = ["#ffffff", "#111111", "#f8d775", "#8fe3b0", "#8dc9ff", "#d4a8ff", "#ff9cac"];
const TYPING_EXPORT_WIDTH = 1920;
const TYPING_EXPORT_HEIGHT = 1080;
const TYPING_TEXT_PADDING_X = 12;
const TYPING_TEXT_PADDING_Y = 8;

function typingPreviewLayout(spot: TypingSpot, previewWidth: number) {
  const width = Math.max(0.02, Math.min(1, spot.width));
  const height = Math.max(0.02, Math.min(1, spot.height));
  const characterCount = Math.max(1, Array.from(spot.text.trim()).length);
  const scale = Math.max(0.4, Math.min(1.8, spot.font_scale ?? 1));
  const paddingX = Math.min(TYPING_TEXT_PADDING_X, width * TYPING_EXPORT_WIDTH / 4);
  const paddingY = Math.min(TYPING_TEXT_PADDING_Y, height * TYPING_EXPORT_HEIGHT / 4);
  const contentWidth = Math.max(1, width * TYPING_EXPORT_WIDTH - 2 * paddingX);
  const contentHeight = Math.max(1, height * TYPING_EXPORT_HEIGHT - 2 * paddingY);
  const fontSize = Math.max(
    18,
    Math.min(
      contentHeight * 0.68,
      contentWidth / (characterCount * 0.65),
    ) * scale,
  );
  const previewScale = previewWidth / TYPING_EXPORT_WIDTH;
  return {
    fontSize: previewWidth > 0 ? `${Math.min(fontSize, 96) * previewScale}px` : undefined,
    paddingLeft: `${paddingX * previewScale}px`,
    paddingTop: `${paddingY * previewScale}px`,
  };
}


function emptyRow(): PlanningRow {
  return { id: newPlanningRowId(), time: "", duration_seconds: null, narrative: "", demo_actions: "", screenshot: null };
}



import type { RowDiff } from "../utils/textDiff";

interface ScriptTableProps {
  rows: PlanningRow[];
  onChange: (rows: PlanningRow[]) => void;
  readOnly?: boolean;
  onCaptureScreenshot?: (rowIndex: number) => void;
  onPasteImage?: (rowIndex: number) => void;
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
  onStartNarrationRecording?: (rowIndex: number) => void;
  onGenerateNarration?: (rowIndex: number) => void;
  onPickNarration?: (rowIndex: number) => void;
  onStopNarrationRecording?: () => void;
  narrationRecordingRow?: number | null;
  narrationSavingRows?: Set<number>;
  typingOverlayDefaults?: {
    fontFamily: NonNullable<TypingSpot["font_family"]>;
    fontScale: number;
  };
}

export function ScriptTable({ rows, onChange, readOnly = false, onCaptureScreenshot, onPasteImage, onPickImage, onBrowseImage, onSparkle, onGenerateVisual, onNudgeVisual, projectRoot, sketchPath, highlightedRows, rowDiffs, aiSnapshotRows, onDismissHighlights, hasLastAiDiffs, onReShowHighlights, onRowLockChange, onCellLockChange, onStartNarrationRecording, onGenerateNarration, onPickNarration, onStopNarrationRecording, narrationRecordingRow, narrationSavingRows, typingOverlayDefaults = { fontFamily: "sans", fontScale: 1 } }: ScriptTableProps) {
  const [activeId, setActiveId] = useState<string | null>(null);
  const [lightboxImage, setLightboxImage] = useState<{ src: string; rowIndex: number } | null>(null);
  const lightboxImageRef = useRef<HTMLImageElement | null>(null);
  const [lightboxPreviewWidth, setLightboxPreviewWidth] = useState(0);
  const [visualLightbox, setVisualLightbox] = useState<{ visualPath: string; rowIndex: number } | null>(null);
  const visualDialogRef = useRef<HTMLDivElement | null>(null);
  const isVisualLightboxOpen = visualLightbox !== null;
  // Move focus into the visual lightbox when it opens and back to the opener when it closes.
  useEffect(() => {
    if (!isVisualLightboxOpen) return;
    const opener = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    visualDialogRef.current?.focus();
    return () => {
      if (opener?.isConnected) opener.focus();
    };
  }, [isVisualLightboxOpen]);
  const [nudgeInput, setNudgeInput] = useState("");
  const [lightboxMode, setLightboxMode] = useState<"preview" | "edit">("preview");
  const [spotAuthoringMode, setSpotAuthoringMode] = useState<"motion" | "typing">("motion");
  const [typingDraw, setTypingDraw] = useState<{ startX: number; startY: number; currentX: number; currentY: number } | null>(null);
  const [selectedTypingSpot, setSelectedTypingSpot] = useState<number | null>(null);
  const [typingSpotInteraction, setTypingSpotInteraction] = useState<{
    kind: "move" | "resize";
    index: number;
    startX: number;
    startY: number;
    currentX: number;
    currentY: number;
    initialSpot: TypingSpot;
  } | null>(null);
  const [motionPointInteraction, setMotionPointInteraction] = useState<{
    index: number;
    startX: number;
    startY: number;
    currentX: number;
    currentY: number;
  } | null>(null);
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
    if (!lightboxImage) return;
    const handleKey = (e: KeyboardEvent) => { if (e.key === "Escape") setLightboxImage(null); };
    window.addEventListener("keydown", handleKey);
    return () => window.removeEventListener("keydown", handleKey);
  }, [lightboxImage]);

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
    useSensor(KeyboardSensor, { coordinateGetter: sortableKeyboardCoordinates }),
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

  useEffect(() => {
    if (!lightboxImage) {
      setLightboxPreviewWidth(0);
      return;
    }
    const updatePreviewWidth = () => {
      setLightboxPreviewWidth(lightboxImageRef.current?.clientWidth ?? 0);
    };
    updatePreviewWidth();
    window.addEventListener("resize", updatePreviewWidth);
    return () => window.removeEventListener("resize", updatePreviewWidth);
  }, [lightboxImage]);

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
      const updated = rowsRef.current.map((r, i) => {
        if (i !== index) return r;
        if (field === "time") {
          return setRowTime(r, value);
        }
        if (field === "screenshot") {
          return { ...r, screenshot: value || null, motion_points: value ? r.motion_points : null, typing_spots: value ? r.typing_spots : null, motion_plan: null };
        }
        return { ...r, [field]: value };
      });
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

  const updateMotionPoints = useCallback(
    (index: number, points: MotionPoint[]) => {
      if (isCellLocked(rowsRef.current[index], "screenshot")) return;
      pushUndo();
      const normalized = points
        .slice(0, 3)
        .map((point, pointIndex) => ({
          ...point,
          rank: (pointIndex + 1) as MotionPoint["rank"],
          x: Math.max(0, Math.min(1, point.x)),
          y: Math.max(0, Math.min(1, point.y)),
          label: point.label?.trim() || null,
        }));
      const updated = rowsRef.current.map((row, rowIndex) =>
        rowIndex === index
          ? { ...row, motion_points: normalized.length > 0 ? normalized : null, motion_plan: null }
          : row,
      );
      onChange(updated);
    },
    [onChange, pushUndo],
  );

  const updateTypingSpots = useCallback(
    (rowIndex: number, spots: TypingSpot[]) => {
      if (isCellLocked(rowsRef.current[rowIndex], "screenshot")) return;
      pushUndo();
      const normalized = spots
        .map((spot) => ({
          ...spot,
          x: Math.max(0, Math.min(1, spot.x)),
          y: Math.max(0, Math.min(1, spot.y)),
          width: Math.max(0.02, Math.min(1, spot.width)),
          height: Math.max(0.02, Math.min(1, spot.height)),
          text: spot.text.slice(0, 160),
          start_offset_ms: Math.max(0, Math.round(spot.start_offset_ms ?? 0)),
          duration_ms: Math.max(0, Math.round(spot.duration_ms ?? 0)) || null,
          characters_per_second: Math.max(1, Math.min(80, spot.characters_per_second ?? 18)),
          show_cursor: spot.show_cursor ?? true,
          text_color: /^#[0-9a-fA-F]{6}$/.test(spot.text_color ?? "") ? spot.text_color : "#ffffff",
          font_family: ["sans", "serif", "mono"].includes(spot.font_family ?? "") ? spot.font_family : typingOverlayDefaults.fontFamily,
          font_scale: Math.max(0.4, Math.min(1.8, spot.font_scale ?? typingOverlayDefaults.fontScale)),
        }))
        .filter((spot) => spot.x + spot.width <= 1.001 && spot.y + spot.height <= 1.001);
      onChange(rowsRef.current.map((row, index) => (
        index === rowIndex ? { ...row, typing_spots: normalized.length > 0 ? normalized : null } : row
      )));
    },
    [onChange, pushUndo],
  );

  const pointerPosition = useCallback((event: ReactMouseEvent) => {
    const image = lightboxImageRef.current;
    if (!image) return null;
    const rect = image.getBoundingClientRect();
    if (rect.width <= 0 || rect.height <= 0) return null;
    const x = (event.clientX - rect.left) / rect.width;
    const y = (event.clientY - rect.top) / rect.height;
    if (x < 0 || x > 1 || y < 0 || y > 1) return null;
    return { x, y };
  }, []);

  const addMotionPointFromLightbox = useCallback((event: ReactMouseEvent) => {
    if (spotAuthoringMode !== "motion" || readOnly || !lightboxImage || isCellLocked(rowsRef.current[lightboxImage.rowIndex], "screenshot")) return;
    const point = pointerPosition(event);
    if (!point) return;
    setSelectedTypingSpot(null);
    const currentPoints = rowsRef.current[lightboxImage.rowIndex]?.motion_points ?? [];
    const nextPoints = [
      ...currentPoints.slice(0, 2),
      {
        rank: Math.min(currentPoints.length + 1, 3) as MotionPoint["rank"],
        x: point.x,
        y: point.y,
        label: null,
      },
    ];
    updateMotionPoints(lightboxImage.rowIndex, nextPoints);
  }, [lightboxImage, pointerPosition, readOnly, spotAuthoringMode, updateMotionPoints]);

  const beginTypingSpot = useCallback((event: ReactMouseEvent) => {
    if (spotAuthoringMode !== "typing" || readOnly || !lightboxImage || isCellLocked(rowsRef.current[lightboxImage.rowIndex], "screenshot")) return;
    const point = pointerPosition(event);
    if (!point) return;
    event.preventDefault();
    event.stopPropagation();
    setSelectedTypingSpot(null);
    setTypingDraw({ startX: point.x, startY: point.y, currentX: point.x, currentY: point.y });
  }, [lightboxImage, pointerPosition, readOnly, spotAuthoringMode]);

  const moveTypingSpot = useCallback((event: ReactMouseEvent) => {
    if (motionPointInteraction) {
      const point = pointerPosition(event);
      if (!point) return;
      setMotionPointInteraction((current) => current ? { ...current, currentX: point.x, currentY: point.y } : null);
      return;
    }
    if (typingSpotInteraction) {
      const point = pointerPosition(event);
      if (!point) return;
      setTypingSpotInteraction((current) => current ? { ...current, currentX: point.x, currentY: point.y } : null);
      return;
    }
    if (!typingDraw) return;
    const point = pointerPosition(event);
    if (!point) return;
    setTypingDraw((current) => current ? { ...current, currentX: point.x, currentY: point.y } : null);
  }, [motionPointInteraction, pointerPosition, typingDraw, typingSpotInteraction]);

  const finishTypingSpot = useCallback((event: ReactMouseEvent) => {
    if (motionPointInteraction && lightboxImage) {
      const point = pointerPosition(event);
      const interaction = point
        ? { ...motionPointInteraction, currentX: point.x, currentY: point.y }
        : motionPointInteraction;
      setMotionPointInteraction(null);
      const points = rowsRef.current[lightboxImage.rowIndex]?.motion_points ?? [];
      updateMotionPoints(lightboxImage.rowIndex, points.map((motionPoint, index) => (
        index === interaction.index
          ? { ...motionPoint, x: interaction.currentX, y: interaction.currentY }
          : motionPoint
      )));
      return;
    }
    if (typingSpotInteraction && lightboxImage) {
      const point = pointerPosition(event);
      const interaction = point
        ? { ...typingSpotInteraction, currentX: point.x, currentY: point.y }
        : typingSpotInteraction;
      const dx = interaction.currentX - interaction.startX;
      const dy = interaction.currentY - interaction.startY;
      const initial = interaction.initialSpot;
      const nextSpot = interaction.kind === "move"
        ? {
            ...initial,
            x: Math.max(0, Math.min(1 - initial.width, initial.x + dx)),
            y: Math.max(0, Math.min(1 - initial.height, initial.y + dy)),
          }
        : {
            ...initial,
            width: Math.max(0.02, Math.min(1 - initial.x, initial.width + dx)),
            height: Math.max(0.02, Math.min(1 - initial.y, initial.height + dy)),
          };
      setTypingSpotInteraction(null);
          const spots = rowsRef.current[lightboxImage.rowIndex]?.typing_spots ?? [];
          updateTypingSpots(lightboxImage.rowIndex, spots.map((spot, index) => (
            index === interaction.index ? nextSpot : spot
          )));
          return;
    }
    if (!typingDraw || !lightboxImage) return;
    const point = pointerPosition(event);
    const completed = point ? { ...typingDraw, currentX: point.x, currentY: point.y } : typingDraw;
    setTypingDraw(null);
    const x = Math.min(completed.startX, completed.currentX);
    const y = Math.min(completed.startY, completed.currentY);
    const width = Math.abs(completed.currentX - completed.startX);
    const height = Math.abs(completed.currentY - completed.startY);
    if (width < 0.03 || height < 0.03) return;
    const spots = rowsRef.current[lightboxImage.rowIndex]?.typing_spots ?? [];
    updateTypingSpots(lightboxImage.rowIndex, [...spots, {
      x,
      y,
      width: Math.min(width, 1 - x),
      height: Math.min(height, 1 - y),
      text: "Type your message",
      start_offset_ms: 0,
      duration_ms: null,
      characters_per_second: 18,
      show_cursor: true,
      text_color: "#ffffff",
      font_family: typingOverlayDefaults.fontFamily,
      font_scale: typingOverlayDefaults.fontScale,
    }]);
    setSelectedTypingSpot(spots.length);
  }, [lightboxImage, motionPointInteraction, pointerPosition, typingDraw, typingOverlayDefaults, typingSpotInteraction, updateMotionPoints, updateTypingSpots]);

  const updateTypingSpot = useCallback((spotIndex: number, changes: Partial<TypingSpot>) => {
    if (!lightboxImage) return;
    const spots = rowsRef.current[lightboxImage.rowIndex]?.typing_spots ?? [];
    updateTypingSpots(lightboxImage.rowIndex, spots.map((spot, index) => index === spotIndex ? { ...spot, ...changes } : spot));
  }, [lightboxImage, updateTypingSpots]);

  const beginTypingSpotInteraction = useCallback((
    event: ReactMouseEvent,
    index: number,
    kind: "move" | "resize",
  ) => {
    if (readOnly || !lightboxImage) return;
    const point = pointerPosition(event);
    const spot = rowsRef.current[lightboxImage.rowIndex]?.typing_spots?.[index];
    if (!point || !spot) return;
    event.preventDefault();
    event.stopPropagation();
    if (selectedTypingSpot !== index) {
      setSelectedTypingSpot(index);
      return;
    }
    setSelectedTypingSpot(index);
    setTypingSpotInteraction({
      kind,
      index,
      startX: point.x,
      startY: point.y,
      currentX: point.x,
      currentY: point.y,
      initialSpot: spot,
    });
  }, [lightboxImage, pointerPosition, readOnly, selectedTypingSpot]);

  const beginMotionPointInteraction = useCallback((event: ReactMouseEvent, index: number) => {
    if (readOnly || !lightboxImage) return;
    const point = pointerPosition(event);
    if (!point) return;
    event.preventDefault();
    event.stopPropagation();
    setMotionPointInteraction({
      index,
      startX: point.x,
      startY: point.y,
      currentX: point.x,
      currentY: point.y,
    });
  }, [lightboxImage, pointerPosition, readOnly]);

  const previewTypingSpot = useCallback((spot: TypingSpot, index: number): TypingSpot => {
    if (!typingSpotInteraction || typingSpotInteraction.index !== index) return spot;
    const dx = typingSpotInteraction.currentX - typingSpotInteraction.startX;
    const dy = typingSpotInteraction.currentY - typingSpotInteraction.startY;
    if (typingSpotInteraction.kind === "move") {
      return {
        ...spot,
        x: Math.max(0, Math.min(1 - spot.width, spot.x + dx)),
        y: Math.max(0, Math.min(1 - spot.height, spot.y + dy)),
      };
    }
    return {
      ...spot,
      width: Math.max(0.02, Math.min(1 - spot.x, spot.width + dx)),
      height: Math.max(0.02, Math.min(1 - spot.y, spot.height + dy)),
    };
  }, [typingSpotInteraction]);

  const previewMotionPoint = useCallback((point: MotionPoint, index: number): MotionPoint => {
    if (!motionPointInteraction || motionPointInteraction.index !== index) return point;
    return {
      ...point,
      x: Math.max(0, Math.min(1, motionPointInteraction.currentX)),
      y: Math.max(0, Math.min(1, motionPointInteraction.currentY)),
    };
  }, [motionPointInteraction]);

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

  const removeNarration = useCallback(
    (index: number) => {
      if (isCellLocked(rowsRef.current[index], "screenshot") || isCellLocked(rowsRef.current[index], "visual")) return;
      pushUndo();
      const updated = rowsRef.current.map((r, i) =>
        i === index ? { ...r, narration: null, narration_plan: null, motion_plan: null } : r,
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
    <div className={`script-table-wrapper overflow-x-auto overflow-y-visible${readOnly ? "" : " my-4"}`}>
      {/* Re-show last AI changes button */}
      {hasLastAiDiffs && onReShowHighlights && (
        <div className="flex justify-end px-1 pb-1.5">
          <button
            onClick={onReShowHighlights}
            className="inline-flex items-center gap-1.5 px-2.5 py-1 text-xs font-medium rounded-md border transition-colors
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
          <table className="w-full min-w-[640px]" style={{ tableLayout: "fixed", borderSpacing: "0 4px", borderCollapse: "separate" }}>
            <colgroup>
              {!readOnly && <col style={{ width: 28 }} />}
              <col style={{ width: 72 }} />
              <col />
              <col />
              <col style={{ width: 210 }} />
              {!readOnly && <col style={{ width: 36 }} />}
            </colgroup>
            <thead>
              <tr>
                {!readOnly && <th className="script-table-th" />}
                <th className="script-table-th">Time</th>
                <th className="script-table-th">Narrative</th>
                <th className="script-table-th">Actions</th>
                <th className="script-table-th">Assets</th>
                {!readOnly && <th className="script-table-th" />}
              </tr>
            </thead>
            <tbody>
              {rows.map((row, idx) => (
                <PlanningRowCard
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
                  onPasteImage={onPasteImage}
                  onPickImage={onPickImage}
                  onBrowseImage={onBrowseImage}
                  onSparkle={onSparkle}
                  onGenerateVisual={onGenerateVisual}
                  onRemoveVisual={removeVisual}
                  onRemoveNarration={removeNarration}
                  projectRoot={projectRoot}
                  sketchPath={sketchPath}
                  onImageClick={(src, rowIndex) => setLightboxImage({ src, rowIndex })}
                  onVisualClick={(visualPath, rowIdx) => setVisualLightbox({ visualPath, rowIndex: rowIdx })}
                  isHighlighted={highlightedRows?.has(idx) ?? false}
                  rowDiff={rowDiffs?.find((d) => d.rowIndex === idx)}
                  onDismissHighlight={onDismissHighlights}
                  visualVersion={visualVersion}
                  onRowLockChange={onRowLockChange}
                  onCellLockChange={onCellLockChange}
                  onStartNarrationRecording={onStartNarrationRecording}
                  onGenerateNarration={onGenerateNarration}
                  onPickNarration={onPickNarration}
                  onStopNarrationRecording={onStopNarrationRecording}
                  narrationRecordingRow={narrationRecordingRow}
                  narrationSavingRows={narrationSavingRows}
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
      {lightboxImage && (
        <div
          className="fixed inset-0 z-modal flex items-center justify-center bg-[rgb(var(--color-overlay-strong)/0.82)] p-5"
          onClick={() => setLightboxImage(null)}
        >
          <div
            className="grid h-[calc(100vh-40px)] w-[calc(100vw-40px)] max-w-[1280px] grid-cols-[minmax(0,1fr)_280px] overflow-hidden rounded-2xl border border-[rgb(var(--color-border))] bg-[rgb(var(--color-surface))] shadow-2xl"
            onClick={(e) => e.stopPropagation()}
          >
            <div className="relative flex min-h-0 items-center justify-center bg-[rgb(var(--color-surface-alt))]/55 p-5">
              <div
                className={`relative max-h-full max-w-full ${spotAuthoringMode === "typing" && !readOnly ? "cursor-crosshair" : ""}`}
                onClick={addMotionPointFromLightbox}
                onMouseDown={beginTypingSpot}
                onMouseMove={moveTypingSpot}
                onMouseUp={finishTypingSpot}
              >
                <img
                  ref={lightboxImageRef}
                  src={lightboxImage.src}
                  alt="Screenshot preview"
                  className="max-h-[calc(100vh-80px)] max-w-full select-none rounded-xl object-contain shadow-2xl"
                  draggable={false}
                  onLoad={(event) => setLightboxPreviewWidth(event.currentTarget.clientWidth)}
                />
                {(rows[lightboxImage.rowIndex]?.motion_points ?? []).map((point, index) => {
                  const displayPoint = previewMotionPoint(point, index);
                  return (
                    <div
                      key={point.rank}
                      className="absolute -translate-x-1/2 -translate-y-1/2"
                      style={{ left: `${displayPoint.x * 100}%`, top: `${displayPoint.y * 100}%` }}
                    >
                      <button
                        type="button"
                        onClick={(event) => event.stopPropagation()}
                        onMouseDown={(event) => beginMotionPointInteraction(event, index)}
                        className={`grid h-8 w-8 place-items-center rounded-full border-2 border-[rgb(var(--color-accent-fg))] bg-[rgb(var(--color-accent))] text-xs font-semibold text-[rgb(var(--color-accent-fg))] shadow-lg shadow-black/30 ring-4 ring-[rgb(var(--color-accent))]/25 ${readOnly ? "" : "cursor-move"}`}
                        title="Drag to move camera point"
                      >
                        {point.rank}
                      </button>
                    </div>
                  );
                })}
                {(rows[lightboxImage.rowIndex]?.typing_spots ?? []).map((spot, index) => {
                  const displaySpot = previewTypingSpot(spot, index);
                  return (
                    <button
                      key={`${spot.x}-${spot.y}-${index}`}
                      type="button"
                      onClick={(event) => {
                        event.stopPropagation();
                        setSelectedTypingSpot(index);
                      }}
                      onMouseDown={(event) => beginTypingSpotInteraction(event, index, "move")}
                      className={`absolute appearance-none overflow-visible rounded-md p-0 text-left leading-none outline outline-2 shadow-lg transition-colors ${selectedTypingSpot === index ? "outline-[rgb(var(--color-accent))] bg-[rgb(var(--color-accent))]/15" : "outline-white/85 bg-black/45"} ${readOnly ? "" : selectedTypingSpot === index ? "cursor-move" : "cursor-pointer"}`}
                      style={{ left: `${displaySpot.x * 100}%`, top: `${displaySpot.y * 100}%`, width: `${displaySpot.width * 100}%`, height: `${displaySpot.height * 100}%` }}
                      title={selectedTypingSpot === index ? "Drag to move selected typing layer" : "Select typing layer"}
                    >
                      <span
                        className="block truncate font-normal leading-none"
                        style={{
                          color: spot.text_color ?? "#ffffff",
                          fontFamily: spot.font_family === "mono" ? "Consolas, 'Courier New', monospace" : spot.font_family === "serif" ? "Georgia, serif" : "'Segoe UI', Arial, sans-serif",
                          ...typingPreviewLayout(spot, lightboxPreviewWidth),
                        }}
                      >
                        {spot.text || "Typing spot"}
                      </span>
                      {!readOnly && selectedTypingSpot === index && (
                        <span
                          role="presentation"
                          onMouseDown={(event) => beginTypingSpotInteraction(event, index, "resize")}
                          className="absolute right-0 bottom-0 h-3 w-3 cursor-se-resize border-l-2 border-t-2 border-[rgb(var(--color-accent-fg))] bg-[rgb(var(--color-accent))]"
                        />
                      )}
                    </button>
                  );
                })}
                {typingDraw && (
                  <div
                    className="pointer-events-none absolute rounded-md border-2 border-dashed border-[rgb(var(--color-accent))] bg-[rgb(var(--color-accent))]/15"
                    style={{
                      left: `${Math.min(typingDraw.startX, typingDraw.currentX) * 100}%`,
                      top: `${Math.min(typingDraw.startY, typingDraw.currentY) * 100}%`,
                      width: `${Math.abs(typingDraw.currentX - typingDraw.startX) * 100}%`,
                      height: `${Math.abs(typingDraw.currentY - typingDraw.startY) * 100}%`,
                    }}
                  />
                )}
              </div>
            </div>
            <aside className="flex min-h-0 flex-col border-l border-[rgb(var(--color-border))] bg-[rgb(var(--color-surface))]">
              <div className="border-b border-[rgb(var(--color-border))] px-4 py-4">
                <div className="flex items-center gap-2">
                  <div className="grid h-8 w-8 place-items-center rounded-xl bg-[rgb(var(--color-accent))]/10 text-[rgb(var(--color-accent))]">
                    <Crosshair className="h-4 w-4" />
                  </div>
                  <div>
                    <div className="text-sm font-semibold text-[rgb(var(--color-text))]">Motion spots</div>
                    <div className="text-xs text-[rgb(var(--color-text-secondary))]">Row {lightboxImage.rowIndex + 1}</div>
                  </div>
                </div>
                <p className="mt-3 text-xs leading-5 text-[rgb(var(--color-text-secondary))]">
                  Camera points and typing overlays share this canvas. Drag existing markers to reposition them; draw a typing box where it belongs in the source frame so it moves and scales with camera motion.
                </p>
                <div className="mt-3 grid grid-cols-2 gap-1 rounded-xl bg-[rgb(var(--color-surface-alt))] p-1">
                  <button
                    type="button"
                    onClick={() => setSpotAuthoringMode("motion")}
                    className={`flex items-center justify-center gap-1.5 rounded-lg px-2 py-1.5 text-xs font-medium transition-colors ${spotAuthoringMode === "motion" ? "bg-[rgb(var(--color-surface))] text-[rgb(var(--color-text))] shadow-sm" : "text-[rgb(var(--color-text-secondary))]"}`}
                  >
                    <Crosshair className="h-3.5 w-3.5" />
                    Camera
                  </button>
                  <button
                    type="button"
                    disabled={readOnly}
                    onClick={() => setSpotAuthoringMode("typing")}
                    className={`flex items-center justify-center gap-1.5 rounded-lg px-2 py-1.5 text-xs font-medium transition-colors disabled:opacity-50 ${spotAuthoringMode === "typing" ? "bg-[rgb(var(--color-accent))] text-[rgb(var(--color-accent-fg))] shadow-sm" : "text-[rgb(var(--color-text-secondary))]"}`}
                  >
                    <Type className="h-3.5 w-3.5" />
                    Typing
                  </button>
                </div>
                <div className="mt-3 space-y-2 rounded-xl border border-[rgb(var(--color-border))] bg-[rgb(var(--color-surface-alt))]/45 p-3">
                  <div>
                    <div className="mb-1 text-2xs font-semibold uppercase tracking-[0.14em] text-[rgb(var(--color-text-secondary))]">Narrative</div>
                    <div className="max-h-24 overflow-y-auto text-xs leading-5 text-[rgb(var(--color-text))]">
                      {rows[lightboxImage.rowIndex]?.narrative ? (
                        <SafeMarkdown placeholder="No narrative yet." remarkPlugins={[remarkGfm, remarkBreaks]}>
                          {rows[lightboxImage.rowIndex].narrative}
                        </SafeMarkdown>
                      ) : (
                        <span className="text-[rgb(var(--color-text-secondary))]">No narrative yet.</span>
                      )}
                    </div>
                  </div>
                  <div className="border-t border-[rgb(var(--color-border))] pt-2">
                    <div className="mb-1 text-2xs font-semibold uppercase tracking-[0.14em] text-[rgb(var(--color-text-secondary))]">Actions</div>
                    <div className="max-h-24 overflow-y-auto text-xs leading-5 text-[rgb(var(--color-text))]">
                      {rows[lightboxImage.rowIndex]?.demo_actions ? (
                        <SafeMarkdown placeholder="No actions yet." remarkPlugins={[remarkGfm, remarkBreaks]}>
                          {rows[lightboxImage.rowIndex].demo_actions}
                        </SafeMarkdown>
                      ) : (
                        <span className="text-[rgb(var(--color-text-secondary))]">No actions yet.</span>
                      )}
                    </div>
                  </div>
                </div>
              </div>
              <div className="min-h-0 flex-1 space-y-2 overflow-y-auto p-4">
                {(rows[lightboxImage.rowIndex]?.motion_points ?? []).length > 0 ? (
                  (rows[lightboxImage.rowIndex]?.motion_points ?? []).map((point, index) => (
                    <div key={point.rank} className="rounded-xl border border-[rgb(var(--color-border))] bg-[rgb(var(--color-surface-alt))]/45 p-3">
                      <div className="flex items-center justify-between gap-3">
                        <div>
                          <div className="text-xs font-semibold text-[rgb(var(--color-text))]">
                            {index === 0 ? "Primary" : index === 1 ? "Secondary" : "Tertiary"} point
                          </div>
                          <div className="mt-0.5 font-mono text-2xs text-[rgb(var(--color-text-secondary))]">
                            x {point.x.toFixed(3)} · y {point.y.toFixed(3)}
                          </div>
                        </div>
                        {!readOnly && (
                          <button
                            type="button"
                            onClick={() => {
                              const next = (rowsRef.current[lightboxImage.rowIndex]?.motion_points ?? []).filter((_, pointIndex) => pointIndex !== index);
                              updateMotionPoints(lightboxImage.rowIndex, next);
                            }}
                            className="rounded-lg p-1 text-[rgb(var(--color-text-secondary))] transition-colors hover:bg-[rgb(var(--color-error))]/10 hover:text-[rgb(var(--color-error))]"
                            aria-label={`Remove motion point ${point.rank}`}
                          >
                            <X className="h-3.5 w-3.5" />
                          </button>
                        )}
                      </div>
                    </div>
                  ))
                ) : (
                  <div className="rounded-xl border border-dashed border-[rgb(var(--color-border))] p-4 text-center text-xs leading-5 text-[rgb(var(--color-text-secondary))]">
                    No motion points yet. Click the image to drop point 1.
                  </div>
                )}
                <div className="mt-4 border-t border-[rgb(var(--color-border))] pt-4">
                  <div className="mb-2 flex items-center justify-between">
                    <div className="text-2xs font-semibold uppercase tracking-[0.14em] text-[rgb(var(--color-text-secondary))]">Typing overlays</div>
                    <span className="text-2xs text-[rgb(var(--color-text-secondary))]">{(rows[lightboxImage.rowIndex]?.typing_spots ?? []).length}</span>
                  </div>
                  <div className="space-y-1">
                    {(rows[lightboxImage.rowIndex]?.typing_spots ?? []).map((spot, index) => (
                      <button
                        key={`${spot.x}-${spot.y}-${index}`}
                        type="button"
                        onClick={() => setSelectedTypingSpot(index)}
                        className={`flex w-full items-center gap-2 rounded-lg border px-2.5 py-2 text-left transition-colors ${selectedTypingSpot === index ? "border-[rgb(var(--color-accent))]/55 bg-[rgb(var(--color-accent))]/10" : "border-transparent bg-[rgb(var(--color-surface-alt))]/45 hover:border-[rgb(var(--color-border))]"}`}
                      >
                        <span className="h-2 w-2 shrink-0 rounded-full" style={{ backgroundColor: spot.text_color ?? "#ffffff" }} />
                        <span className="min-w-0 flex-1 truncate text-xs font-medium text-[rgb(var(--color-text))]">{spot.text || `Typing layer ${index + 1}`}</span>
                        <span className="font-mono text-2xs text-[rgb(var(--color-text-secondary))]">{Math.round((spot.font_scale ?? typingOverlayDefaults.fontScale) * 100)}%</span>
                      </button>
                    ))}
                  </div>
                  {(rows[lightboxImage.rowIndex]?.typing_spots ?? []).length === 0 && (
                    <div className="rounded-xl border border-dashed border-[rgb(var(--color-border))] p-3 text-center text-xs leading-5 text-[rgb(var(--color-text-secondary))]">Choose Typing, then drag a box on the screenshot.</div>
                  )}
                  {selectedTypingSpot !== null && (rows[lightboxImage.rowIndex]?.typing_spots ?? [])[selectedTypingSpot] && (() => {
                    const spot = (rows[lightboxImage.rowIndex]?.typing_spots ?? [])[selectedTypingSpot];
                    const index = selectedTypingSpot;
                    return (
                      <div className="mt-3 rounded-xl border border-[rgb(var(--color-accent))]/35 bg-[rgb(var(--color-accent))]/5 p-3">
                        <div className="mb-2 flex items-center justify-between">
                          <div className="flex items-center gap-1.5 text-xs font-semibold text-[rgb(var(--color-text))]">
                            <Type className="h-3.5 w-3.5 text-[rgb(var(--color-accent))]" />
                            Layer {index + 1}
                          </div>
                          {!readOnly && <button type="button" onClick={() => {
                            const next = (rowsRef.current[lightboxImage.rowIndex]?.typing_spots ?? []).filter((_, spotIndex) => spotIndex !== index);
                            updateTypingSpots(lightboxImage.rowIndex, next);
                            setSelectedTypingSpot(null);
                          }} className="rounded-lg p-1 text-[rgb(var(--color-text-secondary))] transition-colors hover:bg-[rgb(var(--color-error))]/10 hover:text-[rgb(var(--color-error))]" aria-label={`Remove typing layer ${index + 1}`}><X className="h-3.5 w-3.5" /></button>}
                        </div>
                        <textarea
                          value={spot.text}
                          onChange={(event) => updateTypingSpot(index, { text: event.target.value })}
                          readOnly={readOnly}
                          maxLength={160}
                          rows={2}
                          className="w-full resize-none rounded-lg border border-[rgb(var(--color-border))] bg-[rgb(var(--color-surface))] px-2 py-1.5 text-xs text-[rgb(var(--color-text))] outline-none focus:border-[rgb(var(--color-accent))]"
                          aria-label={`Typing text ${index + 1}`}
                        />
                        <div className="mt-2 grid grid-cols-2 gap-2">
                          <label className="text-2xs text-[rgb(var(--color-text-secondary))]">Start (ms)<input type="number" min="0" value={spot.start_offset_ms ?? 0} onChange={(event) => updateTypingSpot(index, { start_offset_ms: Number(event.target.value) || 0 })} readOnly={readOnly} className="mt-1 w-full rounded-md border border-[rgb(var(--color-border))] bg-[rgb(var(--color-surface))] px-1.5 py-1 text-xs text-[rgb(var(--color-text))]" /></label>
                          <label className="text-2xs text-[rgb(var(--color-text-secondary))]">Chars/sec<input type="number" min="1" max="80" value={spot.characters_per_second ?? 18} onChange={(event) => updateTypingSpot(index, { characters_per_second: Number(event.target.value) || 18 })} readOnly={readOnly} className="mt-1 w-full rounded-md border border-[rgb(var(--color-border))] bg-[rgb(var(--color-surface))] px-1.5 py-1 text-xs text-[rgb(var(--color-text))]" /></label>
                        </div>
                        <div className="mt-2">
                          <div className="mb-1.5 text-2xs text-[rgb(var(--color-text-secondary))]">Text color</div>
                          <div className="flex items-center gap-1">
                            {TYPING_COLOR_PRESETS.map((color) => (
                              <button key={color} type="button" disabled={readOnly} onClick={() => updateTypingSpot(index, { text_color: color })} className={`h-5 w-5 rounded-full border-2 transition-transform hover:scale-110 disabled:cursor-not-allowed ${spot.text_color === color ? "border-[rgb(var(--color-accent))] ring-2 ring-[rgb(var(--color-accent))]/25" : "border-[rgb(var(--color-border))]"}`} style={{ backgroundColor: color }} aria-label={`Set typing text color to ${color}`} />
                            ))}
                            <input
                              key={spot.text_color ?? "#ffffff"}
                              type="text"
                              defaultValue={spot.text_color ?? "#ffffff"}
                              maxLength={7}
                              readOnly={readOnly}
                              onBlur={(event) => {
                                const value = event.target.value.trim();
                                if (/^#[0-9a-fA-F]{6}$/.test(value)) updateTypingSpot(index, { text_color: value });
                              }}
                              className="ml-auto w-16 rounded-md border border-[rgb(var(--color-border))] bg-[rgb(var(--color-surface))] px-1.5 py-1 font-mono text-2xs text-[rgb(var(--color-text))] outline-none focus:border-[rgb(var(--color-accent))]"
                              aria-label={`Typing text color ${index + 1}`}
                            />
                          </div>
                        </div>
                        <div className="mt-2 grid grid-cols-2 gap-2">
                          <label className="min-w-0 text-2xs text-[rgb(var(--color-text-secondary))]">Font
                            <select value={spot.font_family ?? typingOverlayDefaults.fontFamily} onChange={(event) => updateTypingSpot(index, { font_family: event.target.value as TypingSpot["font_family"] })} disabled={readOnly} className="mt-1 w-full rounded-md border border-[rgb(var(--color-border))] bg-[rgb(var(--color-surface))] px-1.5 py-1 text-xs text-[rgb(var(--color-text))]">
                              <option value="sans">Sans</option>
                              <option value="serif">Serif</option>
                              <option value="mono">Mono</option>
                            </select>
                          </label>
                          <label className="min-w-0 text-2xs text-[rgb(var(--color-text-secondary))]">Size <span className="font-mono">{Math.round((spot.font_scale ?? typingOverlayDefaults.fontScale) * 100)}%</span>
                            <input type="range" min="0.4" max="1.8" step="0.1" value={spot.font_scale ?? typingOverlayDefaults.fontScale} onChange={(event) => updateTypingSpot(index, { font_scale: Number(event.target.value) })} disabled={readOnly} className="mt-1 block w-full accent-[rgb(var(--color-accent))]" aria-label={`Typing font size ${index + 1}`} />
                          </label>
                        </div>
                      </div>
                    );
                  })()}
                </div>
              </div>
              <div className="flex items-center justify-between gap-2 border-t border-[rgb(var(--color-border))] px-4 py-3">
                <button
                  type="button"
                  disabled={readOnly || (rows[lightboxImage.rowIndex]?.motion_points ?? []).length === 0}
                  onClick={() => updateMotionPoints(lightboxImage.rowIndex, [])}
                  className="rounded-lg border border-[rgb(var(--color-border))] px-3 py-2 text-xs font-medium text-[rgb(var(--color-text-secondary))] transition-colors hover:bg-[rgb(var(--color-surface-alt))] hover:text-[rgb(var(--color-text))] disabled:cursor-not-allowed disabled:opacity-40"
                >
                  Clear
                </button>
                <button
                  type="button"
                  onClick={() => setLightboxImage(null)}
                  className="rounded-lg bg-[rgb(var(--color-accent))] px-3 py-2 text-xs font-medium text-[rgb(var(--color-accent-fg))] transition-colors hover:bg-[rgb(var(--color-accent-hover))]"
                >
                  Done
                </button>
              </div>
            </aside>
          </div>
          <button
            onClick={() => setLightboxImage(null)}
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
            role="dialog"
            aria-label={`Row ${visualLightbox.rowIndex + 1} visual`}
            ref={visualDialogRef}
            tabIndex={-1}
            className="relative flex flex-col rounded-xl overflow-hidden shadow-2xl bg-[rgb(var(--color-surface))] outline-none"
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
                      aria-pressed={lightboxMode === "preview"}
                      className={`px-3 py-1 rounded-md text-xs font-medium transition-colors ${
                        lightboxMode === "preview"
                          ? "bg-[rgb(var(--color-accent))] text-[rgb(var(--color-accent-fg))]"
                          : "text-[rgb(var(--color-text-secondary))] hover:text-[rgb(var(--color-text))]"
                      }`}
                    >
                      Preview
                    </button>
                    <button
                      onClick={() => setLightboxMode("edit")}
                      aria-pressed={lightboxMode === "edit"}
                      className={`px-3 py-1 rounded-md text-xs font-medium transition-colors ${
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
                  <span className="text-xs text-[rgb(var(--color-accent))] font-medium">● Unsaved</span>
                )}
              </div>
              <div className="flex items-center gap-2">
                {/* Save button (edit mode only) */}
                {lightboxMode === "edit" && editorDirty && editorDsl && (
                  <button
                    onClick={() => saveEditorChanges(editorDsl)}
                    title="Save changes"
                    aria-label="Save visual changes"
                    className="p-1.5 rounded-lg text-[rgb(var(--color-accent))] hover:text-[rgb(var(--color-accent-hover))] hover:bg-[rgb(var(--color-surface))] transition-colors"
                  >
                    <Check className="w-4 h-4" />
                  </button>
                )}
                {/* Close button */}
                <button
                  onClick={closeLightbox}
                  aria-label="Close visual"
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
        <div className="fixed bottom-4 left-1/2 -translate-x-1/2 z-dropdown flex items-center gap-2 px-3 py-2 rounded-lg bg-[rgb(var(--color-surface))] border border-[rgb(var(--color-border))] shadow-lg text-xs text-[rgb(var(--color-text))]">
          <span>{undoToast}</span>
          <button
            onClick={() => { popUndo(); setUndoToast(null); }}
            className="px-2 py-0.5 rounded text-xs font-medium text-[rgb(var(--color-accent))] hover:bg-[rgb(var(--color-accent))]/10 transition-colors"
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
