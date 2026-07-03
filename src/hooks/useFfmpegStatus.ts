import { useCallback, useEffect, useState } from "react";
import { invoke } from "../services/tauri";
import type { FfmpegStatus } from "../types/recording";

interface FfmpegStatusState {
  status: FfmpegStatus | null;
  loading: boolean;
  error: string | null;
}

let state: FfmpegStatusState = {
  status: null,
  loading: false,
  error: null,
};

const listeners = new Set<() => void>();

function emit() {
  for (const listener of listeners) {
    listener();
  }
}

function setState(next: Partial<FfmpegStatusState>) {
  state = { ...state, ...next };
  emit();
}

export function setCachedFfmpegStatus(status: FfmpegStatus) {
  setState({ status, error: status.error, loading: false });
}

export async function refreshFfmpegStatus() {
  setState({ loading: true, error: null });
  try {
    const status = await invoke<FfmpegStatus>("check_ffmpeg_status");
    setCachedFfmpegStatus(status);
    return status;
  } catch (error) {
    const message = String(error);
    const status: FfmpegStatus = {
      available: false,
      version: null,
      path: null,
      error: message,
    };
    setState({ status, loading: false, error: message });
    return status;
  }
}

export function warmFfmpegStatus() {
  if (state.loading || state.status) return;
  void refreshFfmpegStatus();
}

export function useFfmpegStatus(enabled = true) {
  const [snapshot, setSnapshot] = useState(state);

  useEffect(() => {
    const listener = () => setSnapshot(state);
    listeners.add(listener);
    return () => {
      listeners.delete(listener);
    };
  }, []);

  useEffect(() => {
    if (enabled) {
      warmFfmpegStatus();
    }
  }, [enabled]);

  const refresh = useCallback(() => refreshFfmpegStatus(), []);

  return {
    ...snapshot,
    refresh,
  };
}
