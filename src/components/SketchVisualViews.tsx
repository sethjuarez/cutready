import { useEffect, useState, type KeyboardEvent as ReactKeyboardEvent, type MouseEvent } from "react";
import { Camera, FolderOpen, Image as ImageIcon, Mic2, Plus, Sparkles, Trash2, Upload, X } from "lucide-react";
import type { PlanningCellField, PlanningRow } from "../types/sketch";
import VisualCell from "./VisualCell";
import { useProjectImage } from "../hooks/useProjectImage";
import { parseDurationSeconds } from "../utils/documentMetadata";

interface SketchVisualViewProps {
  rows: PlanningRow[];
  onChange: (rows: PlanningRow[]) => void;
  projectRoot?: string | null;
  readOnly?: boolean;
  onCaptureScreenshot?: (rowIndex: number) => void;
  onPasteImage?: (rowIndex: number) => void;
  onPickImage?: (rowIndex: number) => void;
  onBrowseImage?: (rowIndex: number) => void;
  onGenerateVisual?: (rowIndex: number) => void;
  onRemoveMedia?: (rowIndex: number) => void;
  onStartNarrationRecording?: (rowIndex: number) => void;
  onGenerateNarration?: (rowIndex: number) => void;
  onPickNarration?: (rowIndex: number) => void;
  onRemoveNarration?: (rowIndex: number) => void;
}

type MediaPreview =
  | { kind: "screenshot"; src: string; rowIndex: number }
  | { kind: "visual"; visualPath: string; rowIndex: number };

function rowMediaLabel(row: PlanningRow): string {
  if (row.visual) return "Elucim visual";
  if (row.screenshot) return "Screenshot";
  return "No media";
}

function isCellLocked(row: PlanningRow, field: PlanningCellField): boolean {
  return row.locked === true || row.locks?.[field] === true;
}

function hasAnyLock(row: PlanningRow): boolean {
  return row.locked === true || Object.values(row.locks ?? {}).some(Boolean);
}

