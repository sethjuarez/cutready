import { useCallback, useEffect, useMemo } from "react";
import { useAppStore } from "../stores/appStore";
import { isUnused, toMediaItems, type MediaItem } from "../utils/media";

/** Reload images, visuals and narration takes, with their references. */
export function reloadMediaLibrary(): Promise<unknown> {
  const { loadAssets, loadNarrationAssets } = useAppStore.getState();
  return Promise.all([loadAssets(), loadNarrationAssets()]);
}

/** Keeps the media library loaded for the open project and in step with sidebar refreshes. Mount once. */
export function useMediaLibraryLoader() {
  const projectRoot = useAppStore((s) => s.currentProject?.root ?? null);
  const reload = useCallback(() => {
    if (useAppStore.getState().currentProject) void reloadMediaLibrary();
  }, []);
  useEffect(() => {
    if (projectRoot) reload();
  }, [projectRoot, reload]);
  useEffect(() => {
    window.addEventListener("sidebar-refresh", reload);
    return () => window.removeEventListener("sidebar-refresh", reload);
  }, [reload]);
}

/** The project's media library as one list, newest first. */
export function useMediaItems(): MediaItem[] {
  const assets = useAppStore((s) => s.assets);
  const narrations = useAppStore((s) => s.narrationAssets);
  return useMemo(() => toMediaItems(assets ?? [], narrations ?? []), [assets, narrations]);
}

/** How many library items nothing uses. */
export function useUnusedMediaCount(): number {
  const items = useMediaItems();
  return useMemo(() => items.filter(isUnused).length, [items]);
}
