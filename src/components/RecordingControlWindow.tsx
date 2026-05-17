import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { convertFileSrc, invoke } from "@tauri-apps/api/core";
import { emit, listen } from "@tauri-apps/api/event";
import { getCurrentWindow, LogicalPosition, LogicalSize, PhysicalPosition } from "@tauri-apps/api/window";
import { Eye, FileText, Keyboard, Mic, Monitor, Square, Video, Volume2, X } from "lucide-react";
import { useRecordingDevices } from "../hooks/useRecordingDevices";
import { useSettings } from "../hooks/useSettings";
import { isMac } from "../utils/platform";
import type { ProjectView } from "../types/project";
import type { CameraFormatInfo, CaptureArea, PrompterScript, RecorderSettings, RecordingDeviceInfo, RecordingPlatformCapabilities, RecordingScope, RecordingTake } from "../types/recording";

interface RecordingControlParams {
  take_id?: string | null;
  document_title: string;
  scope?: RecordingScope | null;
}

interface RecordingAudioLevel {
  available: boolean;
  rms: number;
  peak: number;
  bytes: number;
}

interface MonitorInfo {
  id: number;
  name: string;
  device_name?: string | null;
  hmonitor?: string | null;
  dxgi_output_index?: number | null;
  x: number;
  y: number;
  width: number;
  height: number;
  is_primary: boolean;
}

type Phase = "setup" | "countdown" | "starting" | "recording" | "stopping" | "discarding";
type SourcePreview =
  | { kind: "screen"; title: string; src: string }
  | { kind: "camera"; title: string; stream: MediaStream };

const WAVE_BARS = [0.24, 0.5, 0.34, 0.72, 0.42, 0.88, 0.48, 0.65, 0.3, 0.58, 0.38, 0.76];
const SETUP_SIZE = new LogicalSize(890, 260);
const HUD_SIZE = new LogicalSize(420, 220);

function defaultPlatformCapabilities(): RecordingPlatformCapabilities {
  return {
    platform: "unknown",
    supports_system_audio: false,
    supports_native_monitor_capture: false,
    supports_window_capture_exclusion: false,
    supports_click_through_prompter: true,
    supports_camera_format_discovery: false,
    system_audio_hint: null,
  };
}

