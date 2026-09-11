import { useState } from "react";
import { Trash2 } from "lucide-react";
import { useSettings } from "../../hooks/useSettings";
import { useRecordingDevices } from "../../hooks/useRecordingDevices";
import { invoke } from "../../services/tauri";
import { useToastStore } from "../../stores/toastStore";
import { useConfirmDialog } from "../ConfirmDialog";
import { inputClass } from "../../styles";

export function RecordingTab({
  settings,
  updateSetting,
}: {
  settings: ReturnType<typeof useSettings>["settings"];
  updateSetting: ReturnType<typeof useSettings>["updateSetting"];
}) {
  const { discovery, microphones, cameras, systemAudioDevices, loading, error, refresh } = useRecordingDevices();
  const [clearingRecordings, setClearingRecordings] = useState(false);
  const { confirm, confirmationDialog } = useConfirmDialog();
  const deviceError = error ?? (discovery.devices.length === 0 ? discovery.ffmpeg.error : null);

  const clearRecordings = async () => {
    const confirmed = await confirm({
      title: "Clear local recordings?",
      message: "Clear all local recording takes for this project? This cannot be undone.",
      confirmLabel: "Clear recordings",
      variant: "error",
    });
    if (!confirmed) return;

    setClearingRecordings(true);
    try {
      const removed = await invoke<number>("clear_local_recordings");
      useToastStore.getState().show(
        removed === 1 ? "Cleared 1 local recording item." : `Cleared ${removed} local recording items.`,
        3000,
        "info",
      );
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      useToastStore.getState().show(`Unable to clear recordings: ${message}`, 4000, "error");
    } finally {
      setClearingRecordings(false);
    }
  };

  return (
    <div className="flex flex-col gap-6">
      <p className="text-xs text-[rgb(var(--color-text-secondary))]">
        These defaults apply to new sketch and storyboard recording takes. Each take stores a snapshot of the effective settings used for that recording.
      </p>

      <div className="grid gap-4 md:grid-cols-2">
        <label className="block space-y-1.5">
          <span className="text-xs font-medium text-[rgb(var(--color-text-secondary))]">Default source</span>
          <select
            value="full_screen"
            onChange={(e) => updateSetting("recorderCaptureSource", e.target.value as typeof settings.recorderCaptureSource)}
            className={`${inputClass} w-full`}
          >
            <option value="full_screen">Full screen</option>
            <option value="region" disabled>Region (coming next)</option>
            <option value="window" disabled>Window (coming next)</option>
          </select>
          <p className="text-[10px] text-[rgb(var(--color-text-secondary))]">
            This build records a chosen monitor. Region and window capture will reuse CutReady's capture picker in a follow-up slice.
          </p>
        </label>

        <label className="block space-y-1.5">
          <span className="text-xs font-medium text-[rgb(var(--color-text-secondary))]">Default microphone</span>
          <select
            value={settings.recorderMicDeviceId || "default"}
            onChange={(e) => updateSetting("recorderMicDeviceId", e.target.value === "default" ? "" : e.target.value)}
            className={`${inputClass} w-full`}
          >
            <option value="default">No microphone</option>
            {microphones.map((device) => (
              <option key={device.id} value={device.id}>
                {device.is_default ? `${device.label} (default)` : device.label}
              </option>
            ))}
          </select>
          <div className="flex items-center justify-between gap-2 text-[10px] text-[rgb(var(--color-text-secondary))]">
            <span>
              {recordingDeviceStatusText(loading, deviceError, microphones.length)}
            </span>
            <button
              type="button"
              onClick={refresh}
              disabled={loading}
              className="font-medium text-[rgb(var(--color-accent))] transition-colors hover:text-[rgb(var(--color-accent-hover))] disabled:cursor-not-allowed disabled:opacity-60"
            >
              Refresh
            </button>
          </div>
        </label>

        <label className="block space-y-1.5">
          <span className="text-xs font-medium text-[rgb(var(--color-text-secondary))]">Default camera</span>
          <select
            value={settings.recorderCameraEnabled ? settings.recorderCameraDeviceId || "" : ""}
            onChange={(e) => {
              void updateSetting("recorderCameraDeviceId", e.target.value);
              void updateSetting("recorderCameraEnabled", e.target.value !== "");
            }}
            className={`${inputClass} w-full`}
          >
            <option value="">No camera</option>
            {cameras.map((device) => (
              <option key={device.id} value={device.id}>
                {device.label}
              </option>
            ))}
          </select>
          <p className="text-[10px] text-[rgb(var(--color-text-secondary))]">
            Optional separate camera.mp4 track for edit-ready timelines.
          </p>
        </label>

        <label className="block space-y-1.5">
          <span className="text-xs font-medium text-[rgb(var(--color-text-secondary))]">Countdown</span>
          <select
            value={settings.recorderCountdownSeconds}
            onChange={(e) => updateSetting("recorderCountdownSeconds", Number(e.target.value))}
            className={`${inputClass} w-full`}
          >
            <option value={0}>None</option>
            <option value={3}>3 seconds</option>
            <option value={5}>5 seconds</option>
          </select>
        </label>

        <label className="block space-y-1.5">
          <span className="text-xs font-medium text-[rgb(var(--color-text-secondary))]">Frame rate</span>
          <select
            value={settings.recorderFrameRate}
            onChange={(e) => updateSetting("recorderFrameRate", Number(e.target.value))}
            className={`${inputClass} w-full`}
          >
            <option value={30}>30 fps</option>
            <option value={60}>60 fps</option>
          </select>
        </label>

        <label className="block space-y-1.5">
          <span className="text-xs font-medium text-[rgb(var(--color-text-secondary))]">Output quality</span>
          <select
            value={settings.recorderOutputQuality}
            onChange={(e) => updateSetting("recorderOutputQuality", e.target.value as typeof settings.recorderOutputQuality)}
            className={`${inputClass} w-full`}
          >
            <option value="high">High - smooth MP4 (recommended)</option>
            <option value="compact">Compact - smaller MP4</option>
            <option value="lossless">Lossless - heavy MKV master</option>
          </select>
          <p className="text-[10px] text-[rgb(var(--color-text-secondary))]">
            Use High for smooth capture and playback. Lossless keeps an edit master but can be heavy on real-time capture.
          </p>
        </label>
      </div>

      <div className="rounded-xl border border-[rgb(var(--color-border))] bg-[rgb(var(--color-surface-alt))]/50 p-4">
        <div className="mb-3 text-sm font-medium text-[rgb(var(--color-text))]">Tracks</div>
        <div className="grid gap-2">
          <label className="flex items-center justify-between gap-3 rounded-lg bg-[rgb(var(--color-surface))] px-3 py-2">
            <span className="text-xs text-[rgb(var(--color-text))]">Include cursor</span>
            <input
              type="checkbox"
              checked={settings.recorderIncludeCursor}
              onChange={(e) => updateSetting("recorderIncludeCursor", e.target.checked)}
              className="h-4 w-4 accent-[rgb(var(--color-accent))]"
            />
          </label>
          <label className="flex items-center justify-between gap-3 rounded-lg bg-[rgb(var(--color-surface))] px-3 py-2">
            <span>
              <span className="block text-xs text-[rgb(var(--color-text))]">Camera asset</span>
              <span className="text-[10px] text-[rgb(var(--color-text-secondary))]">Separate camera.mp4</span>
            </span>
            <input
              type="checkbox"
              checked={settings.recorderCameraEnabled}
              onChange={(e) => {
                void updateSetting("recorderCameraEnabled", e.target.checked);
                if (e.target.checked && !settings.recorderCameraDeviceId && cameras[0]) {
                  void updateSetting("recorderCameraDeviceId", cameras[0].id);
                }
              }}
              disabled={cameras.length === 0}
              className="h-4 w-4 accent-[rgb(var(--color-accent))] disabled:opacity-40"
              aria-label="Camera asset default"
            />
          </label>
          <label className="flex items-center justify-between gap-3 rounded-lg bg-[rgb(var(--color-surface))] px-3 py-2">
            <span>
              <span className="block text-xs text-[rgb(var(--color-text))]">System audio asset</span>
              <span className="text-[10px] text-[rgb(var(--color-text-secondary))]">
                {systemAudioDevices.length > 0 ? "Separate system-audio.wav" : "Uses Windows default output"}
              </span>
            </span>
            <input
              type="checkbox"
              checked={settings.recorderSystemAudioEnabled}
              onChange={(e) => updateSetting("recorderSystemAudioEnabled", e.target.checked)}
              className="h-4 w-4 accent-[rgb(var(--color-accent))]"
              aria-label="System audio asset default"
            />
          </label>
        </div>
      </div>

      <div className="rounded-xl border border-[rgb(var(--color-border))] bg-[rgb(var(--color-surface-alt))]/50 p-4">
        <div className="flex items-start justify-between gap-4">
          <div>
            <div className="text-sm font-medium text-[rgb(var(--color-text))]">Local recording storage</div>
            <p className="mt-1 text-xs text-[rgb(var(--color-text-secondary))]">
              Recording media stays in this project under .cutready/recordings and is excluded from git.
            </p>
          </div>
          <button
            type="button"
            onClick={clearRecordings}
            disabled={clearingRecordings}
            className="inline-flex items-center gap-2 rounded-lg border border-[rgb(var(--color-border))] px-3 py-2 text-xs font-medium text-[rgb(var(--color-text))] transition-colors hover:bg-[rgb(var(--color-surface))] disabled:cursor-not-allowed disabled:opacity-60"
          >
            <Trash2 className="h-3.5 w-3.5" />
            {clearingRecordings ? "Clearing..." : "Clear local recordings"}
          </button>
        </div>
      </div>
      {confirmationDialog}
    </div>
  );
}

function recordingDeviceStatusText(
  loading: boolean,
  error: string | null,
  microphoneCount: number,
) {
  if (loading) return "Detecting Windows audio devices...";
  if (error) return "Could not detect recording devices.";
  if (microphoneCount === 0) return "No active Windows microphones were detected.";
  return `${microphoneCount} Windows microphone${microphoneCount === 1 ? "" : "s"} detected`;
}
