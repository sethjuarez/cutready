import { useEffect, useState } from "react";
import { RefreshCw, Mic2 } from "lucide-react";
import { useSettings } from "../../hooks/useSettings";
import { useToastStore } from "../../stores/toastStore";
import { inputClass } from "../../styles";

type BrowserMicrophone = {
  deviceId: string;
  label: string;
};

export function NarrationTab({
  settings,
  updateSetting,
}: {
  settings: ReturnType<typeof useSettings>["settings"];
  updateSetting: ReturnType<typeof useSettings>["updateSetting"];
}) {
  const [microphones, setMicrophones] = useState<BrowserMicrophone[]>([]);
  const [permissionState, setPermissionState] = useState<PermissionState | "unsupported" | "unknown">("unknown");
  const [loading, setLoading] = useState(false);
  const [testing, setTesting] = useState(false);
  const [error, setError] = useState("");

  const refreshMicrophones = async () => {
    setLoading(true);
    setError("");
    try {
      if (!navigator.mediaDevices?.enumerateDevices) {
        setPermissionState("unsupported");
        setMicrophones([]);
        return;
      }

      if (navigator.permissions?.query) {
        try {
          const permission = await navigator.permissions.query({ name: "microphone" as PermissionName });
          setPermissionState(permission.state);
          permission.onchange = () => setPermissionState(permission.state);
        } catch {
          setPermissionState("unknown");
        }
      }

      const devices = await navigator.mediaDevices.enumerateDevices();
      const audioInputs = devices
        .filter((device) => device.kind === "audioinput")
        .map((device, index) => ({
          deviceId: device.deviceId,
          label: device.label || `Microphone ${index + 1}`,
        }));
      setMicrophones(audioInputs);
      if (
        settings.narrationMicDeviceId &&
        audioInputs.length > 0 &&
        !audioInputs.some((device) => device.deviceId === settings.narrationMicDeviceId)
      ) {
        await updateSetting("narrationMicDeviceId", "");
      }
    } catch (err) {
      setError(String(err));
      setMicrophones([]);
    } finally {
      setLoading(false);
    }
  };

  const requestMicrophoneAccess = async () => {
    setTesting(true);
    setError("");
    try {
      if (!navigator.mediaDevices?.getUserMedia) {
        throw new Error("Microphone access is not available in this WebView.");
      }
      const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
      stream.getTracks().forEach((track) => track.stop());
      setPermissionState("granted");
      await refreshMicrophones();
      useToastStore.getState().show("Microphone access is ready.", 3000, "success");
    } catch (err) {
      setPermissionState("denied");
      setError(String(err));
      useToastStore.getState().show(`Microphone access failed: ${err}`, 5000, "error");
    } finally {
      setTesting(false);
    }
  };

  useEffect(() => {
    void refreshMicrophones();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const permissionLabel = permissionState === "granted"
    ? "Allowed"
    : permissionState === "denied"
      ? "Blocked"
      : permissionState === "prompt"
        ? "Ask on first use"
        : permissionState === "unsupported"
          ? "Unavailable"
          : "Unknown";

  return (
    <div className="flex flex-col gap-6">
      <p className="text-xs text-[rgb(var(--color-text-secondary))]">
        Row narration records through the Tauri WebView microphone API, so it works independently of full-screen recording.
      </p>

      <div className="rounded-xl border border-[rgb(var(--color-border))] bg-[rgb(var(--color-surface-alt))]/50 p-4">
        <div className="flex flex-col gap-4 md:flex-row md:items-start md:justify-between">
          <div>
            <div className="text-sm font-medium text-[rgb(var(--color-text))]">Microphone access</div>
            <p className="mt-1 text-xs text-[rgb(var(--color-text-secondary))]">
              Grant access once, then pick the input CutReady should use for sketch-row narration.
            </p>
          </div>
          <div className="flex flex-wrap items-center gap-2">
            <span className={`rounded-full border px-2.5 py-1 text-[11px] font-medium ${
              permissionState === "granted"
                ? "border-[rgb(var(--color-success))]/30 bg-[rgb(var(--color-success))]/10 text-[rgb(var(--color-success))]"
                : permissionState === "denied"
                  ? "border-[rgb(var(--color-error))]/30 bg-[rgb(var(--color-error))]/10 text-[rgb(var(--color-error))]"
                  : "border-[rgb(var(--color-border))] bg-[rgb(var(--color-surface))] text-[rgb(var(--color-text-secondary))]"
            }`}>
              {permissionLabel}
            </span>
            <button
              type="button"
              onClick={requestMicrophoneAccess}
              disabled={testing}
              className="inline-flex items-center gap-2 rounded-lg bg-[rgb(var(--color-accent))] px-3 py-2 text-xs font-medium text-[rgb(var(--color-accent-fg))] transition-colors hover:bg-[rgb(var(--color-accent-hover))] disabled:cursor-not-allowed disabled:opacity-60"
            >
              {testing ? <RefreshCw className="h-3.5 w-3.5 animate-spin" /> : <Mic2 className="h-3.5 w-3.5" />}
              {testing ? "Checking..." : "Allow / test mic"}
            </button>
          </div>
        </div>
      </div>

      <label className="block space-y-1.5">
        <span className="text-xs font-medium text-[rgb(var(--color-text-secondary))]">Narration microphone</span>
        <select
          value={settings.narrationMicDeviceId || "default"}
          onChange={(event) => updateSetting("narrationMicDeviceId", event.target.value === "default" ? "" : event.target.value)}
          className={`${inputClass} w-full`}
        >
          <option value="default">System default microphone</option>
          {microphones.map((device) => (
            <option key={device.deviceId} value={device.deviceId}>
              {device.label}
            </option>
          ))}
        </select>
        <div className="flex items-center justify-between gap-2 text-[10px] text-[rgb(var(--color-text-secondary))]">
          <span>
            {loading
              ? "Looking for WebView microphones..."
              : error
                ? "Could not read microphone devices."
                : microphones.length === 0
                  ? "No microphones visible yet. Use Allow / test mic to unlock device names."
                  : `${microphones.length} microphone${microphones.length === 1 ? "" : "s"} available`}
          </span>
          <button
            type="button"
            onClick={refreshMicrophones}
            disabled={loading}
            className="font-medium text-[rgb(var(--color-accent))] transition-colors hover:text-[rgb(var(--color-accent-hover))] disabled:cursor-not-allowed disabled:opacity-60"
          >
            Refresh
          </button>
        </div>
        {error && (
          <p className="text-[10px] text-[rgb(var(--color-error))]">{error}</p>
        )}
      </label>
    </div>
  );
}

// ── Voice Tab (TTS generation) ────────────────────────────────────
