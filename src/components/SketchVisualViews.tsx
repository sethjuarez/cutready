import { useCallback, useEffect, useLayoutEffect, useRef, useState, type KeyboardEvent as ReactKeyboardEvent, type MouseEvent } from "react";
import { Camera, FolderOpen, Image as ImageIcon, Loader2, Mic2, Pause, Play, Plus, Sparkles, Square, Trash2, Upload, X } from "lucide-react";
import type { PlanningCellField, PlanningRow } from "../types/sketch";
import VisualCell from "./VisualCell";
import { useProjectImage } from "../hooks/useProjectImage";
import { parseDurationSeconds } from "../utils/documentMetadata";
import { invoke } from "../services/tauri";

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
  onStopNarrationRecording?: () => void;
  narrationRecordingRow?: number | null;
  narrationSavingRows?: Set<number>;
  onRemoveNarration?: (rowIndex: number) => void;
}

type MediaPreview =
  | { kind: "screenshot"; src: string; rowIndex: number }
  | { kind: "visual"; visualPath: string; rowIndex: number };

type NarrationAssetData = { data: number[]; mimeType: string };

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
    <div className="pointer-events-none absolute inset-0 z-20 flex items-center justify-center gap-1.5 bg-[rgb(var(--color-media-control-bg)/0.48)] opacity-0 transition-opacity group-hover/media:opacity-100 group-focus-within/media:opacity-100">
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
            className="pointer-events-auto grid h-8 w-8 place-items-center rounded-full bg-[rgb(var(--color-media-control-bg)/0.22)] text-[rgb(var(--color-media-control-fg))] shadow-sm ring-1 ring-[rgb(var(--color-media-control-fg)/0.16)] backdrop-blur transition-colors hover:bg-[rgb(var(--color-accent))]/80 hover:text-[rgb(var(--color-media-control-fg))]"
            aria-label={item.label}
            title={item.label}
          >
            <Icon className="h-3 w-3" />
          </button>
        );
      })}
    </div>
  );
}

