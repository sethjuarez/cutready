import { useCallback, useEffect, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { emit } from "@tauri-apps/api/event";
import { Circle, Keyboard, Video } from "lucide-react";

interface RecordingCountdownParams {
  monitor_id: number;
  monitor_w: number;
  monitor_h: number;
  monitor_x: number;
  monitor_y: number;
  countdown_seconds: number;
  document_title: string;
}

export function RecordingCountdownWindow() {
  const [params, setParams] = useState<RecordingCountdownParams | null>(null);
  const [remaining, setRemaining] = useState<number | null>(null);
  const [cancelled, setCancelled] = useState(false);

  const cancel = useCallback(async () => {
    if (cancelled) return;
    setCancelled(true);
    await emit("recording-countdown-cancel", {});
    await invoke("close_recording_countdown_window");
  }, [cancelled]);

  useEffect(() => {
    (async () => {
      try {
        const next = await invoke<RecordingCountdownParams>("get_recording_countdown_params");
        setParams(next);
        setRemaining(Math.max(next.countdown_seconds, 1));
      } catch (err) {
        console.error("[RecordingCountdownWindow] Failed to get params:", err);
        await emit("recording-countdown-cancel", {});
        await invoke("close_recording_countdown_window");
      }
    })();
  }, []);

  useEffect(() => {
    const handler = (event: KeyboardEvent) => {
      if (event.key === "Escape") void cancel();
    };
    window.addEventListener("keydown", handler);
    return () => window.removeEventListener("keydown", handler);
  }, [cancel]);

  useEffect(() => {
    if (!params || remaining === null || cancelled) return;
    if (remaining <= 1) return;

    const timer = window.setTimeout(() => setRemaining((value) => (value ?? 1) - 1), 1000);
    return () => window.clearTimeout(timer);
  }, [cancelled, params, remaining]);

  if (!params || remaining === null) {
    return (
      <div className="fixed inset-0 flex items-center justify-center bg-[rgb(var(--color-overlay-strong)/0.75)] text-[rgb(var(--color-media-control-fg))]">
        <div className="text-sm animate-pulse">Preparing recorder...</div>
      </div>
    );
  }

  return (
    <div className="fixed inset-0 overflow-hidden bg-[rgb(var(--color-overlay-strong)/0.58)] text-[rgb(var(--color-media-control-fg))]">
      <div className="absolute inset-5 rounded-[2rem] border-2 border-[rgb(var(--color-accent))]/80 shadow-[inset_0_0_0_1px_rgb(var(--color-media-control-fg)/0.15),0_0_80px_rgb(var(--color-accent)/0.28)]" />
      <div className="absolute left-8 top-8 flex items-center gap-2 rounded-full border border-[rgb(var(--color-media-control-fg)/0.14)] bg-[rgb(var(--color-media-control-bg)/0.72)] px-4 py-2 text-xs font-semibold uppercase tracking-[0.2em] backdrop-blur-md">
        <Circle className="h-3 w-3 fill-[rgb(var(--color-accent))] text-[rgb(var(--color-accent))]" />
        Recording starts
      </div>
      <div className="absolute right-8 top-8 max-w-[34rem] rounded-2xl border border-[rgb(var(--color-media-control-fg)/0.14)] bg-[rgb(var(--color-media-control-bg)/0.72)] px-4 py-3 text-right backdrop-blur-md">
        <div className="flex items-center justify-end gap-2 text-xs font-medium text-[rgb(var(--color-media-control-fg)/0.72)]">
          <Video className="h-3.5 w-3.5" />
          {params.document_title}
        </div>
        <div className="mt-1 text-[10px] text-[rgb(var(--color-media-control-fg)/0.48)]">
          {params.monitor_w}x{params.monitor_h}
        </div>
      </div>
      <div className="absolute inset-0 flex items-center justify-center">
        <div className="relative flex h-56 w-56 items-center justify-center rounded-full border border-[rgb(var(--color-media-control-fg)/0.16)] bg-[rgb(var(--color-media-control-bg)/0.74)] shadow-2xl backdrop-blur-xl">
          <div className="absolute inset-4 rounded-full border border-[rgb(var(--color-accent))]/35" />
          <div className="text-[8rem] font-semibold leading-none tabular-nums tracking-[-0.08em] text-[rgb(var(--color-media-control-fg))]">
            {Math.max(remaining, 1)}
          </div>
        </div>
      </div>
      <button
        type="button"
        onClick={cancel}
        className="absolute bottom-8 left-1/2 flex -translate-x-1/2 items-center gap-2 rounded-full border border-[rgb(var(--color-media-control-fg)/0.14)] bg-[rgb(var(--color-media-control-bg)/0.72)] px-4 py-2 text-xs text-[rgb(var(--color-media-control-fg)/0.72)] backdrop-blur-md transition-colors hover:text-[rgb(var(--color-media-control-fg))]"
      >
        <Keyboard className="h-3.5 w-3.5" />
        Esc to cancel
      </button>
    </div>
  );
}
