import type { AiProviderConfig, AiProviderKind, AiAuthMode } from "../hooks/useSettings";

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
  aiMaxToolRounds?: number;
  aiProviders?: AiProviderConfig[];
  aiActiveProviderId?: string;
  aiDefaultProviderId?: string;
}

export interface ProviderSecrets {
  apiKey?: string;
  accessToken?: string;
}

export interface ProviderConfigInput {
  provider: string;
  endpoint: string;
  apiKey: string;
  model: string;
  authMode: string;
  accessToken: string;
  contextLength?: number;
  modelSupportsVision?: string;
  providerId?: string;
  providerName?: string;
  aiVisionMode?: "off" | "notes" | "notes_and_sketches";
  aiWebAccess?: "disabled" | "enabled";
  aiMaxToolRounds?: number;
}

function providerLabel(provider: AiProviderKind): string {
  switch (provider) {
    case "microsoft_foundry": return "Microsoft Foundry";
    case "azure_openai": return "Azure OpenAI";
    case "openai": return "OpenAI";
    case "anthropic": return "Anthropic";
  }
}

export function createAiProviderConfig(provider: AiProviderKind = "azure_openai", index = 1): AiProviderConfig {
  return {
    id: typeof crypto !== "undefined" && "randomUUID" in crypto ? crypto.randomUUID() : `provider-${Date.now()}-${index}`,
    name: `${providerLabel(provider)}${index > 1 ? ` ${index}` : ""}`,
    provider,
    authMode: provider === "azure_openai" || provider === "microsoft_foundry" ? "api_key" : "api_key",
    endpoint: "",
    model: "",
    contextLength: 0,
    modelSupportsVision: "",
    tenantId: "",
    clientId: "",
    subscriptionId: "",
    resourceGroup: "",
    resourceName: "",
  };
}

export function providerToConfigInput(
  provider: AiProviderConfig,
  settings: Pick<ProviderSettings, "aiVisionMode" | "aiWebAccess" | "aiMaxToolRounds">,
  secrets: ProviderSecrets = {},
): ProviderConfigInput {
  return {
    provider: provider.provider,
    endpoint: provider.endpoint,
    apiKey: secrets.apiKey ?? "",
    model: provider.model,
    authMode: provider.authMode,
    accessToken: secrets.accessToken ?? "",
    contextLength: provider.contextLength,
    modelSupportsVision: provider.modelSupportsVision,
    providerId: provider.id,
    providerName: provider.name,
    ...settings,
  } as ProviderConfigInput;
}

export function activeProvider(settings: ProviderSettings): AiProviderConfig | null {
  return (settings.aiProviders || []).find((provider) => provider.id === settings.aiActiveProviderId)
    ?? (settings.aiProviders || [])[0]
    ?? null;
}

export function defaultProvider(settings: ProviderSettings): AiProviderConfig | null {
  return (settings.aiProviders || []).find((provider) => provider.id === settings.aiDefaultProviderId)
    ?? activeProvider(settings);
}

export function providerById(settings: ProviderSettings, providerId?: string): AiProviderConfig | null {
  if (!providerId) return null;
  return (settings.aiProviders || []).find((provider) => provider.id === providerId) ?? null;
}

export function flatProviderInput(settings: ProviderSettings): ProviderConfigInput {
  return {
    provider: settings.aiProvider,
    endpoint: settings.aiEndpoint,
    apiKey: settings.aiApiKey,
    model: settings.aiModel,
    authMode: settings.aiAuthMode,
    accessToken: settings.aiAccessToken,
    contextLength: settings.aiContextLength,
    modelSupportsVision: settings.aiModelSupportsVision,
  };
}

export function activeProviderInput(settings: ProviderSettings): ProviderConfigInput {
  const provider = activeProvider(settings);
  if (!provider) return flatProviderInput(settings);
  return providerToConfigInput(provider, settings, {
    apiKey: settings.aiApiKey,
    accessToken: settings.aiAccessToken,
  });
}

/** Build the provider config payload for IPC calls like list_models / agent_chat_with_tools. */
export function buildProviderConfig(settings: ProviderSettings | ProviderConfigInput) {
  const requestInput = "provider" in settings;
  const contextLength = requestInput ? settings.contextLength : settings.aiContextLength;
  const modelSupportsVision = requestInput ? settings.modelSupportsVision : settings.aiModelSupportsVision;
  return {
    provider: requestInput ? settings.provider : settings.aiProvider,
    endpoint: requestInput ? settings.endpoint : settings.aiEndpoint,
    api_key: requestInput ? settings.apiKey : settings.aiApiKey,
    model: (requestInput ? settings.model : settings.aiModel) || "unused",
    bearer_token:
      (requestInput ? settings.authMode : settings.aiAuthMode) === "azure_oauth"
        ? (requestInput ? settings.accessToken : settings.aiAccessToken)
        : null,
    context_length: contextLength || null,
    vision_mode: settings.aiVisionMode || "off",
    model_supports_vision:
      modelSupportsVision === ""
        ? null
        : modelSupportsVision === "true",
    web_access: settings.aiWebAccess || "disabled",
    max_tool_rounds: Math.max(1, Math.min(200, Number(settings.aiMaxToolRounds || 50))),
    provider_id: requestInput ? settings.providerId : undefined,
    provider_name: requestInput ? settings.providerName : undefined,
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
    ? !!settings.aiApiKey
    : isOAuth
      ? hasToken
      : !!settings.aiApiKey || (isFoundry && !!settings.aiEndpoint);
}

export function canFetchModelsForInput(settings: Pick<ProviderConfigInput, "provider" | "authMode" | "apiKey" | "accessToken" | "endpoint">) {
  return canFetchModelsFor({
    aiProvider: settings.provider,
    aiAuthMode: settings.authMode,
    aiApiKey: settings.apiKey,
    aiAccessToken: settings.accessToken,
    aiEndpoint: settings.endpoint,
  });
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

export function isProviderInputConfigured(settings: Pick<ProviderConfigInput, "provider" | "authMode" | "apiKey" | "accessToken" | "endpoint" | "model">) {
  return isAiProviderConfigured({
    aiProvider: settings.provider,
    aiAuthMode: settings.authMode,
    aiApiKey: settings.apiKey,
    aiAccessToken: settings.accessToken,
    aiEndpoint: settings.endpoint,
    aiModel: settings.model,
  });
}

export function normalizeAuthMode(provider: AiProviderKind, authMode: string): AiAuthMode {
  if ((provider === "azure_openai" || provider === "microsoft_foundry") && authMode === "azure_oauth") {
    return "azure_oauth";
  }
  return "api_key";
}
