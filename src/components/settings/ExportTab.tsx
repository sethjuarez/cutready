import { useEffect, useState } from "react";
import { CheckCircle, ExternalLink, Info, RefreshCw } from "lucide-react";
import { open as dialogOpen } from "@tauri-apps/plugin-dialog";
import { open as shellOpen } from "@tauri-apps/plugin-shell";
import { useSettings, type AppSettings } from "../../hooks/useSettings";
import { useFfmpegStatus } from "../../hooks/useFfmpegStatus";
import { convertFileSrc, invoke } from "../../services/tauri";
import { useToastStore } from "../../stores/toastStore";
import { ensureCachedNarrationVoicePreview } from "../../services/narrationVoicePreview";
import { inputClass } from "../../styles";

function inferSiblingFfprobePath(ffmpegPath: string): string | null {
  if (!ffmpegPath.trim()) return null;
  if (/ffmpeg\.exe$/i.test(ffmpegPath)) return ffmpegPath.replace(/ffmpeg\.exe$/i, "ffprobe.exe");
  if (/ffmpeg$/i.test(ffmpegPath)) return ffmpegPath.replace(/ffmpeg$/i, "ffprobe");
  return null;
}

function formatSecondsLabel(seconds: number): string {
  if (!Number.isFinite(seconds) || seconds <= 0) return "unknown";
  const minutes = Math.floor(seconds / 60);
  const remaining = Math.round(seconds % 60).toString().padStart(2, "0");
  return `${minutes}:${remaining}`;
}

