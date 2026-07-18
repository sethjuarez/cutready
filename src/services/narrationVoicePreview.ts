import type { AppSettings } from "../hooks/useSettings";
import { getProviderSecret, setProviderSecret } from "../hooks/useSecretStore";
import { activeProvider, providerById } from "../utils/providerConfig";
import { invoke } from "./tauri";
import {
  buildPlainSsml,
  inferSpeechEndpoint,
  SPEECH_TOKEN_SCOPE,
  synthesizeSpeechAudio,
} from "./narrationSpeech";

export const NARRATION_VOICE_SAMPLE = "Welcome to CutReady. Together, we'll turn your product story into a polished, confident demo.";

type UpdateSetting = <K extends keyof AppSettings>(key: K, value: AppSettings[K]) => Promise<void>;

export async function ensureCachedNarrationVoicePreview({
  settings,
  updateSetting,
  force = false,
}: {
  settings: AppSettings;
  updateSetting: UpdateSetting;
  force?: boolean;
}): Promise<{ path: string; generated: boolean }> {
  if (!force) {
    const cachedPath = await invoke<string | null>("get_narration_voice_preview", {
      voiceName: settings.narrationVoiceName,
      outputFormat: settings.narrationSpeechOutputFormat,
    });
    if (cachedPath) return { path: cachedPath, generated: false };
  }

  const providers = settings.aiProviders ?? [];
  const narrationProviders = providers.filter((provider) =>
    (provider.provider === "microsoft_foundry" || provider.provider === "azure_openai") && provider.endpoint,
  );
  const selectedNarrationProvider = narrationProviders.find(
    (provider) => provider.id === settings.narrationProviderId,
  ) ?? narrationProviders[0] ?? null;
  const selectedProvider = settings.narrationConnectionMode === "dedicated"
    ? providerById(settings, settings.narrationProviderId) ?? selectedNarrationProvider
    : activeProvider(settings);
  if (!selectedProvider || !["microsoft_foundry", "azure_openai"].includes(selectedProvider.provider) || !selectedProvider.endpoint) {
    throw new Error("Select a Foundry or Azure narration connection before previewing a voice.");
  }
  if (selectedProvider.authMode !== "azure_oauth") {
    throw new Error("Voice previews require an Entra-authenticated Foundry or Azure connection.");
  }

  const refreshToken = selectedProvider.id === settings.aiActiveProviderId
    ? settings.aiRefreshToken
    : await getProviderSecret(selectedProvider.id, "refreshToken");
  if (!refreshToken) throw new Error("Sign in to the selected narration connection before previewing a voice.");

  const token = await invoke<{ access_token: string; refresh_token?: string }>("azure_token_refresh", {
    tenantId: selectedProvider.tenantId || settings.aiTenantId || "",
    refreshToken,
    clientId: selectedProvider.clientId || settings.aiClientId || null,
    scope: SPEECH_TOKEN_SCOPE,
  });
  if (!token.access_token) throw new Error("Azure Speech token refresh did not return an access token.");

  if (selectedProvider.id === settings.aiActiveProviderId) {
    await updateSetting("aiAccessToken", token.access_token);
    if (token.refresh_token) await updateSetting("aiRefreshToken", token.refresh_token);
  } else {
    await setProviderSecret(selectedProvider.id, "accessToken", token.access_token);
    if (token.refresh_token) await setProviderSecret(selectedProvider.id, "refreshToken", token.refresh_token);
  }

  console.info("[narrationVoicePreview] generating cached voice preview", {
    voice: settings.narrationVoiceName,
    outputFormat: settings.narrationSpeechOutputFormat,
  });
  const { audioData } = await synthesizeSpeechAudio({
    accessToken: token.access_token,
    speechEndpoint: inferSpeechEndpoint(selectedProvider.endpoint),
    ssml: buildPlainSsml(NARRATION_VOICE_SAMPLE, settings.narrationVoiceName),
    outputFormat: settings.narrationSpeechOutputFormat,
  });
  const path = await invoke<string>("save_narration_voice_preview", {
    voiceName: settings.narrationVoiceName,
    outputFormat: settings.narrationSpeechOutputFormat,
    audioData: Array.from(new Uint8Array(audioData)),
  });
  return { path, generated: true };
}
