import { useEffect } from "react";
import { create } from "zustand";
import { LazyStore } from "@tauri-apps/plugin-store";

export interface AgentPreset {
  id: string;
  name: string;
  prompt: string;
}

export interface AppSettings {
  outputDirectory: string;
  /** "azure_openai" or "openai" */
  aiProvider: string;
  /** "api_key" or "azure_oauth" */
  aiAuthMode: string;
  /** Azure: resource endpoint. OpenAI: leave empty for default. */
  aiEndpoint: string;
  /** API key for the selected provider. */
  aiApiKey: string;
  /** Model / deployment name. */
  aiModel: string;
  /** Azure tenant ID for OAuth (default: "organizations"). */
  aiTenantId: string;
  /** Custom OAuth client ID (leave empty for default Azure PowerShell). */
  aiClientId: string;
  /** Azure OAuth access token (stored ephemerally). */
  aiAccessToken: string;
  /** Azure OAuth refresh token (for silent re-auth). */
  aiRefreshToken: string;
  audioDevice: string;
  /** Currently selected agent ID (default: "planner"). */
  aiSelectedAgent: string;
  /** User-created custom agents (name + prompt). */
  aiAgents: AgentPreset[];
  /* ── Display settings ────────────────────────── */
  /** Editor text size in px (13–18, default 14). */
  displayFontSize: number;
  /** Chat panel text size in px (13–18, default 14). */
  displayChatFontSize: number;
  /** Row density: "compact" | "comfortable" | "spacious" (default "comfortable"). */
  displayRowDensity: string;
  /** Row color palette: "neutral" | "pastel" | "vivid" (default "vivid"). */
  displayRowColors: string;
  /** Editor width: "centered" | "full" (default "centered"). */
  displayEditorWidth: string;
  /** Font family: "system" | "sans" | "serif" | "mono" (default "system"). */
  displayFontFamily: string;
  // Legacy fields (migrated on load)
  llmApiKey?: string;
  llmEndpoint?: string;
  llmDeployment?: string;
}

const defaultSettings: AppSettings = {
  outputDirectory: "",
  aiProvider: "azure_openai",
  aiAuthMode: "api_key",
  aiEndpoint: "",
  aiApiKey: "",
  aiModel: "",
  aiTenantId: "",
  aiClientId: "",
  aiAccessToken: "",
  aiRefreshToken: "",
  audioDevice: "",
  aiSelectedAgent: "planner",
  aiAgents: [],
  displayFontSize: 14,
  displayChatFontSize: 14,
  displayRowDensity: "comfortable",
  displayRowColors: "vivid",
  displayEditorWidth: "centered",
  displayFontFamily: "system",
};

const STORE_PATH = "settings.json";

interface SettingsStore {
  settings: AppSettings;
  loaded: boolean;
  _store: LazyStore | null;
  _loadSettings: () => Promise<void>;
  updateSetting: <K extends keyof AppSettings>(key: K, value: AppSettings[K]) => Promise<void>;
}

export const useSettingsStore = create<SettingsStore>((set, get) => ({
  settings: defaultSettings,
  loaded: false,
  _store: null,

  _loadSettings: async () => {
    if (get().loaded) return;
    const store = new LazyStore(STORE_PATH);
    set({ _store: store });

    const result = { ...defaultSettings };
    for (const key of Object.keys(defaultSettings) as (keyof AppSettings)[]) {
      const val = await store.get(key);
      if (val !== null && val !== undefined) {
        (result as Record<string, unknown>)[key] = val;
      }
    }

    // Migrate legacy fields
    if (!result.aiApiKey && result.llmApiKey) {
      result.aiApiKey = result.llmApiKey;
      result.aiEndpoint = result.llmEndpoint || "";
      result.aiModel = result.llmDeployment || "";
      result.aiProvider = "azure_openai";
    }

    set({ settings: result, loaded: true });
  },

  updateSetting: async (key, value) => {
    set((state) => ({ settings: { ...state.settings, [key]: value } }));
    const store = get()._store;
    if (store) {
      await store.set(key, value);
      await store.save();
    }
  },
}));

/**
 * Hook for reading and writing application settings.
 * Uses a shared zustand store — all consumers see updates immediately.
 */
export function useSettings() {
  const settings = useSettingsStore((s) => s.settings);
  const loaded = useSettingsStore((s) => s.loaded);
  const updateSetting = useSettingsStore((s) => s.updateSetting);
  const loadSettings = useSettingsStore((s) => s._loadSettings);

  useEffect(() => { loadSettings(); }, [loadSettings]);

  return { settings, updateSetting, loaded };
}
