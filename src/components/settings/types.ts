import type { AppSettings } from "../../hooks/useSettings";
export type { TokenResponse } from "../../types/auth";

export interface ModelInfo {
  id: string;
  created?: number;
  owned_by?: string;
  capabilities?: Record<string, string>;
  context_length?: number;
}

export interface AuthCodeFlowInit {
  auth_url: string;
}

export type SettingsTab = "profile" | "ai" | "agents" | "memory" | "display" | "themes" | "presentation" | "narration" | "recording" | "export" | "feedback" | "repository" | "updates" | "experimental";
export type AiInnerTab = "connections" | "agent" | "voice" | "memory";

export type SettingsUpdate = <K extends keyof AppSettings>(key: K, value: AppSettings[K]) => Promise<void>;
