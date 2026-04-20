import { invoke } from "@tauri-apps/api/core";

export interface AgentChatConfig {
  provider: string;
  endpoint: string;
  api_key: string;
  model: string;
  bearer_token?: string | null;
  context_length?: number | null;
  vision_mode?: "off" | "notes" | "notes_and_sketches";
  model_supports_vision?: boolean | null;
  web_access?: "disabled" | "enabled";
}

export interface AgentChatMessage {
  role: string;
  content: string | null;
}

export interface AgentChatOptions {
  timeoutMs?: number;
}

export function agentChat(
  config: AgentChatConfig,
  messages: AgentChatMessage[],
  options: AgentChatOptions = {},
) {
  return invoke<AgentChatMessage>("agent_chat", {
    config,
    messages,
    timeoutMs: options.timeoutMs,
  });
}
