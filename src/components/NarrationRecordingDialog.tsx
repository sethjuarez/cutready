import { useCallback, useEffect, useRef, useState } from "react";
import { ChevronLeft, ChevronRight, Image as ImageIcon, Loader2, Play, RotateCcw, Save, Square, X } from "lucide-react";
import { useProjectImage } from "../hooks/useProjectImage";
import { invoke } from "../services/tauri";

export interface NarrationRecordingTake {
  audioData: number[];
  mimeType: string;
  durationMs: number;
  sourceText: string;
  leadingSilenceMs: number;
  trailingSilenceMs: number;
  silenceThresholdDb: number;
}

type RecordingStatus = "idle" | "preparing" | "recording" | "recorded" | "error";
type RecordingInputStatus = "preparing" | "ready" | "error" | "unsupported";
type SaveNarrationOptions = { navigateToRow?: number | null };
type NarrationAssetData = { data: number[]; mimeType: string };
type PreparedRecordingInput = {
  stream: MediaStream;
  context: AudioContext;
  analyser: AnalyserNode;
  data: Uint8Array<ArrayBuffer>;
};

const SILENCE_THRESHOLD_DB = -45;
const SILENCE_WINDOW_MS = 10;

interface NarrationRecordingDialogProps {
  rowNumber: number;
  sourceText: string;
  projectRoot?: string | null;
  screenshotPath?: string | null;
  existingNarrationPath?: string | null;
  existingNarrationDurationMs?: number | null;
  canNavigatePrevious?: boolean;
  canNavigateNext?: boolean;
  audio: boolean | MediaTrackConstraints;
  mimeType: string;
  onAddScreenshot?: () => void;
  onCancel: () => void;
  onNavigatePrevious?: () => void;
  onNavigateNext?: () => void;
  onSave: (take: NarrationRecordingTake, options?: SaveNarrationOptions) => Promise<void>;
}

function formatElapsed(ms: number): string {
  const seconds = Math.max(0, Math.floor(ms / 1000));
  const minutes = Math.floor(seconds / 60);
  const remainder = seconds % 60;
  return `${minutes}:${remainder.toString().padStart(2, "0")}`;
}

function alignToDevicePixel(value: number, dpr: number): number {
  return Math.round(value * dpr) / dpr;
}

function amplitudeFromDb(db: number): number {
  return 10 ** (db / 20);
}

