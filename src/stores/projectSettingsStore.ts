import { useEffect } from "react";
import { create } from "zustand";
import type { ProjectSettings } from "@draftline/client";
import { workspaceIpc } from "../ipc/workspace";
import { useAppStore } from "./appStore";

interface ProjectSettingsState {
  /** The project folder `settings` belong to. */
  root: string | null;
  /** What the repository's `.draftline` records; null outside hybrid projects. */
  settings: ProjectSettings | null;
  load: (root: string) => Promise<void>;
  /** Saves new settings as their own version; null clears one. Rejects on failure. */
  save: (root: string, baseBranch: string | null, labelTemplate: string | null) => Promise<void>;
  clear: () => void;
}

export const useProjectSettingsStore = create<ProjectSettingsState>((set, get) => ({
  root: null,
  settings: null,
  load: async (root) => {
    set({ root, settings: null });
    try {
      const settings = await workspaceIpc.readProjectSettings(root);
      if (get().root === root) set({ settings });
    } catch {
      // Settings only change how labels read; History still works without them.
    }
  },
  save: async (root, baseBranch, labelTemplate) => {
    const settings = await workspaceIpc.saveProjectSettings(root, baseBranch, labelTemplate);
    if (get().root === root) set({ settings });
  },
  clear: () => set({ root: null, settings: null }),
}));

/** The open hybrid project's settings, loaded when the project changes. */
export function useProjectSettings(): ProjectSettings | null {
  const root = useAppStore((s) => (s.currentProject?.hybrid ? s.currentProject.root : null));
  useEffect(() => {
    const store = useProjectSettingsStore.getState();
    if (!root) store.clear();
    else if (store.root !== root) void store.load(root);
  }, [root]);
  return useProjectSettingsStore((s) => (root && s.root === root ? s.settings : null));
}
