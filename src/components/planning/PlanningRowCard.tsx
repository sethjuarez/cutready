import { useState, lazy, Suspense } from "react";
import { useSortable } from "@dnd-kit/sortable";
import { CSS } from "@dnd-kit/utilities";
import { X, Sparkles, Maximize2, Search, Image as ImageIcon, Folder, Plus, Camera, Crosshair, Lock, Unlock, Mic, AlertTriangle } from "lucide-react";
import type { PlanningCellField, PlanningRow } from "../../types/sketch";
import type { RowDiff } from "../../utils/textDiff";
import { useProjectImage } from "../../hooks/useProjectImage";
import { useConfirmDialog } from "../ConfirmDialog";
import { getRowColor, hasAnyLock, isCellLocked } from "./rowState";
import { LocalInput, MarkdownCell, CellActionRail, SparkleButton, CellLockButton } from "./PlanningCells";
import { NarrationPlayer } from "./NarrationPlayer";
import { MediaAddPopover } from "./MediaAddPopover";

const VisualCell = lazy(() => import("../VisualCell"));

export function PlanningRowCard({
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
  onPasteImage,
  onPickImage,
  onBrowseImage,
  onSparkle,
  onGenerateVisual,
  onRemoveVisual,
  onRemoveNarration,
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
  onStartNarrationRecording,
  onGenerateNarration,
  onPickNarration,
  onStopNarrationRecording,
  narrationRecordingRow,
  narrationSavingRows,
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
  onPasteImage?: (rowIndex: number) => void;
  onPickImage?: (rowIndex: number) => void;
  onBrowseImage?: (rowIndex: number) => void;
  onSparkle?: (prompt: string) => void;
  onGenerateVisual?: (rowIndex: number) => void;
  onRemoveVisual?: (rowIndex: number) => void;
  onRemoveNarration?: (rowIndex: number) => void;
  projectRoot?: string;
  sketchPath?: string;
  onImageClick: (src: string, rowIndex: number) => void;
  onVisualClick: (visualPath: string, rowIndex: number) => void;
  isHighlighted?: boolean;
  rowDiff?: RowDiff;
  onDismissHighlight?: () => void;
  visualVersion: number;
  onRowLockChange?: (rowIndex: number, locked: boolean) => void;
  onCellLockChange?: (rowIndex: number, field: PlanningCellField, locked: boolean) => void;
  onStartNarrationRecording?: (rowIndex: number) => void;
  onGenerateNarration?: (rowIndex: number) => void;
  onPickNarration?: (rowIndex: number) => void;
  onStopNarrationRecording?: () => void;
  narrationRecordingRow?: number | null;
  narrationSavingRows?: Set<number>;
}){
  const [diffExpanded, setDiffExpanded] = useState(true);
  const rowLocked = row.locked === true;
  const timeLocked = isCellLocked(row, "time");
  const narrativeLocked = isCellLocked(row, "narrative");
  const actionsLocked = isCellLocked(row, "demo_actions");
  const mediaLocked = isCellLocked(row, "screenshot") || isCellLocked(row, "visual");
  const screenshotSrc = useProjectImage(projectRoot ?? null, row.screenshot);
  const displayScreenshotSrc = projectRoot ? screenshotSrc : row.screenshot;
  const isRecordingNarration = narrationRecordingRow === idx;
  const isSavingNarration = narrationSavingRows?.has(idx) ?? false;
  const narrationStale = Boolean(row.narration && row.narration.source_text !== row.narrative);
  const narrationPath = row.narration?.path ?? null;
  const motionPointCount = row.motion_points?.length ?? 0;
  const { confirm, confirmationDialog } = useConfirmDialog();
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

  const confirmRemoveScreenshot = async () => {
    const confirmed = await confirm({
      title: "Remove screenshot?",
      message: "Remove this screenshot from the row?\n\nThe image file stays in the workspace, but this row will no longer reference it.",
      confirmLabel: "Remove screenshot",
      variant: "error",
    });
    if (confirmed) updateRow(idx, "screenshot", "");
  };

  const confirmRemoveNarration = async () => {
    const confirmed = await confirm({
      title: "Remove narration?",
      message: "Remove this narration take from the row?\n\nThe audio file stays in the workspace, but this row will no longer reference it.",
      confirmLabel: "Remove narration",
      variant: "error",
    });
    if (confirmed) onRemoveNarration?.(idx);
  };

  return (
    <>
    <tr
      ref={setNodeRef}
      data-testid={`planning-row-${idx + 1}`}
      style={{ ...style, backgroundColor: isHighlighted ? undefined : rowBg }}
      className={`card-row group hover:shadow-sm ${isSorting ? "" : "transition-all"} ${isHighlighted ? "ai-highlight-row" : ""} ${rowLocked ? "ring-1 ring-[rgb(var(--color-warning))]/15" : ""}`}
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
            aria-label={`Move row ${idx + 1}`}
          >
            {/* Row number (visible by default), drag icon on hover */}
            <span className="text-[0.625rem] font-medium opacity-40 group-hover:hidden">{rowLocked ? <Lock className="w-3 h-3 opacity-80" /> : idx + 1}</span>
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
            label={`Row ${idx + 1} time`}
            readOnly={readOnly || timeLocked}
            onAddRow={isLastRow && !readOnly && !hasAnyLock(row) ? () => addRow(idx) : undefined}
            hasActionRail={!readOnly && !rowLocked && !!onCellLockChange}
          />
          {!readOnly && !rowLocked && onCellLockChange && (
            <CellActionRail persistent={timeLocked}>
              <CellLockButton locked={timeLocked} label={`row ${idx + 1} time`} onClick={() => onCellLockChange(idx, "time", !timeLocked)} />
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
            label={`Row ${idx + 1} narrative`}
            readOnly={readOnly || narrativeLocked}
            onAddRow={isLastRow && !readOnly && !hasAnyLock(row) ? () => addRow(idx) : undefined}
            hasActionRail={!readOnly && (!!onCellLockChange || !!onSparkle)}
          />
          {!readOnly && (
            <CellActionRail persistent={narrativeLocked}>
              {onSparkle && !narrativeLocked && (
                <SparkleButton onClick={() => onSparkle(
                  `Improve the narrative for row ${idx + 1} of sketch "${sketchPath ?? "current"}". Current text: "${row.narrative}". Make it more engaging and natural for spoken delivery. Use update_planning_row with row_number ${idx + 1} and expected_narrative ${JSON.stringify(row.narrative)} to change only this row.`
                )} />
              )}
              {!rowLocked && onCellLockChange && (
                <CellLockButton locked={narrativeLocked} label={`row ${idx + 1} narrative`} onClick={() => onCellLockChange(idx, "narrative", !narrativeLocked)} />
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
            label={`Row ${idx + 1} actions`}
            readOnly={readOnly || actionsLocked}
            onAddRow={isLastRow && !readOnly && !hasAnyLock(row) ? () => addRow(idx) : undefined}
            hasActionRail={!readOnly && (!!onCellLockChange || !!onSparkle)}
          />
          {!readOnly && (
            <CellActionRail persistent={actionsLocked}>
              {onSparkle && !actionsLocked && (
                <SparkleButton onClick={() => onSparkle(
                  `Improve the demo actions for row ${idx + 1} of sketch "${sketchPath ?? "current"}". Current text: "${row.demo_actions}". Make the steps clearer and more specific. Use update_planning_row with row_number ${idx + 1} and expected_demo_actions ${JSON.stringify(row.demo_actions)} to change only this row.`
                )} />
              )}
              {!rowLocked && onCellLockChange && (
                <CellLockButton locked={actionsLocked} label={`row ${idx + 1} actions`} onClick={() => onCellLockChange(idx, "demo_actions", !actionsLocked)} />
              )}
            </CellActionRail>
          )}
        </div>
      </td>
      <td className="script-table-td align-top">
        <div className="flex min-h-8 w-full flex-col items-stretch gap-2">
          {row.screenshot ? (
            <div className="relative group/ss h-24 w-full rounded-md bg-[rgb(var(--color-surface-alt))] border border-[rgb(var(--color-border))] overflow-hidden cursor-pointer"
              onClick={() => {
                if (displayScreenshotSrc) onImageClick(displayScreenshotSrc, idx);
              }}
            >
              {!readOnly && !rowLocked && onCellLockChange && (
                <div className="absolute right-1 top-1 z-10">
                  <CellLockButton locked={mediaLocked} onClick={() => onCellLockChange(idx, "screenshot", !mediaLocked)} className="bg-[rgb(var(--color-media-control-bg)/0.2)] text-[rgb(var(--color-media-control-fg))] hover:bg-[rgb(var(--color-media-control-bg)/0.4)]" />
                </div>
              )}
              {displayScreenshotSrc && (
                <img
                  src={displayScreenshotSrc}
                  alt=""
                  className="w-full h-full object-cover"
                />
              )}
              {motionPointCount > 0 && (
                <div className="absolute bottom-1 left-1 z-10 inline-flex items-center gap-1 rounded-full bg-[rgb(var(--color-media-control-bg)/0.58)] px-1.5 py-0.5 text-2xs font-medium text-[rgb(var(--color-media-control-fg))] backdrop-blur">
                  <Crosshair className="h-3 w-3" />
                  {motionPointCount}
                </div>
              )}
              {!readOnly && !mediaLocked && (
                <div className="absolute inset-0 bg-[rgb(var(--color-media-control-bg)/0.5)] opacity-0 group-hover/ss:opacity-100 transition-opacity flex items-center justify-center gap-1.5" onClick={(e) => e.stopPropagation()}>
                  <button
                    onClick={() => {
                    if (displayScreenshotSrc) onImageClick(displayScreenshotSrc, idx);
                  }}
                  className="p-1 rounded-full bg-[rgb(var(--color-media-control-bg)/0.2)] text-[rgb(var(--color-media-control-fg))] hover:bg-[rgb(var(--color-media-control-bg)/0.3)]"
                  title="View image"
                >
                  <Search className="w-3.5 h-3.5" />
                </button>
                <button
                  onClick={() => {
                    if (displayScreenshotSrc) onImageClick(displayScreenshotSrc, idx);
                  }}
                  className="p-1 rounded-full bg-[rgb(var(--color-media-control-bg)/0.2)] text-[rgb(var(--color-media-control-fg))] hover:bg-[rgb(var(--color-accent)/0.8)]"
                  title="Set motion points"
                >
                  <Crosshair className="w-3.5 h-3.5" />
                </button>
                  <button
                    onClick={() => onCaptureScreenshot?.(idx)}
                    className="p-1 rounded-full bg-[rgb(var(--color-media-control-bg)/0.2)] text-[rgb(var(--color-media-control-fg))] hover:bg-[rgb(var(--color-media-control-bg)/0.3)]"
                    title="Re-capture screenshot"
                  >
                    <Camera className="w-3.5 h-3.5" />
                  </button>
                  {onPickImage && (
                    <button
                      onClick={() => onPickImage(idx)}
                      className="p-1 rounded-full bg-[rgb(var(--color-media-control-bg)/0.2)] text-[rgb(var(--color-media-control-fg))] hover:bg-[rgb(var(--color-media-control-bg)/0.3)]"
                      title="Pick from workspace images"
                    >
                      <ImageIcon className="w-3.5 h-3.5" />
                    </button>
                  )}
                  {onBrowseImage && (
                    <button
                      onClick={() => onBrowseImage(idx)}
                      className="p-1 rounded-full bg-[rgb(var(--color-media-control-bg)/0.2)] text-[rgb(var(--color-media-control-fg))] hover:bg-[rgb(var(--color-media-control-bg)/0.3)]"
                      title="Browse for image file"
                    >
                      <Folder className="w-3.5 h-3.5" />
                    </button>
                  )}
                  <button
                    onClick={() => void confirmRemoveScreenshot()}
                    className="p-1 rounded-full bg-[rgb(var(--color-media-control-bg)/0.2)] text-[rgb(var(--color-media-control-fg))] hover:bg-[rgb(var(--color-error)/0.8)]"
                    title="Remove screenshot"
                  >
                    <X className="w-3.5 h-3.5" />
                  </button>
                </div>
              )}
            </div>
          ) : row.visual ? (
            <div className="relative group/vis cursor-pointer" onClick={() => onVisualClick(row.visual!, idx)}>
              {!readOnly && !rowLocked && onCellLockChange && (
                <div className="absolute right-1 top-1 z-10">
                  <CellLockButton locked={mediaLocked} onClick={() => onCellLockChange(idx, "screenshot", !mediaLocked)} className="bg-[rgb(var(--color-media-control-bg)/0.2)] text-[rgb(var(--color-media-control-fg))] hover:bg-[rgb(var(--color-media-control-bg)/0.4)]" />
                </div>
              )}
              <Suspense fallback={<div className="h-24 w-full rounded-md bg-[rgb(var(--color-surface-alt))] border border-[rgb(var(--color-border))] animate-pulse" />}>
                <VisualCell
                  visualPath={row.visual!}
                  mode="thumbnail"
                  key={`${row.visual}-v${visualVersion}`}
                />
              </Suspense>
              {!mediaLocked && <div className="absolute inset-0 bg-[rgb(var(--color-media-control-bg)/0.4)] opacity-0 group-hover/vis:opacity-100 focus-within:opacity-100 transition-opacity flex items-center justify-center gap-1.5 rounded-md" onClick={(e) => e.stopPropagation()}>
                <button
                  onClick={() => onVisualClick(row.visual!, idx)}
                  className="p-1 rounded-full bg-[rgb(var(--color-media-control-bg)/0.2)] text-[rgb(var(--color-media-control-fg))] hover:bg-[rgb(var(--color-media-control-bg)/0.4)]"
                  title="Preview visual (click to edit)"
                  aria-label={`Preview visual for row ${idx + 1}`}
                >
                  <Maximize2 className="w-3.5 h-3.5" />
                </button>
                {!readOnly && onGenerateVisual && (
                  <button
                    onClick={() => onGenerateVisual(idx)}
                    className="p-1 rounded-full bg-[rgb(var(--color-media-control-bg)/0.2)] text-[rgb(var(--color-media-control-fg))] hover:bg-[rgb(var(--color-accent)/0.8)]"
                    title="Regenerate visual with AI"
                    aria-label={`Regenerate visual for row ${idx + 1}`}
                  >
                    <Sparkles className="w-3.5 h-3.5" />
                  </button>
                )}
                {!readOnly && (
                  <button
                    onClick={() => onRemoveVisual?.(idx)}
                    className="p-1 rounded-full bg-[rgb(var(--color-media-control-bg)/0.2)] text-[rgb(var(--color-media-control-fg))] hover:bg-[rgb(var(--color-error)/0.8)]"
                    title="Remove visual"
                    aria-label={`Remove visual for row ${idx + 1}`}
                  >
                    <X className="w-3.5 h-3.5" />
                  </button>
                )}
              </div>}
            </div>
          ) : (
            <div className="relative flex h-24 w-full items-center justify-center rounded-md border border-dashed border-[rgb(var(--color-border))] bg-[rgb(var(--color-surface))]/45">
              {!readOnly && !mediaLocked ? (
                <div className="flex flex-col items-center gap-1 text-2xs text-[rgb(var(--color-text-secondary))]">
                  <MediaAddPopover
                    idx={idx}
                    variant="placeholder"
                    hasNarration={Boolean(row.narration)}
                    hasPrimaryAsset={Boolean(row.screenshot || row.visual)}
                    assetKind="visual"
                    onCaptureScreenshot={onCaptureScreenshot}
                    onPasteImage={onPasteImage}
                    onPickImage={onPickImage}
                    onBrowseImage={onBrowseImage}
                    onGenerateVisual={onGenerateVisual}
                    onStartNarrationRecording={onStartNarrationRecording}
                    onGenerateNarration={onGenerateNarration}
                  />
                  <span>Screenshot</span>
                </div>
              ) : (
                <span className="flex flex-col items-center gap-1 text-2xs text-[rgb(var(--color-text-secondary))]">
                  <ImageIcon className="h-4 w-4 opacity-60" />
                  {mediaLocked ? "Visual locked" : "Screenshot"}
                </span>
              )}
              {!readOnly && !rowLocked && onCellLockChange && (
                <CellActionRail persistent={mediaLocked}>
                  <CellLockButton locked={mediaLocked} onClick={() => onCellLockChange(idx, "screenshot", !mediaLocked)} />
                </CellActionRail>
              )}
            </div>
          )}

          <div className={`w-full rounded-lg border px-2 py-1.5 text-left ${
            row.narration
              ? narrationStale
                ? "border-[rgb(var(--color-warning))]/30 bg-[rgb(var(--color-warning))]/8"
                : "border-[rgb(var(--color-border))] bg-[rgb(var(--color-surface))]/60"
              : "border-dashed border-[rgb(var(--color-border))] bg-[rgb(var(--color-surface))]/45"
          }`}>
            {row.narration ? (
            <>
              <div className="flex items-center gap-1.5">
                <div className="min-w-0 flex-1">
                  {narrationPath ? (
                    <NarrationPlayer
                      relativePath={narrationPath}
                      onRecord={onStartNarrationRecording && !mediaLocked ? () => onStartNarrationRecording(idx) : undefined}
                      onRemove={!readOnly && !mediaLocked ? () => void confirmRemoveNarration() : undefined}
                      onStopRecording={onStopNarrationRecording}
                      recording={isRecordingNarration}
                      saving={isSavingNarration}
                      recordDisabled={narrationRecordingRow !== null && !isRecordingNarration}
                    />
                  ) : (
                    <div className="text-xs text-[rgb(var(--color-text-secondary))]">Narration file unavailable.</div>
                  )}
                </div>
                {narrationStale && (
                  <span className="inline-flex items-center gap-1 text-2xs uppercase tracking-wide text-[rgb(var(--color-warning))]" title="Narration is stale">
                    <AlertTriangle className="h-3 w-3" />
                    Stale
                  </span>
                )}
              </div>
              {row.narration_plan && (
                <details className="mt-1.5 text-2xs text-[rgb(var(--color-text-secondary))]">
                  <summary className="cursor-pointer select-none hover:text-[rgb(var(--color-text))]">
                    SSML plan · {row.narration_plan.voice}
                    {row.narration_plan.baseline_style ? ` · ${row.narration_plan.baseline_style}` : ""}
                  </summary>
                  <div className="mt-1 space-y-1 border-t border-[rgb(var(--color-border))] pt-1.5">
                    {row.narration_plan.beats?.map((beat, beatIndex) => (
                      <div key={`${beat.text}-${beatIndex}`}>
                        <span className="font-medium text-[rgb(var(--color-text))]">{beat.text}</span>
                        {beat.purpose ? ` · ${beat.purpose}` : ""}
                        {beat.pause_after_ms ? ` · ${beat.pause_after_ms}ms pause` : ""}
                      </div>
                    ))}
                    {Object.keys(row.narration_plan.pronunciation_overrides ?? {}).length > 0 && (
                      <div>
                        Pronunciations: {Object.entries(row.narration_plan.pronunciation_overrides ?? {})
                          .map(([term, pronunciation]) => `${term} → ${pronunciation}`)
                          .join(", ")}
                      </div>
                    )}
                  </div>
                </details>
              )}
              </>
            ) : (
              !readOnly && !mediaLocked ? (
                <div className="flex min-h-12 flex-col items-center justify-center gap-1 text-2xs text-[rgb(var(--color-text-secondary))]">
                  <MediaAddPopover
                    idx={idx}
                    variant="placeholder"
                    assetKind="narration"
                    hasNarration={Boolean(row.narration)}
                    hasPrimaryAsset={Boolean(row.screenshot || row.visual)}
                    onStartNarrationRecording={narrationRecordingRow === null ? onStartNarrationRecording : undefined}
                    onGenerateNarration={onGenerateNarration}
                    onPickNarration={onPickNarration}
                  />
                  <span>Narration</span>
                </div>
              ) : (
                <div className="flex h-8 items-center justify-center gap-1.5 text-xs text-[rgb(var(--color-text-secondary))]">
                  <Mic className="h-3.5 w-3.5 opacity-60" />
                  No narration
                </div>
              )
            )}
          </div>
        </div>
      </td>
      {!readOnly && (
        <td className="p-1 align-top">
          <div className={`flex flex-col gap-0.5 transition-opacity ${rowLocked ? "opacity-100" : "opacity-0 group-hover:opacity-100"}`}>
            {onRowLockChange && (
              <button
                onClick={() => onRowLockChange(idx, !rowLocked)}
                className={`inline-flex h-5 w-5 items-center justify-center rounded border transition-colors ${
                  rowLocked
                    ? "border-[rgb(var(--color-warning))]/25 bg-[rgb(var(--color-warning))]/10 text-[rgb(var(--color-warning))] hover:bg-[rgb(var(--color-warning))]/15"
                    : "border-transparent text-[rgb(var(--color-text-secondary))] hover:border-[rgb(var(--color-border))] hover:bg-[rgb(var(--color-surface-alt))] hover:text-[rgb(var(--color-accent))]"
                }`}
                title={rowLocked ? "Unlock row" : "Lock row"}
                aria-label={`${rowLocked ? "Unlock" : "Lock"} row ${idx + 1}`}
              >
                {rowLocked ? <Lock className="w-3 h-3" /> : <Unlock className="w-3 h-3" />}
              </button>
            )}
            {!hasAnyLock(row) && <button
              onClick={() => addRow(idx)}
              className="p-0.5 rounded text-[rgb(var(--color-text-secondary))] hover:text-[rgb(var(--color-accent))] transition-colors"
              title="Add row below"
              aria-label={`Add row below row ${idx + 1}`}
            >
              <Plus className="w-3 h-3" />
            </button>}
            {!hasAnyLock(row) && <button
              onClick={() => deleteRow(idx)}
              className="p-0.5 rounded text-[rgb(var(--color-text-secondary))] hover:text-error transition-colors"
              title="Delete row"
              aria-label={`Delete row ${idx + 1}`}
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
    {confirmationDialog}
    </>
  );
}