export function RecordingControlWindow() {
  const [params, setParams] = useState<RecordingControlParams | null>(null);
  const [phase, setPhase] = useState<Phase>("setup");
  const [error, setError] = useState<string | null>(null);
  const [monitors, setMonitors] = useState<MonitorInfo[]>([]);
  const [selectedMonitorId, setSelectedMonitorId] = useState<number | null>(null);
  const [micDeviceId, setMicDeviceId] = useState("");
  const [micVolume, setMicVolume] = useState(100);
  const [cameraDeviceId, setCameraDeviceId] = useState("");
  const [includeSystemAudio, setIncludeSystemAudio] = useState(false);
  const [systemAudioVolume, setSystemAudioVolume] = useState(100);
  const [frameRate, setFrameRate] = useState(30);
  const [countdownSeconds, setCountdownSeconds] = useState(3);
  const [includeCursor, setIncludeCursor] = useState(true);
  const [recordingTake, setRecordingTake] = useState<RecordingTake | null>(null);
  const [projectRoot, setProjectRoot] = useState("");
  const [cameraFormatsById, setCameraFormatsById] = useState<Record<string, CameraFormatInfo[]>>({});
  const [cameraFormatsLoading, setCameraFormatsLoading] = useState(false);
  const [prompterEnabled, setPrompterEnabled] = useState(true);
  const [prompterScript, setPrompterScript] = useState<PrompterScript | null>(null);
  const [prompterLoading, setPrompterLoading] = useState(false);
  const [platformCapabilities, setPlatformCapabilities] = useState<RecordingPlatformCapabilities>(() => defaultPlatformCapabilities());
  const [sourcePreview, setSourcePreview] = useState<SourcePreview | null>(null);
  const [audioLevel, setAudioLevel] = useState<RecordingAudioLevel>({
    available: false,
    rms: 0,
    peak: 0,
    bytes: 0,
  });
  const { settings, updateSetting, loaded } = useSettings();
  const { microphones, cameras, loading: devicesLoading, error: devicesError, refresh } = useRecordingDevices(true);
  const currentWindow = useMemo(() => getCurrentWindow(), []);
  const countdownTimerRef = useRef<number | null>(null);
  const settingsHydratedRef = useRef(false);

  const selectedMonitor = monitors.find((monitor) => monitor.id === selectedMonitorId) ?? null;
  const selectedMicrophone = microphones.find((microphone) => microphone.id === micDeviceId) ?? null;
  const selectedCamera = cameras.find((camera) => camera.id === cameraDeviceId) ?? null;
  const selectedCameraFormats = selectedCamera ? (cameraFormatsById[selectedCamera.id] ?? selectedCamera.camera_formats ?? []) : [];
  const selectedCameraFormat = bestCameraFormat(selectedCameraFormats);
  const scope = params?.scope ?? null;
  const documentTitle = params?.document_title ?? "CutReady";
  const prompterAvailable = (prompterScript?.steps.length ?? 0) > 0;
  const canStart = !!scope && !!selectedMonitor && phase === "setup";
  const supportsSystemAudio = platformCapabilities.supports_system_audio;
  const supportsPrompterClickThrough = platformCapabilities.supports_click_through_prompter;

  const clearCountdownTimer = useCallback(() => {
    if (countdownTimerRef.current !== null) {
      window.clearTimeout(countdownTimerRef.current);
      countdownTimerRef.current = null;
    }
  }, []);

  const closePrompter = useCallback(async () => {
    await emit("recording-prompter-close", {}).catch(() => undefined);
    await invoke("close_recording_prompter_window").catch(() => undefined);
  }, []);

  const stopRecording = useCallback(async () => {
    if (phase === "stopping" || phase === "discarding") return;
    setPhase("stopping");
    setError(null);
    clearCountdownTimer();
    await invoke("close_recording_countdown_window").catch(() => undefined);
    await closePrompter();
    try {
      const take = await invoke<RecordingTake>("stop_recording_take");
      setRecordingTake(take);
      await emit("recording-control-stopped", take).catch((err) => {
        console.warn("Failed to notify main window that recording stopped:", err);
      });
      await invoke("close_recording_control_window");
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      setError(message);
      setPhase("recording");
    }
  }, [clearCountdownTimer, closePrompter, phase]);

  const discardRecording = useCallback(async (confirmFirst = true) => {
    if (phase === "stopping" || phase === "discarding") return;
    if (confirmFirst && !window.confirm("Discard this take and delete the files recorded so far?")) return;
    setPhase("discarding");
    setError(null);
    clearCountdownTimer();
    await invoke("close_recording_countdown_window").catch(() => undefined);
    await closePrompter();
    try {
      const take = await invoke<RecordingTake>("discard_recording_take");
      setRecordingTake(take);
      await emit("recording-control-discarded", take).catch((err) => {
        console.warn("Failed to notify main window that recording was discarded:", err);
      });
      await invoke("close_recording_control_window");
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
      setPhase("recording");
    }
  }, [clearCountdownTimer, closePrompter, phase]);

  const requestClose = useCallback(async () => {
    if (phase === "recording") {
      await discardRecording(false);
      return;
    }
    if (phase === "countdown" || phase === "starting") {
      clearCountdownTimer();
      await invoke("close_recording_countdown_window").catch(() => undefined);
    }
    await closePrompter();
    if (phase !== "stopping" && phase !== "discarding") {
      await invoke("close_recording_control_window");
    }
  }, [clearCountdownTimer, closePrompter, discardRecording, phase]);

  const stopSourcePreview = useCallback(async () => {
    let stoppedCameraPreview = false;
    setSourcePreview((current) => {
      if (current?.kind === "camera") {
        current.stream.getTracks().forEach((track) => track.stop());
        stoppedCameraPreview = true;
      }
      return null;
    });
    if (stoppedCameraPreview) {
      await new Promise((resolve) => window.setTimeout(resolve, 750));
    }
  }, []);

  const openPrompter = useCallback(async (readMode: boolean) => {
    if (!scope || !selectedMonitor) return;
    await invoke("open_recording_prompter_window", {
      scope,
      documentTitle,
      physX: selectedMonitor.x,
      physY: selectedMonitor.y,
      physW: selectedMonitor.width,
      physH: selectedMonitor.height,
      readMode,
    });
  }, [documentTitle, scope, selectedMonitor]);

  const startTake = useCallback(async () => {
    if (!scope || !selectedMonitor) return;
    setPhase("starting");
    setError(null);
    await stopSourcePreview();
    await invoke("close_recording_countdown_window").catch(() => undefined);

    const recorderSettings: RecorderSettings = {
      capture_source: "full_screen",
      capture_area: monitorToCaptureArea(selectedMonitor, monitors.indexOf(selectedMonitor)),
      mic_device_id: micDeviceId || null,
      camera_device_id: cameraDeviceId || null,
      camera_format: selectedCameraFormat,
      countdown_seconds: countdownSeconds,
      frame_rate: frameRate,
      include_cursor: includeCursor,
      include_system_audio: includeSystemAudio && supportsSystemAudio,
      mic_volume: micVolume,
      system_audio_volume: systemAudioVolume,
      output_quality: settings.recorderOutputQuality,
      capture_backend: "auto",
    };

    try {
      await Promise.all([
        updateSetting("recorderMicDeviceId", micDeviceId),
        updateSetting("recorderMicVolume", micVolume),
        updateSetting("recorderCameraDeviceId", cameraDeviceId),
        updateSetting("recorderCameraEnabled", !!cameraDeviceId),
        updateSetting("recorderMonitorPreference", monitorPreference(selectedMonitor)),
        updateSetting("recorderSystemAudioEnabled", includeSystemAudio && supportsSystemAudio),
        updateSetting("recorderSystemAudioVolume", systemAudioVolume),
        updateSetting("recorderFrameRate", frameRate),
        updateSetting("recorderCountdownSeconds", countdownSeconds),
        updateSetting("recorderIncludeCursor", includeCursor),
      ]);
      const take = await invoke<RecordingTake>("start_recording_take", {
        scope,
        settings: recorderSettings,
      });
      setRecordingTake(take);
      setPhase("recording");
      await currentWindow.setSize(HUD_SIZE).catch(() => undefined);
      if (prompterEnabled && prompterAvailable && supportsPrompterClickThrough) {
        await emit("recording-prompter-read", {}).catch(() => undefined);
      }
      await emit("recording-control-started", take).catch((err) => {
        console.warn("Failed to notify main window that recording started:", err);
      });
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
      setPhase("setup");
    }
  }, [
    countdownSeconds,
    cameraDeviceId,
    currentWindow,
    frameRate,
    includeCursor,
    includeSystemAudio,
    micDeviceId,
    micVolume,
    monitors,
    prompterAvailable,
    prompterEnabled,
    scope,
    selectedCameraFormat,
    selectedMonitor,
    settings.recorderOutputQuality,
    stopSourcePreview,
    systemAudioVolume,
    supportsPrompterClickThrough,
    supportsSystemAudio,
    updateSetting,
  ]);

  const startRecording = useCallback(async () => {
    if (!selectedMonitor || !canStart) return;
    await stopSourcePreview();
    if (prompterEnabled && prompterAvailable) {
      try {
        await openPrompter(supportsPrompterClickThrough);
      } catch (err) {
        setError(err instanceof Error ? err.message : String(err));
        return;
      }
    } else {
      await closePrompter();
    }
    if (countdownSeconds <= 0) {
      await startTake();
      return;
    }

    setPhase("countdown");
    setError(null);
    try {
      await invoke("open_recording_countdown_window", {
        monitorId: selectedMonitor.id,
        physX: selectedMonitor.x,
        physY: selectedMonitor.y,
        physW: selectedMonitor.width,
        physH: selectedMonitor.height,
        countdownSeconds,
        documentTitle,
      });
      clearCountdownTimer();
      countdownTimerRef.current = window.setTimeout(() => {
        countdownTimerRef.current = null;
        void startTake();
      }, countdownSeconds * 1000);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
      setPhase("setup");
    }
  }, [canStart, clearCountdownTimer, closePrompter, countdownSeconds, documentTitle, openPrompter, prompterAvailable, prompterEnabled, selectedMonitor, startTake, stopSourcePreview, supportsPrompterClickThrough]);

  const previewScreen = useCallback(async () => {
    if (!selectedMonitor) return;
    setError(null);
    try {
      await stopSourcePreview();
      const path = await invoke<string>("capture_fullscreen", { monitorId: selectedMonitor.id });
      const src = projectRoot ? convertFileSrc(`${projectRoot}/${path}`) : path;
      setSourcePreview({
        kind: "screen",
        title: `${selectedMonitor.name || `Screen ${selectedMonitor.id + 1}`} - ${selectedMonitor.width}x${selectedMonitor.height}`,
        src,
      });
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    }
  }, [projectRoot, selectedMonitor, stopSourcePreview]);

  const previewCamera = useCallback(async () => {
    if (!selectedCamera) return;
    setError(null);
    try {
      await stopSourcePreview();
      if (!navigator.mediaDevices?.getUserMedia) {
        throw new Error("Camera preview is not available in this webview");
      }
      const devices = await navigator.mediaDevices.enumerateDevices();
      const matched = devices.find((device) => device.kind === "videoinput" && device.label === selectedCamera.label);
      const stream = await navigator.mediaDevices.getUserMedia({
        video: matched ? { deviceId: { exact: matched.deviceId } } : true,
        audio: false,
      });
      setSourcePreview({
        kind: "camera",
        title: cameraDeviceLabel(selectedCamera, selectedCameraFormats),
        stream,
      });
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    }
  }, [selectedCamera, selectedCameraFormats, stopSourcePreview]);

  const previewPrompter = useCallback(async () => {
    if (!prompterAvailable) return;
    setError(null);
    try {
      await openPrompter(false);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    }
  }, [openPrompter, prompterAvailable]);

  useEffect(() => {
    void currentWindow.setSize(phase === "setup" || phase === "countdown" || phase === "starting" ? SETUP_SIZE : HUD_SIZE).catch(() => undefined);
  }, [currentWindow, phase]);

  useEffect(() => {
    invoke<ProjectView | null>("get_current_project")
      .then((project) => setProjectRoot(project?.root ?? ""))
      .catch(() => setProjectRoot(""));
  }, []);

  useEffect(() => {
    let cancelled = false;
    invoke<RecordingPlatformCapabilities>("get_recording_platform_capabilities")
      .then((capabilities) => {
        if (!cancelled && isRecordingPlatformCapabilities(capabilities)) {
          setPlatformCapabilities(capabilities);
        }
      })
      .catch((err) => {
        console.warn("Failed to load recording platform capabilities:", err);
      });
    return () => {
      cancelled = true;
    };
  }, []);

  useEffect(() => {
    (async () => {
      try {
        const next = await invoke<RecordingControlParams>("get_recording_control_params");
        setParams(next);
        if (next.take_id) {
          setRecordingTake((current) => current ?? { id: next.take_id } as RecordingTake);
          setPhase("recording");
        }
      } catch (err) {
        setError(err instanceof Error ? err.message : String(err));
      }
    })();
  }, []);

  useEffect(() => {
    if (!scope) {
      setPrompterScript(null);
      return;
    }
    let cancelled = false;
    setPrompterLoading(true);
    invoke<PrompterScript>("get_recording_prompter_script", { scope })
      .then((script) => {
        if (cancelled) return;
        const steps = Array.isArray(script?.steps) ? script.steps : [];
        const safeScript = { title: script?.title ?? documentTitle, steps };
        setPrompterScript(safeScript);
        setPrompterEnabled(steps.length > 0);
      })
      .catch((err) => {
        if (cancelled) return;
        console.warn("Failed to load prompter script:", err);
        setPrompterScript(null);
        setPrompterEnabled(false);
      })
      .finally(() => {
        if (!cancelled) setPrompterLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [documentTitle, scope]);

  useEffect(() => {
    if (!loaded || settingsHydratedRef.current) return;
    setMicDeviceId(settings.recorderMicDeviceId || "");
    setMicVolume(settings.recorderMicVolume);
    setCameraDeviceId(settings.recorderCameraEnabled ? settings.recorderCameraDeviceId || "" : "");
    setIncludeSystemAudio(settings.recorderSystemAudioEnabled);
    setSystemAudioVolume(settings.recorderSystemAudioVolume);
    setFrameRate(settings.recorderFrameRate);
    setCountdownSeconds(settings.recorderCountdownSeconds);
    setIncludeCursor(settings.recorderIncludeCursor);
    settingsHydratedRef.current = true;
  }, [loaded, settings]);

  useEffect(() => {
    if (!loaded || !settingsHydratedRef.current || !selectedMonitor) return;
    const timer = window.setTimeout(() => {
      void Promise.all([
        updateSetting("recorderMicDeviceId", micDeviceId),
        updateSetting("recorderMicVolume", micVolume),
        updateSetting("recorderCameraDeviceId", cameraDeviceId),
        updateSetting("recorderCameraEnabled", !!cameraDeviceId),
        updateSetting("recorderMonitorPreference", monitorPreference(selectedMonitor)),
        updateSetting("recorderSystemAudioEnabled", includeSystemAudio && supportsSystemAudio),
        updateSetting("recorderSystemAudioVolume", systemAudioVolume),
        updateSetting("recorderFrameRate", frameRate),
        updateSetting("recorderCountdownSeconds", countdownSeconds),
        updateSetting("recorderIncludeCursor", includeCursor),
      ]);
    }, 250);
    return () => window.clearTimeout(timer);
  }, [
    countdownSeconds,
    frameRate,
    cameraDeviceId,
    includeCursor,
    includeSystemAudio,
    loaded,
    micDeviceId,
    micVolume,
    selectedMonitor,
    systemAudioVolume,
    supportsSystemAudio,
    updateSetting,
  ]);

  useEffect(() => {
    if (!loaded) return;
    let cancelled = false;
    invoke<MonitorInfo[]>("list_monitors")
      .then((next) => {
        if (cancelled) return;
        setMonitors(next);
        const preferred = next.find((monitor) => monitorPreference(monitor) === settings.recorderMonitorPreference);
        const primary = next.find((monitor) => monitor.is_primary) ?? next[0] ?? null;
        setSelectedMonitorId((preferred ?? primary)?.id ?? null);
      })
      .catch((err) => {
        if (!cancelled) setError(err instanceof Error ? err.message : String(err));
      });
    return () => {
      cancelled = true;
    };
  }, [loaded, settings.recorderMonitorPreference]);

  useEffect(() => {
    if (!cameraDeviceId || cameraFormatsById[cameraDeviceId]) return;
    let cancelled = false;
    setCameraFormatsLoading(true);
    invoke<CameraFormatInfo[]>("discover_camera_formats", { cameraDeviceId })
      .then((formats) => {
        if (cancelled) return;
        setCameraFormatsById((current) => ({ ...current, [cameraDeviceId]: formats }));
      })
      .catch((err) => {
        if (!cancelled) setError(err instanceof Error ? err.message : String(err));
      })
      .finally(() => {
        if (!cancelled) setCameraFormatsLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [cameraDeviceId, cameraFormatsById]);

  useEffect(() => {
    const unlistenCancel = listen("recording-countdown-cancel", () => {
      clearCountdownTimer();
      setPhase("setup");
    });
    const unlistenToggle = listen("toggle-recording", () => {
      if (phase === "recording") void stopRecording();
      if (phase === "setup" && canStart) void startRecording();
    });
    return () => {
      unlistenCancel.then((fn) => fn());
      unlistenToggle.then((fn) => fn());
    };
  }, [canStart, clearCountdownTimer, phase, startRecording, stopRecording]);

  useEffect(() => {
    const unlisten = currentWindow.onCloseRequested((event) => {
      if (phase === "recording") {
        event.preventDefault();
        void requestClose();
      } else if (phase === "countdown" || phase === "starting") {
        event.preventDefault();
        void requestClose();
      } else if (phase === "stopping" || phase === "discarding") {
        event.preventDefault();
      }
    });
    return () => {
      unlisten.then((fn) => fn());
    };
  }, [currentWindow, phase, requestClose]);

  useEffect(() => {
    let saveTimer: number | null = null;
    const unlisten = currentWindow.onMoved(({ payload }) => {
      if (saveTimer !== null) window.clearTimeout(saveTimer);
      saveTimer = window.setTimeout(() => {
        void saveWindowPosition(payload);
      }, 250);
    });

    return () => {
      if (saveTimer !== null) window.clearTimeout(saveTimer);
      unlisten.then((fn) => fn());
    };
  }, [currentWindow]);

  useEffect(() => {
    return () => {
      if (sourcePreview?.kind === "camera") {
        sourcePreview.stream.getTracks().forEach((track) => track.stop());
      }
    };
  }, [sourcePreview]);

  useEffect(() => {
    if (phase !== "recording") return;

    let cancelled = false;
    const update = async () => {
      try {
        const next = await invoke<RecordingAudioLevel>("get_recording_audio_level");
        if (!cancelled) setAudioLevel(next);
      } catch {
        if (!cancelled) setAudioLevel((level) => ({ ...level, available: false, rms: 0, peak: 0 }));
      }
    };

    void update();
    const timer = window.setInterval(update, 280);
    return () => {
      cancelled = true;
      window.clearInterval(timer);
    };
  }, [phase]);

  useEffect(() => () => {
    clearCountdownTimer();
  }, [clearCountdownTimer]);

  const dragRef = useRef<{ startX: number; startY: number; winX: number; winY: number } | null>(null);

  const startDrag = useCallback(async (e: React.MouseEvent) => {
    if (!isMac) {
      void currentWindow.startDragging();
      return;
    }
    e.preventDefault();
    const pos = await currentWindow.outerPosition();
    const scale = window.devicePixelRatio || 1;
    dragRef.current = { startX: e.screenX, startY: e.screenY, winX: pos.x / scale, winY: pos.y / scale };

    const onMouseMove = (ev: MouseEvent) => {
      const drag = dragRef.current;
      if (!drag) return;
      const dx = ev.screenX - drag.startX;
      const dy = ev.screenY - drag.startY;
      void currentWindow.setPosition(
        new LogicalPosition(
          Math.round(drag.winX + dx),
          Math.round(drag.winY + dy),
        ),
      );
    };
    const onMouseUp = () => {
      dragRef.current = null;
      document.removeEventListener("mousemove", onMouseMove);
      document.removeEventListener("mouseup", onMouseUp);
    };
    document.addEventListener("mousemove", onMouseMove);
    document.addEventListener("mouseup", onMouseUp);
  }, [currentWindow]);

  const toggleMicrophone = useCallback((enabled: boolean) => {
    if (!enabled) {
      setMicDeviceId("");
      return;
    }
    setMicDeviceId((current) => current || microphones.find((device) => device.is_default)?.id || microphones[0]?.id || "");
  }, [microphones]);

  const toggleCamera = useCallback((enabled: boolean) => {
    if (!enabled) {
      void stopSourcePreview();
      setCameraDeviceId("");
      return;
    }
    setCameraDeviceId((current) => current || cameras.find((device) => device.is_default)?.id || cameras[0]?.id || "");
  }, [cameras, stopSourcePreview]);

  if (phase === "recording" || phase === "stopping" || phase === "discarding") {
    return (
      <RecorderShell compact>
        <RecorderHeader
          title="Recording"
          subtitle={documentTitle}
          meta={recordingTake?.id ?? params?.take_id ?? "Active take"}
          status="REC"
          recording
          onDrag={startDrag}
          onClose={() => void requestClose()}
        />

        {error && <ErrorCard message={error} />}

        <div className="space-y-2">
          <AudioWaveMeter level={audioLevel} enabled={!!micDeviceId} />
          <div className="grid grid-cols-[1fr_auto] gap-2">
            <button
              type="button"
              aria-label="Stop recording and save"
              onClick={stopRecording}
              disabled={phase === "stopping" || phase === "discarding"}
              className="flex items-center justify-center gap-2 rounded-xl bg-[rgb(var(--color-accent))] px-3 py-2 text-xs font-semibold text-white transition-colors hover:bg-[rgb(var(--color-accent-hover))] disabled:cursor-wait disabled:opacity-70"
            >
              <Square className="h-3.5 w-3.5 fill-current" />
              {phase === "stopping" ? "Saving..." : "Stop"}
            </button>
            <button
              type="button"
              aria-label="Cancel recording without saving"
              onClick={() => void discardRecording()}
              disabled={phase === "stopping" || phase === "discarding"}
              className="flex items-center justify-center gap-1.5 rounded-xl border border-[rgb(var(--color-border))] bg-[rgb(var(--color-surface-alt))] px-3 py-2 text-xs font-semibold text-[rgb(var(--color-text-secondary))] transition-colors hover:border-[rgb(var(--color-accent))]/45 hover:text-[rgb(var(--color-text))] disabled:cursor-wait disabled:opacity-60"
            >
              <X className="h-3.5 w-3.5" />
              {phase === "discarding" ? "Canceling..." : "Cancel"}
            </button>
          </div>
          <div className="flex items-center justify-center gap-1.5 text-[10px] text-[rgb(var(--color-text-secondary))]">
            <Keyboard className="h-3 w-3" />
            Ctrl+Shift+R stops and saves
          </div>
        </div>
      </RecorderShell>
    );
  }

  return (
    <RecorderShell>
      <RecorderHeader title="CutReady Recorder" subtitle={documentTitle} status="Ready" onDrag={startDrag} onClose={() => void requestClose()} />

      {error && <ErrorCard message={error} />}
      {sourcePreview && <SourcePreviewPanel preview={sourcePreview} onClose={() => void stopSourcePreview()} />}

      <div className="grid flex-1 grid-cols-[1fr_74px] gap-1.5 px-2 pb-0.5">
        <div className="grid min-h-0 grid-cols-2 grid-rows-[1fr_1fr_auto] gap-1.5">
          <SourceTile
            icon={<Monitor className="h-4 w-4" />}
            label="Screen"
            enabled={!!selectedMonitor}
            onPreview={previewScreen}
            previewDisabled={!selectedMonitor}
            onEnabledChange={(enabled) => {
              if (!enabled) {
                setSelectedMonitorId(null);
                return;
              }
              setSelectedMonitorId((current) => current ?? monitors.find((monitor) => monitor.is_primary)?.id ?? monitors[0]?.id ?? null);
            }}
            control={
              <select
                aria-label="Screen"
                value={selectedMonitorId ?? ""}
                onChange={(event) => setSelectedMonitorId(Number(event.target.value))}
                className="w-full rounded-md border border-[rgb(var(--color-border))] bg-[rgb(var(--color-surface-alt))] px-1.5 py-0.5 text-[11px] font-medium text-[rgb(var(--color-text))] outline-none"
              >
                {monitors.length === 0 && <option value="">No screens</option>}
                {monitors.map((monitor) => (
                  <option key={monitor.id} value={monitor.id}>
                    {`${monitor.name || `Screen ${monitor.id + 1}`} - ${monitor.width}x${monitor.height}${monitor.is_primary ? " (primary)" : ""}`}
                  </option>
                ))}
              </select>
            }
          />

          <SourceTile
            icon={<Video className="h-4 w-4" />}
            label="Camera"
            enabled={!!cameraDeviceId}
            onPreview={previewCamera}
            previewDisabled={!cameraDeviceId || cameraFormatsLoading}
            previewTitle={cameraFormatsLoading ? "Loading camera modes..." : "Preview Camera"}
            onEnabledChange={toggleCamera}
            control={
              <select
                aria-label="Camera"
                value={cameraDeviceId}
                onChange={(event) => setCameraDeviceId(event.target.value)}
                className="w-full rounded-md border border-[rgb(var(--color-border))] bg-[rgb(var(--color-surface-alt))] px-1.5 py-0.5 text-[11px] font-medium text-[rgb(var(--color-text))] outline-none"
              >
                <option value="">No camera</option>
                {cameras.map((device) => (
                  <option key={device.id} value={device.id}>
                    {cameraDeviceLabel(device, cameraFormatsById[device.id] ?? device.camera_formats ?? [])}
                  </option>
                ))}
              </select>
            }
          />

          <SourceTile
            icon={<Mic className="h-4 w-4" />}
            label="Microphone"
            enabled={!!micDeviceId}
            onEnabledChange={toggleMicrophone}
            control={
              <select
                aria-label="Microphone"
                value={micDeviceId}
                onChange={(event) => setMicDeviceId(event.target.value)}
                className="w-full rounded-md border border-[rgb(var(--color-border))] bg-[rgb(var(--color-surface-alt))] px-1.5 py-0.5 text-[11px] font-medium text-[rgb(var(--color-text))] outline-none"
              >
                <option value="">No microphone</option>
                {microphones.map((device) => (
                  <option key={device.id} value={device.id}>
                    {device.is_default ? `${device.label} (default)` : device.label}
                  </option>
                ))}
              </select>
            }
          >
            <AudioVolumeControl label="Microphone volume" active={!!micDeviceId} value={micVolume} onChange={setMicVolume} />
          </SourceTile>

          <SourceTile
            icon={<Volume2 className="h-4 w-4" />}
            label="System Audio"
            enabled={includeSystemAudio && supportsSystemAudio}
            disabled={!supportsSystemAudio}
            onEnabledChange={setIncludeSystemAudio}
            control={
              <span className="block truncate text-[11px] font-medium text-[rgb(var(--color-text))]">
                {supportsSystemAudio ? "System Audio" : (platformCapabilities.system_audio_hint ? "Requires loopback driver" : "Unavailable on this platform")}
              </span>
            }
          >
            {!supportsSystemAudio && platformCapabilities.system_audio_hint && (
              <p className="text-[10px] leading-tight text-[rgb(var(--color-text-muted))] px-2 pb-2">
                {platformCapabilities.system_audio_hint}
              </p>
            )}
            <AudioVolumeControl
              label="System audio volume"
              active={includeSystemAudio && supportsSystemAudio}
              value={systemAudioVolume}
              onChange={setSystemAudioVolume}
            />
          </SourceTile>

          <SourceTile
            className="col-span-2"
            icon={<FileText className="h-4 w-4" />}
            label="Prompter"
            enabled={prompterEnabled && prompterAvailable}
            disabled={!prompterAvailable}
            onEnabledChange={setPrompterEnabled}
            onPreview={previewPrompter}
            previewDisabled={!prompterAvailable || prompterLoading || !selectedMonitor}
            previewTitle={prompterLoading ? "Loading script..." : "Preview Prompter"}
            control={
              <span className="block truncate text-[11px] font-medium text-[rgb(var(--color-text))]">
                {prompterLoading
                  ? "Loading script..."
                  : prompterAvailable
                    ? `${prompterScript?.steps.length ?? 0} manual steps`
                    : "No narrative rows"}
              </span>
            }
          />
        </div>

        <div className="flex flex-col items-center justify-center gap-1 rounded-xl border border-[rgb(var(--color-border))] bg-[rgb(var(--color-surface-alt))]">
          <button
            type="button"
            aria-label="Start recording"
            onClick={startRecording}
            disabled={!canStart}
            className="flex h-12 w-12 items-center justify-center rounded-full bg-[#dc3f43] text-base font-medium lowercase text-white shadow-lg shadow-[#dc3f43]/25 transition-colors hover:bg-[#c9363a] disabled:cursor-not-allowed disabled:opacity-50"
          >
            {phase === "countdown" ? "..." : phase === "starting" ? "..." : "rec"}
          </button>
          <span className="text-[11px] font-semibold text-[rgb(var(--color-text))]">Start</span>
        </div>
      </div>

      <div className="grid grid-cols-[1fr_auto] items-center border-t border-[rgb(var(--color-border))] bg-[rgb(var(--color-surface-alt))]/60 px-2 py-0.5">
        <div className="flex min-w-0 items-center gap-1.5 text-[9px] text-[rgb(var(--color-text-secondary))]">
          <span className="truncate">For {documentTitle}</span>
          <span>{selectedMonitor ? `${selectedMonitor.width}x${selectedMonitor.height}` : "No screen selected"}</span>
          <span>{selectedMicrophone ? `${microphones.length} mic${microphones.length === 1 ? "" : "s"} detected` : deviceStatus(devicesLoading, devicesError, microphones.length)}</span>
        </div>
        <div className="flex items-center gap-2">
          <label className="flex items-center gap-1.5 text-[10px] font-medium text-[rgb(var(--color-text-secondary))]">
            <select
              value={frameRate}
              onChange={(event) => setFrameRate(Number(event.target.value))}
              className="rounded-md border border-[rgb(var(--color-border))] bg-[rgb(var(--color-surface))] px-1 py-0.5 text-[10px] text-[rgb(var(--color-text))] outline-none"
            >
              <option value={30}>30 fps</option>
              <option value={60}>60 fps</option>
            </select>
          </label>
          <label className="flex items-center gap-1.5 text-[10px] font-medium text-[rgb(var(--color-text-secondary))]">
            <select
              value={countdownSeconds}
              onChange={(event) => setCountdownSeconds(Number(event.target.value))}
              className="rounded-md border border-[rgb(var(--color-border))] bg-[rgb(var(--color-surface))] px-1 py-0.5 text-[10px] text-[rgb(var(--color-text))] outline-none"
            >
              <option value={0}>No delay</option>
              <option value={3}>3s delay</option>
              <option value={5}>5s delay</option>
            </select>
          </label>
          <label className="flex items-center gap-1.5 text-[10px] font-medium text-[rgb(var(--color-text-secondary))]">
            <input type="checkbox" checked={includeCursor} onChange={(event) => setIncludeCursor(event.target.checked)} className="h-3 w-3 accent-[rgb(var(--color-accent))]" />
            Cursor
          </label>
          <button type="button" onClick={refresh} className="text-[10px] font-semibold text-[rgb(var(--color-accent))] hover:text-[rgb(var(--color-accent-hover))]">
            Refresh
          </button>
        </div>
      </div>
    </RecorderShell>
  );
}

function RecorderShell({ children, compact = false }: { children: React.ReactNode; compact?: boolean }) {
  return (
    <div
      className={[
        "relative flex h-screen select-none flex-col overflow-hidden border border-[rgb(var(--color-accent))]/30 bg-[rgb(var(--color-surface))] text-[rgb(var(--color-text))] shadow-2xl",
        compact ? "justify-between pb-3 [&>*:not(:first-child)]:mx-3" : "gap-1 pb-1 [&>*:not(:first-child)]:mx-2",
      ].join(" ")}
    >
      {children}
    </div>
  );
}

function RecorderHeader({
  title,
  subtitle,
  meta,
  status,
  recording = false,
  onDrag,
  onClose,
}: {
  title: string;
  subtitle: string;
  meta?: string;
  status: string;
  recording?: boolean;
  onDrag: (e: React.MouseEvent) => void;
  onClose: () => void;
}) {
  return (
    <div
      aria-label="Drag recorder window"
      role="banner"
      className="flex cursor-grab items-center justify-between gap-2 border-b border-[rgb(var(--color-border))] bg-[rgb(var(--color-surface-alt))]/80 px-2.5 py-1 active:cursor-grabbing"
      onMouseDown={onDrag}
      onDoubleClick={onDrag}
    >
      <div className="min-w-0 flex-1">
        <div className="flex items-center gap-2">
          <span
            className={[
              "h-2 w-2 rounded-full",
              recording ? "bg-[rgb(var(--color-accent))]" : "bg-[rgb(var(--color-text-secondary))]/40",
            ].join(" ")}
          />
          <div className="truncate text-xs font-semibold">{title}</div>
        </div>
        <div className="truncate text-[10px] text-[rgb(var(--color-text-secondary))]">{subtitle}</div>
        {meta && <div className="mt-0.5 truncate text-[10px] text-[rgb(var(--color-text-secondary))]/70">{meta}</div>}
      </div>
      <div className="rounded-full border border-[rgb(var(--color-accent))]/25 bg-[rgb(var(--color-accent))]/10 px-1.5 py-0.5 text-[9px] font-semibold uppercase tracking-[0.16em] text-[rgb(var(--color-accent))]">
        {status}
      </div>
      <button
        type="button"
        aria-label={recording ? "Close recorder and cancel recording" : "Close recorder"}
        onClick={(event) => {
          event.stopPropagation();
          onClose();
        }}
        onMouseDown={(event) => event.stopPropagation()}
        className="flex h-6 w-6 items-center justify-center rounded-lg text-[rgb(var(--color-text-secondary))] transition-colors hover:bg-[rgb(var(--color-border))]/35 hover:text-[rgb(var(--color-text))]"
      >
        <X className="h-3.5 w-3.5" />
      </button>
    </div>
  );
}

function SourceTile({
  className,
  icon,
  label,
  enabled,
  disabled,
  control,
  children,
  onEnabledChange,
  onPreview,
  previewDisabled,
  previewTitle,
}: {
  className?: string;
  icon: React.ReactNode;
  label: string;
  enabled: boolean;
  disabled?: boolean;
  control: React.ReactNode;
  children?: React.ReactNode;
  onEnabledChange: (enabled: boolean) => void;
  onPreview?: () => void;
  previewDisabled?: boolean;
  previewTitle?: string;
}) {
  return (
    <section
      className={[
        "flex min-h-0 flex-col gap-0.5",
        className ?? "",
        disabled ? "opacity-60" : "",
      ].join(" ")}
    >
      <div className="grid min-w-0 grid-cols-[auto_1fr_auto_auto] items-center gap-1.5 rounded-md border border-[rgb(var(--color-border))] bg-[rgb(var(--color-surface))] px-1.5 py-0.5">
        <div className="flex items-center text-[rgb(var(--color-text-secondary))]" title={label} aria-hidden="true">
          <span className="text-[rgb(var(--color-text-secondary))]">{icon}</span>
        </div>
        <div className="min-w-0">{control}</div>
        {onPreview ? (
          <button
            type="button"
            aria-label={`Preview ${label}`}
            title={previewTitle ?? `Preview ${label}`}
            disabled={disabled || previewDisabled}
            onClick={onPreview}
            className="flex h-5 w-5 items-center justify-center rounded-md text-[rgb(var(--color-text-secondary))] transition-colors hover:bg-[rgb(var(--color-border))]/40 hover:text-[rgb(var(--color-text))] disabled:cursor-not-allowed disabled:opacity-35"
          >
            <Eye className="h-3 w-3" />
          </button>
        ) : (
          <span aria-hidden="true" className="h-5 w-0" />
        )}
        <ToggleSwitch label={label} checked={enabled} disabled={disabled} onChange={onEnabledChange} />
      </div>
      {children && <div className="min-w-0 px-1">{children}</div>}
    </section>
  );
}

function SourcePreviewPanel({ preview, onClose }: { preview: SourcePreview; onClose: () => void }) {
  return (
    <div className="absolute inset-x-2 top-9 z-20 rounded-xl border border-[rgb(var(--color-accent))]/30 bg-[rgb(var(--color-surface))]/95 p-2 shadow-2xl backdrop-blur-md">
      <div className="mb-1.5 flex items-center justify-between gap-2">
        <span className="truncate text-[10px] font-semibold text-[rgb(var(--color-text-secondary))]">{preview.title}</span>
        <button
          type="button"
          aria-label="Close preview"
          onClick={onClose}
          className="flex h-5 w-5 items-center justify-center rounded-md text-[rgb(var(--color-text-secondary))] transition-colors hover:bg-[rgb(var(--color-border))]/40 hover:text-[rgb(var(--color-text))]"
        >
          <X className="h-3 w-3" />
        </button>
      </div>
      <div className="flex h-32 items-center justify-center overflow-hidden rounded-lg bg-black">
        {preview.kind === "screen" ? (
          <img src={preview.src} alt="" className="h-full w-full object-contain" />
        ) : (
          <CameraPreviewVideo stream={preview.stream} />
        )}
      </div>
    </div>
  );
}

function CameraPreviewVideo({ stream }: { stream: MediaStream }) {
  const ref = useRef<HTMLVideoElement | null>(null);

  useEffect(() => {
    if (!ref.current) return;
    ref.current.srcObject = stream;
  }, [stream]);

  return <video ref={ref} autoPlay muted playsInline className="h-full w-full object-contain" />;
}

function ToggleSwitch({
  label,
  checked,
  disabled,
  onChange,
}: {
  label: string;
  checked: boolean;
  disabled?: boolean;
  onChange: (checked: boolean) => void;
}) {
  return (
    <label className="relative inline-flex h-4 w-7 items-center">
      <input
        type="checkbox"
        aria-label={label}
        checked={checked}
        disabled={disabled}
        onChange={(event) => onChange(event.target.checked)}
        className="peer sr-only"
      />
      <span className="absolute inset-0 rounded-full bg-[rgb(var(--color-border))] transition-colors peer-checked:bg-[rgb(var(--color-accent))] peer-disabled:opacity-50" />
      <span className="absolute left-0.5 h-3 w-3 rounded-full bg-white shadow transition-transform peer-checked:translate-x-3" />
    </label>
  );
}

function AudioVolumeControl({
  active,
  value,
  label,
  onChange,
}: {
  active: boolean;
  value: number;
  label: string;
  onChange: (value: number) => void;
}) {
  return (
    <div className="grid grid-cols-[1fr_auto] items-center gap-2">
      <div className="relative h-3.5">
        <div className="absolute left-0 right-0 top-1.5 h-1 rounded-full bg-[rgb(var(--color-border))]" />
        <div className="absolute left-0 top-1.5 h-1 rounded-full bg-[rgb(var(--color-accent))]" style={{ width: active ? `${Math.min(100, value / 2)}%` : "0%" }} />
        <input
          type="range"
          aria-label={label}
          min={0}
          max={200}
          step={5}
          value={value}
          disabled={!active}
          onChange={(event) => onChange(Number(event.target.value))}
          className="absolute inset-0 h-full w-full cursor-pointer opacity-0 disabled:cursor-not-allowed"
        />
      </div>
      <span className="w-7 text-right text-[9px] font-semibold text-[rgb(var(--color-text-secondary))]">
        {active ? `${value}%` : "Off"}
      </span>
    </div>
  );
}

function ErrorCard({ message }: { message: string }) {
  return (
    <div className="rounded-lg border border-[rgb(var(--color-border))] bg-[rgb(var(--color-surface-alt))] px-2 py-1.5 text-[10px] text-[rgb(var(--color-text-secondary))]">
      {message}
    </div>
  );
}

function AudioWaveMeter({ level, enabled }: { level: RecordingAudioLevel; enabled: boolean }) {
  const signal = Math.min(1, Math.max(level.rms * 14, level.peak * 2.6));
  const active = enabled && level.available && level.bytes > 44;
  const label = !enabled
    ? "Mic off"
    : active
      ? signal > 0.035
        ? "Mic signal"
        : "Mic armed - quiet"
      : "Mic waiting";

  return (
    <div className="rounded-xl border border-[rgb(var(--color-border))] bg-[rgb(var(--color-surface-alt))]/80 px-3 py-2">
      <div className="mb-1.5 flex items-center justify-between gap-2">
        <span className="text-[10px] font-medium uppercase tracking-[0.18em] text-[rgb(var(--color-text-secondary))]">
          {label}
        </span>
        <span
          className={[
            "h-2 w-2 rounded-full",
            signal > 0.035 ? "bg-[rgb(var(--color-accent))]" : "bg-[rgb(var(--color-text-secondary))]/35",
          ].join(" ")}
        />
      </div>
      <div className="flex h-7 items-center gap-1 overflow-hidden" aria-label={label} role="meter" aria-valuemin={0} aria-valuemax={100} aria-valuenow={Math.round(signal * 100)}>
        {WAVE_BARS.map((shape, index) => {
          const motion = Math.max(0.08, Math.min(1, signal * (0.55 + shape)));
          const height = active ? 5 + motion * 22 : 4 + shape * 7;
          return (
            <span
              key={index}
              className="w-1.5 rounded-full bg-[rgb(var(--color-accent))] transition-[height,opacity] duration-150"
              style={{
                height,
                opacity: active ? 0.35 + motion * 0.65 : 0.18,
              }}
            />
          );
        })}
      </div>
    </div>
  );
}

function isRecordingPlatformCapabilities(value: unknown): value is RecordingPlatformCapabilities {
  if (!value || typeof value !== "object") return false;
  const maybe = value as Partial<RecordingPlatformCapabilities>;
  return isKnownRecordingPlatform(maybe.platform)
    && typeof maybe.supports_system_audio === "boolean"
    && typeof maybe.supports_native_monitor_capture === "boolean"
    && typeof maybe.supports_window_capture_exclusion === "boolean"
    && typeof maybe.supports_click_through_prompter === "boolean"
    && typeof maybe.supports_camera_format_discovery === "boolean";
}

function isKnownRecordingPlatform(value: unknown): value is RecordingPlatformCapabilities["platform"] {
  return value === "windows" || value === "macos" || value === "linux" || value === "unknown";
}

function monitorToCaptureArea(monitor: MonitorInfo, displayIndex: number): CaptureArea {
  return {
    x: monitor.x,
    y: monitor.y,
    width: monitor.width,
    height: monitor.height,
    display_index: displayIndex >= 0 ? displayIndex : null,
    hmonitor: monitor.hmonitor ?? null,
    dxgi_output_index: monitor.dxgi_output_index ?? null,
  };
}

function cameraDeviceLabel(device: RecordingDeviceInfo, formats = device.camera_formats ?? []): string {
  const format = bestCameraFormat(formats);
  return format ? `${device.label} - ${cameraFormatLabel(format)}` : device.label;
}

function bestCameraFormat(formats: CameraFormatInfo[]): CameraFormatInfo | null {
  return formats
    .slice()
    .sort((a, b) => cameraFormatScore(b) - cameraFormatScore(a))[0] ?? null;
}

function cameraFormatScore(format: CameraFormatInfo): number {
  const area = format.width * format.height;
  const fps = parseCameraFps(format.fps);
  const rawBonus = format.pixel_format ? 1 : 0;
  return area * 10_000 + fps * 10 + rawBonus;
}

function parseCameraFps(fps?: string | null): number {
  if (!fps) return 0;
  const [numerator, denominator] = fps.split("/");
  if (denominator) {
    const parsedNumerator = Number(numerator);
    const parsedDenominator = Number(denominator);
    return parsedDenominator > 0 ? parsedNumerator / parsedDenominator : 0;
  }
  return Number(fps) || 0;
}

function cameraFormatLabel(format: CameraFormatInfo): string {
  const fps = format.fps ? ` @ ${format.fps}fps` : "";
  const encoding = format.codec ?? format.pixel_format ?? "";
  return `${format.width}x${format.height}${fps}${encoding ? ` ${encoding}` : ""}`;
}

function monitorPreference(monitor: MonitorInfo): string {
  return [
    monitor.device_name ?? "",
    monitor.width,
    monitor.height,
    monitor.is_primary ? "primary" : "secondary",
  ].join("|");
}

function deviceStatus(loading: boolean, error: string | null, microphoneCount: number) {
  if (loading) return "Detecting Windows audio devices...";
  if (error) return "Could not detect recording devices.";
  if (microphoneCount === 0) return "No active Windows microphones were detected.";
  return `${microphoneCount} Windows microphone${microphoneCount === 1 ? "" : "s"} detected`;
}

async function saveWindowPosition(position: PhysicalPosition) {
  await invoke("save_recording_control_position", {
    position: {
      x: position.x,
      y: position.y,
    },
  }).catch((err) => {
    console.warn("Failed to save recording control position:", err);
  });
}