function RowMedia({
  row,
  rowIndex,
  projectRoot,
  readOnly = false,
  className = "",
  imageClassName = "h-full w-full object-contain",
  onOpenPreview,
  onCaptureScreenshot,
  onPasteImage,
  onPickImage,
  onBrowseImage,
  onGenerateVisual,
  onRemoveMedia,
}: {
  row: PlanningRow;
  rowIndex: number;
  projectRoot?: string | null;
  readOnly?: boolean;
  className?: string;
  imageClassName?: string;
  onOpenPreview: (preview: MediaPreview) => void;
  onCaptureScreenshot?: (rowIndex: number) => void;
  onPasteImage?: (rowIndex: number) => void;
  onPickImage?: (rowIndex: number) => void;
  onBrowseImage?: (rowIndex: number) => void;
  onGenerateVisual?: (rowIndex: number) => void;
  onRemoveMedia?: (rowIndex: number) => void;
}) {
  const screenshotSrc = useProjectImage(projectRoot ?? null, row.screenshot);
  const hasMedia = Boolean(row.visual || row.screenshot);
  const mediaLocked = readOnly || isCellLocked(row, "screenshot") || isCellLocked(row, "visual");
  const mediaClass = `group/media relative h-full min-h-[150px] w-full overflow-hidden rounded-xl border border-[rgb(var(--color-border))] bg-[rgb(var(--color-surface-alt))] ${className}`;
  const openMedia = () => {
    if (row.visual) {
      onOpenPreview({ kind: "visual", visualPath: row.visual, rowIndex });
    } else if (screenshotSrc) {
      onOpenPreview({ kind: "screenshot", src: screenshotSrc, rowIndex });
    }
  };
  const stop = (event: MouseEvent) => event.stopPropagation();
  const imageVerb = hasMedia ? "Replace" : "Add";
  const interactiveProps = hasMedia
    ? {
        role: "button",
        tabIndex: 0,
        onClick: openMedia,
        onKeyDown: (event: ReactKeyboardEvent<HTMLDivElement>) => {
          if (event.key === "Enter" || event.key === " ") {
            event.preventDefault();
            openMedia();
          }
        },
      }
    : {};

  if (row.visual) {
    return (
      <div className={`${mediaClass} text-left cursor-zoom-in`} title="Open visual full screen" {...interactiveProps}>
        <VisualCell visualPath={row.visual} mode="thumbnail" className="!h-full !w-full !rounded-none !border-0" />
        <MediaActions
          readOnly={mediaLocked}
          imageVerb={imageVerb}
          removeLabel="Remove visual"
          hasMedia={hasMedia}
          rowIndex={rowIndex}
          onCaptureScreenshot={onCaptureScreenshot}
          onPasteImage={onPasteImage}
          onPickImage={onPickImage}
          onBrowseImage={onBrowseImage}
          onGenerateVisual={onGenerateVisual}
          onRemoveMedia={onRemoveMedia}
          onClickCapture={stop}
        />
      </div>
    );
  }

  if (row.screenshot) {
    return (
      <div className={`${mediaClass} text-left cursor-zoom-in`} title="Open screenshot full screen" {...interactiveProps}>
        {screenshotSrc ? (
          <img
            src={screenshotSrc}
            alt=""
            className={imageClassName}
          />
        ) : (
          <div className="flex h-full min-h-[150px] w-full items-center justify-center text-xs text-[rgb(var(--color-text-secondary))]">
            Loading screenshot...
          </div>
        )}
        <MediaActions
          readOnly={mediaLocked}
          imageVerb={imageVerb}
          removeLabel="Remove screenshot"
          hasMedia={hasMedia}
          rowIndex={rowIndex}
          onCaptureScreenshot={onCaptureScreenshot}
          onPasteImage={onPasteImage}
          onPickImage={onPickImage}
          onBrowseImage={onBrowseImage}
          onGenerateVisual={onGenerateVisual}
          onRemoveMedia={onRemoveMedia}
          onClickCapture={stop}
        />
      </div>
    );
  }

  return (
    <div className={`${mediaClass} flex flex-col items-center justify-center gap-2 text-[rgb(var(--color-text-secondary))]`}>
      <ImageIcon className="h-5 w-5" />
      <span className="text-xs">Add screenshot or visual</span>
      <MediaActions
        readOnly={mediaLocked}
        imageVerb={imageVerb}
        removeLabel="Remove media"
        hasMedia={hasMedia}
        rowIndex={rowIndex}
        onCaptureScreenshot={onCaptureScreenshot}
        onPasteImage={onPasteImage}
        onPickImage={onPickImage}
        onBrowseImage={onBrowseImage}
        onGenerateVisual={onGenerateVisual}
        onRemoveMedia={onRemoveMedia}
        onClickCapture={stop}
      />
    </div>
  );
}

function MediaActions({
  readOnly,
  imageVerb,
  removeLabel,
  hasMedia,
  rowIndex,
  onCaptureScreenshot,
  onPasteImage,
  onPickImage,
  onBrowseImage,
  onGenerateVisual,
  onRemoveMedia,
  onClickCapture,
}: {
  readOnly: boolean;
  imageVerb: string;
  removeLabel: string;
  hasMedia: boolean;
  rowIndex: number;
  onCaptureScreenshot?: (rowIndex: number) => void;
  onPasteImage?: (rowIndex: number) => void;
  onPickImage?: (rowIndex: number) => void;
  onBrowseImage?: (rowIndex: number) => void;
  onGenerateVisual?: (rowIndex: number) => void;
  onRemoveMedia?: (rowIndex: number) => void;
  onClickCapture: (event: MouseEvent) => void;
}) {
  if (readOnly) return null;

  const actions = [
    onCaptureScreenshot ? { icon: Camera, label: `${imageVerb} screenshot`, action: onCaptureScreenshot } : null,
    onPasteImage ? { icon: Upload, label: "Paste image", action: onPasteImage } : null,
    onPickImage ? { icon: ImageIcon, label: `${imageVerb} from workspace`, action: onPickImage } : null,
    onBrowseImage ? { icon: FolderOpen, label: `${imageVerb} from disk`, action: onBrowseImage } : null,
    onGenerateVisual ? { icon: Sparkles, label: hasMedia ? "Replace with visual" : "Generate visual", action: onGenerateVisual } : null,
    hasMedia && onRemoveMedia ? { icon: X, label: removeLabel, action: onRemoveMedia } : null,
  ].filter(Boolean);

  if (actions.length === 0) return null;

  return (
    <div className="absolute bottom-2 left-2 right-2 flex flex-wrap gap-1 opacity-0 transition-opacity group-hover/media:opacity-100 group-focus-within/media:opacity-100">
      {actions.map((item) => {
        if (!item) return null;
        const Icon = item.icon;
        return (
          <button
            key={item.label}
            type="button"
            onClick={(event) => {
              onClickCapture(event);
              item.action(rowIndex);
            }}
            className="inline-flex items-center gap-1 rounded-full bg-[rgb(var(--color-surface))]/95 px-2 py-1 text-[10px] font-medium text-[rgb(var(--color-text))] shadow-sm ring-1 ring-[rgb(var(--color-border))] backdrop-blur transition-colors hover:text-[rgb(var(--color-accent))]"
            title={item.label}
          >
            <Icon className="h-3 w-3" />
            <span>{item.label}</span>
          </button>
        );
      })}
    </div>
  );
}

