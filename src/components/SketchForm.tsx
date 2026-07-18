import { useCallback, useEffect, useRef, useState } from "react";
import { Channel, convertFileSrc, invoke, listen } from "../services/tauri";
import { open, save } from "@tauri-apps/plugin-dialog";
import { openPath } from "@tauri-apps/plugin-opener";
import { ChevronLeft, Sparkles, Monitor, Plus, X, Folder, Check, Film, Image as ImageIcon, Mic2 } from "lucide-react";
import { shouldSuppressEditorFlush, useAppStore } from "../stores/appStore";
import { useToastStore } from "../stores/toastStore";
import { useSettings } from "../hooks/useSettings";
import { useBackgroundAgentAction } from "../hooks/useBackgroundAgentAction";
import { ScriptTable } from "./ScriptTable";
import { ProjectImage } from "./ProjectImage";
import { ScreenCaptureOverlay } from "./ScreenCaptureOverlay";
import { SketchPreview } from "./SketchPreview";
import { DocumentHeader } from "./DocumentHeader";
import { Dialog } from "./Dialog";
import { FieldAiButton } from "./FieldAiButton";
import { LockedDocumentBanner } from "./LockedDocumentBanner";
import { NarrationRecordingDialog, type NarrationRecordingTake } from "./NarrationRecordingDialog";
import { DurationBadge, MetadataEditor } from "./MetadataEditor";
import { InlineDescriptionEditor } from "./InlineDescriptionEditor";
import type { PresentationMode } from "./presentation/types";
import VisualCell from "./VisualCell";
import { exportSketchToWord, type WordOrientation } from "../utils/exportToWord";
import { exportSketchToPowerPoint, type PowerPointExportContent } from "../utils/exportToPowerPoint";
import type { MotionPlan, MotionPlanEasing, MotionPlanKind, PlanningRow, Sketch } from "../types/sketch";
import { diffRow, type RowDiff } from "../utils/textDiff";
import { DocumentToolbar, documentToolbarIcons, type DocumentToolbarAction } from "./DocumentToolbar";
import { SketchIcon } from "./Icons";
import type { RecordingTake } from "../types/recording";
import { parseDurationSeconds, summarizeSketchDuration, type DurationDisplayMode } from "../utils/documentMetadata";
import { preferredNarrationMimeType } from "../utils/narrationAudio";
import { activeProvider, activeProviderInput, buildProviderConfig, providerById } from "../utils/providerConfig";
import { getProviderSecret, setProviderSecret } from "../hooks/useSecretStore";
import { buildPlainSsml, inferSpeechEndpoint, SPEECH_TOKEN_SCOPE, synthesizeSpeechAudio } from "../services/narrationSpeech";

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
const REQUESTED_SETTINGS_TAB_KEY = "cutready:requested-settings-tab";

type ProjectAsset = { path: string; size: number; assetType: string };
type ProjectAudioAsset = { path: string; size: number; mimeType: string; modifiedAt: number };
type SketchVideoExport = { path: string; duration_seconds: number; row_count: number };
type SketchVideoExportProgress = { phase: string; current: number; total: number; message: string };
type NarrationGenerationProgress = { phase: string; current: number; total: number; message: string };
type SketchVideoExportSettings = {
  includeTitleCard: boolean;
  titleCardDurationSeconds: number;
  titleToFirstRowHoldSeconds: number;
  rowTransitionHoldSeconds: number;
  finalHoldSeconds: number;
  rowTransitionDipSeconds: number;
  narrationTailHoldSeconds: number;
  motionMaxScale: number;
  videoWidth: number;
  videoHeight: number;
  videoFps: number;
  videoEncoder: string;
  videoPixelFormat: string;
  videoCrf: string;
  backgroundMusicPath?: string | null;
  backgroundMusicVolumeDb: number;
  backgroundMusicDuckNarration: boolean;
  backgroundMusicFadeSeconds: number;
};
type VideoExportIssue = { rowNumber: number; missing: string[] };
type AgentChatResult = { response: string };
type NarrationSsmlRow = { row_number: number; ssml: string; source_text?: string };
type NarrationSsmlPlan = { rows: NarrationSsmlRow[] };
type MotionDirectorRow = { row_number: number; motion_plan: MotionPlan };
type MotionDirectorPlan = { rows: MotionDirectorRow[] };

function projectAssetSrc(projectRoot: string | undefined | null, relativePath: string | null | undefined): string {
  if (!projectRoot || !relativePath) return "";
  const separator = projectRoot.includes("\\") ? "\\" : "/";
  const root = projectRoot.replace(/[\\/]+$/, "");
  const relative = relativePath.replace(/[\\/]+/g, separator);
  return convertFileSrc(`${root}${separator}${relative}`);
}

function extractJsonObject(text: string): string {
  const trimmed = text.trim();
  const fenced = trimmed.match(/^```(?:json)?\s*([\s\S]*?)\s*```$/i);
  if (fenced) return fenced[1].trim();

  const start = trimmed.indexOf("{");
  const end = trimmed.lastIndexOf("}");
  if (start >= 0 && end > start) return trimmed.slice(start, end + 1);
  return trimmed;
}

function parseNarrationSsmlPlan(response: string): NarrationSsmlPlan {
  const parsed = JSON.parse(extractJsonObject(response)) as Partial<NarrationSsmlPlan>;
  if (!Array.isArray(parsed.rows)) throw new Error("Narration agent did not return a rows array.");
  const rows = parsed.rows.map((row) => ({
    row_number: Number(row.row_number),
    ssml: String(row.ssml ?? ""),
    source_text: typeof row.source_text === "string" ? row.source_text : undefined,
  }));
  if (rows.some((row) => !Number.isInteger(row.row_number) || row.row_number < 1 || !row.ssml.trim())) {
    throw new Error("Narration agent returned an invalid row entry.");
  }
  return { rows };
}

function clampMotionNumber(value: unknown, fallback: number, min: number, max: number): number {
  const numberValue = Number(value);
  if (!Number.isFinite(numberValue)) return fallback;
  return Math.max(min, Math.min(max, numberValue));
}

function parseMotionPlan(response: string, maxScale: number): MotionDirectorPlan {
  const parsed = JSON.parse(extractJsonObject(response)) as Partial<MotionDirectorPlan>;
  if (!Array.isArray(parsed.rows)) throw new Error("Motion Director did not return a rows array.");
  const allowedKinds = new Set<MotionPlanKind>(["subtle_push", "wide_hold_then_push", "push_then_drift"]);
  const rows = parsed.rows.map((row) => {
    const rowNumber = Number(row.row_number);
    const rawPlan = row.motion_plan as Partial<MotionPlan> | undefined;
    if (!Number.isInteger(rowNumber) || rowNumber < 1 || !rawPlan || !allowedKinds.has(rawPlan.kind as MotionPlanKind)) {
      throw new Error("Motion Director returned an invalid row entry.");
    }
    const kind = rawPlan.kind as MotionPlanKind;
    if (!Array.isArray(rawPlan.keyframes) || rawPlan.keyframes.length < 2) {
      throw new Error(`Motion Director returned too few keyframes for row ${rowNumber}.`);
    }
    const keyframes = rawPlan.keyframes
      .slice(0, 4)
      .map((keyframe) => {
        return {
          time_ms: Math.round(clampMotionNumber(keyframe.time_ms, 0, 0, 120_000)),
          scale: clampMotionNumber(keyframe.scale, 1, 1, maxScale),
          x: clampMotionNumber(keyframe.x, 0.5, 0, 1),
          y: clampMotionNumber(keyframe.y, 0.5, 0, 1),
          easing: "linear" as MotionPlanEasing,
        };
      })
      .sort((a, b) => a.time_ms - b.time_ms);
    keyframes[0] = { ...keyframes[0], time_ms: 0 };
    return {
      row_number: rowNumber,
      motion_plan: {
        kind,
        keyframes,
        rationale: typeof rawPlan.rationale === "string" ? rawPlan.rationale.slice(0, 240) : null,
      },
    };
  });
  return { rows };
}

function validateGeneratedSsml(ssml: string): string {
  const trimmed = ssml.trim();
  if (!/^<speak[\s>]/i.test(trimmed)) throw new Error("Narration agent returned SSML without a speak root.");
  if (/<\s*(audio|lexicon|bookmark|mstts:backgroundaudio)\b/i.test(trimmed)) {
    throw new Error("Narration agent returned unsupported SSML elements.");
  }

  const document = new DOMParser().parseFromString(trimmed, "application/xml");
  if (document.querySelector("parsererror")) throw new Error("Narration agent returned malformed SSML.");
  if (document.documentElement.localName !== "speak") throw new Error("Narration agent returned SSML without a speak root.");
  return trimmed;
}

async function decodeAudioDurationMs(data: ArrayBuffer): Promise<number | null> {
  try {
    const context = new AudioContext();
    try {
      const buffer = await context.decodeAudioData(data.slice(0));
      return Math.round(buffer.duration * 1000);
    } finally {
      void context.close();
    }
  } catch {
    return null;
  }
}

async function sha256Hex(value: string): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(value));
  return Array.from(new Uint8Array(digest))
    .map((byte) => byte.toString(16).padStart(2, "0"))
    .join("");
}

function alignToDevicePixel(value: number, dpr: number): number {
  return Math.round(value * dpr) / dpr;
}

function prepareWaveformCanvas(canvas: HTMLCanvasElement) {
  const context = canvas.getContext("2d");
  if (!context) return null;

  const rect = canvas.getBoundingClientRect();
  const width = Math.max(1, rect.width);
  const height = Math.max(1, rect.height);
  const dpr = Math.max(1, window.devicePixelRatio || 1);
  const backingWidth = Math.round(width * dpr);
  const backingHeight = Math.round(height * dpr);

  if (canvas.width !== backingWidth) canvas.width = backingWidth;
  if (canvas.height !== backingHeight) canvas.height = backingHeight;
  context.setTransform(dpr, 0, 0, dpr, 0, 0);

  return { context, width, height, dpr };
}

