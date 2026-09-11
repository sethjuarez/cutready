import type { AppSettings } from "../../hooks/useSettings";

export interface ModelInfo {
  id: string;
  created?: number;
  owned_by?: string;
  capabilities?: Record<string, string>;
  context_length?: number;
}

// Mirrors Prompty's canonical `OAuthToken` wire form (camelCase), which the
// Tauri command returns verbatim over IPC. The Foundry OAuth wire (snake_case)
// is remapped to this canonical shape inside prompty-foundry on load.
export interface TokenResponse {
  accessToken: string;
  tokenType: string;
  expiresIn: number;
  refreshToken?: string;
  scope?: string;
}

export interface AuthCodeFlowInit {
  auth_url: string;
}

export type SettingsTab = "ai" | "agents" | "memory" | "display" | "themes" | "presentation" | "narration" | "recording" | "export" | "feedback" | "repository" | "updates" | "experimental";
export type AiInnerTab = "connections" | "agent" | "voice" | "memory";

export type SettingsUpdate = <K extends keyof AppSettings>(key: K, value: AppSettings[K]) => Promise<void>;