function RowChips({ row }: { row: PlanningRow }) {
  const chips = [
    row.time?.trim() ? row.time.trim() : null,
    row.narration?.path ? "Narration" : null,
    row.motion_plan ? "Motion" : null,
    row.visual ? "Visual" : null,
  ].filter(Boolean);

  if (chips.length === 0) return null;

  return (
    <div className="flex flex-wrap gap-1.5">
      {chips.map((chip) => (
        <span
          key={chip}
          className="rounded-full border border-[rgb(var(--color-border))] bg-[rgb(var(--color-surface-alt))] px-2 py-0.5 text-[10px] font-medium text-[rgb(var(--color-text-secondary))]"
        >
          {chip}
        </span>
      ))}
    </div>
  );
}

function formatNarrationDuration(durationMs?: number | null): string | null {
  if (!durationMs || durationMs <= 0) return null;
  const seconds = Math.round(durationMs / 1000);
  const minutes = Math.floor(seconds / 60);
  const remainder = seconds % 60;
  return minutes > 0 ? `${minutes}:${String(remainder).padStart(2, "0")}` : `${seconds}s`;
}

function RowNarration({ row, compact = false }: { row: PlanningRow; compact?: boolean }) {
  if (!row.narration) return null;

  const duration = formatNarrationDuration(row.narration.duration_ms);
  const source = row.narration.source_text?.trim() || row.narrative.trim();

  return (
    <div className={`rounded-lg border border-[rgb(var(--color-border))] bg-[rgb(var(--color-surface-alt))]/70 ${compact ? "px-2 py-1.5" : "px-3 py-2"}`}>
      <div className="mb-1 flex items-center justify-between gap-2 text-[10px] font-semibold uppercase tracking-[0.16em] text-[rgb(var(--color-text-secondary))]">
        <span className="inline-flex items-center gap-1.5">
          <Mic2 className="h-3 w-3 text-[rgb(var(--color-accent))]" />
          Narration
        </span>
        {duration && <span>{duration}</span>}
      </div>
      {source && (
        <p className={`${compact ? "line-clamp-1" : "line-clamp-2"} text-xs leading-5 text-[rgb(var(--color-text-secondary))]`}>
          {source}
        </p>
      )}
    </div>
  );
}

function updateRowField(
  rows: PlanningRow[],
  rowIndex: number,
  field: "time" | "narrative" | "demo_actions",
  value: string,
): PlanningRow[] {
  return rows.map((row, index) => {
    if (index !== rowIndex) return row;
    if (field === "time") {
      return { ...row, time: value, duration_seconds: parseDurationSeconds(value) };
    }
    return { ...row, [field]: value };
  });
}

function createEmptyRow(): PlanningRow {
  return {
    time: "",
    narrative: "",
    demo_actions: "",
    screenshot: null,
  };
}

