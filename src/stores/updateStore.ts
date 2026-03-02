import { create } from "zustand";
import { check, type Update } from "@tauri-apps/plugin-updater";

interface UpdateState {
  update: Update | null;
  checking: boolean;
  dismissed: boolean;
  checkForUpdate: () => Promise<void>;
  dismiss: () => void;
}

export const useUpdateStore = create<UpdateState>((set) => ({
  update: null,
  checking: false,
  dismissed: false,

  checkForUpdate: async () => {
    set({ checking: true });
    try {
      const u = await check();
      if (u?.available) set({ update: u });
    } catch {
      // Network down, no releases, etc. — silently ignore
    } finally {
      set({ checking: false });
    }
  },

  dismiss: () => set({ dismissed: true }),
}));