function drawEmptyWaveform(canvas: HTMLCanvasElement) {
  const metrics = prepareWaveformCanvas(canvas);
  if (!metrics) return;

  const { context, width, height, dpr } = metrics;
  const styles = getComputedStyle(document.documentElement);
  const border = `rgb(${styles.getPropertyValue("--color-border").trim()})`;
  const surface = `rgb(${styles.getPropertyValue("--color-surface-alt").trim()})`;
  const midline = alignToDevicePixel(height / 2, dpr);

  context.clearRect(0, 0, width, height);
  context.fillStyle = surface;
  context.fillRect(0, 0, width, height);
  context.strokeStyle = border;
  context.lineWidth = 1 / dpr;
  context.beginPath();
  context.moveTo(0, midline);
  context.lineTo(width, midline);
  context.stroke();
}

function drawDecodedWaveform(canvas: HTMLCanvasElement, audioBuffer: AudioBuffer) {
  const metrics = prepareWaveformCanvas(canvas);
  if (!metrics) return;

  const { context, width, height, dpr } = metrics;
  const styles = getComputedStyle(document.documentElement);
  const accent = `rgb(${styles.getPropertyValue("--color-accent").trim()})`;
  const border = `rgb(${styles.getPropertyValue("--color-border").trim()})`;
  const surface = `rgb(${styles.getPropertyValue("--color-surface-alt").trim()})`;
  const samples = audioBuffer.getChannelData(0);
  const pixels = Math.max(1, Math.floor(width));
  const samplesPerPixel = Math.max(1, Math.floor(samples.length / pixels));
  const midline = alignToDevicePixel(height / 2, dpr);

  context.clearRect(0, 0, width, height);
  context.fillStyle = surface;
  context.fillRect(0, 0, width, height);
  context.strokeStyle = border;
  context.lineWidth = 1 / dpr;
  context.beginPath();
  context.moveTo(0, midline);
  context.lineTo(width, midline);
  context.stroke();

  context.strokeStyle = accent;
  context.lineWidth = 1.5;
  context.beginPath();
  for (let x = 0; x < pixels; x += 1) {
    const start = x * samplesPerPixel;
    let min = 1;
    let max = -1;
    for (let i = 0; i < samplesPerPixel && start + i < samples.length; i += 1) {
      const sample = samples[start + i];
      min = Math.min(min, sample);
      max = Math.max(max, sample);
    }
    context.moveTo(x, ((1 - max) * height) / 2);
    context.lineTo(x, ((1 - min) * height) / 2);
  }
  context.stroke();
}

function getVideoExportIssues(rows: PlanningRow[]): VideoExportIssue[] {
  if (rows.length === 0) {
    return [{ rowNumber: 0, missing: ["at least one row"] }];
  }

  return rows.flatMap((row, index) => {
    const missing: string[] = [];
    if (!row.screenshot?.trim()) missing.push("screenshot");
    if (!row.narration?.path?.trim()) missing.push("narration");
    return missing.length > 0 ? [{ rowNumber: index + 1, missing }] : [];
  });
}

function slugifyExportName(value: string): string {
  const slug = value
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
  return slug || "sketch";
}

function formatExportTimestamp(date = new Date()): string {
  const pad = (value: number) => String(value).padStart(2, "0");
  return [
    date.getFullYear(),
    pad(date.getMonth() + 1),
    pad(date.getDate()),
    "-",
    pad(date.getHours()),
    pad(date.getMinutes()),
    pad(date.getSeconds()),
  ].join("");
}

function defaultVideoExportName(title: string): string {
  const fileName = `${slugifyExportName(title)}-${formatExportTimestamp()}.mp4`;
  return fileName;
}

function ensureMp4Extension(path: string): string {
  return /\.mp4$/i.test(path) ? path : `${path}.mp4`;
}

function VideoExportReadinessDialog({
  issues,
  onClose,
}: {
  issues: VideoExportIssue[] | null;
  onClose: () => void;
}) {
  if (!issues) return null;

  const hasRows = !(issues.length === 1 && issues[0].rowNumber === 0);

  return (
    <Dialog
      isOpen={issues !== null}
      onClose={onClose}
      align="top"
      topOffset="18vh"
      width="w-full max-w-lg mx-4"
      labelledBy="video-export-readiness-title"
    >
      <div className="cr-modal-surface overflow-hidden rounded-2xl">
        <div className="flex items-start gap-3 border-b border-[rgb(var(--color-border))] px-5 py-4">
          <div className="mt-0.5 grid h-9 w-9 shrink-0 place-items-center rounded-xl bg-[rgb(var(--color-accent))]/10 text-[rgb(var(--color-accent))]">
            <Film className="h-4 w-4" />
          </div>
          <div className="min-w-0 flex-1">
            <h2 id="video-export-readiness-title" className="text-sm font-semibold text-[rgb(var(--color-text))]">
              Video export needs a complete sketch
            </h2>
            <p className="mt-1 text-xs leading-5 text-[rgb(var(--color-text-secondary))]">
              CutReady can render a sketch video when every row has a screenshot and narration. Add the missing pieces below, then export again.
            </p>
          </div>
          <button
            type="button"
            onClick={onClose}
            className="rounded-lg p-1.5 text-[rgb(var(--color-text-secondary))] transition-colors hover:bg-[rgb(var(--color-surface-alt))] hover:text-[rgb(var(--color-text))]"
            aria-label="Close video export requirements"
          >
            <X className="h-4 w-4" />
          </button>
        </div>

        <div className="max-h-[45vh] overflow-y-auto px-5 py-4">
          {!hasRows ? (
            <div className="rounded-xl border border-[rgb(var(--color-border))] bg-[rgb(var(--color-surface-alt))]/60 px-3 py-2 text-xs text-[rgb(var(--color-text-secondary))]">
              Add at least one planning row with a screenshot and narration.
            </div>
          ) : (
            <div className="space-y-2">
              {issues.map((issue) => (
                <div
                  key={issue.rowNumber}
                  className="flex items-center justify-between gap-3 rounded-xl border border-[rgb(var(--color-border))] bg-[rgb(var(--color-surface-alt))]/60 px-3 py-2"
                >
                  <span className="text-xs font-medium text-[rgb(var(--color-text))]">Row {issue.rowNumber}</span>
                  <span className="text-xs text-[rgb(var(--color-text-secondary))]">
                    Missing {issue.missing.join(" and ")}
                  </span>
                </div>
              ))}
            </div>
          )}
        </div>

        <div className="flex justify-end border-t border-[rgb(var(--color-border))] px-5 py-4">
          <button
            type="button"
            onClick={onClose}
            className="rounded-lg bg-[rgb(var(--color-accent))] px-3 py-2 text-xs font-semibold text-[rgb(var(--color-accent-fg))] transition-colors hover:bg-[rgb(var(--color-accent-hover))]"
          >
            Got it
          </button>
        </div>
      </div>
    </Dialog>
  );
}

function VideoExportProgressDialog({
  progress,
}: {
  progress: SketchVideoExportProgress | null;
}) {
  if (!progress) return null;

  const total = Math.max(1, progress.total);
  const current = Math.min(Math.max(0, progress.current), total);
  const percent = Math.round((current / total) * 100);
  const isFinishing = progress.phase === "complete";

  return (
    <Dialog
      isOpen={progress !== null}
      onClose={() => {}}
      align="top"
      topOffset="18vh"
      width="w-full max-w-md mx-4"
      labelledBy="video-export-progress-title"
    >
      <div className="cr-modal-surface overflow-hidden rounded-2xl">
        <div className="px-5 py-5">
          <div className="flex items-start gap-3">
            <div className="relative grid h-10 w-10 shrink-0 place-items-center rounded-xl bg-[rgb(var(--color-accent))]/10 text-[rgb(var(--color-accent))]">
              <Film className="h-4 w-4" />
              <span className="absolute -right-0.5 -top-0.5 h-2.5 w-2.5 animate-pulse rounded-full bg-[rgb(var(--color-accent))]" />
            </div>
            <div className="min-w-0 flex-1">
              <h2 id="video-export-progress-title" className="text-sm font-semibold text-[rgb(var(--color-text))]">
                Exporting video
              </h2>
              <p className="mt-1 text-xs leading-5 text-[rgb(var(--color-text-secondary))]">
                {progress.message}
              </p>
            </div>
          </div>

          <div className="mt-5">
            <div className="mb-2 flex items-center justify-between text-[11px] font-medium uppercase tracking-[0.14em] text-[rgb(var(--color-text-secondary))]">
              <span>{isFinishing ? "Wrapping up" : `Step ${current} of ${total}`}</span>
              <span>{percent}%</span>
            </div>
            <div className="h-2 overflow-hidden rounded-full bg-[rgb(var(--color-surface-alt))]">
              <div
                className="h-full rounded-full bg-[rgb(var(--color-accent))] transition-all duration-300 ease-out"
                style={{ width: `${percent}%` }}
              />
            </div>
          </div>

          <div className="mt-4 rounded-xl border border-[rgb(var(--color-border))] bg-[rgb(var(--color-surface-alt))]/60 px-3 py-2 text-xs text-[rgb(var(--color-text-secondary))]">
            Keeping screenshots lossless in RGB, preserving generated narration from first sample to last sample, easing into the first row, holding adjacent rows for transitions, and ending on a 3-second hold.
          </div>
        </div>
      </div>
    </Dialog>
  );
}