function RowEditActions({
  rowIndex,
  rows,
  readOnly,
  onChange,
}: {
  rowIndex: number;
  rows: PlanningRow[];
  readOnly: boolean;
  onChange: (rows: PlanningRow[]) => void;
}) {
  if (readOnly || hasAnyLock(rows[rowIndex])) return null;

  return (
    <div className="flex items-center gap-1">
      <button
        type="button"
        onClick={() => {
          const updated = [...rows];
          updated.splice(rowIndex + 1, 0, createEmptyRow());
          onChange(updated);
        }}
        className="rounded-full p-1 text-[rgb(var(--color-text-secondary))] transition-colors hover:bg-[rgb(var(--color-accent))]/10 hover:text-[rgb(var(--color-accent))]"
        title="Add row after"
        aria-label={`Add row after row ${rowIndex + 1}`}
      >
        <Plus className="h-3.5 w-3.5" />
      </button>
      <button
        type="button"
        onClick={() => {
          if (rows.length <= 1) {
            onChange([createEmptyRow()]);
            return;
          }
          onChange(rows.filter((_, index) => index !== rowIndex));
        }}
        className="rounded-full p-1 text-[rgb(var(--color-text-secondary))] transition-colors hover:bg-error/10 hover:text-error"
        title="Remove row"
        aria-label={`Remove row ${rowIndex + 1}`}
      >
        <Trash2 className="h-3.5 w-3.5" />
      </button>
    </div>
  );
}

function AddRowButton({
  rows,
  readOnly,
  onChange,
}: {
  rows: PlanningRow[];
  readOnly: boolean;
  onChange: (rows: PlanningRow[]) => void;
}) {
  if (readOnly || (rows.length > 0 && hasAnyLock(rows[rows.length - 1]))) return null;

  return (
    <button
      type="button"
      onClick={() => onChange([...rows, createEmptyRow()])}
      className="mt-3 flex w-full items-center justify-center gap-1.5 rounded-lg border border-dashed border-[rgb(var(--color-border))] px-3 py-2 text-xs text-[rgb(var(--color-text-secondary))] transition-colors hover:border-[rgb(var(--color-accent))]/40 hover:text-[rgb(var(--color-accent))]"
    >
      <Plus className="h-3.5 w-3.5" />
      Add Row
    </button>
  );
}

function EditableText({
  value,
  placeholder,
  readOnly,
  multiline = true,
  className,
  onChange,
}: {
  value: string;
  placeholder: string;
  readOnly: boolean;
  multiline?: boolean;
  className: string;
  onChange: (value: string) => void;
}) {
  if (readOnly) {
    return (
      <p className={className}>
        {value || placeholder}
      </p>
    );
  }

  if (!multiline) {
    return (
      <input
        value={value}
        onChange={(event) => onChange(event.target.value)}
        placeholder={placeholder}
        className={`${className} w-full rounded-lg border border-transparent bg-transparent px-2 py-1 outline-none transition-colors placeholder:text-[rgb(var(--color-text-secondary))]/45 hover:border-[rgb(var(--color-border))] focus:border-[rgb(var(--color-accent))]/45 focus:bg-[rgb(var(--color-surface))] focus:ring-1 focus:ring-[rgb(var(--color-accent))]/25`}
      />
    );
  }

  return (
    <textarea
      value={value}
      onChange={(event) => onChange(event.target.value)}
      placeholder={placeholder}
      rows={compactTextRows(value)}
      className={`${className} w-full resize-none rounded-lg border border-transparent bg-transparent px-2 py-1 outline-none transition-colors placeholder:text-[rgb(var(--color-text-secondary))]/45 hover:border-[rgb(var(--color-border))] focus:border-[rgb(var(--color-accent))]/45 focus:bg-[rgb(var(--color-surface))] focus:ring-1 focus:ring-[rgb(var(--color-accent))]/25`}
    />
  );
}

function compactTextRows(value: string): number {
  const lineCount = value.split(/\r?\n/).length;
  return Math.min(5, Math.max(2, lineCount));
}

function NarrationActions({
  rowIndex,
  readOnly,
  onStartNarrationRecording,
  onGenerateNarration,
  onPickNarration,
  onRemoveNarration,
}: {
  rowIndex: number;
  readOnly: boolean;
  onStartNarrationRecording?: (rowIndex: number) => void;
  onGenerateNarration?: (rowIndex: number) => void;
  onPickNarration?: (rowIndex: number) => void;
  onRemoveNarration?: (rowIndex: number) => void;
}) {
  if (readOnly) return null;
  const actions = [
    onStartNarrationRecording ? { label: "Record narration", action: onStartNarrationRecording } : null,
    onGenerateNarration ? { label: "Generate narration", action: onGenerateNarration } : null,
    onPickNarration ? { label: "Pick narration", action: onPickNarration } : null,
    onRemoveNarration ? { label: "Remove narration", action: onRemoveNarration } : null,
  ].filter(Boolean);
  if (actions.length === 0) return null;

  return (
    <div className="flex flex-wrap gap-1.5">
      {actions.map((item) => item && (
        <button
          key={item.label}
          type="button"
          onClick={() => item.action(rowIndex)}
          className="rounded-full border border-[rgb(var(--color-border))] px-2 py-1 text-[10px] font-medium text-[rgb(var(--color-text-secondary))] transition-colors hover:border-[rgb(var(--color-accent))]/45 hover:text-[rgb(var(--color-accent))]"
        >
          {item.label}
        </button>
      ))}
    </div>
  );
}

