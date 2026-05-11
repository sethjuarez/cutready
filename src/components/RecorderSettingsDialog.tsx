import { useEffect, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { CheckCircle2, Mic, MousePointer2, Timer, Video, X } from "lucide-react";
import { Dialog } from "./Dialog";
import { useToastStore } from "../stores/toastStore";
import { useSettings } from "../hooks/useSettings";
import type {
  OutputQuality,
  RecorderSettings,
  RecordingScope,
  RecordingTake,
} from "../types/recording";

interface RecorderSettingsDialogProps {
  isOpen: boolean;
  onClose: () => void;
  scope: RecordingScope;
  documentTitle: string;
  onPrepared?: (take: RecordingTake) => void;
}

const defaultSettings: RecorderSettings = {
  capture_source: "full_screen",
  mic_device_id: null,
  countdown_seconds: 3,
  include_cursor: true,
  output_quality: "lossless",
};

function recorderSettingsFromDefaults(settings: ReturnType<typeof useSettings>["settings"]): RecorderSettings {
  return {
    capture_source: settings.recorderCaptureSource,
    mic_device_id: settings.recorderMicDeviceId || null,
    countdown_seconds: settings.recorderCountdownSeconds,
    include_cursor: settings.recorderIncludeCursor,
    output_quality: settings.recorderOutputQuality,
  };
}

export function RecorderSettingsDialog({
  isOpen,
  onClose,
  scope,
  documentTitle,
  onPrepared,
}: RecorderSettingsDialogProps) {
  const { settings: globalSettings, loaded } = useSettings();
  const [settings, setSettings] = useState<RecorderSettings>(defaultSettings);
  const [busy, setBusy] = useState(false);
  const [preparedTake, setPreparedTake] = useState<RecordingTake | null>(null);

  useEffect(() => {
    if (!isOpen || !loaded) return;
    setSettings(recorderSettingsFromDefaults(globalSettings));
    setPreparedTake(null);
  }, [globalSettings, isOpen, loaded]);

  const update = <K extends keyof RecorderSettings>(key: K, value: RecorderSettings[K]) => {
    setSettings((current) => ({ ...current, [key]: value }));
  };

  const handlePrepare = async () => {
    setBusy(true);
    setPreparedTake(null);
    try {
      const take = await invoke<RecordingTake>("create_recording_take", {
        scope,
        settings,
      });
      setPreparedTake(take);
      useToastStore.getState().show("Recording take prepared");
      onPrepared?.(take);
    } catch (err) {
      console.error("Failed to prepare recording take:", err);
      useToastStore.getState().show(`Could not prepare recording: ${err}`, 5000, "error");
    } finally {
      setBusy(false);
    }
  };

  return (
    <Dialog
      isOpen={isOpen}
      onClose={onClose}
      width="w-[560px] max-w-[92vw]"
      labelledBy="recorder-settings-title"
      backdropClass="bg-[rgb(var(--color-overlay-scrim)/0.45)] backdrop-blur-sm"
    >
      <div className="overflow-hidden rounded-2xl border border-[rgb(var(--color-border))] bg-[rgb(var(--color-surface))] shadow-2xl">
        <div className="flex items-start justify-between gap-4 border-b border-[rgb(var(--color-border))] px-5 py-4">
          <div>
            <div className="mb-1 flex items-center gap-2 text-[10px] font-semibold uppercase tracking-[0.16em] text-[rgb(var(--color-accent))]">
              <Video className="h-3.5 w-3.5" />
              Recorder setup
            </div>
            <h2 id="recorder-settings-title" className="text-lg font-semibold text-[rgb(var(--color-text))]">
              {documentTitle}
            </h2>
            <p className="mt-1 text-xs text-[rgb(var(--color-text-secondary))]">
              Prepare a local take for this {scope.kind}. Defaults come from Settings &gt; Recording; changes here apply only to this take.
            </p>
          </div>
          <button
            type="button"
            onClick={onClose}
            className="rounded-lg p-1.5 text-[rgb(var(--color-text-secondary))] transition-colors hover:bg-[rgb(var(--color-surface-alt))] hover:text-[rgb(var(--color-text))]"
            aria-label="Close recorder settings"
          >
            <X className="h-4 w-4" />
          </button>
        </div>

        <div className="space-y-4 px-5 py-4">
          <fieldset className="space-y-2">
            <legend className="text-xs font-medium text-[rgb(var(--color-text))]">Capture source</legend>
            <div className="grid grid-cols-3 gap-2">
              <ChoiceButton
                selected={settings.capture_source === "full_screen"}
                label="Full screen"
                description="Fastest first pass"
                onClick={() => update("capture_source", "full_screen")}
              />
              <ChoiceButton
                selected={settings.capture_source === "region"}
                label="Region"
                description="Uses capture picker"
                onClick={() => update("capture_source", "region")}
              />
              <ChoiceButton
                selected={settings.capture_source === "window"}
                label="Window"
                description="Uses capture picker"
                onClick={() => update("capture_source", "window")}
              />
            </div>
          </fieldset>

          <div className="grid grid-cols-2 gap-3">
            <label className="space-y-1.5">
              <span className="flex items-center gap-1.5 text-xs font-medium text-[rgb(var(--color-text))]">
                <Mic className="h-3.5 w-3.5 text-[rgb(var(--color-text-secondary))]" />
                Microphone
              </span>
              <select
                value={settings.mic_device_id ?? "default"}
                onChange={(event) => update("mic_device_id", event.target.value === "default" ? null : event.target.value)}
                className="w-full rounded-lg border border-[rgb(var(--color-border))] bg-[rgb(var(--color-surface))] px-3 py-2 text-xs text-[rgb(var(--color-text))] outline-none transition-colors focus:border-[rgb(var(--color-accent))]"
              >
                <option value="default">System default microphone</option>
              </select>
            </label>

            <label className="space-y-1.5">
              <span className="flex items-center gap-1.5 text-xs font-medium text-[rgb(var(--color-text))]">
                <Timer className="h-3.5 w-3.5 text-[rgb(var(--color-text-secondary))]" />
                Countdown
              </span>
              <select
                value={settings.countdown_seconds}
                onChange={(event) => update("countdown_seconds", Number(event.target.value))}
                className="w-full rounded-lg border border-[rgb(var(--color-border))] bg-[rgb(var(--color-surface))] px-3 py-2 text-xs text-[rgb(var(--color-text))] outline-none transition-colors focus:border-[rgb(var(--color-accent))]"
              >
                <option value={0}>None</option>
                <option value={3}>3 seconds</option>
                <option value={5}>5 seconds</option>
              </select>
            </label>
          </div>

          <div className="grid grid-cols-2 gap-3">
            <label className="flex items-center justify-between rounded-xl border border-[rgb(var(--color-border))] px-3 py-2">
              <span className="flex items-center gap-2 text-xs font-medium text-[rgb(var(--color-text))]">
                <MousePointer2 className="h-3.5 w-3.5 text-[rgb(var(--color-text-secondary))]" />
                Include cursor
              </span>
              <input
                type="checkbox"
                checked={settings.include_cursor}
                onChange={(event) => update("include_cursor", event.target.checked)}
                className="h-4 w-4 accent-[rgb(var(--color-accent))]"
              />
            </label>

            <label className="space-y-1.5">
              <span className="text-xs font-medium text-[rgb(var(--color-text))]">Output quality</span>
              <select
                value={settings.output_quality}
                onChange={(event) => update("output_quality", event.target.value as OutputQuality)}
                className="w-full rounded-lg border border-[rgb(var(--color-border))] bg-[rgb(var(--color-surface))] px-3 py-2 text-xs text-[rgb(var(--color-text))] outline-none transition-colors focus:border-[rgb(var(--color-accent))]"
              >
                <option value="lossless">Lossless</option>
                <option value="high">High</option>
                <option value="compact">Compact</option>
              </select>
            </label>
          </div>

          <div className="rounded-xl border border-dashed border-[rgb(var(--color-border))] bg-[rgb(var(--color-surface-alt))]/60 p-3">
            <div className="mb-2 text-xs font-medium text-[rgb(var(--color-text))]">Future tracks</div>
            <div className="grid grid-cols-2 gap-2">
              <label className="flex items-center justify-between rounded-lg bg-[rgb(var(--color-surface))] px-3 py-2 text-xs text-[rgb(var(--color-text-secondary))]">
                Camera separate asset
                <input type="checkbox" checked={globalSettings.recorderCameraEnabled} disabled className="h-4 w-4" readOnly />
              </label>
              <label className="flex items-center justify-between rounded-lg bg-[rgb(var(--color-surface))] px-3 py-2 text-xs text-[rgb(var(--color-text-secondary))]">
                System audio separate asset
                <input type="checkbox" checked={globalSettings.recorderSystemAudioEnabled} disabled className="h-4 w-4" readOnly />
              </label>
            </div>
          </div>

          {preparedTake && (
            <div className="flex items-start gap-2 rounded-xl border border-[rgb(var(--color-success))]/30 bg-[rgb(var(--color-success))]/10 px-3 py-2 text-xs text-[rgb(var(--color-text))]">
              <CheckCircle2 className="mt-0.5 h-4 w-4 shrink-0 text-[rgb(var(--color-success))]" />
              <div>
                <div className="font-medium">Take prepared</div>
                <div className="mt-0.5 text-[rgb(var(--color-text-secondary))]">{preparedTake.metadata_path}</div>
              </div>
            </div>
          )}
        </div>

        <div className="flex items-center justify-end gap-2 border-t border-[rgb(var(--color-border))] px-5 py-4">
          <button
            type="button"
            onClick={onClose}
            className="rounded-lg px-3 py-2 text-xs font-medium text-[rgb(var(--color-text-secondary))] transition-colors hover:bg-[rgb(var(--color-surface-alt))] hover:text-[rgb(var(--color-text))]"
          >
            Close
          </button>
          <button
            type="button"
            onClick={handlePrepare}
            disabled={busy}
            className="rounded-lg bg-[rgb(var(--color-accent))] px-3 py-2 text-xs font-semibold text-white transition-colors hover:bg-[rgb(var(--color-accent-hover))] disabled:cursor-not-allowed disabled:opacity-50"
          >
            {busy ? "Preparing..." : "Prepare recording"}
          </button>
        </div>
      </div>
    </Dialog>
  );
}

function ChoiceButton({
  selected,
  label,
  description,
  onClick,
}: {
  selected: boolean;
  label: string;
  description: string;
  onClick: () => void;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      className={`rounded-xl border px-3 py-2 text-left transition-colors ${
        selected
          ? "border-[rgb(var(--color-accent))] bg-[rgb(var(--color-accent))]/10"
          : "border-[rgb(var(--color-border))] hover:border-[rgb(var(--color-accent))]/40 hover:bg-[rgb(var(--color-surface-alt))]"
      }`}
    >
      <div className="text-xs font-medium text-[rgb(var(--color-text))]">{label}</div>
      <div className="mt-0.5 text-[10px] text-[rgb(var(--color-text-secondary))]">{description}</div>
    </button>
  );
}
