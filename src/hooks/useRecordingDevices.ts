import { useCallback, useEffect, useMemo, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import type { RecordingDeviceDiscovery, RecordingDeviceInfo } from "../types/recording";

const initialDiscovery: RecordingDeviceDiscovery = {
  ffmpeg: {
    available: false,
    version: null,
    path: "ffmpeg",
    error: null,
  },
  devices: [],
};

export function useRecordingDevices(enabled: boolean = true) {
  const [discovery, setDiscovery] = useState<RecordingDeviceDiscovery>(initialDiscovery);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const refresh = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const next = await invoke<RecordingDeviceDiscovery>("discover_recording_devices");
      setDiscovery(next);
    } catch (err) {
      setError(String(err));
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    if (!enabled) return;
    void refresh();
  }, [enabled, refresh]);

  const microphones = useMemo(
    () => discovery.devices.filter((device): device is RecordingDeviceInfo => device.kind === "microphone"),
    [discovery.devices],
  );
  const cameras = useMemo(
    () => discovery.devices.filter((device): device is RecordingDeviceInfo => device.kind === "camera"),
    [discovery.devices],
  );
  const systemAudioDevices = useMemo(
    () => discovery.devices.filter((device): device is RecordingDeviceInfo => device.kind === "system_audio"),
    [discovery.devices],
  );

  return {
    discovery,
    microphones,
    cameras,
    systemAudioDevices,
    loading,
    error,
    refresh,
  };
}
