import { useCallback, useEffect, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { emit } from "@tauri-apps/api/event";
import { Keyboard } from "lucide-react";

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
      <div className="fixed inset-0 flex items-center justify-center bg-transparent text-[rgb(var(--color-media-control-fg))]">
        <div className="rounded-full border border-[rgb(var(--color-media-control-fg)/0.14)] bg-[rgb(var(--color-media-control-bg)/0.52)] px-4 py-2 text-sm shadow-2xl backdrop-blur-xl animate-pulse">
          Preparing recorder...
        </div>
      </div>
    );
  }

  return (
    <div className="fixed inset-0 overflow-hidden bg-transparent text-[rgb(var(--color-media-control-fg))]">
      <div className="absolute inset-5 rounded-[2rem] border-2 border-[rgb(var(--color-accent))]/75 shadow-[inset_0_0_0_1px_rgb(var(--color-media-control-fg)/0.12),0_0_60px_rgb(var(--color-accent)/0.24)]" />
      <div className="absolute inset-0 flex items-center justify-center">
        <div className="flex flex-col items-center gap-4">
          <div className="relative flex h-56 w-56 items-center justify-center rounded-full border border-[rgb(var(--color-media-control-fg)/0.18)] bg-[rgb(var(--color-media-control-bg)/0.62)] shadow-[0_24px_80px_rgb(0_0_0/0.36),0_0_70px_rgb(var(--color-accent)/0.2)] backdrop-blur-xl">
            <div className="absolute inset-4 rounded-full border border-[rgb(var(--color-accent))]/40" />
            <div className="absolute inset-0 rounded-full bg-[radial-gradient(circle_at_50%_32%,rgb(var(--color-media-control-fg)/0.16),transparent_48%)]" />
            <div className="relative text-[8rem] font-semibold leading-none tabular-nums tracking-[-0.08em] text-[rgb(var(--color-media-control-fg))]">
              {Math.max(remaining, 1)}
            </div>
          </div>
          <button
            type="button"
            onClick={cancel}
            className="flex items-center gap-2 rounded-full border border-[rgb(var(--color-media-control-fg)/0.12)] bg-[rgb(var(--color-media-control-bg)/0.34)] px-3 py-1.5 text-[11px] text-[rgb(var(--color-media-control-fg)/0.6)] backdrop-blur-sm transition-colors hover:bg-[rgb(var(--color-media-control-bg)/0.5)] hover:text-[rgb(var(--color-media-control-fg))]"
          >
            <Keyboard className="h-3 w-3" />
            Esc to cancel
          </button>
        </div>
      </div>
    </div>
  );
}
