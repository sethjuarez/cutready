import { useEffect } from "react";
import { create } from "zustand";
import { LazyStore } from "@tauri-apps/plugin-store";
import { invoke } from "@tauri-apps/api/core";
import { isSecretKey, loadAllSecrets, setSecret, type SecretKey } from "./useSecretStore";

export interface AgentPreset {
  id: string;
  name: string;
  prompt: string;
  /** Optional model override — if set, this agent uses a different model than the global setting. */
  modelOverride?: string;
}

// ── Global settings (stored in Tauri app data) ────────────────────

export interface GlobalSettings {
  outputDirectory: string;
  /** "azure_openai", "openai", or "copilot_sdk" */
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
  /** API-reported context window (tokens) for the selected model. */
  aiContextLength: number;
  /** Vision mode: "off", "notes", or "notes_and_sketches". */
  aiVisionMode: "off" | "notes" | "notes_and_sketches";
  /** Whether the selected model supports vision (set when model is picked). */
  aiModelSupportsVision: string;
  // Legacy fields (migrated on load)
  llmApiKey?: string;
  llmEndpoint?: string;
  llmDeployment?: string;
}

// ── Workspace settings (stored per-workspace in .cutready/settings.json) ──

export interface WorkspaceSettings {
  /** Git remote URL (e.g. https://github.com/user/repo.git). */
  repoRemoteUrl: string;
  /** Auth method: "gh_cli" | "pat" | "ssh" (default "gh_cli"). */
  repoAuthMethod: string;
  /** Personal Access Token (when repoAuthMethod is "pat"). */
  repoToken: string;
  /** Git author name for commits. */
  repoAuthorName: string;
  /** Git author email for commits. */
  repoAuthorEmail: string;
}

/** Combined view for backward compatibility — consumers that need both. */
export type AppSettings = GlobalSettings & WorkspaceSettings;

const defaultGlobalSettings: GlobalSettings = {
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
  aiContextLength: 0,
  aiVisionMode: "notes_and_sketches",
  aiModelSupportsVision: "",
};

export const defaultWorkspaceSettings: WorkspaceSettings = {
  repoRemoteUrl: "",
  repoAuthMethod: "gh_cli",
  repoToken: "",
  repoAuthorName: "",
  repoAuthorEmail: "",
};

const defaultSettings: AppSettings = {
  ...defaultGlobalSettings,
  ...defaultWorkspaceSettings,
};

const STORE_PATH = "settings.json";

const WORKSPACE_KEYS: (keyof WorkspaceSettings)[] = [
  "repoRemoteUrl",
  "repoAuthMethod",
  "repoToken",
  "repoAuthorName",
  "repoAuthorEmail",
];

interface SettingsStore {
  settings: AppSettings;
  loaded: boolean;
  workspaceLoaded: boolean;
  _store: LazyStore | null;
  _loadSettings: () => Promise<void>;
  _loadWorkspaceSettings: () => Promise<void>;
  _clearWorkspaceSettings: () => void;
  updateSetting: <K extends keyof AppSettings>(key: K, value: AppSettings[K]) => Promise<void>;
}

