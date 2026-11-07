import { useEffect } from "react";
import { create } from "zustand";
import type { ProjectSettings } from "@draftline/client";
import { workspaceIpc } from "../ipc/workspace";
import { useAppStore } from "./appStore";

interface ProjectSettingsState {
  /** The project folder `settings` belong to. */
  root: string | null;
  /** What the repository's `.draftline` records; null outside hybrid projects or until loaded. */
  settings: ProjectSettings | null;
  /** True once `settings` reflect `root`, even if reading them failed. */
  loaded: boolean;
  /** Bumped by every load and save, so only the latest request lands. */
  generation: number;
  load: (root: string) => Promise<void>;
  /** Saves new settings as their own version; null clears one. Rejects on failure. */
  save: (root: string, baseBranch: string | null, labelTemplate: string | null) => Promise<void>;
  clear: () => void;
}

export const useProjectSettingsStore = create<ProjectSettingsState>((set, get) => ({
  root: null,
  settings: null,
  loaded: false,
  generation: 0,
  load: async (root) => {
    const generation = get().generation + 1;
    set({ root, settings: null, loaded: false, generation });
    let settings: ProjectSettings | null = null;
    try {
      settings = await workspaceIpc.readProjectSettings(root);
    } catch {
      // Settings only change how labels read; History still works without them.
    }
    if (get().root === root && get().generation === generation) set({ settings, loaded: true });
  },
  save: async (root, baseBranch, labelTemplate) => {
    const generation = get().generation + 1;
    set({ generation });
    const settings = await workspaceIpc.saveProjectSettings(root, baseBranch, labelTemplate);
    if (get().root === root && get().generation === generation) set({ settings, loaded: true });
  },
  clear: () => set((s) => ({ root: null, settings: null, loaded: false, generation: s.generation + 1 })),
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