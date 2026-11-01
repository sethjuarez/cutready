import { useEffect } from "react";
import { listenEvent } from "../ipc/events";
import { useAppStore } from "../stores/appStore";
import type { RecordingScope, RecordingTake } from "../types/recording";

type ActivityLevel = "info" | "success" | "error";

const TAKE_EVENTS = [
  ["recording-control-started", "Started", (): ActivityLevel => "info"],
  ["recording-control-stopped", "Saved", (take: RecordingTake): ActivityLevel => (take.status === "finalized" ? "success" : "error")],
  ["recording-control-discarded", "Discarded", (): ActivityLevel => "info"],
] as const;

/** Logs recorder take events for `scope` to the activity panel while mounted. */
export function useRecordingTakeActivity(scope: RecordingScope | null, title: string) {
  const kind = scope?.kind;
  const path = scope?.path;
  useEffect(() => {
    if (!kind || !path) return;
    const unlisteners = TAKE_EVENTS.map(([event, verb, level]) =>
      listenEvent(event, ({ payload: take }) => {
        if (take.scope.kind !== kind || take.scope.path !== path) return;
        useAppStore.getState().addActivityEntries([{ id: crypto.randomUUID(), timestamp: new Date(), source: "recording", content: `${verb} recording take ${take.id} for "${title}"`, level: level(take) }]);
      }),
    );
    return () => {
      for (const unlisten of unlisteners) unlisten.then((fn) => fn());
    };
  }, [kind, path, title]);
}