function MediaPreviewLightbox({ preview, onClose }: { preview: MediaPreview | null; onClose: () => void }) {
  useEffect(() => {
    if (!preview) return;
    const handleKey = (event: globalThis.KeyboardEvent) => {
      if (event.key === "Escape") onClose();
    };
    window.addEventListener("keydown", handleKey);
    return () => window.removeEventListener("keydown", handleKey);
  }, [onClose, preview]);

  if (!preview) return null;

  return (
    <div
      className="fixed inset-0 z-modal flex items-center justify-center bg-[rgb(var(--color-overlay-strong)/0.82)] p-5"
      onClick={onClose}
    >
      <div
        className="relative flex h-[calc(100vh-40px)] w-[calc(100vw-40px)] max-w-[1280px] items-center justify-center overflow-hidden rounded-2xl border border-[rgb(var(--color-border))] bg-[rgb(var(--color-surface-alt))] p-5 shadow-2xl"
        onClick={(event) => event.stopPropagation()}
      >
        {preview.kind === "screenshot" ? (
          <img src={preview.src} alt="Screenshot preview" className="max-h-full max-w-full rounded-xl object-contain shadow-2xl" />
        ) : (
          <VisualCell visualPath={preview.visualPath} mode="full" className="h-full w-full" />
        )}
        <div className="absolute left-4 top-4 rounded-full bg-[rgb(var(--color-media-control-bg)/0.55)] px-3 py-1 text-xs font-medium text-[rgb(var(--color-media-control-fg))]">
          Row {preview.rowIndex + 1}
        </div>
        <button
          type="button"
          onClick={onClose}
          className="absolute right-4 top-4 rounded-full bg-[rgb(var(--color-media-control-bg)/0.55)] p-2 text-[rgb(var(--color-media-control-fg)/0.8)] transition-colors hover:text-[rgb(var(--color-media-control-fg))]"
          aria-label="Close media preview"
        >
          <X className="h-5 w-5" />
        </button>
      </div>
    </div>
  );
}

function EmptyRows({ readOnly, onAddRow }: { readOnly: boolean; onAddRow: () => void }) {
  return (
    <div className="rounded-2xl border border-dashed border-[rgb(var(--color-border))] bg-[rgb(var(--color-surface-alt))]/40 px-4 py-10 text-center">
      <p className="text-sm font-medium text-[rgb(var(--color-text))]">No rows yet</p>
      <p className="mt-1 text-xs text-[rgb(var(--color-text-secondary))]">
        Add planning rows to start shaping the visual flow.
      </p>
      {!readOnly && (
        <button
          type="button"
          onClick={onAddRow}
          className="mt-4 inline-flex items-center gap-1.5 rounded-lg bg-[rgb(var(--color-accent))] px-3 py-2 text-xs font-medium text-[rgb(var(--color-accent-fg))] transition-colors hover:bg-[rgb(var(--color-accent-hover))]"
        >
          <Plus className="h-3.5 w-3.5" />
          Add Row
        </button>
      )}
    </div>
  );
}

