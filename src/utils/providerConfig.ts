export interface ProviderSettings {
  aiProvider: string;
  aiEndpoint: string;
  aiApiKey: string;
  aiModel: string;
  aiAuthMode: string;
  aiAccessToken: string;
  aiContextLength?: number;
  aiVisionMode?: "off" | "notes" | "notes_and_sketches";
  aiModelSupportsVision?: string;
  aiWebAccess?: "disabled" | "enabled";
}

/** Build the provider config payload for IPC calls like list_models / agent_chat_with_tools. */
export function buildProviderConfig(settings: ProviderSettings) {
  return {
    provider: settings.aiProvider,
    endpoint: settings.aiEndpoint,
    api_key: settings.aiApiKey,
    model: settings.aiModel || "unused",
    bearer_token:
      settings.aiAuthMode === "azure_oauth"
        ? settings.aiAccessToken
        : null,
    context_length: settings.aiContextLength || null,
    vision_mode: settings.aiVisionMode || "off",
    model_supports_vision:
      settings.aiModelSupportsVision === ""
        ? null
        : settings.aiModelSupportsVision === "true",
    web_access: settings.aiWebAccess || "disabled",
  };
}

/** Determine whether the "Fetch Models" button should be enabled. */
export function canFetchModelsFor(settings: Pick<ProviderSettings, "aiProvider" | "aiAuthMode" | "aiApiKey" | "aiAccessToken" | "aiEndpoint">) {
  const isAzure = settings.aiProvider === "azure_openai";
  const isFoundry = settings.aiProvider === "microsoft_foundry";
  const isAnthropic = settings.aiProvider === "anthropic";
  const isOAuth = (isAzure || isFoundry) && settings.aiAuthMode === "azure_oauth";
  const hasToken = !!settings.aiAccessToken;
  return isAnthropic
    ? true
    : isOAuth
      ? hasToken
      : !!settings.aiApiKey || (isFoundry && !!settings.aiEndpoint);
}

/** Determine whether chat-like agent calls have enough provider settings to run. */
export function isAiProviderConfigured(settings: Pick<ProviderSettings, "aiProvider" | "aiAuthMode" | "aiApiKey" | "aiAccessToken" | "aiEndpoint" | "aiModel">) {
  const hasModel = !!settings.aiModel;
  if (!hasModel) return false;

  const isAzure = settings.aiProvider === "azure_openai";
  const isFoundry = settings.aiProvider === "microsoft_foundry";
  const isAnthropic = settings.aiProvider === "anthropic";
  const isOAuth = (isAzure || isFoundry) && settings.aiAuthMode === "azure_oauth";

  if (isAnthropic) return !!settings.aiApiKey;
  if (settings.aiProvider === "openai") return !!settings.aiApiKey;
  if (isOAuth) return !!settings.aiEndpoint && !!settings.aiAccessToken;
  if (isFoundry) return !!settings.aiEndpoint && !!settings.aiApiKey;
  return !!settings.aiEndpoint && !!settings.aiApiKey;
}
