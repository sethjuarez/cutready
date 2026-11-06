import { savesToSend } from "../domain/versioning";
import { useSyncStore } from "../stores/syncStore";
import { useVersioningStore } from "../stores/versioningStore";

/** Saves waiting to send, not counting versions that only brought in team updates. */
export function useSavesToSend(): number {
  const ahead = useSyncStore((s) => (s.currentRemote ? s.syncStatus?.ahead ?? 0 : 0));
  const graphNodes = useVersioningStore((s) => s.graphNodes);
  return savesToSend(graphNodes, ahead);
}
