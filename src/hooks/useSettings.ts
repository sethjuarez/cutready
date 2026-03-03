import { useCallback, useEffect, useRef, useState } from "react";
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
};

const STORE_PATH = "settings.json";

/**
 * Hook for reading and writing application settings via tauri-plugin-store.
 * Settings persist across restarts.
 */
export function useSettings() {
  const [settings, setSettings] = useState<AppSettings>(defaultSettings);
  const [loaded, setLoaded] = useState(false);
  const storeRef = useRef<LazyStore | null>(null);

  useEffect(() => {
    const load = async () => {
      const store = new LazyStore(STORE_PATH);
      storeRef.current = store;

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

      setSettings(result);
      setLoaded(true);
    };
    load();
  }, []);

  const updateSetting = useCallback(
    async <K extends keyof AppSettings>(key: K, value: AppSettings[K]) => {
      setSettings((prev) => ({ ...prev, [key]: value }));
      if (storeRef.current) {
        await storeRef.current.set(key, value);
        await storeRef.current.save();
      }
    },
    [],
  );

  return { settings, updateSetting, loaded };
}
