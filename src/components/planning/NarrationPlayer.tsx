import { useEffect, useRef, useState } from "react";
import { X, Loader2, Mic, Pause, Play, Square } from "lucide-react";
import { mediaIpc } from "../../ipc/media";


function formatPlaybackTime(seconds: number): string {
  if (!Number.isFinite(seconds) || seconds <= 0) return "0:00";
  const rounded = Math.floor(seconds);
  const minutes = Math.floor(rounded / 60);
  const remainder = rounded % 60;
  return `${minutes}:${remainder.toString().padStart(2, "0")}`;
}

export function NarrationPlayer({
  relativePath,
  onRecord,
  onRemove,
  onStopRecording,
  recording = false,
  saving = false,
  recordDisabled = false,
}: {
  relativePath: string;
  onRecord?: () => void;
  onRemove?: () => void;
  onStopRecording?: () => void;
  recording?: boolean;
  saving?: boolean;
  recordDisabled?: boolean;
}) {
  const audioRef = useRef<HTMLAudioElement>(null);
  const objectUrlRef = useRef("");
  const pendingAutoplaySrcRef = useRef("");
  const [src, setSrc] = useState("");
  const [duration, setDuration] = useState(0);
  const [currentTime, setCurrentTime] = useState(0);
  const [playing, setPlaying] = useState(false);
  const [loading, setLoading] = useState(false);
  const [loadError, setLoadError] = useState("");

  useEffect(() => {
    const objectUrl = objectUrlRef.current;
    if (objectUrl) URL.revokeObjectURL(objectUrl);
    objectUrlRef.current = "";
    setSrc("");
    setLoadError("");
    setLoading(false);
    setCurrentTime(0);
    setDuration(0);
    setPlaying(false);
    pendingAutoplaySrcRef.current = "";

    return () => {
      const currentObjectUrl = objectUrlRef.current;
      if (currentObjectUrl) URL.revokeObjectURL(currentObjectUrl);
      objectUrlRef.current = "";
      pendingAutoplaySrcRef.current = "";
    };
  }, [relativePath]);

  const handlePlaybackError = (err: unknown) => {
    if (err instanceof DOMException && err.name === "AbortError") {
      console.debug("[NarrationPlayer] narration playback was interrupted by an audio source reload");
      return;
    }
    setLoadError(`Could not play narration: ${err}`);
  };

  useEffect(() => {
    const audio = audioRef.current;
    if (!audio) return;
    setCurrentTime(0);
    setDuration(0);
    setPlaying(false);
    audio.pause();
    audio.load();

    if (!src || pendingAutoplaySrcRef.current !== src) return;

    let cancelled = false;
    const playLoadedAudio = () => {
      if (cancelled || pendingAutoplaySrcRef.current !== src) return;
      pendingAutoplaySrcRef.current = "";
      void audio.play().catch(handlePlaybackError);
    };

    if (audio.readyState >= HTMLMediaElement.HAVE_CURRENT_DATA) {
      queueMicrotask(playLoadedAudio);
      return () => { cancelled = true; };
    }

    audio.addEventListener("canplay", playLoadedAudio, { once: true });
    return () => {
      cancelled = true;
      audio.removeEventListener("canplay", playLoadedAudio);
    };
  }, [src]);

  const loadNarrationForPlayback = async (autoplay = false) => {
    if (src) return src;
    setLoading(true);
    setLoadError("");
    try {
      const asset = await mediaIpc.readNarrationAsset(relativePath);
      const objectUrl = URL.createObjectURL(new Blob([new Uint8Array(asset.data)], { type: asset.mimeType }));
      objectUrlRef.current = objectUrl;
      if (autoplay) pendingAutoplaySrcRef.current = objectUrl;
      setSrc(objectUrl);
      return objectUrl;
    } catch (err) {
      setLoadError(`Could not load narration: ${err}`);
      return "";
    } finally {
      setLoading(false);
    }
  };

  const togglePlayback = async () => {
    const audio = audioRef.current;
    if (!audio || loading) return;
    if (audio.paused) {
      if (src) {
        setLoadError("");
        await audio.play().catch(handlePlaybackError);
        return;
      }
      const playbackSrc = await loadNarrationForPlayback(true);
      if (!playbackSrc) return;
    } else {
      pendingAutoplaySrcRef.current = "";
      audio.pause();
    }
  };

  const seek = (value: string) => {
    const audio = audioRef.current;
    if (!audio) return;
    const nextTime = Number(value);
    audio.currentTime = nextTime;
    setCurrentTime(nextTime);
  };

  return (
    <div className="flex w-full flex-col gap-1">
      <audio
        ref={audioRef}
        src={src || undefined}
        preload="metadata"
        onLoadedMetadata={(event) => setDuration(event.currentTarget.duration || 0)}
        onTimeUpdate={(event) => setCurrentTime(event.currentTarget.currentTime)}
        onPlay={() => setPlaying(true)}
        onPause={() => setPlaying(false)}
        onEnded={() => setPlaying(false)}
      />
      {loadError && (
        <div className="text-xs text-[rgb(var(--color-error))]">
          {loadError}
        </div>
      )}
      <input
        type="range"
        min={0}
        max={duration || 0}
        step={0.1}
        value={Math.min(currentTime, duration || 0)}
        onChange={(event) => seek(event.target.value)}
        disabled={!duration}
        className="w-full accent-[rgb(var(--color-accent))] disabled:opacity-50"
        aria-label="Scrub narration"
      />
      <div className="flex items-center gap-2">
        <button
          type="button"
          onClick={togglePlayback}
            disabled={loading}
          className="grid h-7 w-7 shrink-0 place-items-center rounded-lg border border-[rgb(var(--color-border))] bg-[rgb(var(--color-surface))] text-[rgb(var(--color-accent))] transition-colors hover:border-[rgb(var(--color-accent))]/35 hover:bg-[rgb(var(--color-accent))]/8"
            aria-label={playing ? "Pause narration" : loading ? "Loading narration" : "Play narration"}
            title={playing ? "Pause narration" : loading ? "Loading narration" : "Play narration"}
        >
            {loading ? (
              <Loader2 className="h-3.5 w-3.5 animate-spin" />
            ) : playing ? (
              <Pause className="h-3 w-3" strokeWidth={2.4} />
            ) : (
              <Play className="h-3.5 w-3.5 fill-current" />
            )}
          </button>
        <span className="min-w-0 flex-1 truncate text-xs text-[rgb(var(--color-text-secondary))]">
          {formatPlaybackTime(currentTime)} / {formatPlaybackTime(duration)}
        </span>
        {onRemove && (
          <button
            type="button"
            onClick={onRemove}
            disabled={saving || recording}
            className="grid h-7 w-7 shrink-0 place-items-center rounded-full bg-[rgb(var(--color-surface-alt))] text-[rgb(var(--color-text-secondary))] transition-colors hover:bg-[rgb(var(--color-error))]/10 hover:text-[rgb(var(--color-error))] disabled:cursor-not-allowed disabled:opacity-40"
            aria-label="Remove narration"
            title="Remove narration"
          >
            <X className="h-3.5 w-3.5" />
          </button>
        )}
        {onRecord && (
          <button
            type="button"
            onClick={() => recording ? onStopRecording?.() : onRecord()}
            disabled={saving || recordDisabled}
            className={`grid h-7 w-7 shrink-0 place-items-center rounded-full transition-colors disabled:cursor-not-allowed disabled:opacity-40 ${
              recording
                ? "bg-[rgb(var(--color-error))]/10 text-[rgb(var(--color-error))]"
                : "bg-[rgb(var(--color-surface-alt))] text-[rgb(var(--color-text-secondary))] hover:bg-[rgb(var(--color-accent))]/10 hover:text-[rgb(var(--color-accent))]"
            }`}
            aria-label={recording ? "Stop narration recording" : "Rerecord narration"}
            title={recording ? "Stop narration recording" : "Rerecord narration"}
          >
            {saving ? (
              <Loader2 className="h-3.5 w-3.5 animate-spin" />
            ) : recording ? (
              <Square className="h-3.5 w-3.5 fill-current" />
            ) : (
              <Mic className="h-3.5 w-3.5" />
            )}
          </button>
        )}
      </div>
    </div>
  );
}