export function SketchBalancedView({
  rows,
  onChange,
  projectRoot,
  readOnly = false,
  onCaptureScreenshot,
  onPasteImage,
  onPickImage,
  onBrowseImage,
  onGenerateVisual,
  onRemoveMedia,
  onStartNarrationRecording,
  onGenerateNarration,
  onPickNarration,
  onRemoveNarration,
}: SketchVisualViewProps) {
  const [preview, setPreview] = useState<MediaPreview | null>(null);
  const updateField = (rowIndex: number, field: "time" | "narrative" | "demo_actions", value: string) => {
    if (readOnly || isCellLocked(rows[rowIndex], field)) return;
    onChange(updateRowField(rows, rowIndex, field, value));
  };
  if (rows.length === 0) return <EmptyRows readOnly={readOnly} onAddRow={() => onChange([createEmptyRow()])} />;

  return (
    <>
      <div className="space-y-3">
        {rows.map((row, index) => (
          <article
            key={index}
            className="grid gap-3 rounded-2xl border border-[rgb(var(--color-border-subtle))] bg-[rgb(var(--color-surface))]/45 p-3 shadow-sm md:grid-cols-[minmax(220px,0.92fr)_minmax(0,1fr)]"
          >
            <RowMedia
              row={row}
              rowIndex={index}
              projectRoot={projectRoot}
              readOnly={readOnly}
              onOpenPreview={setPreview}
              onCaptureScreenshot={onCaptureScreenshot}
              onPasteImage={onPasteImage}
              onPickImage={onPickImage}
              onBrowseImage={onBrowseImage}
              onGenerateVisual={onGenerateVisual}
              onRemoveMedia={onRemoveMedia}
            />
            <div className="flex min-w-0 flex-col gap-3">
              <div className="flex items-center justify-between gap-3">
                <div className="flex min-w-0 items-center gap-2">
                  <div className="text-[10px] font-semibold uppercase tracking-[0.22em] text-[rgb(var(--color-text-secondary))]/70">
                    Row {index + 1} · {rowMediaLabel(row)}
                  </div>
                  <RowEditActions rowIndex={index} rows={rows} readOnly={readOnly} onChange={onChange} />
                </div>
                <div className="flex min-w-[8rem] items-center gap-2">
                  <span className="text-[10px] font-semibold uppercase tracking-[0.16em] text-[rgb(var(--color-text-secondary))]">Time</span>
                  <EditableText
                    value={row.time}
                    placeholder="~30s"
                    readOnly={readOnly || isCellLocked(row, "time")}
                    multiline={false}
                    className="text-xs font-medium text-[rgb(var(--color-text))]"
                    onChange={(value) => updateField(index, "time", value)}
                  />
                </div>
              </div>
              <div>
                <h3 className="mb-1 text-xs font-semibold uppercase tracking-[0.16em] text-[rgb(var(--color-text-secondary))]">
                  Narrative
                </h3>
                <EditableText
                  value={row.narrative}
                  placeholder="No narrative yet."
                  readOnly={readOnly || isCellLocked(row, "narrative")}
                  className="whitespace-pre-wrap text-sm leading-6 text-[rgb(var(--color-text))]"
                  onChange={(value) => updateField(index, "narrative", value)}
                />
              </div>
              <div>
                <h3 className="mb-1 text-xs font-semibold uppercase tracking-[0.16em] text-[rgb(var(--color-text-secondary))]">
                  Actions
                </h3>
                <EditableText
                  value={row.demo_actions}
                  placeholder="No actions yet."
                  readOnly={readOnly || isCellLocked(row, "demo_actions")}
                  className="whitespace-pre-wrap text-sm leading-6 text-[rgb(var(--color-text-secondary))]"
                  onChange={(value) => updateField(index, "demo_actions", value)}
                />
              </div>
              <RowNarration row={row} />
              <RowChips row={row} />
              <NarrationActions
                rowIndex={index}
                readOnly={readOnly || isCellLocked(row, "screenshot") || isCellLocked(row, "visual")}
                onStartNarrationRecording={onStartNarrationRecording}
                onGenerateNarration={onGenerateNarration}
                onPickNarration={onPickNarration}
                onRemoveNarration={row.narration ? onRemoveNarration : undefined}
              />
            </div>
          </article>
        ))}
      </div>
      <AddRowButton rows={rows} readOnly={readOnly} onChange={onChange} />
      <MediaPreviewLightbox preview={preview} onClose={() => setPreview(null)} />
    </>
  );
}