export function ExportTab({
  settings,
  updateSetting,
  scope,
}: {
  settings: ReturnType<typeof useSettings>["settings"];
  updateSetting: ReturnType<typeof useSettings>["updateSetting"];
  scope: "app" | "workspace";
}) {
  type AppExportNumberKey =
    | "videoExportTitleCardDurationSeconds"
    | "videoExportTitleToFirstRowHoldSeconds"
    | "videoExportRowTransitionHoldSeconds"
    | "videoExportFinalHoldSeconds"
    | "videoExportRowTransitionDipSeconds"
    | "videoExportNarrationTailHoldSeconds"
    | "videoExportMotionMaxScale"
    | "videoExportWidth"
    | "videoExportHeight"
    | "videoExportFps";
  type WorkspaceExportNumberKey =
    | "workspaceVideoExportTitleCardDurationSeconds"
    | "workspaceVideoExportTitleToFirstRowHoldSeconds"
    | "workspaceVideoExportRowTransitionHoldSeconds"
    | "workspaceVideoExportFinalHoldSeconds"
    | "workspaceVideoExportRowTransitionDipSeconds"
    | "workspaceVideoExportNarrationTailHoldSeconds"
    | "workspaceVideoExportMotionMaxScale"
    | "workspaceVideoExportWidth"
    | "workspaceVideoExportHeight"
    | "workspaceVideoExportFps";
  type AppExportBooleanKey = "videoExportIncludeTitleCard";
  type WorkspaceExportBooleanKey = "workspaceVideoExportIncludeTitleCard";
  type AppExportTextKey = "videoExportEncoder" | "videoExportPixelFormat" | "videoExportCrf";
  type WorkspaceExportTextKey = "workspaceVideoExportEncoder" | "workspaceVideoExportPixelFormat" | "workspaceVideoExportCrf";
  const timingFields: Array<{
    appKey: AppExportNumberKey;
    workspaceKey: WorkspaceExportNumberKey;
    label: string;
    description: string;
    min?: number;
    max?: number;
    step?: number;
    unit?: string;
  }> = [
    {
      appKey: "videoExportTitleCardDurationSeconds",
      workspaceKey: "workspaceVideoExportTitleCardDurationSeconds",
      label: "Title card",
      description: "How long the sketch title and description stay on screen before the demo begins.",
      min: 0.1,
      step: 0.1,
      unit: "sec",
    },
    {
      appKey: "videoExportTitleToFirstRowHoldSeconds",
      workspaceKey: "workspaceVideoExportTitleToFirstRowHoldSeconds",
      label: "Lead into first row",
      description: "Silent hold on the first row screenshot before narration starts.",
      min: 0.1,
      step: 0.1,
      unit: "sec",
    },
    {
      appKey: "videoExportRowTransitionHoldSeconds",
      workspaceKey: "workspaceVideoExportRowTransitionHoldSeconds",
      label: "Between rows",
      description: "Transition hold split evenly between the previous screenshot and the next screenshot.",
      min: 0.1,
      step: 0.1,
      unit: "sec",
    },
    {
      appKey: "videoExportFinalHoldSeconds",
      workspaceKey: "workspaceVideoExportFinalHoldSeconds",
      label: "Final hold",
      description: "How long the last screenshot remains on screen after the final narration ends.",
      min: 0.1,
      step: 0.1,
      unit: "sec",
    },
    {
      appKey: "videoExportRowTransitionDipSeconds",
      workspaceKey: "workspaceVideoExportRowTransitionDipSeconds",
      label: "Dip to black",
      description: "Fade duration used inside the row-to-row transition hold.",
      min: 0,
      step: 0.05,
      unit: "sec",
    },
    {
      appKey: "videoExportNarrationTailHoldSeconds",
      workspaceKey: "workspaceVideoExportNarrationTailHoldSeconds",
      label: "Narration tail",
      description: "Extra visual hold after each row's narration audio completes.",
      min: 0,
      step: 0.05,
      unit: "sec",
    },
  ];
  const renderNumberFields: Array<{
    appKey: AppExportNumberKey;
    workspaceKey: WorkspaceExportNumberKey;
    label: string;
    description: string;
    min: number;
    max?: number;
    step: number;
    unit?: string;
  }> = [
    {
      appKey: "videoExportMotionMaxScale",
      workspaceKey: "workspaceVideoExportMotionMaxScale",
      label: "Max motion push",
      description: "Upper zoom limit for generated screenshot camera moves.",
      min: 1,
      max: 3,
      step: 0.05,
      unit: "x",
    },
    {
      appKey: "videoExportFps",
      workspaceKey: "workspaceVideoExportFps",
      label: "Frame rate",
      description: "Frames per second for generated video clips.",
      min: 12,
      max: 120,
      step: 1,
      unit: "fps",
    },
    {
      appKey: "videoExportWidth",
      workspaceKey: "workspaceVideoExportWidth",
      label: "Width",
      description: "Output frame width in pixels.",
      min: 240,
      max: 7680,
      step: 2,
      unit: "px",
    },
    {
      appKey: "videoExportHeight",
      workspaceKey: "workspaceVideoExportHeight",
      label: "Height",
      description: "Output frame height in pixels.",
      min: 240,
      max: 7680,
      step: 2,
      unit: "px",
    },
  ];
  const codecFields: Array<{
    appKey: AppExportTextKey;
    workspaceKey: WorkspaceExportTextKey;
    label: string;
    description: string;
  }> = [
    {
      appKey: "videoExportEncoder",
      workspaceKey: "workspaceVideoExportEncoder",
      label: "Video encoder",
      description: "FFmpeg encoder for intermediate clips and final MP4.",
    },
    {
      appKey: "videoExportPixelFormat",
      workspaceKey: "workspaceVideoExportPixelFormat",
      label: "Pixel format",
      description: "FFmpeg pixel format. rgb24 preserves screenshot color fidelity.",
    },
    {
      appKey: "videoExportCrf",
      workspaceKey: "workspaceVideoExportCrf",
      label: "CRF / quality",
      description: "CRF value passed to FFmpeg. 0 keeps the current lossless behavior.",
    },
  ];

  const isWorkspace = scope === "workspace";
  const disabled = isWorkspace && !settings.videoExportOverrideEnabled;
  const typingTypographyDisabled = isWorkspace && !settings.typingOverlayOverrideEnabled;
  const typingFontFamilyKey = isWorkspace
    ? "workspaceTypingOverlayFontFamily"
    : "typingOverlayFontFamily";
  const typingFontScaleKey = isWorkspace
    ? "workspaceTypingOverlayFontScale"
    : "typingOverlayFontScale";
  const typingFontFamily = settings[typingFontFamilyKey];
  const typingFontScale = settings[typingFontScaleKey];
  const includeTitleCardKey: AppExportBooleanKey | WorkspaceExportBooleanKey = isWorkspace
    ? "workspaceVideoExportIncludeTitleCard"
    : "videoExportIncludeTitleCard";
  const selectedBackgroundMusicTrack = settings.videoExportBackgroundMusicTracks.find(
    (track) => track.id === settings.videoExportBackgroundMusicTrackId,
  ) ?? null;
  const backgroundMusicDisabled = isWorkspace || !selectedBackgroundMusicTrack;
  const [importingBackgroundMusic, setImportingBackgroundMusic] = useState(false);
  const [previewingBackgroundMusic, setPreviewingBackgroundMusic] = useState(false);
  const [backgroundMusicPreview, setBackgroundMusicPreview] = useState<{
    path: string;
    durationSeconds: number;
  } | null>(null);
  const { status: ffmpegStatus, loading: ffmpegChecking, refresh: refreshFfmpegStatus } = useFfmpegStatus();
  const ffmpegVersion = ffmpegStatus?.version?.split(/\r?\n/)[0] ?? null;
  const ffprobeVersion = ffmpegStatus?.ffprobe_version?.split(/\r?\n/)[0] ?? null;
  const updateNumber = <K extends AppExportNumberKey | WorkspaceExportNumberKey>(
    key: K,
    value: string,
    min = 0.1,
    max?: number,
  ) => {
    const parsed = Number.parseFloat(value);
    const lowerBounded = Number.isFinite(parsed) ? Math.max(min, parsed) : min;
    const nextValue = max === undefined ? lowerBounded : Math.min(max, lowerBounded);
    void updateSetting(key, nextValue as AppSettings[K]);
  };

  useEffect(() => {
    void refreshFfmpegStatus();
  }, [refreshFfmpegStatus]);

  const chooseExecutable = async (kind: "ffmpeg" | "ffprobe") => {
    const selected = await dialogOpen({
      multiple: false,
      title: kind === "ffmpeg" ? "Locate FFmpeg executable" : "Locate FFprobe executable",
    });
    if (!selected || Array.isArray(selected)) return;

    if (kind === "ffmpeg") {
      await updateSetting("ffmpegExecutablePath", selected);
      if (!settings.ffprobeExecutablePath) {
        const inferred = inferSiblingFfprobePath(selected);
        if (inferred) {
          await updateSetting("ffprobeExecutablePath", inferred);
        }
      }
    } else {
      await updateSetting("ffprobeExecutablePath", selected);
    }
    await refreshFfmpegStatus();
  };

  const clearExecutablePaths = async () => {
    await updateSetting("ffmpegExecutablePath", "");
    await updateSetting("ffprobeExecutablePath", "");
    await refreshFfmpegStatus();
  };

  const importBackgroundMusic = async () => {
    if (isWorkspace) return;
    const selected = await dialogOpen({
      multiple: false,
      title: "Choose loopable background music WAV",
      filters: [{ name: "WAV audio", extensions: ["wav"] }],
    });
    if (!selected || Array.isArray(selected)) return;

    setImportingBackgroundMusic(true);
    try {
      const track = await invoke<{
        id: string;
        name: string;
        path: string;
        durationSeconds?: number;
      }>("import_background_music", { sourcePath: selected });
      const tracks = settings.videoExportBackgroundMusicTracks.filter((existing) => existing.id !== track.id);
      await updateSetting("videoExportBackgroundMusicTracks", [...tracks, track]);
      await updateSetting("videoExportBackgroundMusicTrackId", track.id);
      useToastStore.getState().show("Background music added to your app library.", 3000, "success");
    } catch (err) {
      useToastStore.getState().show(`Could not add background music: ${err}`, 5000, "error");
    } finally {
      setImportingBackgroundMusic(false);
    }
  };

  const removeBackgroundMusic = async (trackId: string) => {
    const track = settings.videoExportBackgroundMusicTracks.find((candidate) => candidate.id === trackId);
    if (!track) return;
    try {
      await invoke("delete_background_music", { relativePath: track.path });
      await updateSetting(
        "videoExportBackgroundMusicTracks",
        settings.videoExportBackgroundMusicTracks.filter((candidate) => candidate.id !== trackId),
      );
      if (settings.videoExportBackgroundMusicTrackId === trackId) {
        await updateSetting("videoExportBackgroundMusicTrackId", "");
      }
      useToastStore.getState().show("Background music removed.", 3000, "success");
    } catch (err) {
      useToastStore.getState().show(`Could not remove background music: ${err}`, 5000, "error");
    }
  };

  const previewBackgroundMusicMix = async () => {
    if (!selectedBackgroundMusicTrack || backgroundMusicDisabled) return;
    setPreviewingBackgroundMusic(true);
    try {
      const voicePreview = await ensureCachedNarrationVoicePreview({
        settings,
        updateSetting,
      });
      const preview = await invoke<{
        path: string;
        durationSeconds: number;
      }>("preview_background_music_mix", {
        settings: {
          backgroundMusicPath: selectedBackgroundMusicTrack.path,
          narrationVoiceName: settings.narrationVoiceName,
          narrationVoiceOutputFormat: settings.narrationSpeechOutputFormat,
          backgroundMusicVolumeDb: settings.videoExportBackgroundMusicVolumeDb,
          backgroundMusicDuckNarration: settings.videoExportBackgroundMusicDuckNarration,
          backgroundMusicFadeSeconds: settings.videoExportBackgroundMusicFadeSeconds,
        },
      });
      setBackgroundMusicPreview(preview);
      useToastStore.getState().show(
        voicePreview.generated
          ? "Generated the voice sample and rendered the mix preview."
          : "Rendered a voice and music preview.",
        3500,
        "success",
      );
    } catch (err) {
      useToastStore.getState().show(`Could not preview background music: ${err}`, 5000, "error");
    } finally {
      setPreviewingBackgroundMusic(false);
    }
  };

  return (
    <div className="flex flex-col gap-6">
      <p className="text-xs text-[rgb(var(--color-text-secondary))]">
        {isWorkspace
          ? "Override the app-level sketch video export defaults for this workspace."
          : "These app defaults apply when exporting a sketch directly to MP4. The current rhythm is tuned for screenshots plus narration."}
      </p>

      {isWorkspace && (
        <label className="flex items-center justify-between gap-4 rounded-xl border border-[rgb(var(--color-border))] bg-[rgb(var(--color-surface-alt))]/40 p-4">
          <span>
            <span className="block text-sm font-medium text-[rgb(var(--color-text))]">Use workspace export settings</span>
            <span className="mt-1 block text-xs text-[rgb(var(--color-text-secondary))]">
              When off, this workspace uses the app-level Export settings.
            </span>
          </span>
          <input
            type="checkbox"
            checked={settings.videoExportOverrideEnabled}
            onChange={(event) => updateSetting("videoExportOverrideEnabled", event.target.checked)}
            className="h-4 w-4 accent-[rgb(var(--color-accent))]"
          />
        </label>
      )}

      <fieldset className="flex flex-col gap-3 rounded-xl border border-[rgb(var(--color-border))] bg-[rgb(var(--color-surface-alt))]/40 p-4">
        <div>
          <label className="text-sm font-medium">Typing overlay typography</label>
          <p className="mt-1 text-xs text-[rgb(var(--color-text-secondary))]">
            Default type styling for new typing overlays. Individual overlays can still override these values.
          </p>
        </div>

        {isWorkspace && (
          <label className="flex items-center justify-between gap-4 rounded-lg border border-[rgb(var(--color-border))] bg-[rgb(var(--color-surface))] px-3 py-2.5">
            <span className="min-w-0">
              <span className="block text-xs font-semibold text-[rgb(var(--color-text))]">Use workspace typography</span>
              <span className="mt-0.5 block text-[11px] leading-4 text-[rgb(var(--color-text-secondary))]">
                When off, new overlays use the app-level typography defaults.
              </span>
            </span>
            <input
              type="checkbox"
              checked={settings.typingOverlayOverrideEnabled}
              onChange={(event) => updateSetting("typingOverlayOverrideEnabled", event.target.checked)}
              className="h-4 w-4 shrink-0 accent-[rgb(var(--color-accent))]"
            />
          </label>
        )}

        <div className="grid grid-cols-2 gap-3">
          <label className="min-w-0 text-xs font-medium text-[rgb(var(--color-text))]">
            Font
            <select
              value={typingFontFamily}
              onChange={(event) => updateSetting(
                typingFontFamilyKey,
                event.target.value as AppSettings[typeof typingFontFamilyKey],
              )}
              disabled={typingTypographyDisabled}
              className="mt-1 block w-full rounded-md border border-[rgb(var(--color-border))] bg-[rgb(var(--color-surface))] px-2 py-1.5 text-xs disabled:cursor-not-allowed disabled:opacity-50"
            >
              <option value="sans">Sans</option>
              <option value="serif">Serif</option>
              <option value="mono">Mono</option>
            </select>
          </label>
          <label className="min-w-0 text-xs font-medium text-[rgb(var(--color-text))]">
            Size <span className="font-mono text-[rgb(var(--color-text-secondary))]">{Math.round(typingFontScale * 100)}%</span>
            <input
              type="range"
              min="0.4"
              max="1.8"
              step="0.1"
              value={typingFontScale}
              onChange={(event) => updateSetting(
                typingFontScaleKey,
                Number(event.target.value) as AppSettings[typeof typingFontScaleKey],
              )}
              disabled={typingTypographyDisabled}
              className="mt-2 block w-full accent-[rgb(var(--color-accent))] disabled:cursor-not-allowed disabled:opacity-50"
            />
          </label>
        </div>
      </fieldset>

      <fieldset className="flex flex-col gap-3 rounded-xl border border-[rgb(var(--color-border))] bg-[rgb(var(--color-surface-alt))]/40 p-4">
        <div>
          <label className="text-sm font-medium">Sketch video timing</label>
          <p className="mt-1 text-xs text-[rgb(var(--color-text-secondary))]">
            Adjust the pacing around the generated title card, row transitions, and ending hold.
          </p>
        </div>

        <label className="flex items-center justify-between gap-4 rounded-lg border border-[rgb(var(--color-border))] bg-[rgb(var(--color-surface))] px-3 py-2.5">
          <span className="min-w-0">
            <span className="block text-xs font-semibold text-[rgb(var(--color-text))]">Include title card</span>
            <span className="mt-0.5 block text-[11px] leading-4 text-[rgb(var(--color-text-secondary))]">
              Start the video with the sketch title and description.
            </span>
            {isWorkspace && !settings.videoExportOverrideEnabled && (
              <span className="mt-1 block text-[10px] text-[rgb(var(--color-text-secondary))]">
                App default: {settings.videoExportIncludeTitleCard ? "on" : "off"}
              </span>
            )}
          </span>
          <input
            type="checkbox"
            checked={settings[includeTitleCardKey]}
            onChange={(event) => updateSetting(includeTitleCardKey, event.target.checked)}
            disabled={disabled}
            className="h-4 w-4 shrink-0 accent-[rgb(var(--color-accent))]"
          />
        </label>

        <div className="grid gap-3 md:grid-cols-2">
          {timingFields.map((field) => {
            const key = isWorkspace ? field.workspaceKey : field.appKey;
            const fallbackValue = settings[field.appKey];
            const value = settings[key];
            const fieldDisabled = disabled || (
              field.appKey === "videoExportTitleCardDurationSeconds" && !settings[includeTitleCardKey]
            );
            return (
              <label
                key={key}
                className="grid gap-3 rounded-lg border border-[rgb(var(--color-border))] bg-[rgb(var(--color-surface))] px-3 py-2.5 sm:grid-cols-[minmax(0,1fr)_9rem] sm:items-center"
              >
                <span className="min-w-0">
                  <span className="block text-xs font-semibold text-[rgb(var(--color-text))]">{field.label}</span>
                  <span className="mt-0.5 block text-[11px] leading-4 text-[rgb(var(--color-text-secondary))]">
                    {field.description}
                  </span>
                  {isWorkspace && !settings.videoExportOverrideEnabled && (
                    <span className="mt-1 block text-[10px] text-[rgb(var(--color-text-secondary))]">
                      App default: {fallbackValue}s
                    </span>
                  )}
                </span>
                <span className="flex items-center gap-2 sm:justify-end">
                  <input
                    type="number"
                    min={field.min ?? 0.1}
                    max={field.max}
                    step={field.step ?? 0.1}
                    value={value}
                    onChange={(event) => updateNumber(key, event.target.value, field.min ?? 0.1, field.max)}
                    disabled={fieldDisabled}
                    className={`${inputClass} min-w-0 flex-1 sm:w-24 sm:flex-none`}
                  />
                  <span className="w-8 text-[11px] font-medium text-[rgb(var(--color-text-secondary))]">{field.unit ?? "sec"}</span>
                </span>
              </label>
            );
          })}
        </div>
      </fieldset>

      <fieldset className="flex flex-col gap-3 rounded-xl border border-[rgb(var(--color-border))] bg-[rgb(var(--color-surface-alt))]/40 p-4">
        <div>
          <label className="text-sm font-medium">Motion and render profile</label>
          <p className="mt-1 text-xs text-[rgb(var(--color-text-secondary))]">
            Control camera-move limits and the generated MP4 frame shape.
          </p>
        </div>
        <div className="grid gap-3 md:grid-cols-2">
          {renderNumberFields.map((field) => {
            const key = isWorkspace ? field.workspaceKey : field.appKey;
            const fallbackValue = settings[field.appKey];
            const value = settings[key];
            return (
              <label key={key} className="grid gap-3 rounded-lg border border-[rgb(var(--color-border))] bg-[rgb(var(--color-surface))] px-3 py-2.5 sm:grid-cols-[minmax(0,1fr)_9rem] sm:items-center">
                <span className="min-w-0">
                  <span className="block text-xs font-semibold text-[rgb(var(--color-text))]">{field.label}</span>
                  <span className="mt-0.5 block text-[11px] leading-4 text-[rgb(var(--color-text-secondary))]">{field.description}</span>
                  {isWorkspace && !settings.videoExportOverrideEnabled && (
                    <span className="mt-1 block text-[10px] text-[rgb(var(--color-text-secondary))]">
                      App default: {fallbackValue}{field.unit ? ` ${field.unit}` : ""}
                    </span>
                  )}
                </span>
                <span className="flex items-center gap-2 sm:justify-end">
                  <input
                    type="number"
                    min={field.min}
                    max={field.max}
                    step={field.step}
                    value={value}
                    onChange={(event) => updateNumber(key, event.target.value, field.min, field.max)}
                    disabled={disabled}
                    className={`${inputClass} min-w-0 flex-1 sm:w-24 sm:flex-none`}
                  />
                  <span className="w-8 text-[11px] font-medium text-[rgb(var(--color-text-secondary))]">{field.unit ?? ""}</span>
                </span>
              </label>
            );
          })}
        </div>
      </fieldset>

      <fieldset className="flex flex-col gap-3 rounded-xl border border-[rgb(var(--color-border))] bg-[rgb(var(--color-surface-alt))]/40 p-4">
        <div>
          <label className="text-sm font-medium">Codec and quality</label>
          <p className="mt-1 text-xs text-[rgb(var(--color-text-secondary))]">
            Advanced FFmpeg values. Invalid values will make export fail instead of silently changing quality.
          </p>
        </div>
        <div className="grid gap-3 md:grid-cols-3">
          {codecFields.map((field) => {
            const key = isWorkspace ? field.workspaceKey : field.appKey;
            const fallbackValue = settings[field.appKey];
            const value = settings[key];
            return (
              <label key={key} className="rounded-lg border border-[rgb(var(--color-border))] bg-[rgb(var(--color-surface))] px-3 py-2.5">
                <span className="min-w-0">
                  <span className="block text-xs font-semibold text-[rgb(var(--color-text))]">{field.label}</span>
                  <span className="mt-0.5 block text-[11px] leading-4 text-[rgb(var(--color-text-secondary))]">{field.description}</span>
                  {isWorkspace && !settings.videoExportOverrideEnabled && (
                    <span className="mt-1 block text-[10px] text-[rgb(var(--color-text-secondary))]">App default: {fallbackValue}</span>
                  )}
                </span>
                <input
                  type="text"
                  value={value}
                  onChange={(event) => updateSetting(key, event.target.value)}
                  disabled={disabled}
                  className={`${inputClass} mt-3 w-full min-w-0`}
                />
              </label>
            );
          })}
        </div>
      </fieldset>

      <fieldset className="flex flex-col gap-3 rounded-xl border border-[rgb(var(--color-border))] bg-[rgb(var(--color-surface-alt))]/40 p-4">
        <div className="flex flex-col gap-3 md:flex-row md:items-start md:justify-between">
          <div>
            <label className="text-sm font-medium">Background music</label>
            <p className="mt-1 text-xs text-[rgb(var(--color-text-secondary))]">
              Keep reusable WAV beds in your app library and mix one under exported narration.
            </p>
          </div>
          {!isWorkspace && (
            <button
              type="button"
              onClick={() => void importBackgroundMusic()}
              disabled={importingBackgroundMusic}
              className="inline-flex items-center justify-center rounded-lg border border-[rgb(var(--color-border))] bg-[rgb(var(--color-surface))] px-3 py-2 text-xs font-medium text-[rgb(var(--color-text))] transition-colors hover:border-[rgb(var(--color-border-strong))] disabled:cursor-not-allowed disabled:opacity-60"
            >
              {importingBackgroundMusic ? "Adding..." : "Add WAV loop..."}
            </button>
          )}
        </div>

        {isWorkspace ? (
          <div className="rounded-lg border border-[rgb(var(--color-border))] bg-[rgb(var(--color-surface))] px-3 py-2.5 text-[11px] leading-4 text-[rgb(var(--color-text-secondary))]">
            Background music is an app-wide library. Choose the music and mix defaults from the app Export settings.
          </div>
        ) : (
          <>
            <div className="grid gap-2 md:grid-cols-[minmax(0,1fr)_auto] md:items-center">
              <label className="grid gap-3 rounded-lg border border-[rgb(var(--color-border))] bg-[rgb(var(--color-surface))] px-3 py-2.5 md:grid-cols-[minmax(0,1fr)_18rem] md:items-center">
                <span className="min-w-0">
                  <span className="block text-xs font-semibold text-[rgb(var(--color-text))]">Selected music</span>
                  <span className="mt-0.5 block text-[11px] leading-4 text-[rgb(var(--color-text-secondary))]">
                    Choose the loop to repeat for the full export. None leaves narration unchanged.
                  </span>
                </span>
                <select
                  value={settings.videoExportBackgroundMusicTrackId}
                  onChange={(event) => updateSetting("videoExportBackgroundMusicTrackId", event.target.value)}
                  className={`${inputClass} min-w-0`}
                >
                  <option value="">None</option>
                  {settings.videoExportBackgroundMusicTracks.map((track) => (
                    <option key={track.id} value={track.id}>
                      {track.name}{track.durationSeconds ? ` (${formatSecondsLabel(track.durationSeconds)})` : ""}
                    </option>
                  ))}
                </select>
              </label>
              {selectedBackgroundMusicTrack && (
                <button
                  type="button"
                  onClick={() => void removeBackgroundMusic(selectedBackgroundMusicTrack.id)}
                  className="rounded-lg border border-[rgb(var(--color-border))] bg-[rgb(var(--color-surface))] px-3 py-2 text-xs font-medium text-[rgb(var(--color-text-secondary))] transition-colors hover:border-[rgb(var(--color-border-strong))] hover:text-[rgb(var(--color-text))]"
                >
                  Remove selected
                </button>
              )}
            </div>

            {selectedBackgroundMusicTrack && (
              <label className="grid gap-3 rounded-lg border border-[rgb(var(--color-border))] bg-[rgb(var(--color-surface))] px-3 py-2.5 md:grid-cols-[minmax(0,1fr)_18rem] md:items-center">
                <span className="min-w-0">
                  <span className="block text-xs font-semibold text-[rgb(var(--color-text))]">Track name</span>
                  <span className="mt-0.5 block text-[11px] leading-4 text-[rgb(var(--color-text-secondary))]">
                    This name appears wherever you choose background music.
                  </span>
                </span>
                <input
                  type="text"
                  value={selectedBackgroundMusicTrack.name}
                  onChange={(event) => {
                    const tracks = settings.videoExportBackgroundMusicTracks.map((track) => (
                      track.id === selectedBackgroundMusicTrack.id
                        ? { ...track, name: event.target.value }
                        : track
                    ));
                    void updateSetting("videoExportBackgroundMusicTracks", tracks);
                  }}
                  className={`${inputClass} min-w-0`}
                />
              </label>
            )}

            <div className="grid gap-2 md:grid-cols-3">
              <label className="rounded-lg border border-[rgb(var(--color-border))] bg-[rgb(var(--color-surface))] px-3 py-2.5">
                <span className="block text-xs font-semibold text-[rgb(var(--color-text))]">Volume</span>
                <span className="mt-0.5 block text-[11px] leading-4 text-[rgb(var(--color-text-secondary))]">Gain applied before mixing.</span>
                <div className="mt-3 flex items-center gap-2">
                  <input
                    type="number"
                    min={-60}
                    max={0}
                    step={1}
                    value={settings.videoExportBackgroundMusicVolumeDb}
                    onChange={(event) => updateSetting("videoExportBackgroundMusicVolumeDb", Math.min(0, Math.max(-60, Number.parseFloat(event.target.value) || -24)))}
                    disabled={backgroundMusicDisabled}
                    className={`${inputClass} min-w-0 flex-1`}
                  />
                  <span className="text-[11px] font-medium text-[rgb(var(--color-text-secondary))]">dB</span>
                </div>
              </label>

              <label className="rounded-lg border border-[rgb(var(--color-border))] bg-[rgb(var(--color-surface))] px-3 py-2.5">
                <span className="block text-xs font-semibold text-[rgb(var(--color-text))]">Fade</span>
                <span className="mt-0.5 block text-[11px] leading-4 text-[rgb(var(--color-text-secondary))]">Fade in and out at export edges.</span>
                <div className="mt-3 flex items-center gap-2">
                  <input
                    type="number"
                    min={0}
                    max={10}
                    step={0.1}
                    value={settings.videoExportBackgroundMusicFadeSeconds}
                    onChange={(event) => updateSetting("videoExportBackgroundMusicFadeSeconds", Math.max(0, Number.parseFloat(event.target.value) || 0))}
                    disabled={backgroundMusicDisabled}
                    className={`${inputClass} min-w-0 flex-1`}
                  />
                  <span className="text-[11px] font-medium text-[rgb(var(--color-text-secondary))]">sec</span>
                </div>
              </label>

              <label className="flex items-center justify-between gap-3 rounded-lg border border-[rgb(var(--color-border))] bg-[rgb(var(--color-surface))] px-3 py-2.5">
                <span className="min-w-0">
                  <span className="block text-xs font-semibold text-[rgb(var(--color-text))]">Duck under narration</span>
                  <span className="mt-0.5 block text-[11px] leading-4 text-[rgb(var(--color-text-secondary))]">Automatically lowers music while narration is present.</span>
                </span>
                <input
                  type="checkbox"
                  checked={settings.videoExportBackgroundMusicDuckNarration}
                  onChange={(event) => updateSetting("videoExportBackgroundMusicDuckNarration", event.target.checked)}
                  disabled={backgroundMusicDisabled}
                  className="h-4 w-4 shrink-0 accent-[rgb(var(--color-accent))]"
                />
              </label>
            </div>

            <div className="rounded-lg border border-[rgb(var(--color-border))] bg-[rgb(var(--color-surface))] px-3 py-2.5">
              <div className="flex flex-col gap-3 md:flex-row md:items-center md:justify-between">
                <span className="min-w-0">
                  <span className="block text-xs font-semibold text-[rgb(var(--color-text))]">Preview mix</span>
                  <span className="mt-0.5 block text-[11px] leading-4 text-[rgb(var(--color-text-secondary))]">
                    Mixes the selected loop under the saved {settings.narrationVoiceName} voice sample, including your ducking, fade, and volume settings.
                  </span>
                </span>
                <button
                  type="button"
                  onClick={() => void previewBackgroundMusicMix()}
                  disabled={backgroundMusicDisabled || previewingBackgroundMusic}
                  className="rounded-lg border border-[rgb(var(--color-border))] bg-[rgb(var(--color-surface-alt))] px-3 py-2 text-xs font-medium text-[rgb(var(--color-text))] transition-colors hover:border-[rgb(var(--color-accent))] disabled:cursor-not-allowed disabled:opacity-50"
                >
                  {previewingBackgroundMusic ? "Rendering..." : "Preview mix"}
                </button>
              </div>
              {backgroundMusicPreview && (
                <div className="mt-3 grid gap-2">
                  <audio controls src={convertFileSrc(backgroundMusicPreview.path)} className="w-full" />
                  <span className="text-[11px] text-[rgb(var(--color-text-secondary))]">
                    Voice and music preview ({formatSecondsLabel(backgroundMusicPreview.durationSeconds)}).
                  </span>
                </div>
              )}
            </div>
          </>
        )}
      </fieldset>

      <div className="rounded-xl border border-[rgb(var(--color-border))] bg-[rgb(var(--color-surface-alt))]/50 p-4">
        <div className="flex flex-wrap items-start justify-between gap-3">
          <div>
            <div className="flex items-center gap-2 text-sm font-medium text-[rgb(var(--color-text))]">
              {ffmpegStatus?.available ? (
                <CheckCircle className="h-4 w-4 text-success" />
              ) : (
                <Info className="h-4 w-4 text-warning" />
              )}
              FFmpeg for video export
            </div>
            <p className="mt-1 text-xs leading-5 text-[rgb(var(--color-text-secondary))]">
              CutReady uses FFmpeg and FFprobe for sketch MP4 export. Auto-detection checks your saved path, PATH, and common install locations.
            </p>
            {ffmpegStatus?.available ? (
              <p className="mt-2 text-[11px] leading-5 text-[rgb(var(--color-text-secondary))]">
                Detected {ffmpegVersion ?? "FFmpeg"}{ffmpegStatus.path ? ` at ${ffmpegStatus.path}` : ""}.
                {ffmpegStatus.ffprobe_path ? ` FFprobe: ${ffprobeVersion ?? "detected"} at ${ffmpegStatus.ffprobe_path}.` : ""}
              </p>
            ) : (
              <p className="mt-2 text-[11px] leading-5 text-warning">
                {ffmpegStatus?.error || "FFmpeg or FFprobe was not detected. Install FFmpeg or use Locate FFmpeg to choose the executable."}
              </p>
            )}
            {(settings.ffmpegExecutablePath || settings.ffprobeExecutablePath) && (
              <p className="mt-2 text-[11px] leading-5 text-[rgb(var(--color-text-secondary))]">
                Custom paths: {settings.ffmpegExecutablePath || "auto FFmpeg"}; {settings.ffprobeExecutablePath || "auto FFprobe"}.
              </p>
            )}
          </div>
          <div className="flex shrink-0 items-center gap-2">
            <button
              type="button"
              onClick={() => void refreshFfmpegStatus()}
              disabled={ffmpegChecking}
              className="inline-flex items-center gap-1.5 rounded-lg border border-[rgb(var(--color-border))] px-3 py-2 text-xs font-medium text-[rgb(var(--color-text-secondary))] transition-colors hover:bg-[rgb(var(--color-surface))] hover:text-[rgb(var(--color-text))] disabled:cursor-not-allowed disabled:opacity-50"
            >
              <RefreshCw className={`h-3.5 w-3.5 ${ffmpegChecking ? "animate-spin" : ""}`} />
              Check
            </button>
            <button
              type="button"
              onClick={() => void chooseExecutable("ffmpeg")}
              className="inline-flex items-center gap-1.5 rounded-lg border border-[rgb(var(--color-border))] px-3 py-2 text-xs font-medium text-[rgb(var(--color-text-secondary))] transition-colors hover:bg-[rgb(var(--color-surface))] hover:text-[rgb(var(--color-text))]"
            >
              Locate FFmpeg
            </button>
            <button
              type="button"
              onClick={() => void chooseExecutable("ffprobe")}
              className="inline-flex items-center gap-1.5 rounded-lg border border-[rgb(var(--color-border))] px-3 py-2 text-xs font-medium text-[rgb(var(--color-text-secondary))] transition-colors hover:bg-[rgb(var(--color-surface))] hover:text-[rgb(var(--color-text))]"
            >
              Locate FFprobe
            </button>
            {(settings.ffmpegExecutablePath || settings.ffprobeExecutablePath) && (
              <button
                type="button"
                onClick={() => void clearExecutablePaths()}
                className="inline-flex items-center gap-1.5 rounded-lg border border-[rgb(var(--color-border))] px-3 py-2 text-xs font-medium text-[rgb(var(--color-text-secondary))] transition-colors hover:bg-[rgb(var(--color-surface))] hover:text-[rgb(var(--color-text))]"
              >
                Clear paths
              </button>
            )}
            <button
              type="button"
              onClick={() => void shellOpen("https://ffmpeg.org/download.html")}
              className="inline-flex items-center gap-1.5 rounded-lg bg-[rgb(var(--color-accent))] px-3 py-2 text-xs font-medium text-[rgb(var(--color-accent-fg))] transition-colors hover:bg-[rgb(var(--color-accent-hover))]"
            >
              <ExternalLink className="h-3.5 w-3.5" />
              Install FFmpeg
            </button>
          </div>
        </div>
      </div>

      <div className="rounded-xl border border-[rgb(var(--color-border))] bg-[rgb(var(--color-surface-alt))]/50 p-4">
        <div className="text-sm font-medium text-[rgb(var(--color-text))]">Current output format</div>
        <p className="mt-1 text-xs leading-5 text-[rgb(var(--color-text-secondary))]">
          Sketch video export currently writes {settings.videoExportWidth}x{settings.videoExportHeight} MP4 files at {settings.videoExportFps}fps with {settings.videoExportIncludeTitleCard ? "a title card" : "no title card"}, {settings.videoExportEncoder}, {settings.videoExportPixelFormat}, CRF {settings.videoExportCrf}, trimmed recorded narration audio, and AAC audio.
        </p>
      </div>
    </div>
  );
}