function closeAudioContext(context: AudioContext | null) {
  if (!context || context.state === "closed") return;
  void context.close().catch((error: unknown) => {
    console.warn("[NarrationRecordingDialog] failed to close audio context", { error });
  });
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

function drawWaveform(
  canvas: HTMLCanvasElement,
  analyser: AnalyserNode,
  data: Uint8Array<ArrayBuffer>,
) {
  const metrics = prepareWaveformCanvas(canvas);
  if (!metrics) return;

  const { context, width, height, dpr } = metrics;
  const styles = getComputedStyle(document.documentElement);
  const accent = `rgb(${styles.getPropertyValue("--color-accent").trim()})`;
  const border = `rgb(${styles.getPropertyValue("--color-border").trim()})`;
  const surface = `rgb(${styles.getPropertyValue("--color-surface-alt").trim()})`;
  const midline = alignToDevicePixel(height / 2, dpr);

  analyser.getByteTimeDomainData(data);
  context.clearRect(0, 0, width, height);

  const gradient = context.createLinearGradient(0, 0, width, height);
  gradient.addColorStop(0, surface);
  gradient.addColorStop(1, "rgba(255,255,255,0)");
  context.fillStyle = gradient;
  context.fillRect(0, 0, width, height);

  context.strokeStyle = border;
  context.lineWidth = 1 / dpr;
  context.beginPath();
  context.moveTo(0, midline);
  context.lineTo(width, midline);
  context.stroke();

  context.strokeStyle = accent;
  context.lineWidth = 2;
  context.beginPath();
  const sliceWidth = width / data.length;
  data.forEach((value, index) => {
    const y = (value / 255) * height;
    const x = index * sliceWidth;
    if (index === 0) context.moveTo(x, y);
    else context.lineTo(x, y);
  });
  context.stroke();
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

async function analyzeSilence(encodedAudio: ArrayBuffer): Promise<{
  leadingSilenceMs: number;
  trailingSilenceMs: number;
  thresholdDb: number;
}> {
  const context = new AudioContext();
  try {
    const audioBuffer = await context.decodeAudioData(encodedAudio);
    const threshold = amplitudeFromDb(SILENCE_THRESHOLD_DB);
    const windowSize = Math.max(1, Math.round((audioBuffer.sampleRate * SILENCE_WINDOW_MS) / 1000));
    const channelData = Array.from({ length: audioBuffer.numberOfChannels }, (_, index) => audioBuffer.getChannelData(index));
    const totalSamples = audioBuffer.length;

    const windowRms = (start: number, end: number) => {
      let sum = 0;
      let count = 0;
      for (const channel of channelData) {
        for (let index = start; index < end && index < totalSamples; index += 1) {
          sum += channel[index] * channel[index];
          count += 1;
        }
      }
      return count > 0 ? Math.sqrt(sum / count) : 0;
    };

    let leadingSample = totalSamples;
    for (let start = 0; start < totalSamples; start += windowSize) {
      if (windowRms(start, Math.min(totalSamples, start + windowSize)) > threshold) {
        leadingSample = start;
        break;
      }
    }

    let trailingSample = totalSamples;
    for (let end = totalSamples; end > 0; end -= windowSize) {
      const start = Math.max(0, end - windowSize);
      if (windowRms(start, end) > threshold) {
        trailingSample = end;
        break;
      }
    }

    if (leadingSample === totalSamples) {
      return {
        leadingSilenceMs: Math.round(audioBuffer.duration * 1000),
        trailingSilenceMs: Math.round(audioBuffer.duration * 1000),
        thresholdDb: SILENCE_THRESHOLD_DB,
      };
    }

    return {
      leadingSilenceMs: Math.round((leadingSample / audioBuffer.sampleRate) * 1000),
      trailingSilenceMs: Math.round(((totalSamples - trailingSample) / audioBuffer.sampleRate) * 1000),
      thresholdDb: SILENCE_THRESHOLD_DB,
    };
  } finally {
    closeAudioContext(context);
  }
}

export function NarrationRecordingDialog({
  rowNumber,
  sourceText,
  projectRoot,
  screenshotPath,
  existingNarrationPath,
  existingNarrationDurationMs,
  canNavigatePrevious = false,
  canNavigateNext = false,
  audio,
  mimeType,
  onAddScreenshot,
  onCancel,
  onNavigatePrevious,
  onNavigateNext,
  onSave,
}: NarrationRecordingDialogProps) {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const recorderRef = useRef<MediaRecorder | null>(null);
  const chunksRef = useRef<Blob[]>([]);
  const streamRef = useRef<MediaStream | null>(null);
  const audioContextRef = useRef<AudioContext | null>(null);
  const audioRef = useRef<HTMLAudioElement>(null);
  const waveformFrameRef = useRef<HTMLDivElement>(null);
  const animationRef = useRef<number | null>(null);
  const timerRef = useRef<number | null>(null);
  const startedAtRef = useRef(0);
  const preparedInputRef = useRef<PreparedRecordingInput | null>(null);
  const prepareInputPromiseRef = useRef<Promise<PreparedRecordingInput> | null>(null);
  const recordedBlobRef = useRef<Blob | null>(null);
  const recordedUrlRef = useRef("");
  const recordedUrlIsObjectRef = useRef(false);
  const [status, setStatus] = useState<RecordingStatus>("idle");
  const [inputStatus, setInputStatus] = useState<RecordingInputStatus>("preparing");
  const [elapsedMs, setElapsedMs] = useState(0);
  const [recordedUrl, setRecordedUrl] = useState("");
  const [error, setError] = useState("");
  const [saving, setSaving] = useState(false);
  const [hasUnsavedTake, setHasUnsavedTake] = useState(false);
  const [playbackCurrentTime, setPlaybackCurrentTime] = useState(0);
  const [playbackDuration, setPlaybackDuration] = useState(0);
  const [waveformWidth, setWaveformWidth] = useState(0);
  const [waveformLayoutVersion, setWaveformLayoutVersion] = useState(0);
  const screenshotSrc = useProjectImage(projectRoot ?? null, screenshotPath);
  const hasExistingNarration = Boolean(existingNarrationPath);
  const playheadLeft = playbackDuration > 0 && waveformWidth > 0
    ? alignToDevicePixel(
        Math.min(waveformWidth, Math.max(0, (playbackCurrentTime / playbackDuration) * waveformWidth)),
        Math.max(1, window.devicePixelRatio || 1),
      )
    : 0;

  const stopVisualizer = useCallback(() => {
    if (animationRef.current !== null) cancelAnimationFrame(animationRef.current);
    animationRef.current = null;
    if (timerRef.current !== null) window.clearInterval(timerRef.current);
    timerRef.current = null;
  }, []);

  const replaceRecordedUrl = useCallback((url: string, isObjectUrl: boolean) => {
    const previousUrl = recordedUrlRef.current;
    if (previousUrl && recordedUrlIsObjectRef.current && previousUrl !== url) {
      URL.revokeObjectURL(previousUrl);
    }
    recordedUrlRef.current = url;
    recordedUrlIsObjectRef.current = isObjectUrl;
    setRecordedUrl(url);
  }, []);

  const cleanupInput = useCallback(() => {
    stopVisualizer();
    streamRef.current?.getTracks().forEach((track) => track.stop());
    streamRef.current = null;
    preparedInputRef.current = null;
    prepareInputPromiseRef.current = null;
    closeAudioContext(audioContextRef.current);
    audioContextRef.current = null;
  }, [stopVisualizer]);

  const prepareRecordingInput = useCallback(async (): Promise<PreparedRecordingInput> => {
    if (!navigator.mediaDevices?.getUserMedia || typeof MediaRecorder === "undefined") {
      setInputStatus("unsupported");
      throw new Error("Microphone recording is not available in this WebView.");
    }

    const preparedInput = preparedInputRef.current;
    if (preparedInput && preparedInput.stream.getAudioTracks().some((track) => track.readyState === "live")) {
      setInputStatus("ready");
      return preparedInput;
    }

    if (prepareInputPromiseRef.current) return prepareInputPromiseRef.current;

    setInputStatus("preparing");
    const preparePromise = navigator.mediaDevices.getUserMedia({ audio })
      .then((stream) => {
        const context = new AudioContext();
        const analyser = context.createAnalyser();
        analyser.fftSize = 2048;
        context.createMediaStreamSource(stream).connect(analyser);
        const prepared: PreparedRecordingInput = {
          stream,
          context,
          analyser,
          data: new Uint8Array(new ArrayBuffer(analyser.fftSize)),
        };
        streamRef.current = stream;
        audioContextRef.current = context;
        preparedInputRef.current = prepared;
        setInputStatus("ready");
        return prepared;
      })
      .catch((err: unknown) => {
        setInputStatus("error");
        throw err;
      })
      .finally(() => {
        prepareInputPromiseRef.current = null;
      });
    prepareInputPromiseRef.current = preparePromise;

    return preparePromise;
  }, [audio]);

  const stopRecording = useCallback(() => {
    const recorder = recorderRef.current;
    if (recorder && recorder.state !== "inactive") recorder.stop();
  }, []);

  const startRecording = useCallback(async () => {
    replaceRecordedUrl("", false);
    setHasUnsavedTake(false);
    setPlaybackCurrentTime(0);
    setPlaybackDuration(0);
    recordedBlobRef.current = null;
    setError("");
    setStatus("preparing");

    try {
      const preparedInput = await prepareRecordingInput();
      if (preparedInput.context.state === "suspended") {
        await preparedInput.context.resume();
      }

      const recorder = mimeType ? new MediaRecorder(preparedInput.stream, { mimeType }) : new MediaRecorder(preparedInput.stream);
      const canvas = canvasRef.current;
      let recordingUiStarted = false;
      let startFallbackTimer: number | null = null;
      const startRecordingUi = () => {
        if (recordingUiStarted) return;
        recordingUiStarted = true;
        startedAtRef.current = performance.now();
        setElapsedMs(0);
        setStatus("recording");

        const render = () => {
          if (canvas) drawWaveform(canvas, preparedInput.analyser, preparedInput.data);
          animationRef.current = requestAnimationFrame(render);
        };
        render();
        timerRef.current = window.setInterval(() => {
          setElapsedMs(Math.max(0, Math.round(performance.now() - startedAtRef.current)));
        }, 125);
      };
      chunksRef.current = [];
      recorderRef.current = recorder;
      setElapsedMs(0);

      recorder.ondataavailable = (event) => {
        if (event.data.size > 0) startRecordingUi();
        if (event.data.size > 0) chunksRef.current.push(event.data);
      };
      recorder.onstart = () => {
        startRecordingUi();
      };
      recorder.onerror = () => {
        if (startFallbackTimer !== null) window.clearTimeout(startFallbackTimer);
        setStatus("error");
        setError("Narration recording failed.");
        cleanupInput();
      };
      recorder.onstop = () => {
        if (startFallbackTimer !== null) window.clearTimeout(startFallbackTimer);
        const durationMs = Math.max(0, Math.round(performance.now() - startedAtRef.current));
        const blob = new Blob(chunksRef.current, { type: recorder.mimeType || mimeType || "audio/webm" });
        recordedBlobRef.current = blob;
        setElapsedMs(durationMs);
        replaceRecordedUrl(URL.createObjectURL(blob), true);
        setHasUnsavedTake(true);
        setStatus("recorded");
        recorderRef.current = null;
        chunksRef.current = [];
        cleanupInput();
      };
      recorder.start();
      startFallbackTimer = window.setTimeout(() => {
        if (recorder.state === "recording") startRecordingUi();
      }, 250);
    } catch (err) {
      setStatus("error");
      setError(`Could not prepare microphone recording: ${err}`);
      cleanupInput();
    }
  }, [cleanupInput, mimeType, prepareRecordingInput, replaceRecordedUrl]);

  const resetTake = () => {
    replaceRecordedUrl("", false);
    recordedBlobRef.current = null;
    setHasUnsavedTake(false);
    setPlaybackCurrentTime(0);
    setPlaybackDuration(0);
    setElapsedMs(existingNarrationDurationMs ?? 0);
    setStatus(hasExistingNarration ? "recorded" : "idle");
    setError("");
  };

  const saveTake = async (options?: SaveNarrationOptions) => {
    const blob = recordedBlobRef.current;
    if (!blob || saving) return;
    setSaving(true);
    try {
      const encodedAudio = await blob.arrayBuffer();
      const silence = await analyzeSilence(encodedAudio.slice(0));
      const audioData = new Uint8Array(encodedAudio);
      await onSave(
        {
          audioData: Array.from(audioData),
          mimeType: blob.type || mimeType || "audio/webm",
          durationMs: elapsedMs,
          sourceText,
          leadingSilenceMs: silence.leadingSilenceMs,
          trailingSilenceMs: silence.trailingSilenceMs,
          silenceThresholdDb: silence.thresholdDb,
        },
        options,
      );
      recordedBlobRef.current = null;
      setHasUnsavedTake(false);
      setStatus("recorded");
      setError("");
    } catch (err) {
      console.error("[NarrationRecordingDialog] failed to save narration take", err);
      setError(`Could not analyze and save narration: ${err}`);
    } finally {
      setSaving(false);
    }
  };

  const navigatePrevious = async () => {
    if (!canNavigatePrevious || status === "preparing" || status === "recording" || saving) return;
    if (hasUnsavedTake) {
      await saveTake({ navigateToRow: rowNumber - 2 });
      return;
    }
    onNavigatePrevious?.();
  };

  const navigateNext = async () => {
    if (!canNavigateNext || status === "preparing" || status === "recording" || saving) return;
    if (hasUnsavedTake) {
      await saveTake({ navigateToRow: rowNumber });
      return;
    }
    onNavigateNext?.();
  };

  const close = () => {
    if (status === "recording") stopRecording();
    cleanupInput();
    replaceRecordedUrl("", false);
    onCancel();
  };

  useEffect(() => {
    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.code === "Escape") {
        event.preventDefault();
        close();
        return;
      }
      if (event.code === "ArrowLeft") {
        event.preventDefault();
        void navigatePrevious();
        return;
      }
      if (event.code === "ArrowRight") {
        event.preventDefault();
        void navigateNext();
        return;
      }
      if (event.code === "Space") {
        event.preventDefault();
        if (status === "recording") stopRecording();
        else if ((status === "idle" || status === "recorded") && inputStatus === "ready") void startRecording();
      }
    };
    window.addEventListener("keydown", handleKeyDown);
    return () => window.removeEventListener("keydown", handleKeyDown);
  }, [close, inputStatus, navigateNext, navigatePrevious, startRecording, status, stopRecording]);

  useEffect(() => {
    return () => {
      cleanupInput();
      replaceRecordedUrl("", false);
    };
  }, [cleanupInput, replaceRecordedUrl]);

  useEffect(() => {
    if (status === "preparing" || status === "recording" || hasUnsavedTake) return;
    void prepareRecordingInput().catch((err: unknown) => {
      console.warn("[NarrationRecordingDialog] failed to prewarm microphone", { error: err });
    });
  }, [hasUnsavedTake, prepareRecordingInput, status]);

  useEffect(() => {
    if (status === "preparing" || status === "recording" || hasUnsavedTake) return;
    recordedBlobRef.current = null;
    setPlaybackCurrentTime(0);
    setPlaybackDuration(0);
    setElapsedMs(existingNarrationDurationMs ?? 0);
    setError("");
    if (!existingNarrationPath) {
      replaceRecordedUrl("", false);
      setStatus("idle");
      return;
    }

    let cancelled = false;
    invoke<NarrationAssetData>("read_narration_asset", { relativePath: existingNarrationPath })
      .then((asset) => {
        if (cancelled) return;
        const data = new Uint8Array(asset.data);
        replaceRecordedUrl(URL.createObjectURL(new Blob([data], { type: asset.mimeType })), true);
        setStatus("recorded");
      })
      .catch((err: unknown) => {
        if (cancelled) return;
        replaceRecordedUrl("", false);
        setStatus("error");
        setError(`Could not load saved narration: ${err}`);
      });

    return () => {
      cancelled = true;
    };
  }, [existingNarrationDurationMs, existingNarrationPath, hasUnsavedTake, replaceRecordedUrl, status === "recording"]);

  useEffect(() => {
    if (status === "recording") return;
    const canvas = canvasRef.current;
    if (!canvas) return;
    if (!recordedUrl) {
      drawEmptyWaveform(canvas);
      return;
    }

    let cancelled = false;
    const context = new AudioContext();
    fetch(recordedUrl)
      .then((response) => response.arrayBuffer())
      .then((data) => context.decodeAudioData(data))
      .then((buffer) => {
        if (!cancelled) drawDecodedWaveform(canvas, buffer);
      })
      .catch((error: unknown) => {
        console.warn("[NarrationRecordingDialog] failed to render playback waveform", { error });
        if (!cancelled) drawEmptyWaveform(canvas);
      })
      .finally(() => {
        closeAudioContext(context);
      });

    return () => {
      cancelled = true;
      closeAudioContext(context);
    };
  }, [recordedUrl, status, waveformLayoutVersion]);

  useEffect(() => {
    const frame = waveformFrameRef.current;
    if (!frame) return;

    const updateWaveformMetrics = () => {
      const nextWidth = frame.getBoundingClientRect().width;
      setWaveformWidth(nextWidth);
      setWaveformLayoutVersion((version) => version + 1);
    };

    updateWaveformMetrics();
    const observer = new ResizeObserver(updateWaveformMetrics);
    observer.observe(frame);
    return () => observer.disconnect();
  }, []);

  return (
    <div
      className="cr-modal-backdrop fixed inset-0 z-modal flex items-center justify-center p-5"
      onClick={close}
    >
      <div
        role="dialog"
        aria-modal="true"
        aria-labelledby="narration-recording-title"
        className="cr-modal-surface h-[min(760px,calc(100vh-40px))] w-[min(1120px,calc(100vw-40px))] overflow-hidden rounded-xl"
        onClick={(event) => event.stopPropagation()}
      >
        <div className="flex items-center justify-between border-b border-[rgb(var(--color-border))] px-5 py-4">
          <div>
            <h2 id="narration-recording-title" className="text-sm font-semibold text-[rgb(var(--color-text))]">
              Narration take — Row {rowNumber}
            </h2>
            <p className="mt-1 text-xs text-[rgb(var(--color-text-secondary))]">
              Space starts or stops recording. Left and Right move rows. Escape closes.
            </p>
          </div>
          <button
            type="button"
            onClick={close}
            className="rounded-xl p-2 text-[rgb(var(--color-text-secondary))] transition-colors hover:bg-[rgb(var(--color-surface-alt))] hover:text-[rgb(var(--color-text))]"
            aria-label="Close narration recorder"
          >
            <X className="h-4 w-4" />
          </button>
        </div>

        <div className="grid h-[calc(100%-73px)] min-h-0 gap-5 p-5 lg:grid-cols-[minmax(280px,0.68fr)_minmax(520px,1.32fr)]">
          <section className="flex min-h-0 flex-col rounded-lg border border-[rgb(var(--color-border))] bg-[rgb(var(--color-surface-alt))]/45 p-5">
            <div className="shrink-0 text-[10px] font-semibold uppercase tracking-[0.2em] text-[rgb(var(--color-text-secondary))]">
              Read this
            </div>
            <div className="narration-read-scroll mt-3 min-h-0 flex-1 overflow-y-auto pr-1 text-[1.65rem] font-medium leading-snug text-[rgb(var(--color-text))]">
              {sourceText || "No narrative text for this row yet."}
            </div>
          </section>

          <section className="flex min-h-0 flex-col gap-3">
            <div className="min-h-0 flex-[2] overflow-hidden rounded-lg border border-[rgb(var(--color-border))] bg-[rgb(var(--color-surface))]">
              {screenshotSrc ? (
                <img
                  src={screenshotSrc}
                  alt={`Row ${rowNumber} screenshot`}
                  className="h-full w-full object-contain"
                />
              ) : (
                <button
                  type="button"
                  onClick={onAddScreenshot}
                  disabled={!onAddScreenshot || status === "preparing" || status === "recording"}
                  className="flex h-full min-h-0 w-full flex-col items-center justify-center gap-2 border border-dashed border-[rgb(var(--color-border))] text-xs text-[rgb(var(--color-text-secondary))] transition-colors hover:border-[rgb(var(--color-accent))] hover:bg-[rgb(var(--color-accent))]/5 hover:text-[rgb(var(--color-accent))] disabled:cursor-not-allowed disabled:opacity-50"
                >
                  <ImageIcon className="h-5 w-5 opacity-70" />
                  Add screenshot
                </button>
              )}
            </div>

            <div
              ref={waveformFrameRef}
              className="relative flex-[0.72] overflow-hidden rounded-lg border border-[rgb(var(--color-border))] bg-[rgb(var(--color-surface-alt))]/55"
            >
              <span className="absolute right-3 top-2 z-10 rounded-md bg-[rgb(var(--color-surface))]/80 px-1.5 py-0.5 font-mono text-[10px] text-[rgb(var(--color-text-secondary))]">
                {formatElapsed(elapsedMs)}
              </span>
              <canvas
                ref={canvasRef}
                width={900}
                height={140}
                className="block h-full min-h-0 w-full"
                aria-label="Live narration waveform"
              />
              {recordedUrl && playbackDuration > 0 && status !== "recording" && (
                <span
                  className="pointer-events-none absolute bottom-0 top-0 z-10 w-px bg-[rgb(var(--color-accent))] shadow-[0_0_0_1px_rgb(var(--color-accent)/0.22),0_0_14px_rgb(var(--color-accent)/0.35)]"
                  style={{ left: `${playheadLeft}px` }}
                  aria-hidden="true"
                />
              )}
            </div>

            {recordedUrl && (
              <div className="rounded-lg border border-[rgb(var(--color-border))] bg-[rgb(var(--color-surface-alt))]/45 px-3 py-2">
                <audio
                  ref={audioRef}
                  controls
                  src={recordedUrl}
                  className="h-8 w-full"
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
            )}

            {error && (
              <div className="rounded-xl border border-[rgb(var(--color-error))]/25 bg-[rgb(var(--color-error))]/8 px-3 py-2 text-xs text-[rgb(var(--color-error))]">
                {error}
              </div>
            )}

            <div className="flex flex-wrap items-center justify-between gap-3">
              <div className="flex items-center gap-2">
                <button
                  type="button"
                  onClick={() => void navigatePrevious()}
                  disabled={!canNavigatePrevious || status === "preparing" || status === "recording" || saving}
                  className="inline-flex items-center gap-1.5 rounded-xl border border-[rgb(var(--color-border))] px-3 py-2 text-xs font-medium text-[rgb(var(--color-text-secondary))] transition-colors hover:bg-[rgb(var(--color-surface-alt))] hover:text-[rgb(var(--color-text))] disabled:cursor-not-allowed disabled:opacity-40"
                  title={hasUnsavedTake ? "Save take and move to previous row" : "Previous row"}
                >
                  <ChevronLeft className="h-3.5 w-3.5" />
                  Previous
                </button>
                <button
                  type="button"
                  onClick={() => void navigateNext()}
                  disabled={!canNavigateNext || status === "preparing" || status === "recording" || saving}
                  className="inline-flex items-center gap-1.5 rounded-xl border border-[rgb(var(--color-border))] px-3 py-2 text-xs font-medium text-[rgb(var(--color-text-secondary))] transition-colors hover:bg-[rgb(var(--color-surface-alt))] hover:text-[rgb(var(--color-text))] disabled:cursor-not-allowed disabled:opacity-40"
                  title={hasUnsavedTake ? "Save take and move to next row" : "Next row"}
                >
                  Next
                  <ChevronRight className="h-3.5 w-3.5" />
                </button>
              </div>
              <div className="text-xs text-[rgb(var(--color-text-secondary))]">
                {status === "preparing"
                  ? "Starting..."
                  : status === "recording"
                  ? "Recording..."
                  : hasUnsavedTake
                    ? "New take ready to save."
                    : inputStatus === "preparing"
                      ? "Preparing microphone..."
                    : inputStatus === "error"
                      ? "Microphone needs attention."
                    : inputStatus === "unsupported"
                      ? "Microphone recording is unavailable."
                    : hasExistingNarration
                      ? "Current saved take loaded."
                      : "Ready when you are."}
              </div>
              <div className="flex flex-wrap items-center gap-2">
                <button
                  type="button"
                  onClick={close}
                  className="rounded-xl border border-[rgb(var(--color-border))] px-3 py-2 text-xs font-medium text-[rgb(var(--color-text-secondary))] transition-colors hover:bg-[rgb(var(--color-surface-alt))] hover:text-[rgb(var(--color-text))]"
                >
                  Cancel
                </button>
                {status === "recorded" && hasUnsavedTake && (
                  <button
                    type="button"
                    onClick={resetTake}
                    className="inline-flex items-center gap-2 rounded-xl border border-[rgb(var(--color-border))] px-3 py-2 text-xs font-medium text-[rgb(var(--color-text-secondary))] transition-colors hover:bg-[rgb(var(--color-surface-alt))] hover:text-[rgb(var(--color-text))]"
                  >
                    <RotateCcw className="h-3.5 w-3.5" />
                    Rerecord
                  </button>
                )}
                <button
                  type="button"
                  onClick={() => status === "recording" ? stopRecording() : void startRecording()}
                  disabled={saving || status === "preparing" || (inputStatus === "preparing" && status !== "recording")}
                  className={`inline-flex items-center gap-2 rounded-xl px-4 py-2 text-xs font-semibold transition-colors disabled:cursor-not-allowed disabled:opacity-50 ${
                    status === "recording"
                      ? "bg-[rgb(var(--color-error))]/12 text-[rgb(var(--color-error))] hover:bg-[rgb(var(--color-error))]/18"
                      : "bg-[rgb(var(--color-accent))] text-[rgb(var(--color-accent-fg))] hover:bg-[rgb(var(--color-accent-hover))]"
                  }`}
                >
                  {status === "preparing" ? (
                    <>
                      <Loader2 className="h-3.5 w-3.5 animate-spin" />
                      Starting...
                    </>
                  ) : status === "recording" ? (
                    <>
                      <Square className="h-3.5 w-3.5 fill-current" />
                      Stop
                    </>
                  ) : (
                    <>
                      <Play className="h-3.5 w-3.5 fill-current" />
                      {inputStatus === "preparing"
                        ? "Preparing..."
                        : status === "recorded"
                          ? "Record again"
                          : "Start recording"}
                    </>
                  )}
                </button>
                <button
                  type="button"
                  onClick={() => void saveTake()}
                  disabled={status !== "recorded" || !hasUnsavedTake || saving}
                  className="inline-flex items-center gap-2 rounded-xl bg-[rgb(var(--color-accent))] px-4 py-2 text-xs font-semibold text-[rgb(var(--color-accent-fg))] transition-colors hover:bg-[rgb(var(--color-accent-hover))] disabled:cursor-not-allowed disabled:opacity-40"
                >
                  {saving ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <Save className="h-3.5 w-3.5" />}
                  {hasUnsavedTake ? "Save take" : "Saved"}
                </button>
              </div>
            </div>
          </section>
        </div>
      </div>
    </div>
  );
}
