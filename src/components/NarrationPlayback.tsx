import { useEffect, useRef, useState } from "react";
import type { KeyboardEvent, PointerEvent } from "react";

function alignToDevicePixel(value: number, dpr: number): number {
  return Math.round(value * dpr) / dpr;
}

function formatPlaybackTime(seconds: number): string {
  if (!Number.isFinite(seconds) || seconds <= 0) return "0:00";
  const rounded = Math.floor(seconds);
  const minutes = Math.floor(rounded / 60);
  const remainder = rounded % 60;
  return `${minutes}:${remainder.toString().padStart(2, "0")}`;
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

interface NarrationPlaybackProps {
  src: string;
  waveformHeight?: string;
  className?: string;
  waveformLabel?: string;
  showControls?: boolean;
  allowScrubbing?: boolean;
}

export function NarrationPlayback({
  src,
  waveformHeight = "h-28",
  className = "",
  waveformLabel = "Narration waveform",
  showControls = true,
  allowScrubbing = showControls,
}: NarrationPlaybackProps) {
  const audioRef = useRef<HTMLAudioElement>(null);
  const waveformFrameRef = useRef<HTMLDivElement>(null);
  const waveformCanvasRef = useRef<HTMLCanvasElement>(null);
  const [currentTime, setCurrentTime] = useState(0);
  const [duration, setDuration] = useState(0);
  const [isScrubbing, setIsScrubbing] = useState(false);
  const [waveformWidth, setWaveformWidth] = useState(0);
  const [waveformLayoutVersion, setWaveformLayoutVersion] = useState(0);
  const canScrub = allowScrubbing && duration > 0;
  const playheadLeft = duration > 0 && waveformWidth > 0
    ? alignToDevicePixel(
        Math.min(waveformWidth, Math.max(0, (currentTime / duration) * waveformWidth)),
        window.devicePixelRatio || 1,
      )
    : 0;

  useEffect(() => {
    const audio = audioRef.current;
    setCurrentTime(0);
    setDuration(0);
    setIsScrubbing(false);
    if (audio) {
      audio.pause();
      audio.load();
    }
  }, [src]);

  const seekToRatio = (ratio: number) => {
    const audio = audioRef.current;
    if (!audio || duration <= 0) return;

    const nextTime = Math.min(duration, Math.max(0, ratio * duration));
    audio.currentTime = nextTime;
    setCurrentTime(nextTime);
  };

  const seekFromClientX = (clientX: number) => {
    const frame = waveformFrameRef.current;
    if (!frame || duration <= 0) return;

    const rect = frame.getBoundingClientRect();
    const ratio = rect.width > 0 ? (clientX - rect.left) / rect.width : 0;
    seekToRatio(ratio);
  };

  const handleWaveformPointerDown = (event: PointerEvent<HTMLDivElement>) => {
    if (!canScrub) return;

    event.preventDefault();
    event.currentTarget.setPointerCapture(event.pointerId);
    setIsScrubbing(true);
    seekFromClientX(event.clientX);
  };

  const handleWaveformPointerMove = (event: PointerEvent<HTMLDivElement>) => {
    if (!canScrub || !isScrubbing) return;
    seekFromClientX(event.clientX);
  };

  const stopScrubbing = (event: PointerEvent<HTMLDivElement>) => {
    if (!isScrubbing) return;

    if (event.currentTarget.hasPointerCapture(event.pointerId)) {
      event.currentTarget.releasePointerCapture(event.pointerId);
    }
    setIsScrubbing(false);
  };

  const handleWaveformKeyDown = (event: KeyboardEvent<HTMLDivElement>) => {
    if (!canScrub) return;

    const stepSeconds = event.shiftKey ? 5 : 1;
    if (event.key === "ArrowLeft") {
      event.preventDefault();
      seekToRatio((currentTime - stepSeconds) / duration);
    } else if (event.key === "ArrowRight") {
      event.preventDefault();
      seekToRatio((currentTime + stepSeconds) / duration);
    } else if (event.key === "Home") {
      event.preventDefault();
      seekToRatio(0);
    } else if (event.key === "End") {
      event.preventDefault();
      seekToRatio(1);
    }
  };

  useEffect(() => {
    const canvas = waveformCanvasRef.current;
    if (!canvas || !src) return;

    let cancelled = false;
    let closing = false;
    const context = new AudioContext();
    const closeContext = () => {
      if (closing || context.state === "closed") return;
      closing = true;
      try {
        void context.close().catch((error: unknown) => {
          console.warn("[NarrationPlayback] failed to close waveform audio context", { error });
        });
      } catch (error) {
        console.warn("[NarrationPlayback] failed to close waveform audio context", { error });
      }
    };

    fetch(src)
      .then((response) => response.arrayBuffer())
      .then((data) => context.decodeAudioData(data))
      .then((buffer) => {
        if (!cancelled) drawDecodedWaveform(canvas, buffer);
      })
      .catch((error: unknown) => {
        console.warn("[NarrationPlayback] failed to render waveform", { error });
        if (!cancelled) drawEmptyWaveform(canvas);
      })
      .finally(() => {
        closeContext();
      });

    return () => {
      cancelled = true;
      closeContext();
    };
  }, [src, waveformLayoutVersion]);

  useEffect(() => {
    const frame = waveformFrameRef.current;
    if (!frame) return;

    const update = () => {
      setWaveformWidth(frame.getBoundingClientRect().width);
      setWaveformLayoutVersion((version) => version + 1);
    };
    update();

    const observer = new ResizeObserver(update);
    observer.observe(frame);
    return () => observer.disconnect();
  }, []);

  return (
    <div className={`w-full ${className}`}>
      <div
        ref={waveformFrameRef}
        className={`relative overflow-hidden rounded-lg border border-[rgb(var(--color-border))] bg-[rgb(var(--color-surface-alt))]/55 ${waveformHeight} ${
          canScrub ? "cursor-pointer focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-[rgb(var(--color-accent))]" : ""
        }`}
        role={canScrub ? "slider" : undefined}
        tabIndex={canScrub ? 0 : undefined}
        aria-label={canScrub ? `${waveformLabel}. Use arrow keys to scrub.` : undefined}
        aria-valuemin={canScrub ? 0 : undefined}
        aria-valuemax={canScrub ? Math.round(duration) : undefined}
        aria-valuenow={canScrub ? Math.round(currentTime) : undefined}
        aria-valuetext={canScrub ? `${formatPlaybackTime(currentTime)} of ${formatPlaybackTime(duration)}` : undefined}
        onPointerDown={handleWaveformPointerDown}
        onPointerMove={handleWaveformPointerMove}
        onPointerUp={stopScrubbing}
        onPointerCancel={stopScrubbing}
        onKeyDown={handleWaveformKeyDown}
      >
        <canvas
          ref={waveformCanvasRef}
          className="block h-full w-full"
          aria-label={waveformLabel}
        />
        {duration > 0 && (
          <span
            className="pointer-events-none absolute bottom-0 top-0 z-10 w-px bg-[rgb(var(--color-accent))] shadow-[0_0_0_1px_rgb(var(--color-accent)/0.22),0_0_14px_rgb(var(--color-accent)/0.35)]"
            style={{ left: `${playheadLeft}px` }}
          />
        )}
        {duration > 0 && (
          <span className="pointer-events-none absolute right-2 top-2 rounded-full bg-[rgb(var(--color-surface))]/85 px-2 py-0.5 text-[11px] font-medium text-[rgb(var(--color-text-secondary))]">
            {formatPlaybackTime(duration)}
          </span>
        )}
      </div>
      <div className={showControls ? "mt-3 rounded-xl border border-[rgb(var(--color-border))] bg-[rgb(var(--color-surface))] px-3 py-2" : "sr-only"}>
        <audio
          ref={audioRef}
          controls={showControls}
          preload="metadata"
          src={src}
          className="h-8 w-full"
          onLoadedMetadata={(event) => {
            const nextDuration = event.currentTarget.duration;
            setDuration(Number.isFinite(nextDuration) ? nextDuration : 0);
            setCurrentTime(event.currentTarget.currentTime || 0);
          }}
          onTimeUpdate={(event) => setCurrentTime(event.currentTarget.currentTime || 0)}
          onSeeked={(event) => setCurrentTime(event.currentTarget.currentTime || 0)}
          onEnded={(event) => setCurrentTime(event.currentTarget.duration || 0)}
        />
      </div>
    </div>
  );
}