function RowChips({ row }: { row: PlanningRow }) {
  const chips = [
    row.time?.trim() ? row.time.trim() : null,
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

function formatPlaybackTime(seconds: number): string {
  if (!Number.isFinite(seconds) || seconds <= 0) return "0:00";
  const rounded = Math.floor(seconds);
  const minutes = Math.floor(rounded / 60);
  const remainder = rounded % 60;
  return `${minutes}:${remainder.toString().padStart(2, "0")}`;
}

function RowNarration({
  row,
  rowIndex,
  readOnly,
  mediaLocked,
  recording,
  saving,
  recordDisabled,
  onStartNarrationRecording,
  onStopNarrationRecording,
  onRemoveNarration,
}: {
  row: PlanningRow;
  rowIndex: number;
  readOnly: boolean;
  mediaLocked: boolean;
  recording: boolean;
  saving: boolean;
  recordDisabled: boolean;
  onStartNarrationRecording?: (rowIndex: number) => void;
  onStopNarrationRecording?: () => void;
  onRemoveNarration?: (rowIndex: number) => void;
}) {
  const narration = row.narration;
  const audioRef = useRef<HTMLAudioElement>(null);
  const objectUrlRef = useRef("");
  const pendingAutoplaySrcRef = useRef("");
  const [src, setSrc] = useState("");
  const [duration, setDuration] = useState(narration?.duration_ms ? narration.duration_ms / 1000 : 0);
  const [currentTime, setCurrentTime] = useState(0);
  const [playing, setPlaying] = useState(false);
  const [loading, setLoading] = useState(false);
  const [loadError, setLoadError] = useState("");

  useEffect(() => {
    const objectUrl = objectUrlRef.current;
    if (objectUrl) URL.revokeObjectURL(objectUrl);
    objectUrlRef.current = "";
    pendingAutoplaySrcRef.current = "";
    setSrc("");
    setCurrentTime(0);
    setDuration(narration?.duration_ms ? narration.duration_ms / 1000 : 0);
    setPlaying(false);
    setLoading(false);
    setLoadError("");

    return () => {
      const currentObjectUrl = objectUrlRef.current;
      if (currentObjectUrl) URL.revokeObjectURL(currentObjectUrl);
      objectUrlRef.current = "";
      pendingAutoplaySrcRef.current = "";
    };
  }, [narration?.path, narration?.duration_ms]);

  useEffect(() => {
    const audio = audioRef.current;
    if (!audio) return;
    setCurrentTime(0);
    setPlaying(false);
    audio.pause();
    audio.load();

    if (!src || pendingAutoplaySrcRef.current !== src) return;

    let cancelled = false;
    const playLoadedAudio = () => {
      if (cancelled || pendingAutoplaySrcRef.current !== src) return;
      pendingAutoplaySrcRef.current = "";
      void audio.play().catch((err: unknown) => {
        if (err instanceof DOMException && err.name === "AbortError") return;
        setLoadError(`Could not play narration: ${err}`);
      });
    };

    if (audio.readyState >= HTMLMediaElement.HAVE_CURRENT_DATA) {
      queueMicrotask(playLoadedAudio);
      return () => { cancelled = true; };
    }

    audio.addEventListener("canplay", playLoadedAudio, { once: true });
    return () => {
      cancelled = true;
      audio.removeEventListener("canplay", playLoadedAudio);
    };
  }, [src]);

  const loadNarrationForPlayback = async (autoplay = false) => {
    if (src) return src;
    if (!narration?.path) return "";
    setLoading(true);
    setLoadError("");
    try {
      const asset = await invoke<NarrationAssetData>("read_narration_asset", { relativePath: narration.path });
      const objectUrl = URL.createObjectURL(new Blob([new Uint8Array(asset.data)], { type: asset.mimeType }));
      objectUrlRef.current = objectUrl;
      if (autoplay) pendingAutoplaySrcRef.current = objectUrl;
      setSrc(objectUrl);
      return objectUrl;
    } catch (err) {
      setLoadError(`Could not load narration: ${err}`);
      return "";
    } finally {
      setLoading(false);
    }
  };

  const togglePlayback = async () => {
    const audio = audioRef.current;
    if (!audio || loading) return;
    if (audio.paused) {
      if (src) {
        setLoadError("");
        await audio.play().catch((err: unknown) => {
          if (err instanceof DOMException && err.name === "AbortError") return;
          setLoadError(`Could not play narration: ${err}`);
        });
        return;
      }
      await loadNarrationForPlayback(true);
    } else {
      pendingAutoplaySrcRef.current = "";
      audio.pause();
    }
  };

  const seek = (value: string) => {
    const audio = audioRef.current;
    if (!audio) return;
    const nextTime = Number(value);
    audio.currentTime = nextTime;
    setCurrentTime(nextTime);
  };

  if (!narration) return null;

  const isStale = narration.source_text !== row.narrative;
  const canEditNarration = !readOnly && !mediaLocked;

  return (
    <div className={`w-full min-w-0 overflow-hidden rounded-md border px-2 py-1 ${
      isStale
        ? "border-[rgb(var(--color-warning))]/30 bg-[rgb(var(--color-warning))]/8"
        : "border-[rgb(var(--color-border))] bg-[rgb(var(--color-surface-alt))]/55"
    }`}>
      <audio
        ref={audioRef}
        src={src || undefined}
        preload="metadata"
        onLoadedMetadata={(event) => setDuration(event.currentTarget.duration || duration)}
        onTimeUpdate={(event) => setCurrentTime(event.currentTarget.currentTime)}
        onPlay={() => setPlaying(true)}
        onPause={() => setPlaying(false)}
        onEnded={() => setPlaying(false)}
      />
      <div className="grid min-w-0 grid-cols-[auto_minmax(64px,1fr)_auto] items-center gap-1.5 xl:grid-cols-[auto_auto_minmax(80px,1fr)_auto]">
        <button
          type="button"
          onClick={togglePlayback}
          disabled={loading}
          className="grid h-6 w-6 shrink-0 place-items-center rounded-md border border-[rgb(var(--color-border))] bg-[rgb(var(--color-surface))] text-[rgb(var(--color-accent))] transition-colors hover:border-[rgb(var(--color-accent))]/35 hover:bg-[rgb(var(--color-accent))]/8 disabled:opacity-50"
          aria-label={playing ? "Pause narration" : loading ? "Loading narration" : "Play narration"}
          title={playing ? "Pause narration" : loading ? "Loading narration" : "Play narration"}
        >
          {loading ? (
            <Loader2 className="h-3.5 w-3.5 animate-spin" />
          ) : playing ? (
            <Pause className="h-3 w-3" strokeWidth={2.4} />
          ) : (
            <Play className="h-3.5 w-3.5 fill-current" />
          )}
        </button>
        <span className="hidden items-center gap-1 whitespace-nowrap text-[10px] tabular-nums text-[rgb(var(--color-text-secondary))] xl:inline-flex">
          <Mic2 className="h-3 w-3 shrink-0 text-[rgb(var(--color-accent))]" />
          {formatPlaybackTime(currentTime)} / {formatPlaybackTime(duration)}
        </span>
        <input
          type="range"
          min={0}
          max={duration || 0}
          step={0.1}
          value={Math.min(currentTime, duration || 0)}
          onChange={(event) => seek(event.target.value)}
          disabled={!duration}
          className="block w-full min-w-0 accent-[rgb(var(--color-accent))] disabled:opacity-50"
          aria-label="Scrub narration"
        />
        <div className="flex items-center gap-1">
          {canEditNarration && onRemoveNarration && (
            <button
              type="button"
              onClick={() => onRemoveNarration(rowIndex)}
              disabled={saving || recording}
              className="grid h-6 w-6 shrink-0 place-items-center rounded-full bg-[rgb(var(--color-surface))] text-[rgb(var(--color-text-secondary))] transition-colors hover:bg-[rgb(var(--color-error))]/10 hover:text-[rgb(var(--color-error))] disabled:cursor-not-allowed disabled:opacity-40"
              aria-label="Remove narration"
              title="Remove narration"
            >
              <X className="h-3.5 w-3.5" />
            </button>
          )}
          {canEditNarration && onStartNarrationRecording && (
            <button
              type="button"
              onClick={() => recording ? onStopNarrationRecording?.() : onStartNarrationRecording(rowIndex)}
              disabled={saving || recordDisabled}
              className={`grid h-6 w-6 shrink-0 place-items-center rounded-full transition-colors disabled:cursor-not-allowed disabled:opacity-40 ${
                recording
                  ? "bg-[rgb(var(--color-error))]/10 text-[rgb(var(--color-error))]"
                  : "bg-[rgb(var(--color-surface))] text-[rgb(var(--color-text-secondary))] hover:bg-[rgb(var(--color-accent))]/10 hover:text-[rgb(var(--color-accent))]"
              }`}
              aria-label={recording ? "Stop narration recording" : "Rerecord narration"}
              title={recording ? "Stop narration recording" : "Rerecord narration"}
            >
              {saving ? (
                <Loader2 className="h-3.5 w-3.5 animate-spin" />
              ) : recording ? (
                <Square className="h-3.5 w-3.5 fill-current" />
              ) : (
                <Mic2 className="h-3.5 w-3.5" />
              )}
            </button>
          )}
        </div>
      </div>
      {loadError && (
        <div className="mt-1 text-[11px] text-[rgb(var(--color-error))]">
          {loadError}
        </div>
      )}
    </div>
  );
}

function NarrationPlaceholder({
  rowIndex,
  readOnly,
  mediaLocked,
  hasNarrationPlan,
  recording,
  saving,
  onStartNarrationRecording,
  onStopNarrationRecording,
  onGenerateNarration,
  onPickNarration,
  narrationRecordingRow,
}: {
  rowIndex: number;
  readOnly: boolean;
  mediaLocked: boolean;
  hasNarrationPlan?: boolean;
  recording: boolean;
  saving: boolean;
  onStartNarrationRecording?: (rowIndex: number) => void;
  onStopNarrationRecording?: () => void;
  onGenerateNarration?: (rowIndex: number) => void;
  onPickNarration?: (rowIndex: number) => void;
  narrationRecordingRow?: number | null;
}) {
  const disabled = readOnly || mediaLocked;
  const recordingBusy = narrationRecordingRow !== null && narrationRecordingRow !== undefined && !recording;
  const actions = readOnly ? [] : [
    onGenerateNarration ? { icon: Sparkles, label: "Generate narration", action: () => onGenerateNarration(rowIndex), disabled: disabled || saving || recordingBusy } : null,
    onStartNarrationRecording ? {
      icon: saving ? Loader2 : recording ? Square : Mic2,
      label: recording ? "Stop narration recording" : "Record narration",
      action: () => recording ? onStopNarrationRecording?.() : onStartNarrationRecording(rowIndex),
      disabled: disabled || saving || recordingBusy || (recording && !onStopNarrationRecording),
      spin: saving,
    } : null,
    onPickNarration ? { icon: FolderOpen, label: "Pick narration", action: () => onPickNarration(rowIndex), disabled: disabled || saving || recordingBusy } : null,
  ].filter(Boolean);

  return (
    <div className="flex min-w-0 items-center justify-between gap-2 overflow-hidden rounded-lg border border-dashed border-[rgb(var(--color-border))] bg-[rgb(var(--color-surface-alt))]/35 px-2 py-1.5">
      <span className="flex min-w-0 items-center gap-1.5 truncate text-[10px] font-medium uppercase tracking-[0.14em] text-[rgb(var(--color-text-secondary))]/75">
        <Mic2 className="h-3 w-3 shrink-0" />
        {hasNarrationPlan ? "Narration plan" : "No narration"}
      </span>
      <div className="flex shrink-0 items-center gap-1">
        {actions.map((item) => {
          if (!item) return null;
          const Icon = item.icon;
          return (
            <button
              key={item.label}
              type="button"
              onClick={item.action}
              disabled={item.disabled}
              className="grid h-7 w-7 place-items-center rounded-full bg-[rgb(var(--color-surface))] text-[rgb(var(--color-text-secondary))] transition-colors hover:bg-[rgb(var(--color-accent))]/10 hover:text-[rgb(var(--color-accent))] disabled:cursor-not-allowed disabled:opacity-40"
              aria-label={item.label}
              title={item.label}
            >
              <Icon className={`h-3.5 w-3.5 ${item.spin ? "animate-spin" : ""}`} />
            </button>
          );
        })}
      </div>
    </div>
  );
}

function RowMediaStack({
  row,
  rowIndex,
  projectRoot,
  readOnly,
  frameClassName,
  mediaClassName,
  imageClassName,
  narrationPaddingClassName = "",
  onOpenPreview,
  onCaptureScreenshot,
  onPasteImage,
  onPickImage,
  onBrowseImage,
  onGenerateVisual,
  onRemoveMedia,
  onStartNarrationRecording,
  onGenerateNarration,
  onPickNarration,
  onStopNarrationRecording,
  narrationRecordingRow,
  narrationSavingRows,
  onRemoveNarration,
}: {
  row: PlanningRow;
  rowIndex: number;
  projectRoot?: string | null;
  readOnly: boolean;
  frameClassName?: string;
  mediaClassName?: string;
  imageClassName?: string;
  narrationPaddingClassName?: string;
  onOpenPreview: (preview: MediaPreview) => void;
  onCaptureScreenshot?: (rowIndex: number) => void;
  onPasteImage?: (rowIndex: number) => void;
  onPickImage?: (rowIndex: number) => void;
  onBrowseImage?: (rowIndex: number) => void;
  onGenerateVisual?: (rowIndex: number) => void;
  onRemoveMedia?: (rowIndex: number) => void;
  onStartNarrationRecording?: (rowIndex: number) => void;
  onGenerateNarration?: (rowIndex: number) => void;
  onPickNarration?: (rowIndex: number) => void;
  onStopNarrationRecording?: () => void;
  narrationRecordingRow?: number | null;
  narrationSavingRows?: Set<number>;
  onRemoveNarration?: (rowIndex: number) => void;
}) {
  const mediaLocked = isCellLocked(row, "screenshot") || isCellLocked(row, "visual");

  return (
    <div className={`min-w-0 overflow-hidden ${frameClassName ? frameClassName : "space-y-2"}`}>
      <RowMedia
        row={row}
        rowIndex={rowIndex}
        projectRoot={projectRoot}
        readOnly={readOnly}
        className={mediaClassName}
        imageClassName={imageClassName}
        onOpenPreview={onOpenPreview}
        onCaptureScreenshot={onCaptureScreenshot}
        onPasteImage={onPasteImage}
        onPickImage={onPickImage}
        onBrowseImage={onBrowseImage}
        onGenerateVisual={onGenerateVisual}
        onRemoveMedia={onRemoveMedia}
      />
      <div className={`min-w-0 overflow-hidden ${narrationPaddingClassName}`}>
        {row.narration ? (
          <RowNarration
            row={row}
            rowIndex={rowIndex}
            readOnly={readOnly}
            mediaLocked={mediaLocked}
            recording={narrationRecordingRow === rowIndex}
            saving={narrationSavingRows?.has(rowIndex) ?? false}
            recordDisabled={narrationRecordingRow !== null && narrationRecordingRow !== undefined && narrationRecordingRow !== rowIndex}
            onStartNarrationRecording={onStartNarrationRecording}
            onStopNarrationRecording={onStopNarrationRecording}
            onRemoveNarration={onRemoveNarration}
          />
        ) : (
          <NarrationPlaceholder
            rowIndex={rowIndex}
            readOnly={readOnly}
            mediaLocked={mediaLocked}
            hasNarrationPlan={Boolean(row.narration_plan)}
            recording={narrationRecordingRow === rowIndex}
            saving={narrationSavingRows?.has(rowIndex) ?? false}
            onStartNarrationRecording={onStartNarrationRecording}
            onStopNarrationRecording={onStopNarrationRecording}
            onGenerateNarration={onGenerateNarration}
            onPickNarration={onPickNarration}
            narrationRecordingRow={narrationRecordingRow}
          />
        )}
      </div>
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

function VisualRowHeader({
  row,
  rowIndex,
  rows,
  readOnly,
  onChange,
  onTimeChange,
}: {
  row: PlanningRow;
  rowIndex: number;
  rows: PlanningRow[];
  readOnly: boolean;
  onChange: (rows: PlanningRow[]) => void;
  onTimeChange: (value: string) => void;
}) {
  return (
    <div className="flex min-w-0 items-center gap-3">
      <div className="flex min-w-0 flex-1 items-center gap-2">
        <span className="grid h-7 w-7 shrink-0 place-items-center rounded-full border border-[rgb(var(--color-accent))]/30 bg-[rgb(var(--color-accent))]/10 text-xs font-semibold tabular-nums text-[rgb(var(--color-accent))]">
          <span className="sr-only">Row </span>
          {rowIndex + 1}
        </span>
        <div className="flex min-w-0 flex-1 items-center gap-1.5">
          <span className="text-[10px] font-semibold uppercase tracking-[0.14em] text-[rgb(var(--color-text-secondary))]">Time</span>
          <div className="min-w-[4.5rem] max-w-[8rem] flex-1">
            <EditableText
              value={row.time}
              placeholder="~30s"
              readOnly={readOnly || isCellLocked(row, "time")}
              multiline={false}
              className="truncate whitespace-nowrap text-xs font-medium tabular-nums text-[rgb(var(--color-text))]"
              onChange={onTimeChange}
            />
          </div>
        </div>
      </div>
      <RowEditActions rowIndex={rowIndex} rows={rows} readOnly={readOnly} onChange={onChange} />
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
  const textareaRef = useRef<HTMLTextAreaElement>(null);

  const resizeTextarea = useCallback(() => {
    const textarea = textareaRef.current;
    if (!textarea) return;
    textarea.style.height = "auto";
    textarea.style.height = `${textarea.scrollHeight}px`;
  }, []);

  useLayoutEffect(() => {
    if (readOnly || !multiline || !textareaRef.current) return;
    resizeTextarea();
  }, [multiline, readOnly, resizeTextarea, value]);

  useEffect(() => {
    if (readOnly || !multiline || !textareaRef.current) return;
    if (typeof ResizeObserver === "undefined") {
      window.addEventListener("resize", resizeTextarea);
      return () => window.removeEventListener("resize", resizeTextarea);
    }
    const observer = new ResizeObserver(resizeTextarea);
    observer.observe(textareaRef.current);
    return () => observer.disconnect();
  }, [multiline, readOnly, resizeTextarea]);

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
      ref={textareaRef}
      value={value}
      onChange={(event) => onChange(event.target.value)}
      placeholder={placeholder}
      rows={1}
      className={`${className} w-full resize-none overflow-hidden rounded-lg border border-transparent bg-transparent px-2 py-1 outline-none transition-colors placeholder:text-[rgb(var(--color-text-secondary))]/45 hover:border-[rgb(var(--color-border))] focus:border-[rgb(var(--color-accent))]/45 focus:bg-[rgb(var(--color-surface))] focus:ring-1 focus:ring-[rgb(var(--color-accent))]/25`}
    />
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
  onStopNarrationRecording,
  narrationRecordingRow,
  narrationSavingRows,
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
            <RowMediaStack
              row={row}
              rowIndex={index}
              projectRoot={projectRoot}
              readOnly={readOnly}
              frameClassName="rounded-xl border border-[rgb(var(--color-border-subtle))] bg-[rgb(var(--color-surface-alt))]"
              mediaClassName="!h-auto aspect-video !min-h-0 rounded-t-xl rounded-b-none border-0"
              imageClassName="h-full w-full object-contain"
              narrationPaddingClassName="border-t border-[rgb(var(--color-border-subtle))] bg-[rgb(var(--color-surface))]/75 px-2 py-1.5"
              onOpenPreview={setPreview}
              onCaptureScreenshot={onCaptureScreenshot}
              onPasteImage={onPasteImage}
              onPickImage={onPickImage}
              onBrowseImage={onBrowseImage}
              onGenerateVisual={onGenerateVisual}
              onRemoveMedia={onRemoveMedia}
              onStartNarrationRecording={onStartNarrationRecording}
              onGenerateNarration={onGenerateNarration}
              onPickNarration={onPickNarration}
              onStopNarrationRecording={onStopNarrationRecording}
              narrationRecordingRow={narrationRecordingRow}
              narrationSavingRows={narrationSavingRows}
              onRemoveNarration={onRemoveNarration}
            />
            <div className="flex min-w-0 flex-col gap-3">
              <VisualRowHeader
                row={row}
                rowIndex={index}
                rows={rows}
                readOnly={readOnly}
                onChange={onChange}
                onTimeChange={(value) => updateField(index, "time", value)}
              />
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
  onStopNarrationRecording,
  narrationRecordingRow,
  narrationSavingRows,
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
            className="grid overflow-hidden rounded-xl border border-[rgb(var(--color-border-subtle))] bg-[rgb(var(--color-surface))]/45 shadow-sm md:grid-cols-[minmax(320px,1.15fr)_minmax(0,0.9fr)]"
          >
            <RowMediaStack
              row={row}
              rowIndex={index}
              projectRoot={projectRoot}
              readOnly={readOnly}
              frameClassName="rounded-xl border border-[rgb(var(--color-border-subtle))] bg-[rgb(var(--color-surface-alt))]"
              mediaClassName="!h-auto aspect-video !min-h-0 rounded-t-xl rounded-b-none border-0 md:!min-h-[280px]"
              imageClassName="h-full w-full object-contain"
              narrationPaddingClassName="border-t border-[rgb(var(--color-border-subtle))] bg-[rgb(var(--color-surface))]/75 px-2 py-1.5"
              onOpenPreview={setPreview}
              onCaptureScreenshot={onCaptureScreenshot}
              onPasteImage={onPasteImage}
              onPickImage={onPickImage}
              onBrowseImage={onBrowseImage}
              onGenerateVisual={onGenerateVisual}
              onRemoveMedia={onRemoveMedia}
              onStartNarrationRecording={onStartNarrationRecording}
              onGenerateNarration={onGenerateNarration}
              onPickNarration={onPickNarration}
              onStopNarrationRecording={onStopNarrationRecording}
              narrationRecordingRow={narrationRecordingRow}
              narrationSavingRows={narrationSavingRows}
              onRemoveNarration={onRemoveNarration}
            />
            <div className="space-y-3 p-4">
              <VisualRowHeader
                row={row}
                rowIndex={index}
                rows={rows}
                readOnly={readOnly}
                onChange={onChange}
                onTimeChange={(value) => updateField(index, "time", value)}
              />
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
