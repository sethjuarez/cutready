import type { AppSettings } from "../hooks/useSettings";
import { getProviderSecret, setProviderSecret } from "../hooks/useSecretStore";
import { narrationProvider } from "../utils/providerConfig";
import { invoke } from "./tauri";

export const NARRATION_VOICE_SAMPLE = "Welcome to CutReady. Together, we'll turn your product story into a polished, confident demo.";

type UpdateSetting = <K extends keyof AppSettings>(key: K, value: AppSettings[K]) => Promise<void>;

interface NarrationVoicePreviewResult {
  path: string;
  generated: boolean;
  accessToken?: string | null;
  refreshToken?: string | null;
}

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

  const selectedProvider = narrationProvider(settings);
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

  // Synthesis, token refresh, and disk write all happen in the Rust backend
  // (the SpeechSynthesizer seam, issue #256): the audio bytes never cross the
  // IPC boundary and the round-trips collapse into this single command.
  const result = await invoke<NarrationVoicePreviewResult>("synthesize_narration_voice_preview", {
    request: {
      voiceName: settings.narrationVoiceName,
      outputFormat: settings.narrationSpeechOutputFormat,
      text: NARRATION_VOICE_SAMPLE,
      endpoint: selectedProvider.endpoint,
      tenantId: selectedProvider.tenantId || settings.aiTenantId || "",
      clientId: selectedProvider.clientId || settings.aiClientId || null,
      refreshToken,
      force,
    },
  });

  // Persist any rotated credentials the backend returned (token storage stays a
  // frontend concern; only the network work moved to the backend).
  if (result.generated && result.accessToken) {
    if (selectedProvider.id === settings.aiActiveProviderId) {
      await updateSetting("aiAccessToken", result.accessToken);
      if (result.refreshToken) await updateSetting("aiRefreshToken", result.refreshToken);
    } else {
      await setProviderSecret(selectedProvider.id, "accessToken", result.accessToken);
      if (result.refreshToken) await setProviderSecret(selectedProvider.id, "refreshToken", result.refreshToken);
    }
  }

  return { path: result.path, generated: result.generated };
}
