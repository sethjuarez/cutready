import { create } from "zustand";
import { check, type DownloadEvent, type Update } from "@tauri-apps/plugin-updater";

type AppUpdate = Pick<Update, "available" | "currentVersion" | "version" | "date" | "body" | "downloadAndInstall">;

interface UpdateState {
  update: AppUpdate | null;
  checking: boolean;
  dismissed: boolean;
  checkForUpdate: () => Promise<void>;
  dismiss: () => void;
}

function shouldMockUpdate(): boolean {
  if (!import.meta.env.DEV) return false;
  if (import.meta.env.VITE_CUTREADY_MOCK_UPDATE === "1") return true;
  try {
    return window.localStorage.getItem("cutready:mockUpdate") === "1";
  } catch {
    return false;
  }
}

function createMockUpdate(): AppUpdate {
  return {
    available: true,
    currentVersion: "1.8.0",
    version: "1.9.0",
    date: new Date().toISOString(),
    body: "## What's new\n\n### Features\n\n- **Update spotlight:** a prominent activity-bar update button now opens release notes directly.\n- **Cleaner release notes:** markdown is rendered with headings, links, lists, and code styling.\n\n### Fixes\n\n- Update install progress stays visible until CutReady relaunches.",
    downloadAndInstall: async (onEvent?: (progress: DownloadEvent) => void) => {
      onEvent?.({ event: "Started", data: { contentLength: 8_388_608 } });
      onEvent?.({ event: "Progress", data: { chunkLength: 2_097_152 } });
      onEvent?.({ event: "Progress", data: { chunkLength: 6_291_456 } });
      onEvent?.({ event: "Finished" });
    },
  };
}

export const useUpdateStore = create<UpdateState>((set) => ({
  update: null,
  checking: false,
  dismissed: false,

  checkForUpdate: async () => {
    set({ checking: true });
    try {
      if (shouldMockUpdate()) {
        set({ update: createMockUpdate() });
        return;
      }
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
