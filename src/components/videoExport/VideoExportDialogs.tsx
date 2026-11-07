import { useCallback, useEffect, useState } from "react";
import { commandErrorText } from "../../services/tauri";
import { exportIpc, type ResolvedDemoInspection, type ResolvedDemoRowInspection, type ResolvedDemoStepInspection } from "../../ipc/export";
import { open } from "../../dialogs";
import { X, Folder, Film, Mic2 } from "lucide-react";
import { Dialog } from "../Dialog";
import type { PlanningRow } from "../../types/sketch";
import {
  emptyVideoExportOptions,
  getVideoExportCoverage,
  normalizeVideoExportOptions,
  isSafeProjectRelativePath,
  selectedFileToProjectRelativePath,
  type VideoExportIssue,
  type VideoExportMediaSource,
  type VideoExportOptions,
  type VideoExportTimingSource,
} from "../../utils/videoExport";

export type SketchVideoExportProgress = { phase: string; current: number; total: number; message: string };

export type ResolvedDemoInspectionState = {
  path: string;
  loading: boolean;
  inspection: ResolvedDemoInspection | null;
  error: string | null;
};

export type NarrationGenerationProgress = { phase: string; current: number; total: number; message: string };

export type SketchVideoExportSettings = {
  includeTitleCard: boolean;
  titleCardDurationSeconds: number;
  titleToFirstRowHoldSeconds: number;
  rowTransitionHoldSeconds: number;
  finalHoldSeconds: number;
  rowTransitionDipSeconds: number;
  narrationTailHoldSeconds: number;
  resolvedDemoPath?: string | null;
  generateResolvedDemo?: boolean;
  visualFrameManifestPaths?: Array<string | null>;
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

export function slugifyExportName(value: string): string {
  const slug = value
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
  return slug || "sketch";
}

export function formatExportTimestamp(date = new Date()): string {
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

export function defaultVideoExportName(title: string): string {
  const fileName = `${slugifyExportName(title)}-${formatExportTimestamp()}.mp4`;
  return fileName;
}

export function ensureMp4Extension(path: string): string {
  return /\.mp4$/i.test(path) ? path : `${path}.mp4`;
}

export function VideoExportReadinessDialog({
  issues,
  onClose,
}: {
  issues: VideoExportIssue[] | null;
  onClose: () => void;
}) {
  if (!issues) return null;

  const missingSketchRows = issues.some((issue) => (
    issue.rowNumber === 0 && issue.missing.includes("at least one row")
  ));

  return (
    <Dialog
      isOpen={issues !== null}
      onClose={onClose}
      align="top"
      topOffset="18vh"
      width="w-full max-w-lg mx-4"
      labelledBy="video-export-readiness-title"
    >
      <div className="cr-modal-surface overflow-hidden">
        <div className="flex items-start gap-3 border-b border-[rgb(var(--color-border))] px-5 py-4">
          <div className="mt-0.5 grid h-9 w-9 shrink-0 place-items-center rounded-xl bg-[rgb(var(--color-accent))]/10 text-[rgb(var(--color-accent))]">
            <Film className="h-4 w-4" />
          </div>
          <div className="min-w-0 flex-1">
            <h2 id="video-export-readiness-title" className="text-sm font-semibold text-[rgb(var(--color-text))]">
              Video export needs a complete sketch
            </h2>
            <p className="mt-1 text-xs leading-5 text-[rgb(var(--color-text-secondary))]">
              CutReady can render a sketch video when every row has narration and a screenshot, visual, or Elucim frame manifest. Add the missing pieces below, then export again.
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
          {missingSketchRows ? (
            <div className="rounded-xl border border-[rgb(var(--color-border))] bg-[rgb(var(--color-surface-alt))]/60 px-3 py-2 text-xs text-[rgb(var(--color-text-secondary))]">
              Add at least one planning row with narration and a screenshot, visual, or frame manifest.
            </div>
          ) : (
            <div className="space-y-2">
              {issues.map((issue) => (
                <div
                  key={issue.rowNumber}
                  className="flex items-center justify-between gap-3 rounded-xl border border-[rgb(var(--color-border))] bg-[rgb(var(--color-surface-alt))]/60 px-3 py-2"
                >
                  <span className="text-xs font-medium text-[rgb(var(--color-text))]">
                    {issue.rowNumber === 0 ? "Export inputs" : `Row ${issue.rowNumber}`}
                  </span>
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

export function VideoExportOptionsDialog({
  isOpen,
  rows,
  projectRoot,
  onClose,
  onExport,
}: {
  isOpen: boolean;
  rows: PlanningRow[];
  projectRoot: string;
  onClose: () => void;
  onExport: (options: VideoExportOptions) => void;
}) {
  const [options, setOptions] = useState<VideoExportOptions>(() => emptyVideoExportOptions(rows.length));
  const [pathError, setPathError] = useState<string | null>(null);
  const normalizedOptions = normalizeVideoExportOptions(options, rows.length);
  const coverage = getVideoExportCoverage(rows, normalizedOptions);
  const resolvedMediaRows = coverage.filter((row) => row.usesResolvedDemoMedia).length;
  const resolvedTimingRows = coverage.filter((row) => row.timingSource === "resolved-demo").length;
  const [resolvedDemoInspection, setResolvedDemoInspection] = useState<ResolvedDemoInspectionState | null>(null);
  const activeResolvedDemoInspection = resolvedDemoInspection?.path === normalizedOptions.resolvedDemoPath
    ? resolvedDemoInspection
    : null;
  const resolvedDemoExportBlock = normalizedOptions.resolvedDemoPath
    ? !isSafeProjectRelativePath(normalizedOptions.resolvedDemoPath)
      ? "Choose a project-relative Scenecast resolved demo path before exporting."
      : !activeResolvedDemoInspection || activeResolvedDemoInspection.loading
        ? "Wait for resolved demo inspection to finish before exporting."
        : activeResolvedDemoInspection.error
          ? `Resolve the Scenecast inspection error before exporting: ${activeResolvedDemoInspection.error}`
          : activeResolvedDemoInspection.inspection && !activeResolvedDemoInspection.inspection.canExport
            ? activeResolvedDemoInspection.inspection.blockingError ?? "Resolve blocking Scenecast diagnostics before exporting."
            : null
    : null;

  useEffect(() => {
    if (isOpen) {
      setOptions(emptyVideoExportOptions(rows.length));
      setPathError(null);
      setResolvedDemoInspection(null);
    }
  }, [isOpen, rows.length]);

  useEffect(() => {
    const path = normalizedOptions.resolvedDemoPath;
    if (!isOpen || !path || !isSafeProjectRelativePath(path)) {
      setResolvedDemoInspection(null);
      return;
    }

    let cancelled = false;
    setResolvedDemoInspection({ path, loading: true, inspection: null, error: null });
    const timeout = window.setTimeout(() => {
      void exportIpc.inspectResolvedDemo(path, rows.length, rows.map((row) => row.id ?? ""))
        .then((inspection) => {
          if (!cancelled) setResolvedDemoInspection({ path, loading: false, inspection, error: null });
        })
        .catch((error) => {
          if (!cancelled) {
            setResolvedDemoInspection({
              path,
              loading: false,
              inspection: null,
              error: commandErrorText(error),
            });
          }
        });
    }, 250);

    return () => {
      cancelled = true;
      window.clearTimeout(timeout);
    };
  }, [isOpen, normalizedOptions.resolvedDemoPath, rows.length]);

  const chooseJsonPath = useCallback(async (onSelected: (relativePath: string) => void) => {
    setPathError(null);
    const selected = await open({
      multiple: false,
      directory: false,
      defaultPath: projectRoot,
      filters: [{ name: "JSON", extensions: ["json"] }],
    });
    if (!selected || Array.isArray(selected)) return;
    const relativePath = selectedFileToProjectRelativePath(projectRoot, selected);
    if (!relativePath) {
      setPathError("Choose a JSON file inside this CutReady project folder.");
      return;
    }
    onSelected(relativePath);
  }, [projectRoot]);

  const updateManifestPath = useCallback((index: number, value: string | null) => {
    setOptions((current) => ({
      ...current,
      visualFrameManifestPaths: Array.from({ length: rows.length }, (_, rowIndex) => (
        rowIndex === index ? value : current.visualFrameManifestPaths[rowIndex] ?? null
      )),
    }));
  }, [rows.length]);

  if (!isOpen) return null;

  return (
    <Dialog
      isOpen={isOpen}
      onClose={onClose}
      align="top"
      topOffset="10vh"
      width="w-full max-w-2xl mx-4"
      labelledBy="video-export-options-title"
    >
      <div className="cr-modal-surface overflow-hidden rounded-2xl">
        <div className="flex items-start gap-3 border-b border-[rgb(var(--color-border))] px-5 py-4">
          <div className="mt-0.5 grid h-9 w-9 shrink-0 place-items-center rounded-xl bg-[rgb(var(--color-accent))]/10 text-[rgb(var(--color-accent))]">
            <Film className="h-4 w-4" />
          </div>
          <div className="min-w-0 flex-1">
            <h2 id="video-export-options-title" className="text-sm font-semibold text-[rgb(var(--color-text))]">
              Video export inputs
            </h2>
            <p className="mt-1 text-xs leading-5 text-[rgb(var(--color-text-secondary))]">
              Optional pipeline artifacts for the current export. Leave them blank for the sketch media-and-narration path.
            </p>
          </div>
          <button
            type="button"
            onClick={onClose}
            className="rounded-lg p-1.5 text-[rgb(var(--color-text-secondary))] transition-colors hover:bg-[rgb(var(--color-surface-alt))] hover:text-[rgb(var(--color-text))]"
            aria-label="Close video export inputs"
          >
            <X className="h-4 w-4" />
          </button>
        </div>

        <div className="max-h-[62vh] space-y-4 overflow-y-auto px-5 py-4">
          <label className="block">
            <span className="text-xs font-semibold text-[rgb(var(--color-text))]">Scenecast resolved demo</span>
            <span className="mt-1 block text-xs leading-5 text-[rgb(var(--color-text-secondary))]">
              Project-relative path to a resolved-demo JSON file. It can provide Scenecast playback media and extend row timing from playback spans.
            </span>
            <div className="mt-2 flex gap-2">
              <input
                value={options.resolvedDemoPath ?? ""}
                onChange={(event) => setOptions((current) => ({ ...current, resolvedDemoPath: event.target.value }))}
                placeholder=".cutready/scenecast/resolved-demo.json"
                className="min-w-0 flex-1 rounded-lg border border-[rgb(var(--color-border))] bg-[rgb(var(--color-surface))] px-3 py-2 text-xs text-[rgb(var(--color-text))] outline-none transition-colors placeholder:text-[rgb(var(--color-text-secondary))] focus:border-[rgb(var(--color-accent))]"
                data-testid="video-export-resolved-demo-path"
              />
              <button
                type="button"
                onClick={() => void chooseJsonPath((relativePath) => {
                  setOptions((current) => ({ ...current, resolvedDemoPath: relativePath }));
                })}
                className="inline-flex items-center gap-1.5 rounded-lg border border-[rgb(var(--color-border))] px-3 py-2 text-xs font-medium text-[rgb(var(--color-text))] transition-colors hover:bg-[rgb(var(--color-surface-alt))]"
              >
                <Folder className="h-3.5 w-3.5" />
                Browse
              </button>
            </div>
          </label>

          <label className="flex items-start gap-3 rounded-xl border border-[rgb(var(--color-border))] bg-[rgb(var(--color-surface-alt))]/50 px-3 py-2">
            <input
              type="checkbox"
              checked={options.generateResolvedDemo}
              disabled={Boolean(options.resolvedDemoPath?.trim())}
              onChange={(event) => {
                setOptions((current) => ({ ...current, generateResolvedDemo: event.target.checked }));
              }}
              className="mt-0.5 h-4 w-4 rounded border-[rgb(var(--color-border))] accent-[rgb(var(--color-accent))]"
              data-testid="video-export-generate-resolved-demo"
            />
            <span>
              <span className="block text-xs font-semibold text-[rgb(var(--color-text))]">
                Generate resolved demo with Scenecast
              </span>
              <span className="mt-1 block text-xs leading-5 text-[rgb(var(--color-text-secondary))]">
                Builds a temporary .scenecast bundle from screenshot-backed rows and runs scenecast-cli for this export.
              </span>
            </span>
          </label>

          {(normalizedOptions.resolvedDemoPath || normalizedOptions.generateResolvedDemo) && (
            <div className="rounded-2xl border border-[rgb(var(--color-border))] bg-[rgb(var(--color-surface-alt))]/40 p-3">
              <div className="flex items-start justify-between gap-3">
                <div>
                  <div className="text-xs font-semibold text-[rgb(var(--color-text))]">Export source map</div>
                  <p className="mt-1 text-xs leading-5 text-[rgb(var(--color-text-secondary))]">
                    Scenecast timing will be tried for {resolvedTimingRows} row{resolvedTimingRows === 1 ? "" : "s"}
                    {normalizedOptions.resolvedDemoPath
                      ? `; resolved-demo media is eligible for ${resolvedMediaRows} row${resolvedMediaRows === 1 ? "" : "s"} after frame manifests and visuals, replacing screenshots unless overlays need them.`
                      : ". Generated demos reuse row screenshots for media."}
                  </p>
                </div>
                <span className="rounded-full border border-[rgb(var(--color-accent))]/30 bg-[rgb(var(--color-accent))]/10 px-2 py-1 text-[11px] font-medium text-[rgb(var(--color-accent))]">
                  {resolvedMediaRows} media / {resolvedTimingRows} timing
                </span>
              </div>
              <div className="mt-3 grid gap-1.5">
                {coverage.map((rowCoverage) => (
                  <ResolvedDemoCoverageRow
                    key={rowCoverage.rowNumber}
                    coverage={rowCoverage}
                    inspection={activeResolvedDemoInspection?.inspection?.rows.find((row) => row.rowNumber === rowCoverage.rowNumber) ?? null}
                  />
                ))}
              </div>
              {normalizedOptions.resolvedDemoPath && (
                <ResolvedDemoInspectionPanel
                  state={activeResolvedDemoInspection}
                />
              )}
            </div>
          )}

          <div>
            <div className="text-xs font-semibold text-[rgb(var(--color-text))]">Elucim frame manifests</div>
            <p className="mt-1 text-xs leading-5 text-[rgb(var(--color-text-secondary))]">
              Optional project-relative JSON manifests per row. Rows with attached visuals generate these automatically during export.
            </p>
            <div className="mt-2 space-y-2">
              {rows.map((row, index) => (
                <div
                  key={index}
                  className="rounded-xl border border-[rgb(var(--color-border))] bg-[rgb(var(--color-surface-alt))]/50 px-3 py-2"
                >
                  <div className="mb-2 flex items-center justify-between gap-3">
                    <span className="text-xs font-medium text-[rgb(var(--color-text))]">Row {index + 1}</span>
                    <span className="truncate text-[11px] text-[rgb(var(--color-text-secondary))]">
                      {row.time || row.narrative || "Untitled beat"}
                    </span>
                  </div>
                  <div className="flex gap-2">
                    <input
                      value={options.visualFrameManifestPaths[index] ?? ""}
                      onChange={(event) => updateManifestPath(index, event.target.value)}
                      placeholder={`.cutready/visuals/row-${index + 1}/frames.json`}
                      className="min-w-0 flex-1 rounded-lg border border-[rgb(var(--color-border))] bg-[rgb(var(--color-surface))] px-3 py-2 text-xs text-[rgb(var(--color-text))] outline-none transition-colors placeholder:text-[rgb(var(--color-text-secondary))] focus:border-[rgb(var(--color-accent))]"
                      data-testid={`video-export-frame-manifest-${index + 1}`}
                    />
                    <button
                      type="button"
                      onClick={() => void chooseJsonPath((relativePath) => updateManifestPath(index, relativePath))}
                      className="inline-flex items-center gap-1.5 rounded-lg border border-[rgb(var(--color-border))] px-3 py-2 text-xs font-medium text-[rgb(var(--color-text))] transition-colors hover:bg-[rgb(var(--color-surface-alt))]"
                    >
                      <Folder className="h-3.5 w-3.5" />
                      Browse
                    </button>
                  </div>
                </div>
              ))}
            </div>
          </div>

          {pathError && (
            <div className="rounded-xl border border-[rgb(var(--color-warning))]/30 bg-[rgb(var(--color-warning))]/10 px-3 py-2 text-xs text-[rgb(var(--color-text))]">
              {pathError}
            </div>
          )}
          {resolvedDemoExportBlock && (
            <div
              id="video-export-resolved-demo-block"
              aria-live="polite"
              className="rounded-xl border border-[rgb(var(--color-warning))]/30 bg-[rgb(var(--color-warning))]/10 px-3 py-2 text-xs text-[rgb(var(--color-text))]"
            >
              {resolvedDemoExportBlock}
            </div>
          )}
        </div>

        <div className="flex justify-end gap-2 border-t border-[rgb(var(--color-border))] px-5 py-4">
          <button
            type="button"
            onClick={onClose}
            className="rounded-lg border border-[rgb(var(--color-border))] px-3 py-2 text-xs font-medium text-[rgb(var(--color-text))] transition-colors hover:bg-[rgb(var(--color-surface-alt))]"
          >
            Cancel
          </button>
          <button
            type="button"
            disabled={Boolean(resolvedDemoExportBlock)}
            aria-describedby={resolvedDemoExportBlock ? "video-export-resolved-demo-block" : undefined}
            onClick={() => {
              if (resolvedDemoExportBlock) return;
              onExport(normalizeVideoExportOptions(options, rows.length));
            }}
            className="rounded-lg bg-[rgb(var(--color-accent))] px-3 py-2 text-xs font-semibold text-[rgb(var(--color-accent-fg))] transition-colors hover:bg-[rgb(var(--color-accent-hover))] disabled:cursor-not-allowed disabled:opacity-50"
            data-testid="video-export-options-submit"
          >
            Export video
          </button>
        </div>
      </div>
    </Dialog>
  );
}

export function ResolvedDemoCoverageRow({
  coverage,
  inspection,
}: {
  coverage: ReturnType<typeof getVideoExportCoverage>[number];
  inspection: ResolvedDemoRowInspection | null;
}) {
  return (
    <div className="grid grid-cols-[3rem_minmax(0,1fr)_auto_auto] items-center gap-2 rounded-xl border border-[rgb(var(--color-border))]/70 bg-[rgb(var(--color-surface))]/70 px-2.5 py-2 text-[11px]">
      <span className="font-medium text-[rgb(var(--color-text-secondary))]">Row {coverage.rowNumber}</span>
      <span className="min-w-0">
        <span className="block truncate text-[rgb(var(--color-text))]">{coverage.label}</span>
        {inspection && (
          <>
            <span className="mt-0.5 block truncate text-[rgb(var(--color-text-secondary))]">
              {inspection.segmentCount} segment{inspection.segmentCount === 1 ? "" : "s"}
              {inspection.durationSeconds != null ? `, ${formatCompactSeconds(inspection.durationSeconds)}` : ""}
              {inspection.mediaAssetCount > 0 ? `, ${inspection.mediaAssetCount} demo media asset${inspection.mediaAssetCount === 1 ? "" : "s"}` : ""}
              {inspection.missingAssetCount > 0 ? `, ${inspection.missingAssetCount} missing demo asset${inspection.missingAssetCount === 1 ? "" : "s"}` : ""}
              {inspection.invalidAssetCount > 0 ? `, ${inspection.invalidAssetCount} invalid demo asset${inspection.invalidAssetCount === 1 ? "" : "s"}` : ""}
            </span>
            {(inspection.steps ?? []).length > 0 && (
              <span className="mt-0.5 block truncate text-[10px] text-[rgb(var(--color-text-secondary))]">
                Demo doc: {summarizeResolvedDemoSteps(inspection.steps ?? [])}
              </span>
            )}
          </>
        )}
      </span>
      <SourceBadge source={coverage.mediaSource} />
      <TimingBadge source={coverage.timingSource} />
    </div>
  );
}

export function ResolvedDemoInspectionPanel({ state }: { state: ResolvedDemoInspectionState | null }) {
  if (!state) return null;
  if (state.loading) {
    return (
      <div className="mt-3 rounded-xl border border-[rgb(var(--color-border))] bg-[rgb(var(--color-surface))]/70 px-3 py-2 text-xs text-[rgb(var(--color-text-secondary))]">
        Inspecting resolved demo...
      </div>
    );
  }
  if (state.error) {
    return (
      <div className="mt-3 rounded-xl border border-[rgb(var(--color-warning))]/30 bg-[rgb(var(--color-warning))]/10 px-3 py-2 text-xs leading-5 text-[rgb(var(--color-text))]">
        Could not inspect resolved demo: {state.error}
      </div>
    );
  }
  if (!state.inspection) return null;

  const diagnostics = state.inspection.diagnostics.slice(0, 3);
  return (
    <div className="mt-3 rounded-xl border border-[rgb(var(--color-border))] bg-[rgb(var(--color-surface))]/70 px-3 py-2 text-xs leading-5 text-[rgb(var(--color-text-secondary))]">
      <div className="flex flex-wrap items-center gap-2">
        <span className="font-semibold text-[rgb(var(--color-text))]">{state.inspection.title}</span>
        <span>{state.inspection.rowCount} row{state.inspection.rowCount === 1 ? "" : "s"}</span>
        <span>{state.inspection.diagnosticCount} diagnostic{state.inspection.diagnosticCount === 1 ? "" : "s"}</span>
        <span className={state.inspection.canExport ? "text-[rgb(var(--color-accent))]" : "text-[rgb(var(--color-warning))]"}>
          {state.inspection.canExport ? "schema valid" : "blocked"}
        </span>
      </div>
      {state.inspection.blockingError && (
        <div className="mt-1 text-[rgb(var(--color-warning))]">{state.inspection.blockingError}</div>
      )}
      {diagnostics.length > 0 && (
        <div className="mt-2 space-y-1">
          {diagnostics.map((diagnostic, index) => (
            <div key={`${index}-${diagnostic.severity}-${diagnostic.code}-${diagnostic.message}`}>
              <span className="font-medium text-[rgb(var(--color-text))]">{diagnostic.severity}</span>{" "}
              <span className="font-mono">{diagnostic.code}</span>: {diagnostic.message}
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

export function formatCompactSeconds(value: number): string {
  return `${value.toFixed(value < 10 ? 2 : 1).replace(/\.?0+$/, "")}s`;
}

export function summarizeResolvedDemoSteps(steps: ResolvedDemoStepInspection[]): string {
  const visibleSteps = steps.slice(0, 2).map(summarizeResolvedDemoStep);
  const remaining = steps.length - visibleSteps.length;
  return `${visibleSteps.join("; ")}${remaining > 0 ? ` +${remaining} more` : ""}`;
}

export function summarizeResolvedDemoStep(step: ResolvedDemoStepInspection): string {
  const targetSummary = step.targetLabels.length > 0
    ? ` -> ${step.targetLabels.slice(0, 2).join(", ")}${step.targetLabels.length > 2 ? ` +${step.targetLabels.length - 2}` : ""}`
    : "";
  return `${step.title}${targetSummary}`;
}

export function SourceBadge({ source }: { source: VideoExportMediaSource }) {
  const label = {
    "frame-manifest": "frames",
    visual: "visual",
    "resolved-demo": "Scenecast media",
    screenshot: "screenshot",
    missing: "missing media",
  }[source];
  const tone = source === "missing"
    ? "border-[rgb(var(--color-warning))]/30 bg-[rgb(var(--color-warning))]/10 text-[rgb(var(--color-warning))]"
    : source === "resolved-demo"
      ? "border-[rgb(var(--color-accent))]/30 bg-[rgb(var(--color-accent))]/10 text-[rgb(var(--color-accent))]"
      : "border-[rgb(var(--color-border))] bg-[rgb(var(--color-surface-alt))] text-[rgb(var(--color-text-secondary))]";

  return <span className={`whitespace-nowrap rounded-full border px-2 py-0.5 font-medium ${tone}`}>{label}</span>;
}

export function TimingBadge({ source }: { source: VideoExportTimingSource }) {
  return (
    <span className="whitespace-nowrap rounded-full border border-[rgb(var(--color-border))] bg-[rgb(var(--color-surface-alt))] px-2 py-0.5 font-medium text-[rgb(var(--color-text-secondary))]">
      {source === "resolved-demo" ? "Scenecast timing" : "sketch timing"}
    </span>
  );
}

export function VideoExportProgressDialog({
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
      <div className="cr-modal-surface overflow-hidden">
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
            <div className="mb-2 flex items-center justify-between text-xs font-medium uppercase tracking-[0.14em] text-[rgb(var(--color-text-secondary))]">
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

export function NarrationGenerationProgressDialog({
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
      <div className="cr-modal-surface overflow-hidden">
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
            <div className="mb-2 flex items-center justify-between text-xs font-medium uppercase tracking-[0.14em] text-[rgb(var(--color-text-secondary))]">
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