function NarrationGenerationProgressDialog({
  progress,
}: {
  progress: NarrationGenerationProgress | null;
}) {
  if (!progress) return null;

  const total = Math.max(1, progress.total);
  const current = Math.min(Math.max(0, progress.current), total);
  const percent = Math.round((current / total) * 100);
  const isFinishing = progress.phase === "complete";

  return (
    <Dialog
      isOpen={progress !== null}
      onClose={() => {}}
      align="top"
      topOffset="18vh"
      width="w-full max-w-md mx-4"
      labelledBy="narration-generation-progress-title"
    >
      <div className="cr-modal-surface overflow-hidden rounded-2xl">
        <div className="px-5 py-5">
          <div className="flex items-start gap-3">
            <div className="relative grid h-10 w-10 shrink-0 place-items-center rounded-xl bg-[rgb(var(--color-accent))]/10 text-[rgb(var(--color-accent))]">
              <Mic2 className="h-4 w-4" />
              <span className="absolute -right-0.5 -top-0.5 h-2.5 w-2.5 animate-pulse rounded-full bg-[rgb(var(--color-accent))]" />
            </div>
            <div className="min-w-0 flex-1">
              <h2 id="narration-generation-progress-title" className="text-sm font-semibold text-[rgb(var(--color-text))]">
                Generating narration
              </h2>
              <p className="mt-1 text-xs leading-5 text-[rgb(var(--color-text-secondary))]">
                {progress.message}
              </p>
            </div>
          </div>

          <div className="mt-5">
            <div className="mb-2 flex items-center justify-between text-[11px] font-medium uppercase tracking-[0.14em] text-[rgb(var(--color-text-secondary))]">
              <span>{isFinishing ? "Wrapping up" : `Step ${current} of ${total}`}</span>
              <span>{percent}%</span>
            </div>
            <div className="h-2 overflow-hidden rounded-full bg-[rgb(var(--color-surface-alt))]">
              <div
                className="h-full rounded-full bg-[rgb(var(--color-accent))] transition-all duration-300 ease-out"
                style={{ width: `${percent}%` }}
              />
            </div>
          </div>

          <div className="mt-4 rounded-xl border border-[rgb(var(--color-border))] bg-[rgb(var(--color-surface-alt))]/60 px-3 py-2 text-xs text-[rgb(var(--color-text-secondary))]">
            The Narration Director is writing grounded SSML, shaping pacing with Azure Speech markup, synthesizing MAI-Voice-2 audio, and attaching each cut to its row.
          </div>
        </div>
      </div>
    </Dialog>
  );
}

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
      className="cr-modal-backdrop fixed inset-0 z-modal flex items-center justify-center p-4"
      onClick={onCancel}
    >
      <div
        role="dialog"
        aria-modal="true"
        aria-labelledby="sketch-row-asset-picker-title"
        className="cr-modal-surface rounded-2xl w-full max-h-[calc(100vh-32px)] flex flex-col overflow-hidden"
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

interface SketchRowNarrationPickerProps {
  assets: ProjectAudioAsset[];
  projectRoot: string | null;
  selectedPath: string | null;
  onSelectedPathChange: (path: string) => void;
  onInsert: (asset: ProjectAudioAsset) => void;
  onCancel: () => void;
}