export function SketchScreenView({
  rows,
  onChange,
  projectRoot,
  readOnly = false,
  onCaptureScreenshot,
  onPasteImage,
  onPickImage,
  onBrowseImage,
  onGenerateVisual,
  onRemoveMedia,
  onStartNarrationRecording,
  onGenerateNarration,
  onPickNarration,
  onRemoveNarration,
}: SketchVisualViewProps) {
  const [preview, setPreview] = useState<MediaPreview | null>(null);
  const updateField = (rowIndex: number, field: "time" | "narrative" | "demo_actions", value: string) => {
    if (readOnly || isCellLocked(rows[rowIndex], field)) return;
    onChange(updateRowField(rows, rowIndex, field, value));
  };
  if (rows.length === 0) return <EmptyRows readOnly={readOnly} onAddRow={() => onChange([createEmptyRow()])} />;

  return (
    <>
      <div className="space-y-3">
        {rows.map((row, index) => (
          <article
            key={index}
            className="grid overflow-hidden rounded-xl border border-[rgb(var(--color-border-subtle))] bg-[rgb(var(--color-surface))]/45 shadow-sm md:grid-cols-[minmax(360px,1.45fr)_minmax(0,0.75fr)]"
          >
            <RowMedia
              row={row}
              rowIndex={index}
              projectRoot={projectRoot}
              readOnly={readOnly}
              className="aspect-video min-h-0 rounded-none border-0 md:min-h-[280px]"
              imageClassName="h-full w-full object-contain"
              onOpenPreview={setPreview}
              onCaptureScreenshot={onCaptureScreenshot}
              onPasteImage={onPasteImage}
              onPickImage={onPickImage}
              onBrowseImage={onBrowseImage}
              onGenerateVisual={onGenerateVisual}
              onRemoveMedia={onRemoveMedia}
            />
            <div className="space-y-2.5 p-3">
              <div className="flex items-center justify-between gap-2">
                <div className="flex min-w-0 items-center gap-2">
                  <span className="text-[10px] font-semibold uppercase tracking-[0.22em] text-[rgb(var(--color-text-secondary))]/70">
                    Beat {index + 1}
                  </span>
                  <RowEditActions rowIndex={index} rows={rows} readOnly={readOnly} onChange={onChange} />
                </div>
                <div className="flex min-w-[7rem] items-center gap-2">
                  <span className="text-[10px] font-semibold uppercase tracking-[0.16em] text-[rgb(var(--color-text-secondary))]">Time</span>
                  <EditableText
                    value={row.time}
                    placeholder="~30s"
                    readOnly={readOnly || isCellLocked(row, "time")}
                    multiline={false}
                    className="text-xs font-medium text-[rgb(var(--color-text))]"
                    onChange={(value) => updateField(index, "time", value)}
                  />
                </div>
              </div>
              <div>
                <div className="mb-1 flex items-center gap-1.5 text-[10px] font-semibold uppercase tracking-[0.16em] text-[rgb(var(--color-text-secondary))]">
                  Narrative
                  {row.visual && <Sparkles className="h-3.5 w-3.5 text-[rgb(var(--color-accent))]" />}
                </div>
                <EditableText
                  value={row.narrative}
                  placeholder="No narrative yet."
                  readOnly={readOnly || isCellLocked(row, "narrative")}
                  className="text-sm leading-6 text-[rgb(var(--color-text))]"
                  onChange={(value) => updateField(index, "narrative", value)}
                />
              </div>
              <div>
                <h3 className="mb-1 text-[10px] font-semibold uppercase tracking-[0.16em] text-[rgb(var(--color-text-secondary))]">
                  Actions
                </h3>
                <EditableText
                  value={row.demo_actions}
                  placeholder="No actions yet."
                  readOnly={readOnly || isCellLocked(row, "demo_actions")}
                  className="text-xs leading-5 text-[rgb(var(--color-text-secondary))]"
                  onChange={(value) => updateField(index, "demo_actions", value)}
                />
              </div>
              <RowNarration row={row} compact />
              <NarrationActions
                rowIndex={index}
                readOnly={readOnly || isCellLocked(row, "screenshot") || isCellLocked(row, "visual")}
                onStartNarrationRecording={onStartNarrationRecording}
                onGenerateNarration={onGenerateNarration}
                onPickNarration={onPickNarration}
                onRemoveNarration={row.narration ? onRemoveNarration : undefined}
              />
              <RowChips row={row} />
            </div>
          </article>
        ))}
      </div>
      <AddRowButton rows={rows} readOnly={readOnly} onChange={onChange} />
      <MediaPreviewLightbox preview={preview} onClose={() => setPreview(null)} />
    </>
  );
}
