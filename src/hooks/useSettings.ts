import { useCallback, useEffect, useRef, useState } from "react";
import { LazyStore } from "@tauri-apps/plugin-store";

export interface AppSettings {
  outputDirectory: string;
  llmApiKey: string;
  llmEndpoint: string;
  llmDeployment: string;
  audioDevice: string;
}

const defaultSettings: AppSettings = {
  outputDirectory: "",
  llmApiKey: "",
  llmEndpoint: "",
  llmDeployment: "",
  audioDevice: "",
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
        const val = await store.get<string>(key);
        if (val !== null && val !== undefined) {
          result[key] = val;
        }
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