function SketchRowNarrationPicker({
  assets,
  projectRoot,
  selectedPath,
  onSelectedPathChange,
  onInsert,
  onCancel,
}: SketchRowNarrationPickerProps) {
  const selectedAsset = assets.find((asset) => asset.path === selectedPath) ?? assets[0] ?? null;
  const selectedSrc = projectAssetSrc(projectRoot, selectedAsset?.path);
  const audioRef = useRef<HTMLAudioElement>(null);
  const waveformFrameRef = useRef<HTMLDivElement>(null);
  const waveformCanvasRef = useRef<HTMLCanvasElement>(null);
  const [playbackCurrentTime, setPlaybackCurrentTime] = useState(0);
  const [playbackDuration, setPlaybackDuration] = useState(0);
  const [waveformWidth, setWaveformWidth] = useState(0);
  const [waveformLayoutVersion, setWaveformLayoutVersion] = useState(0);
  const playheadLeft = playbackDuration > 0 && waveformWidth > 0
    ? alignToDevicePixel(
        Math.min(waveformWidth, Math.max(0, (playbackCurrentTime / playbackDuration) * waveformWidth)),
        Math.max(1, window.devicePixelRatio || 1),
      )
    : 0;

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

  useEffect(() => {
    setPlaybackCurrentTime(0);
    setPlaybackDuration(0);
  }, [selectedSrc]);

  useEffect(() => {
    const canvas = waveformCanvasRef.current;
    if (!canvas) return;
    if (!selectedSrc) {
      drawEmptyWaveform(canvas);
      return;
    }

    let cancelled = false;
    const context = new AudioContext();
    fetch(selectedSrc)
      .then((response) => response.arrayBuffer())
      .then((data) => context.decodeAudioData(data))
      .then((buffer) => {
        if (!cancelled) drawDecodedWaveform(canvas, buffer);
      })
      .catch((error: unknown) => {
        console.warn("[SketchRowNarrationPicker] failed to render waveform", { error });
        if (!cancelled) drawEmptyWaveform(canvas);
      })
      .finally(() => {
        void context.close();
      });

    return () => {
      cancelled = true;
      void context.close();
    };
  }, [selectedSrc, waveformLayoutVersion]);

  useEffect(() => {
    const frame = waveformFrameRef.current;
    if (!frame) return;

    const updateWaveformMetrics = () => {
      setWaveformWidth(frame.getBoundingClientRect().width);
      setWaveformLayoutVersion((version) => version + 1);
    };

    updateWaveformMetrics();
    const observer = new ResizeObserver(updateWaveformMetrics);
    observer.observe(frame);
    return () => observer.disconnect();
  }, []);

  return (
    <div
      className="cr-modal-backdrop fixed inset-0 z-modal flex items-center justify-center p-4"
      onClick={onCancel}
    >
      <div
        role="dialog"
        aria-modal="true"
        aria-labelledby="sketch-row-narration-picker-title"
        className="cr-modal-surface flex max-h-[calc(100vh-32px)] w-full max-w-3xl flex-col overflow-hidden rounded-xl"
        onClick={(event) => event.stopPropagation()}
      >
        <div className="flex items-start justify-between gap-4 border-b border-[rgb(var(--color-border))] px-5 py-4">
          <div>
            <h2 id="sketch-row-narration-picker-title" className="text-sm font-semibold text-[rgb(var(--color-text))]">
              Pick narration audio
            </h2>
            <p className="mt-1 text-xs text-[rgb(var(--color-text-secondary))]">
              Choose an existing workspace audio cut to attach to this row.
            </p>
          </div>
          <button
            type="button"
            onClick={onCancel}
            className="rounded-lg p-1.5 text-[rgb(var(--color-text-secondary))] transition-colors hover:bg-[rgb(var(--color-surface-alt))] hover:text-[rgb(var(--color-text))]"
            aria-label="Cancel"
          >
            <X className="h-4 w-4" />
          </button>
        </div>

        <div className="grid min-h-0 flex-1 grid-cols-1 lg:grid-cols-[minmax(0,1fr)_300px]">
          <section className="min-h-0 border-b border-[rgb(var(--color-border))] bg-[rgb(var(--color-surface-alt))]/45 p-4 lg:border-b-0 lg:border-r">
            {selectedAsset ? (
              <div className="flex h-full min-h-[260px] flex-col justify-center gap-4 rounded-xl border border-[rgb(var(--color-border))] bg-[rgb(var(--color-surface))] p-5">
                <div className="min-w-0">
                  <div className="text-xs font-medium text-[rgb(var(--color-text-secondary))]">Previewing selected cut</div>
                  <div className="mt-1 truncate text-sm font-medium text-[rgb(var(--color-text))]">{selectedAsset.path}</div>
                </div>
                <div
                  ref={waveformFrameRef}
                  className="relative h-28 overflow-hidden rounded-lg border border-[rgb(var(--color-border))] bg-[rgb(var(--color-surface-alt))]/55"
                >
                  <canvas
                    ref={waveformCanvasRef}
                    className="block h-full w-full"
                    aria-label="Selected narration waveform"
                  />
                  {playbackDuration > 0 && (
                    <span
                      className="pointer-events-none absolute bottom-0 top-0 z-10 w-px bg-[rgb(var(--color-accent))] shadow-[0_0_0_1px_rgb(var(--color-accent)/0.22),0_0_14px_rgb(var(--color-accent)/0.35)]"
                      style={{ left: `${playheadLeft}px` }}
                      aria-hidden="true"
                    />
                  )}
                </div>
                <audio
                  ref={audioRef}
                  controls
                  src={selectedSrc}
                  className="w-full"
                  onLoadedMetadata={(event) => {
                    const duration = event.currentTarget.duration;
                    setPlaybackDuration(Number.isFinite(duration) ? duration : 0);
                    setPlaybackCurrentTime(event.currentTarget.currentTime || 0);
                  }}
                  onTimeUpdate={(event) => setPlaybackCurrentTime(event.currentTarget.currentTime || 0)}
                  onSeeked={(event) => setPlaybackCurrentTime(event.currentTarget.currentTime || 0)}
                  onEnded={(event) => setPlaybackCurrentTime(event.currentTarget.duration || 0)}
                />
              </div>
            ) : (
              <div className="flex h-full min-h-[260px] items-center justify-center rounded-xl border border-dashed border-[rgb(var(--color-border))] bg-[rgb(var(--color-surface))] p-8 text-center">
                <div>
                  <Mic2 className="mx-auto h-8 w-8 text-[rgb(var(--color-text-secondary))]" />
                  <div className="mt-3 text-sm font-medium text-[rgb(var(--color-text))]">No narration cuts in workspace</div>
                  <div className="mt-1 text-xs text-[rgb(var(--color-text-secondary))]">
                    Record a narration take first, then reuse it from here.
                  </div>
                </div>
              </div>
            )}
          </section>

          <aside className="flex min-h-0 flex-col">
            <div className="border-b border-[rgb(var(--color-border))] px-4 py-3">
              <div className="text-xs font-medium text-[rgb(var(--color-text))]">Workspace cuts</div>
              <div className="text-[11px] text-[rgb(var(--color-text-secondary))]">{assets.length} available</div>
            </div>
            <div className="min-h-0 flex-1 overflow-y-auto p-3">
              {assets.length > 0 ? (
                <div className="space-y-2">
                  {assets.map((asset) => {
                    const isSelected = asset.path === selectedAsset?.path;
                    const assetName = asset.path.split("/").pop() ?? asset.path;
                    return (
                      <button
                        type="button"
                        key={asset.path}
                        onClick={() => onSelectedPathChange(asset.path)}
                        onDoubleClick={() => onInsert(asset)}
                        className={`flex w-full items-center gap-2 rounded-xl border px-3 py-2 text-left transition-colors ${
                          isSelected
                            ? "border-[rgb(var(--color-accent))] bg-[rgb(var(--color-accent))]/10"
                            : "border-[rgb(var(--color-border))] hover:border-[rgb(var(--color-accent))]/70 hover:bg-[rgb(var(--color-surface-alt))]"
                        }`}
                      >
                        <Mic2 className="h-3.5 w-3.5 shrink-0 text-[rgb(var(--color-accent))]" />
                        <span className="min-w-0 flex-1 truncate text-[11px] text-[rgb(var(--color-text))]">{assetName}</span>
                      </button>
                    );
                  })}
                </div>
              ) : (
                <div className="rounded-xl border border-dashed border-[rgb(var(--color-border))] p-4 text-center text-xs text-[rgb(var(--color-text-secondary))]">
                  No workspace cuts yet.
                </div>
              )}
            </div>
          </aside>
        </div>

        <div className="flex items-center justify-end gap-2 border-t border-[rgb(var(--color-border))] px-4 py-3">
          <button
            type="button"
            onClick={onCancel}
            className="rounded-lg border border-[rgb(var(--color-border))] px-3 py-2 text-xs font-medium text-[rgb(var(--color-text-secondary))] transition-colors hover:bg-[rgb(var(--color-surface-alt))] hover:text-[rgb(var(--color-text))]"
          >
            Cancel
          </button>
          <button
            type="button"
            onClick={() => selectedAsset && onInsert(selectedAsset)}
            disabled={!selectedAsset}
            className="inline-flex items-center gap-1.5 rounded-lg bg-[rgb(var(--color-accent))] px-3 py-2 text-xs font-medium text-[rgb(var(--color-accent-fg))] transition-colors hover:bg-[rgb(var(--color-accent-hover))] disabled:cursor-not-allowed disabled:opacity-50"
          >
            <Check className="h-3.5 w-3.5" />
            Insert
          </button>
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
  const { settings, updateSetting } = useSettings();

  const [localTitle, setLocalTitle] = useState(activeSketch?.title ?? "");
  const [localRows, setLocalRows] = useState<PlanningRow[]>(activeSketch?.rows ?? []);
  const [captureRowIdx, setCaptureRowIdx] = useState<number | null>(null);
  const [showPreview, setShowPreview] = useState(false);
  const [previewMode, setPreviewMode] = useState<PresentationMode>("slides");
  const [showMonitorPicker, setShowMonitorPicker] = useState(false);
  const [durationDisplayMode, setDurationDisplayMode] = useState<DurationDisplayMode>("minutes");
  const [availableMonitors, setAvailableMonitors] = useState<MonitorInfo[]>([]);
  const [aiUpdatedFlash, setAiUpdatedFlash] = useState(false);
  const [highlightedRows, setHighlightedRows] = useState<Set<number>>(new Set());
  const [rowDiffs, setRowDiffs] = useState<RowDiff[]>([]);
  const [narrationRecordingRow, setNarrationRecordingRow] = useState<number | null>(null);
  const [narrationSavingRows, setNarrationSavingRows] = useState<Set<number>>(new Set());
  const [exportingVideo, setExportingVideo] = useState(false);
  const [videoExportProgress, setVideoExportProgress] = useState<SketchVideoExportProgress | null>(null);
  const [narrationGenerationProgress, setNarrationGenerationProgress] = useState<NarrationGenerationProgress | null>(null);
  const [videoExportIssues, setVideoExportIssues] = useState<VideoExportIssue[] | null>(null);
  const [showNarrationSetupPrompt, setShowNarrationSetupPrompt] = useState(false);
  // Last AI diffs are preserved so the user can re-show them after auto-fade
  const lastAiDiffs = useRef<{ rows: Set<number>; diffs: RowDiff[] } | null>(null);
  // Snapshot of rows before an AI edit lands — used for diff computation
  const aiSnapshotRef = useRef<{ rows: PlanningRow[]; changedIndices: number[] } | null>(null);
  const [visualPromptRow, setVisualPromptRow] = useState<number | null>(null);
  const [visualInstructions, setVisualInstructions] = useState("");
  const [localDesc, setLocalDesc] = useState(
    typeof activeSketch?.description === "string" ? activeSketch.description : ""
  );
  const titleTimeoutRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const rowsTimeoutRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const [narrationDialogRow, setNarrationDialogRow] = useState<number | null>(null);
  const [returnToNarrationAfterCapture, setReturnToNarrationAfterCapture] = useState<number | null>(null);

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
        await useAppStore.getState().loadSketches();
        const store = useAppStore.getState();
        if (store.activeSketchPath === path) {
          const sketch = await invoke<Sketch>("get_sketch", { relativePath: path });
          if (useAppStore.getState().activeSketchPath === path) {
            useAppStore.setState({ activeSketch: sketch });
          }
        }
        await useAppStore.getState().checkDirty();
        await useAppStore.getState().refreshChangedFiles();
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
      description: localDesc,
    }));
  }, [localRows, projectRoot, localTitle, localDesc]);

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
    const rowNumber = visualPromptRow + 1;
    let prompt: string;
    if (instructions) {
      prompt = `Generate an animated framing visual ONLY for sketch "${activeSketchPath ?? "current"}", row ${rowNumber}.

**USER INSTRUCTIONS (HIGHEST PRIORITY — follow these exactly):**
${instructions}

Row context:
- **Narrative:** ${row?.narrative || "(empty)"}
- **Actions:** ${row?.demo_actions || "(empty)"}

The Actions describe what happens on screen — use them as visual design hints. You may read the sketch for context, but the only persistent edit allowed is set_row_visual with row_number ${rowNumber}. Do not call design_plan, write_sketch, update_planning_row, write_storyboard, or set_row_visual for any other row. Do not create, remove, reorder, or rewrite rows. If validation fails, fix the visual and retry set_row_visual for this same row only. Use a 960×540 canvas. The user instructions above override any defaults.`;
    } else {
      prompt = `Generate an animated framing visual ONLY for sketch "${activeSketchPath ?? "current"}", row ${rowNumber}.

Row context:
- **Narrative:** ${row?.narrative || "(empty)"}
- **Actions:** ${row?.demo_actions || "(empty)"}

The Actions describe what happens on screen — use them as visual design hints. You may read the sketch for context, but the only persistent edit allowed is set_row_visual with row_number ${rowNumber}. Do not call design_plan, write_sketch, update_planning_row, write_storyboard, or set_row_visual for any other row. Do not create, remove, reorder, or rewrite rows. If validation fails, fix the visual and retry set_row_visual for this same row only. Use a 960×540 canvas.`;
    }
    void runBackgroundAgentAction(prompt, { agent: "designer", label: "Generate visual" });
    setVisualPromptRow(null);
    setVisualInstructions("");
  }, [visualPromptRow, localRows, activeSketchPath, visualInstructions, runBackgroundAgentAction]);

  const handleCaptureComplete = useCallback(
    (screenshotPath: string) => {
      if (captureRowIdx === null) return;
      const updated = [...localRows];
      updated[captureRowIdx] = { ...updated[captureRowIdx], screenshot: screenshotPath, visual: null, motion_points: null, motion_plan: null };
      handleRowsChange(updated);
      if (returnToNarrationAfterCapture !== null) {
        setNarrationDialogRow(returnToNarrationAfterCapture);
        setReturnToNarrationAfterCapture(null);
      }
      setCaptureRowIdx(null);
    },
    [captureRowIdx, localRows, handleRowsChange, returnToNarrationAfterCapture],
  );

  const handleCaptureCancel = useCallback(() => {
    if (returnToNarrationAfterCapture !== null) {
      setNarrationDialogRow(returnToNarrationAfterCapture);
      setReturnToNarrationAfterCapture(null);
    }
    setCaptureRowIdx(null);
  }, [returnToNarrationAfterCapture]);

  // Image/visual picker state
  const [imagePickerRowIdx, setImagePickerRowIdx] = useState<number | null>(null);
  const [projectAssets, setProjectAssets] = useState<ProjectAsset[]>([]);
  const [selectedAssetPath, setSelectedAssetPath] = useState<string | null>(null);
  const [narrationPickerRowIdx, setNarrationPickerRowIdx] = useState<number | null>(null);
  const [projectAudioAssets, setProjectAudioAssets] = useState<ProjectAudioAsset[]>([]);
  const [selectedNarrationPath, setSelectedNarrationPath] = useState<string | null>(null);

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
      updated[imagePickerRowIdx] = { ...updated[imagePickerRowIdx], visual: asset.path, screenshot: null, motion_points: null, motion_plan: null };
    } else {
      updated[imagePickerRowIdx] = { ...updated[imagePickerRowIdx], screenshot: asset.path, visual: null, motion_points: null, motion_plan: null };
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
      updated[rowIndex] = { ...updated[rowIndex], screenshot: relativePath, visual: null, motion_points: null, motion_plan: null };
      handleRowsChange(updated);
    } catch (err) {
      console.error("Failed to import image:", err);
    }
  }, [localRows, handleRowsChange]);

  const handlePickNarration = useCallback(async (rowIndex: number) => {
    setNarrationPickerRowIdx(rowIndex);
    try {
      const assets = await invoke<ProjectAudioAsset[]>("list_project_narration_assets");
      setProjectAudioAssets(assets);
      setSelectedNarrationPath(assets[0]?.path ?? null);
    } catch (err) {
      console.error("Failed to list narration audio:", err);
      setProjectAudioAssets([]);
      setSelectedNarrationPath(null);
    }
  }, []);

  const handleNarrationPicked = useCallback(async (asset: ProjectAudioAsset) => {
    if (narrationPickerRowIdx === null) return;
    const sourceText = localRows[narrationPickerRowIdx]?.narrative ?? "";
    const updated = [...localRows];
    updated[narrationPickerRowIdx] = {
      ...updated[narrationPickerRowIdx],
      narration: {
        path: asset.path,
        source_text: sourceText,
        source_text_hash: await sha256Hex(sourceText),
        mime_type: asset.mimeType,
        duration_ms: null,
        leading_silence_ms: null,
        trailing_silence_ms: null,
        silence_threshold_db: null,
        byte_size: asset.size,
        recorded_at: new Date().toISOString(),
      },
    };
    handleRowsChange(updated);
    setNarrationPickerRowIdx(null);
    setSelectedNarrationPath(null);
  }, [handleRowsChange, localRows, narrationPickerRowIdx]);

  const handleStopNarrationRecording = useCallback(() => {
    setNarrationDialogRow(null);
    setNarrationRecordingRow(null);
  }, []);

  const handleStartNarrationRecording = useCallback(async (rowIndex: number) => {
    if (!activeSketchPath || sketchLocked || narrationDialogRow !== null) return;
    if (!navigator.mediaDevices?.getUserMedia || typeof MediaRecorder === "undefined") {
      useToastStore.getState().show("Microphone recording is not available in this WebView.", 5000, "error");
      return;
    }

    try {
      await saveSketchEditsForPath(activeSketchPath, null, localRows, "narration recording");
      setNarrationDialogRow(rowIndex);
    } catch (err) {
      console.error("[SketchForm] Failed to prepare narration recording:", err);
      useToastStore.getState().show(`Could not prepare narration recording: ${err}`, 5000, "error");
    }
  }, [
    activeSketchPath,
    localRows,
    narrationDialogRow,
    saveSketchEditsForPath,
    sketchLocked,
  ]);

  const synthesizeNarrationForRow = useCallback(async (
    rowIndex: number,
    ssml: string,
    sourceText: string,
    accessToken: string,
    speechEndpoint: string,
  ) => {
    if (!activeSketchPath) throw new Error("No active sketch is open.");
    const { audioData, mimeType } = await synthesizeSpeechAudio({
      accessToken,
      speechEndpoint,
      ssml: validateGeneratedSsml(ssml),
      outputFormat: settings.narrationSpeechOutputFormat,
    });

    const durationMs = await decodeAudioDurationMs(audioData);
    const sketch = await invoke<Sketch>("save_narration_recording", {
      sketchPath: activeSketchPath,
      rowIndex,
      audioData: Array.from(new Uint8Array(audioData)),
      mimeType,
      durationMs,
      sourceText,
      leadingSilenceMs: 0,
      trailingSilenceMs: 0,
      silenceThresholdDb: null,
    });
    useAppStore.setState({ activeSketch: sketch });
    setLocalRows(sketch.rows ?? []);
    return sketch;
  }, [activeSketchPath, settings.narrationSpeechOutputFormat]);

  const refreshSpeechAccess = useCallback(async () => {
    const narrationProviders = settings.aiProviders?.filter((provider) =>
      (provider.provider === "microsoft_foundry" || provider.provider === "azure_openai") && provider.endpoint
    ) ?? [];
    const selectedProvider = settings.narrationConnectionMode === "dedicated"
      ? providerById(settings, settings.narrationProviderId) ?? narrationProviders[0] ?? null
      : activeProvider(settings);
    if (!selectedProvider || !["microsoft_foundry", "azure_openai"].includes(selectedProvider.provider) || !selectedProvider.endpoint) {
      throw new Error("Select a Foundry/Azure narration connection before generating narration.");
    }
    if (selectedProvider.authMode !== "azure_oauth") {
      throw new Error("Generated narration currently requires an Entra-authenticated Foundry/Azure connection.");
    }
    const refreshToken = selectedProvider.id === settings.aiActiveProviderId
      ? settings.aiRefreshToken
      : await getProviderSecret(selectedProvider.id, "refreshToken");
    if (!refreshToken) throw new Error("Sign in to the selected narration connection before generating narration.");
    const speechEndpoint = inferSpeechEndpoint(selectedProvider.endpoint);
    const token = await invoke<{ access_token: string; refresh_token?: string }>("azure_token_refresh", {
      tenantId: selectedProvider.tenantId || settings.aiTenantId || "",
      refreshToken,
      clientId: selectedProvider.clientId || settings.aiClientId || null,
      scope: SPEECH_TOKEN_SCOPE,
    });
    if (!token.access_token) throw new Error("Azure Speech token refresh did not return an access token.");
    if (selectedProvider.id === settings.aiActiveProviderId) {
      if (token.access_token) await updateSetting("aiAccessToken", token.access_token);
      if (token.refresh_token) await updateSetting("aiRefreshToken", token.refresh_token);
    } else {
      await setProviderSecret(selectedProvider.id, "accessToken", token.access_token);
      if (token.refresh_token) await setProviderSecret(selectedProvider.id, "refreshToken", token.refresh_token);
    }
    return { accessToken: token.access_token, speechEndpoint };
  }, [
    settings,
    updateSetting,
  ]);

  const refreshAgentAccessToken = useCallback(async () => {
    if (settings.aiAuthMode !== "azure_oauth" || !settings.aiRefreshToken) return settings.aiAccessToken;
    const token = await invoke<{ access_token: string; refresh_token?: string }>("azure_token_refresh", {
      tenantId: settings.aiTenantId || "",
      refreshToken: settings.aiRefreshToken,
      clientId: settings.aiClientId || null,
    });
    if (token.access_token) await updateSetting("aiAccessToken", token.access_token);
    if (token.refresh_token) await updateSetting("aiRefreshToken", token.refresh_token);
    return token.access_token || settings.aiAccessToken;
  }, [
    settings.aiAccessToken,
    settings.aiAuthMode,
    settings.aiClientId,
    settings.aiRefreshToken,
    settings.aiTenantId,
    updateSetting,
  ]);

  const generateSketchNarrationSsml = useCallback(async () => {
    const agentAccessToken = await refreshAgentAccessToken();
    const providerConfig = buildProviderConfig(activeProviderInput(settings));
    if (settings.aiAuthMode === "azure_oauth" && agentAccessToken) {
      providerConfig.bearer_token = agentAccessToken;
    }

    const sketchContext = {
      title: localTitle,
      description: localDesc,
      voice: settings.narrationVoiceName,
      style: settings.narrationStylePrompt,
      rows: localRows.map((row, index) => ({
        row_number: index + 1,
        time: row.time,
        narrative: row.narrative,
        actions: row.demo_actions,
        screenshot: row.screenshot,
        visual: row.visual,
      })),
    };
    const systemPrompt = `You are CutReady's Narration Director, an expert scriptwriter and SSML author for Azure Speech.

Your job is to turn a complete demo sketch into compelling spoken narration SSML for ${settings.narrationVoiceName}.

Rules:
- Return ONLY valid JSON. No markdown, no prose, no code fences.
- Output shape: {"rows":[{"row_number":1,"source_text":"plain narration text","ssml":"<speak ...>...</speak>"}]}
- Include every row that has narrative or actions. Skip only rows with neither.
- Each ssml value must be a complete Azure Speech SSML document with a <speak> root and <voice name="${settings.narrationVoiceName}">.
- Use natural spoken delivery, short sentences, and clean transitions across rows.
- Style direction: ${settings.narrationStylePrompt || "Natural presenter delivery."}
- Use SSML intentionally: <break time="200ms"/> to shape pacing, <prosody rate="-5%" pitch="+0st"> sparingly, <emphasis level="moderate"> for one key idea when useful.
- Do not include <audio>, external URLs, lexicons, bookmarks, or background audio.
- Keep the narration grounded in the sketch. Do not invent product capabilities beyond the title, description, narrative, actions, screenshots, or visuals.
- Avoid hype words and AI marketing cliches. Use plain, presenter-like language.
- Use ASCII punctuation in text content.`;

    const result = await invoke<AgentChatResult>("agent_chat_with_tools", {
      config: providerConfig,
      messages: [
        { role: "system", content: systemPrompt },
        { role: "user", content: `Generate narration SSML for this sketch:\n${JSON.stringify(sketchContext, null, 2)}` },
      ],
      agentPrompts: {},
      agentId: "narration-director",
      emitEvents: false,
      allowMutationTools: false,
    });
    return parseNarrationSsmlPlan(result.response);
  }, [localDesc, localRows, localTitle, refreshAgentAccessToken, settings]);

  const generateSketchMotionPlans = useCallback(async (eligibleRows: { row: PlanningRow; index: number }[]) => {
    const agentAccessToken = await refreshAgentAccessToken();
    const providerConfig = buildProviderConfig(activeProviderInput(settings));
    const motionMaxScale = settings.videoExportOverrideEnabled
      ? settings.workspaceVideoExportMotionMaxScale
      : settings.videoExportMotionMaxScale;
    if (settings.aiAuthMode === "azure_oauth" && agentAccessToken) {
      providerConfig.bearer_token = agentAccessToken;
    }

    const sketchContext = {
      title: localTitle,
      description: localDesc,
      rows: eligibleRows.map(({ row, index }) => ({
        row_number: index + 1,
        narrative: row.narrative,
        actions: row.demo_actions,
        narration_duration_ms: row.narration?.duration_ms ?? Math.round((row.duration_seconds ?? parseDurationSeconds(row.time) ?? 3) * 1000),
        screenshot: row.screenshot,
        points: row.motion_points,
      })),
    };
    const systemPrompt = `You are CutReady's Motion Director, an expert video editor designing subtle camera motion for static product demo screenshots.

Your job is to convert user-ranked screenshot attention points into safe camera motion plans that fit each row's narration duration.

Rules:
- Return ONLY valid JSON. No markdown, no prose, no code fences.
- Output shape: {"rows":[{"row_number":1,"motion_plan":{"kind":"subtle_push","keyframes":[{"time_ms":0,"scale":1,"x":0.5,"y":0.5,"easing":"linear"},{"time_ms":2200,"scale":1.28,"x":0.62,"y":0.41,"easing":"linear"}],"rationale":"..."}}]}
- Include one row entry for every input row.
- kind must be one of: "subtle_push", "wide_hold_then_push", "push_then_drift".
- Keyframe x/y are normalized 0..1 screenshot coordinates. Use only the provided points as targets, except the first frame may start at center x=0.5 y=0.5.
- scale must stay between 1.0 and ${motionMaxScale}. Prefer 1.12-${Math.min(motionMaxScale, 1.35).toFixed(2)} for normal narration; use higher values when the narrative/actions need a clear detail focus, especially for edge or small UI targets.
- Keep motion linear and editorial. Avoid rapid cuts, bouncing, easing curves, spins, or disorienting zooms.
- Use at least two keyframes and at most four.
- If narration is under 2500ms, use a single subtle push to the primary point.
- If narration is longer, you may hold wide briefly, push to primary, and drift subtly toward secondary/tertiary only if that helps the row's actions.
- Final keyframe time must be no later than narration_duration_ms.`;

    const result = await invoke<AgentChatResult>("agent_chat_with_tools", {
      config: providerConfig,
      messages: [
        { role: "system", content: systemPrompt },
        { role: "user", content: `Generate screenshot camera motion plans for this sketch:\n${JSON.stringify(sketchContext, null, 2)}` },
      ],
      agentPrompts: {},
      agentId: "motion-director",
      emitEvents: false,
      allowMutationTools: false,
    });
    return parseMotionPlan(result.response, motionMaxScale);
  }, [localDesc, localTitle, refreshAgentAccessToken, settings]);

  const generateAndSaveMotionRows = useCallback(async (rows: PlanningRow[]) => {
    if (!activeSketchPath || sketchLocked) return null;
    const eligibleRows = rows
      .map((row, index) => ({ row, index }))
      .filter(({ row }) => row.screenshot?.trim() && !row.visual && (row.motion_points?.length ?? 0) > 0);
    if (eligibleRows.length === 0) {
      return rows;
    }

    const totalSteps = eligibleRows.length + 3;
    setVideoExportProgress({
      phase: "motion-prepare",
      current: 0,
      total: totalSteps,
      message: "Saving the latest sketch edits before planning camera motion.",
    });
    await saveSketchEditsForPath(activeSketchPath, null, rows, "motion generation");
    useToastStore.getState().show("Motion Director is planning camera moves...", 3000, "info");
    setVideoExportProgress({
      phase: "motion-director",
      current: 1,
      total: totalSteps,
      message: `Motion Director is planning camera moves for ${eligibleRows.length} marked row${eligibleRows.length === 1 ? "" : "s"}.`,
    });
    const plan = await generateSketchMotionPlans(eligibleRows);
    const plansByNumber = new Map(plan.rows.map((row) => [row.row_number, row.motion_plan]));
    const eligibleRowNumbers = new Set(eligibleRows.map(({ index }) => index + 1));
    let appliedCount = 0;
    const updatedRows = rows.map((row, index) => {
      if (!eligibleRowNumbers.has(index + 1)) return row;
      const motionPlan = plansByNumber.get(index + 1);
      if (!motionPlan) return row;
      appliedCount += 1;
      return { ...row, motion_plan: motionPlan };
    });
    if (appliedCount === 0) throw new Error("Motion Director did not return plans for any marked rows.");
    setVideoExportProgress({
      phase: "motion-save",
      current: totalSteps - 1,
      total: totalSteps,
      message: "Saving generated motion plans before video export.",
    });
    setLocalRows(updatedRows);
    await saveSketchEditsForPath(activeSketchPath, null, updatedRows, "AI motion generation");
    const { refreshChangedFiles, checkDirty, addActivityEntries } = useAppStore.getState();
    await checkDirty();
    await refreshChangedFiles();
    addActivityEntries([{
      id: crypto.randomUUID(),
      timestamp: new Date(),
      source: "agent",
      content: `Generated motion plans for ${appliedCount} row${appliedCount === 1 ? "" : "s"}`,
      level: "success",
    }]);
    useToastStore.getState().show(`Generated motion plans for ${appliedCount} row${appliedCount === 1 ? "" : "s"}`, 5000, "success");
    return updatedRows;
  }, [
    activeSketchPath,
    generateSketchMotionPlans,
    saveSketchEditsForPath,
    sketchLocked,
  ]);

  const refreshAfterNarrationGeneration = useCallback(async (message: string, level: "success" | "error" = "success") => {
    const { loadSketches, loadNarrationAssets, refreshChangedFiles, checkDirty, addActivityEntries } = useAppStore.getState();
    await loadSketches();
    await loadNarrationAssets();
    await checkDirty();
    await refreshChangedFiles();
    addActivityEntries([{
      id: crypto.randomUUID(),
      timestamp: new Date(),
      source: "recording",
      content: message,
      level,
    }]);
  }, []);

  const handleGenerateNarration = useCallback(async (rowIndex: number) => {
    if (!activeSketchPath || sketchLocked) return;
    const row = localRows[rowIndex];
    const text = row?.narrative?.trim();
    if (!row || !text) {
      useToastStore.getState().show("Add narrative text before generating narration.", 5000, "error");
      return;
    }

    setNarrationSavingRows((rows) => new Set(rows).add(rowIndex));
    try {
      await saveSketchEditsForPath(activeSketchPath, null, localRows, "generated narration");
      const { accessToken, speechEndpoint } = await refreshSpeechAccess();
      console.info("[SketchForm] generating Azure Speech narration", {
        rowIndex,
        speechHost: new URL(speechEndpoint).host,
        voice: settings.narrationVoiceName,
      });
      await synthesizeNarrationForRow(rowIndex, buildPlainSsml(text, settings.narrationVoiceName), text, accessToken, speechEndpoint);
      await refreshAfterNarrationGeneration(`Generated narration for row ${rowIndex + 1}`);
      useToastStore.getState().show(`Generated narration for row ${rowIndex + 1}`, 4000, "success");
    } catch (err) {
      console.warn("[SketchForm] Failed to generate narration:", err);
      useToastStore.getState().show(`Could not generate narration: ${err}`, 6000, "error");
    } finally {
      setNarrationSavingRows((rows) => {
        const next = new Set(rows);
        next.delete(rowIndex);
        return next;
      });
    }
  }, [
    activeSketchPath,
    localRows,
    refreshAfterNarrationGeneration,
    refreshSpeechAccess,
    saveSketchEditsForPath,
    settings.narrationVoiceName,
    sketchLocked,
    synthesizeNarrationForRow,
  ]);

  const handleGenerateSketchNarration = useCallback(async () => {
    if (!activeSketchPath || sketchLocked) return;
    const eligibleRows = localRows
      .map((row, index) => ({ row, index }))
      .filter(({ row }) => row.narrative.trim() || row.demo_actions.trim());
    if (eligibleRows.length === 0) {
      useToastStore.getState().show("Add narrative or actions before generating narration.", 5000, "error");
      return;
    }

    setNarrationSavingRows((rows) => {
      const next = new Set(rows);
      eligibleRows.forEach(({ index }) => next.add(index));
      return next;
    });
    try {
      const totalSteps = eligibleRows.length + 4;
      setNarrationGenerationProgress({
        phase: "prepare",
        current: 0,
        total: totalSteps,
        message: "Saving the latest sketch edits before writing narration.",
      });
      await saveSketchEditsForPath(activeSketchPath, null, localRows, "AI narration generation");
      useToastStore.getState().show("Narration Director is writing SSML...", 3000, "info");

      setNarrationGenerationProgress({
        phase: "script",
        current: 1,
        total: totalSteps,
        message: "Narration Director is reading the full sketch and writing SSML.",
      });
      const plan = await generateSketchNarrationSsml();

      setNarrationGenerationProgress({
        phase: "auth",
        current: 2,
        total: totalSteps,
        message: "Borrowing the current Azure/Foundry connection for Speech synthesis.",
      });
      const { accessToken, speechEndpoint } = await refreshSpeechAccess();

      const rowsByNumber = new Map(plan.rows.map((row) => [row.row_number, row]));
      let generatedCount = 0;
      for (const { row, index } of eligibleRows) {
        const generated = rowsByNumber.get(index + 1);
        if (!generated) continue;
        setNarrationGenerationProgress({
          phase: "synthesize",
          current: 3 + generatedCount,
          total: totalSteps,
          message: `Synthesizing row ${index + 1} with MAI-Voice-2.`,
        });
        const sourceText = generated.source_text?.trim() || row.narrative.trim() || row.demo_actions.trim();
        await synthesizeNarrationForRow(index, generated.ssml, sourceText, accessToken, speechEndpoint);
        generatedCount += 1;
      }

      if (generatedCount === 0) throw new Error("Narration agent did not return SSML for any eligible rows.");
      setNarrationGenerationProgress({
        phase: "refresh",
        current: totalSteps - 1,
        total: totalSteps,
        message: "Refreshing narration assets and sketch state.",
      });
      await refreshAfterNarrationGeneration(`Generated AI narration for ${generatedCount} row${generatedCount === 1 ? "" : "s"}`);
      setNarrationGenerationProgress({
        phase: "complete",
        current: totalSteps,
        total: totalSteps,
        message: "Narration generation complete.",
      });
      useToastStore.getState().show(`Generated AI narration for ${generatedCount} row${generatedCount === 1 ? "" : "s"}`, 5000, "success");
    } catch (err) {
      console.warn("[SketchForm] Failed to generate sketch narration:", err);
      useToastStore.getState().show(`Could not generate sketch narration: ${err}`, 7000, "error");
      await refreshAfterNarrationGeneration(`AI narration generation failed: ${err}`, "error");
    } finally {
      setNarrationSavingRows((rows) => {
        const next = new Set(rows);
        eligibleRows.forEach(({ index }) => next.delete(index));
        return next;
      });
      setNarrationGenerationProgress(null);
    }
  }, [
    activeSketchPath,
    generateSketchNarrationSsml,
    localRows,
    refreshAfterNarrationGeneration,
    refreshSpeechAccess,
    saveSketchEditsForPath,
    sketchLocked,
    synthesizeNarrationForRow,
  ]);

  const handleSaveNarrationTake = useCallback(async (
    rowIndex: number,
    take: NarrationRecordingTake,
    options?: { navigateToRow?: number | null },
  ) => {
    if (!activeSketchPath) return;
    setNarrationSavingRows((rows) => new Set(rows).add(rowIndex));
    try {
      const sketch = await invoke<Sketch>("save_narration_recording", {
        sketchPath: activeSketchPath,
        rowIndex,
        audioData: take.audioData,
        mimeType: take.mimeType,
        durationMs: take.durationMs,
        sourceText: take.sourceText,
        leadingSilenceMs: take.leadingSilenceMs,
        trailingSilenceMs: take.trailingSilenceMs,
        silenceThresholdDb: take.silenceThresholdDb,
      });
      useAppStore.setState({ activeSketch: sketch });
      setLocalRows(sketch.rows ?? []);
      const { loadSketches, loadNarrationAssets, refreshChangedFiles, checkDirty, addActivityEntries } = useAppStore.getState();
      await loadSketches();
      await loadNarrationAssets();
      await checkDirty();
      await refreshChangedFiles();
      addActivityEntries([{
        id: crypto.randomUUID(),
        timestamp: new Date(),
        source: "recording",
        content: `Saved narration for row ${rowIndex + 1}`,
        level: "success",
      }]);
      const navigateToRow = options?.navigateToRow;
      setNarrationDialogRow(
        typeof navigateToRow === "number" && navigateToRow >= 0 && navigateToRow < (sketch.rows?.length ?? 0)
          ? navigateToRow
          : rowIndex,
      );
    } catch (err) {
      console.error("[SketchForm] Failed to save narration recording:", err);
      useToastStore.getState().show(`Could not save narration: ${err}`, 5000, "error");
    } finally {
      setNarrationSavingRows((rows) => {
        const next = new Set(rows);
        next.delete(rowIndex);
        return next;
      });
    }
  }, [activeSketchPath]);

  /** Launch fullscreen preview on a specific monitor */
  const launchPreviewOnMonitor = useCallback(async (monitor: MonitorInfo | null, mode: PresentationMode = "slides") => {
    setShowMonitorPicker(false);
    // Serialize sketch data for the preview window to read
    localStorage.setItem(PREVIEW_DATA_KEY, JSON.stringify({
      rows: localRows,
      projectRoot,
      title: localTitle || "Untitled Sketch",
      description: localDesc,
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
  }, [localRows, projectRoot, localTitle, localDesc]);

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

  const handleExportPowerPoint = useCallback((content: PowerPointExportContent) => {
    if (!activeSketch) return;
    exportSketchToPowerPoint(activeSketch, content).then((exported) => {
      if (!exported) return;
      const label = content === "narrative" ? "narration" : "actions";
      useToastStore.getState().show("Export complete");
      useAppStore.getState().addActivityEntries([{ id: crypto.randomUUID(), timestamp: new Date(), source: "export", content: `Exported "${activeSketch.title}" ${label} deck to PowerPoint`, level: "success" }]);
    }).catch(err => console.error("PowerPoint export failed:", err));
  }, [activeSketch]);

  const promptForVideoOutputPath = useCallback(async () => {
    if (!activeSketch) return null;
    const selectedPath = await save({
      defaultPath: defaultVideoExportName(localTitle || activeSketch.title || "sketch"),
      filters: [{ name: "MP4 Video", extensions: ["mp4"] }],
    });
    return selectedPath ? ensureMp4Extension(selectedPath) : null;
  }, [activeSketch, localTitle]);

  const handleExportVideo = useCallback(async (rowsOverride?: PlanningRow[], outputPathOverride?: string) => {
    if (!activeSketchPath || !activeSketch || !projectRoot || exportingVideo) return;
    const rowsForExport = rowsOverride ?? localRows;
    const issues = getVideoExportIssues(rowsForExport);
    if (issues.length > 0) {
      setVideoExportIssues(issues);
      return;
    }

    const outputPath = outputPathOverride ?? await promptForVideoOutputPath();
    if (!outputPath) return;

    setExportingVideo(true);
    setVideoExportProgress({
      phase: "preparing",
      current: 0,
      total: Math.max(1, rowsForExport.length + Math.max(0, rowsForExport.length - 1) + 4),
      message: "Preparing sketch video export",
    });
    try {
      await saveSketchEditsForPath(activeSketchPath, localTitle, rowsForExport, "video export");
      const progressChannel = new Channel<SketchVideoExportProgress>();
      progressChannel.onmessage = (progress) => {
        setVideoExportProgress(progress);
      };
      const selectedBackgroundMusicTrack = settings.videoExportBackgroundMusicTracks.find(
        (track) => track.id === settings.videoExportBackgroundMusicTrackId,
      );
      const videoExportSettings = {
        includeTitleCard: settings.videoExportOverrideEnabled
          ? settings.workspaceVideoExportIncludeTitleCard
          : settings.videoExportIncludeTitleCard,
        titleCardDurationSeconds: settings.videoExportOverrideEnabled
          ? settings.workspaceVideoExportTitleCardDurationSeconds
          : settings.videoExportTitleCardDurationSeconds,
        titleToFirstRowHoldSeconds: settings.videoExportOverrideEnabled
          ? settings.workspaceVideoExportTitleToFirstRowHoldSeconds
          : settings.videoExportTitleToFirstRowHoldSeconds,
        rowTransitionHoldSeconds: settings.videoExportOverrideEnabled
          ? settings.workspaceVideoExportRowTransitionHoldSeconds
          : settings.videoExportRowTransitionHoldSeconds,
        finalHoldSeconds: settings.videoExportOverrideEnabled
          ? settings.workspaceVideoExportFinalHoldSeconds
          : settings.videoExportFinalHoldSeconds,
        rowTransitionDipSeconds: settings.videoExportOverrideEnabled
          ? settings.workspaceVideoExportRowTransitionDipSeconds
          : settings.videoExportRowTransitionDipSeconds,
        narrationTailHoldSeconds: settings.videoExportOverrideEnabled
          ? settings.workspaceVideoExportNarrationTailHoldSeconds
          : settings.videoExportNarrationTailHoldSeconds,
        motionMaxScale: settings.videoExportOverrideEnabled
          ? settings.workspaceVideoExportMotionMaxScale
          : settings.videoExportMotionMaxScale,
        videoWidth: settings.videoExportOverrideEnabled
          ? settings.workspaceVideoExportWidth
          : settings.videoExportWidth,
        videoHeight: settings.videoExportOverrideEnabled
          ? settings.workspaceVideoExportHeight
          : settings.videoExportHeight,
        videoFps: settings.videoExportOverrideEnabled
          ? settings.workspaceVideoExportFps
          : settings.videoExportFps,
        videoEncoder: settings.videoExportOverrideEnabled
          ? settings.workspaceVideoExportEncoder
          : settings.videoExportEncoder,
        videoPixelFormat: settings.videoExportOverrideEnabled
          ? settings.workspaceVideoExportPixelFormat
          : settings.videoExportPixelFormat,
        videoCrf: settings.videoExportOverrideEnabled
          ? settings.workspaceVideoExportCrf
          : settings.videoExportCrf,
        backgroundMusicPath: selectedBackgroundMusicTrack?.path ?? null,
        backgroundMusicVolumeDb: settings.videoExportBackgroundMusicVolumeDb,
        backgroundMusicDuckNarration: settings.videoExportBackgroundMusicDuckNarration,
        backgroundMusicFadeSeconds: settings.videoExportBackgroundMusicFadeSeconds,
      } satisfies SketchVideoExportSettings;

      const result = await invoke<SketchVideoExport>("export_sketch_video", {
        relativePath: activeSketchPath,
        outputPath,
        settings: videoExportSettings,
        onProgress: progressChannel,
      });
      setVideoExportProgress({
        phase: "complete",
        current: 1,
        total: 1,
        message: "Video export complete",
      });
      useToastStore.getState().show(`Video exported to ${result.path}`, 5000, "success");
      useAppStore.getState().addActivityEntries([{
        id: crypto.randomUUID(),
        timestamp: new Date(),
        source: "export",
        content: `Exported "${activeSketch.title}" to video`,
        level: "success",
      }]);
      await useAppStore.getState().refreshChangedFiles();
      try {
        await openPath(result.path);
      } catch (openErr) {
        console.warn("[SketchForm] Video exported, but opening it failed:", openErr);
      }
    } catch (err) {
      console.error("[SketchForm] Video export failed:", err);
      useToastStore.getState().show(`Video export failed: ${err}`, 6000, "error");
    } finally {
      setExportingVideo(false);
      setVideoExportProgress(null);
    }
  }, [
    activeSketchPath,
    activeSketch,
    projectRoot,
    exportingVideo,
    promptForVideoOutputPath,
    saveSketchEditsForPath,
    localTitle,
    localRows,
    settings.videoExportOverrideEnabled,
    settings.videoExportIncludeTitleCard,
    settings.videoExportTitleCardDurationSeconds,
    settings.videoExportTitleToFirstRowHoldSeconds,
    settings.videoExportRowTransitionHoldSeconds,
    settings.videoExportFinalHoldSeconds,
    settings.videoExportRowTransitionDipSeconds,
    settings.videoExportNarrationTailHoldSeconds,
    settings.videoExportMotionMaxScale,
    settings.videoExportWidth,
    settings.videoExportHeight,
    settings.videoExportFps,
    settings.videoExportEncoder,
    settings.videoExportPixelFormat,
    settings.videoExportCrf,
    settings.videoExportBackgroundMusicTracks,
    settings.videoExportBackgroundMusicTrackId,
    settings.videoExportBackgroundMusicVolumeDb,
    settings.videoExportBackgroundMusicDuckNarration,
    settings.videoExportBackgroundMusicFadeSeconds,
    settings.workspaceVideoExportIncludeTitleCard,
    settings.workspaceVideoExportTitleCardDurationSeconds,
    settings.workspaceVideoExportTitleToFirstRowHoldSeconds,
    settings.workspaceVideoExportRowTransitionHoldSeconds,
    settings.workspaceVideoExportFinalHoldSeconds,
    settings.workspaceVideoExportRowTransitionDipSeconds,
    settings.workspaceVideoExportNarrationTailHoldSeconds,
    settings.workspaceVideoExportMotionMaxScale,
    settings.workspaceVideoExportWidth,
    settings.workspaceVideoExportHeight,
    settings.workspaceVideoExportFps,
    settings.workspaceVideoExportEncoder,
    settings.workspaceVideoExportPixelFormat,
    settings.workspaceVideoExportCrf,
  ]);

  const handleGenerateVideo = useCallback(async () => {
    if (!activeSketchPath || sketchLocked || exportingVideo) return;
    try {
      const outputPath = await promptForVideoOutputPath();
      if (!outputPath) return;
      const rowsForExport = await generateAndSaveMotionRows(localRows);
      if (!rowsForExport) return;
      await handleExportVideo(rowsForExport, outputPath);
    } catch (err) {
      console.warn("[SketchForm] Failed to generate video:", err);
      useToastStore.getState().show(`Could not generate video: ${err}`, 7000, "error");
      setVideoExportProgress(null);
    }
  }, [
    activeSketchPath,
    exportingVideo,
    generateAndSaveMotionRows,
    handleExportVideo,
    localRows,
    promptForVideoOutputPath,
    sketchLocked,
  ]);

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
    {
      id: "generate-narration",
      label: "Generate narration",
      icon: <Mic2 className="h-3.5 w-3.5" />,
      onSelect: handleGenerateSketchNarration,
      disabled: localRows.length === 0 || narrationSavingRows.size > 0,
    },
    {
      id: "generate-video",
      label: exportingVideo ? "Rendering video..." : "Generate video",
      icon: <Film className="h-3.5 w-3.5" />,
      onSelect: handleGenerateVideo,
      disabled: localRows.length === 0 || exportingVideo,
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
    {
      id: "powerpoint-narration",
      label: "PowerPoint - Narration",
      icon: documentToolbarIcons.fileText,
      onSelect: () => handleExportPowerPoint("narrative"),
    },
    {
      id: "powerpoint-actions",
      label: "PowerPoint - Actions",
      icon: documentToolbarIcons.fileText,
      onSelect: () => handleExportPowerPoint("actions"),
    },
    {
      id: "video",
      label: exportingVideo ? "Rendering video..." : "Video",
      icon: documentToolbarIcons.video,
      onSelect: () => void handleExportVideo(),
      disabled: exportingVideo,
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

        <InlineDescriptionEditor
          value={localDesc}
          placeholder="Describe what this sketch covers..."
          disabled={sketchLocked}
          rows={4}
          className="my-8"
          previewClassName={`prose-desc min-h-[2rem] rounded-lg border border-transparent px-3 py-2 pr-10 text-sm leading-relaxed text-[rgb(var(--color-text))] transition-colors hover:border-[rgb(var(--color-border))] ${sketchLocked ? "cursor-default" : "cursor-text"}`}
          textareaClassName="w-full resize-none text-sm bg-transparent text-[rgb(var(--color-text))] placeholder:text-[rgb(var(--color-text-secondary))]/40 outline-none border border-[rgb(var(--color-border))] rounded-lg px-3 py-2 focus:ring-1 focus:ring-[rgb(var(--color-accent))]/40 transition-colors"
          onDraftChange={setLocalDesc}
          onSave={(description) => updateSketch({ description })}
          action={
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
          }
        />

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
              const rowNumber = rowIndex + 1;
              const prompt = `Modify the existing visual ONLY for sketch "${activeSketchPath ?? "current"}", row ${rowNumber}.

**USER INSTRUCTIONS (HIGHEST PRIORITY):**
${instruction}

Row context:
- **Narrative:** ${row?.narrative || "(empty)"}
- **Actions:** ${row?.demo_actions || "(empty)"}

The row already has a visual and design_plan. You may read the sketch for context, but the only persistent edit allowed is set_row_visual with row_number ${rowNumber}. Do not call write_sketch, update_planning_row, write_storyboard, or set_row_visual for any other row. Do not create, remove, reorder, or rewrite rows. Keep the existing design but apply the requested changes. Do NOT redesign from scratch.`;
              void runBackgroundAgentAction(prompt, { agent: "designer", label: "Modify visual" });
            }}
            projectRoot={projectRoot}
            sketchPath={activeSketchPath ?? undefined}
            onRowLockChange={handleRowLockChange}
            onCellLockChange={handleCellLockChange}
            onStartNarrationRecording={handleStartNarrationRecording}
            onGenerateNarration={handleGenerateNarration}
            onPickNarration={handlePickNarration}
            onStopNarrationRecording={handleStopNarrationRecording}
            narrationRecordingRow={narrationRecordingRow}
            narrationSavingRows={narrationSavingRows}
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

      {narrationPickerRowIdx !== null && (
        <SketchRowNarrationPicker
          assets={projectAudioAssets}
          projectRoot={projectRoot}
          selectedPath={selectedNarrationPath}
          onSelectedPathChange={setSelectedNarrationPath}
          onInsert={(asset) => void handleNarrationPicked(asset)}
          onCancel={() => {
            setNarrationPickerRowIdx(null);
            setSelectedNarrationPath(null);
          }}
        />
      )}

      {narrationDialogRow !== null && (
        <NarrationRecordingDialog
          rowNumber={narrationDialogRow + 1}
          sourceText={localRows[narrationDialogRow]?.narrative ?? ""}
          projectRoot={projectRoot}
          screenshotPath={localRows[narrationDialogRow]?.screenshot}
          existingNarrationPath={localRows[narrationDialogRow]?.narration?.path}
          existingNarrationDurationMs={localRows[narrationDialogRow]?.narration?.duration_ms}
          canNavigatePrevious={narrationDialogRow > 0}
          canNavigateNext={narrationDialogRow < localRows.length - 1}
          audio={settings.narrationMicDeviceId ? { deviceId: { exact: settings.narrationMicDeviceId } } : true}
          mimeType={preferredNarrationMimeType()}
          onAddScreenshot={() => {
            setReturnToNarrationAfterCapture(narrationDialogRow);
            setNarrationDialogRow(null);
            setCaptureRowIdx(narrationDialogRow);
          }}
          onCancel={() => setNarrationDialogRow(null)}
          onNavigatePrevious={() => setNarrationDialogRow(Math.max(0, narrationDialogRow - 1))}
          onNavigateNext={() => setNarrationDialogRow(Math.min(localRows.length - 1, narrationDialogRow + 1))}
          onSave={(take, options) => handleSaveNarrationTake(narrationDialogRow, take, options)}
        />
      )}

      <VideoExportReadinessDialog
        issues={videoExportIssues}
        onClose={() => setVideoExportIssues(null)}
      />
      <VideoExportProgressDialog progress={videoExportProgress} />
      <NarrationGenerationProgressDialog progress={narrationGenerationProgress} />

      {showNarrationSetupPrompt && (
        <div
          className="cr-modal-backdrop fixed inset-0 z-modal flex items-center justify-center p-4"
          onClick={() => setShowNarrationSetupPrompt(false)}
        >
          <div
            role="dialog"
            aria-modal="true"
            aria-labelledby="narration-setup-title"
            className="cr-modal-surface w-full max-w-sm rounded-2xl p-5"
            onClick={(event) => event.stopPropagation()}
          >
            <div className="flex items-start gap-3">
              <div className="grid h-9 w-9 shrink-0 place-items-center rounded-xl bg-[rgb(var(--color-accent))]/10 text-[rgb(var(--color-accent))]">
                <Mic2 className="h-4 w-4" />
              </div>
              <div className="min-w-0">
                <h2 id="narration-setup-title" className="text-sm font-semibold text-[rgb(var(--color-text))]">
                  Set up narration microphone
                </h2>
                <p className="mt-1 text-xs leading-relaxed text-[rgb(var(--color-text-secondary))]">
                  Pick a microphone in Narration settings before recording row audio. This keeps narration capture predictable.
                </p>
              </div>
            </div>
            <div className="mt-5 flex justify-end gap-2">
              <button
                type="button"
                onClick={() => setShowNarrationSetupPrompt(false)}
                className="rounded-lg border border-[rgb(var(--color-border))] px-3 py-2 text-xs font-medium text-[rgb(var(--color-text-secondary))] transition-colors hover:bg-[rgb(var(--color-surface-alt))] hover:text-[rgb(var(--color-text))]"
              >
                Cancel
              </button>
              <button
                type="button"
                onClick={() => {
                  localStorage.setItem(REQUESTED_SETTINGS_TAB_KEY, "narration");
                  setShowNarrationSetupPrompt(false);
                  useAppStore.getState().setView("settings");
                }}
                className="rounded-lg bg-[rgb(var(--color-accent))] px-3 py-2 text-xs font-medium text-[rgb(var(--color-accent-fg))] transition-colors hover:bg-[rgb(var(--color-accent-hover))]"
              >
                Open settings
              </button>
            </div>
          </div>
        </div>
      )}

      {/* Visual generation instructions popup */}
      {visualPromptRow !== null && (
        <div className="cr-modal-backdrop fixed inset-0 z-modal flex items-center justify-center" onClick={() => setVisualPromptRow(null)}>
          <div className="cr-modal-surface rounded-xl w-full max-w-md flex flex-col" onClick={(e) => e.stopPropagation()}>
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
          description={localDesc}
          initialMode={previewMode}
          onClose={() => { setShowPreview(false); setPreviewMode("slides"); }}
        />
      )}
    </div>
  );
}
