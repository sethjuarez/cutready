import { useEffect, useMemo, useState } from "react";
import { documentsIpc } from "../ipc/documents";
import { useAppStore } from "../stores/appStore";
import type { Storyboard, StoryboardSummary } from "../types/sketch";
import { getUniqueStoryboardSketchPaths } from "../utils/storyboard";

/**
 * Sketch paths of each storyboard, in storyboard order, for the navigation tree.
 * Reloads a storyboard when its summary changes; the open storyboard comes from the store.
 */
export function useStoryboardMembership(storyboards: StoryboardSummary[]): Map<string, string[]> {
  const activeStoryboardPath = useAppStore((s) => s.activeStoryboardPath);
  const activeStoryboard = useAppStore((s) => s.activeStoryboard);
  const [loaded, setLoaded] = useState<Map<string, string[]>>(() => new Map());
  const summaryKey = storyboards.map((sb) => `${sb.path}|${sb.updated_at}|${sb.sketch_count}`).join("\n");

  useEffect(() => {
    let cancelled = false;
    const paths = summaryKey ? summaryKey.split("\n").map((line) => line.split("|")[0]) : [];
    void Promise.all(
      paths.map(async (path) => {
        try {
          const result = await documentsIpc.read<Storyboard>("storyboard", path);
          return [path, getUniqueStoryboardSketchPaths(result.document)] as const;
        } catch {
          return [path, [] as string[]] as const;
        }
      }),
    ).then((entries) => {
      if (!cancelled) setLoaded(new Map(entries));
    });
    return () => {
      cancelled = true;
    };
  }, [summaryKey]);

  return useMemo(() => {
    if (!activeStoryboardPath || !activeStoryboard) return loaded;
    const merged = new Map(loaded);
    merged.set(activeStoryboardPath, getUniqueStoryboardSketchPaths(activeStoryboard));
    return merged;
  }, [loaded, activeStoryboardPath, activeStoryboard]);
}