export const useSettingsStore = create<SettingsStore>((set, get) => ({
  settings: defaultSettings,
  loaded: false,
  workspaceLoaded: false,
  _store: null,

  _loadSettings: async () => {
    if (get().loaded) return;
    const store = new LazyStore(STORE_PATH);
    set({ _store: store });

    const result = { ...defaultGlobalSettings };
    for (const key of Object.keys(defaultGlobalSettings) as (keyof GlobalSettings)[]) {
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

    // Load secrets from Stronghold (encrypted vault)
    try {
      const secrets = await loadAllSecrets();

      // Migrate: if stronghold is empty but plain store has secrets, move them over
      let migrated = false;
      for (const sk of Object.keys(secrets) as SecretKey[]) {
        const plainVal = (result as Record<string, unknown>)[sk] as string | undefined;
        if (!secrets[sk] && plainVal) {
          // Secret exists in plain store but not vault — migrate it
          await setSecret(sk, plainVal);
          secrets[sk] = plainVal;
          // Clear from plain store
          await store.set(sk, "");
          migrated = true;
        }
      }
      if (migrated) await store.save();

      // Override result with vault values (vault is authoritative)
      for (const sk of Object.keys(secrets) as SecretKey[]) {
        if (secrets[sk]) {
          (result as Record<string, unknown>)[sk] = secrets[sk];
        }
      }
    } catch {
      // Stronghold unavailable (e.g. browser dev mode) — use plain store values
    }

    set({ settings: { ...get().settings, ...result }, loaded: true });

    // Auto-refresh OAuth token on startup if we have a refresh token
    if (result.aiAuthMode === "azure_oauth" && result.aiRefreshToken) {
      try {
        const tokenResult = await invoke<{ access_token: string; refresh_token?: string }>(
          "azure_token_refresh",
          {
            tenantId: result.aiTenantId || "",
            refreshToken: result.aiRefreshToken,
            clientId: result.aiClientId || null,
          },
        );
        if (tokenResult.access_token) {
          const updates: Partial<GlobalSettings> = { aiAccessToken: tokenResult.access_token };
          if (tokenResult.refresh_token) {
            updates.aiRefreshToken = tokenResult.refresh_token;
          }
          set((state) => ({ settings: { ...state.settings, ...updates } }));
          // Save refreshed tokens to vault
          try {
            await setSecret("aiAccessToken", tokenResult.access_token);
            if (tokenResult.refresh_token) {
              await setSecret("aiRefreshToken", tokenResult.refresh_token);
            }
          } catch {
            // Vault unavailable — fall through
          }
        }
      } catch {
        // Token refresh failed silently — user will re-auth when needed
      }
    }
  },

  _loadWorkspaceSettings: async () => {
    try {
      const data = await invoke<Record<string, unknown>>("get_workspace_settings");
      const ws = { ...defaultWorkspaceSettings };
      for (const key of WORKSPACE_KEYS) {
        if (data[key] !== null && data[key] !== undefined) {
          (ws as Record<string, unknown>)[key] = data[key];
        }
      }
      set((state) => ({ settings: { ...state.settings, ...ws }, workspaceLoaded: true }));
    } catch {
      // No workspace settings yet — use defaults
      set((state) => ({
        settings: { ...state.settings, ...defaultWorkspaceSettings },
        workspaceLoaded: true,
      }));
    }
  },

  _clearWorkspaceSettings: () => {
    set((state) => ({
      settings: { ...state.settings, ...defaultWorkspaceSettings },
      workspaceLoaded: false,
    }));
  },

  updateSetting: async (key, value) => {
    set((state) => ({ settings: { ...state.settings, [key]: value } }));

    if (WORKSPACE_KEYS.includes(key as keyof WorkspaceSettings)) {
      // Workspace setting — special handling for repoToken (encrypted)
      if (isSecretKey(key as string)) {
        try { await setSecret(key as SecretKey, value as string); } catch { /* vault unavailable */ }
      }
      try {
        const data = await invoke<Record<string, unknown>>("get_workspace_settings");
        // Don't persist secrets in workspace settings file
        if (!isSecretKey(key as string)) {
          data[key] = value;
        }
        await invoke("set_workspace_settings", { settings: data });
      } catch {
        // No repo open — setting stored in memory only
      }
    } else if (isSecretKey(key as string)) {
      // Global secret → save to encrypted vault
      try {
        await setSecret(key as SecretKey, value as string);
      } catch {
        // Vault unavailable — fall back to plain store
        const store = get()._store;
        if (store) {
          await store.set(key, value);
          await store.save();
        }
      }
    } else {
      // Global non-secret → save to Tauri app data (plaintext)
      const store = get()._store;
      if (store) {
        await store.set(key, value);
        await store.save();
      }
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
