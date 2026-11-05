import { useCallback } from "react";
import { useSettings } from "../../hooks/useSettings";
import { loadProviderSecrets } from "../../hooks/useSecretStore";
import { authIpc } from "../../ipc/auth";
import {
  activeProviderInput,
  buildProviderConfig,
  defaultProvider,
  isProviderInputConfigured,
  providerToConfigInput,
} from "../../utils/providerConfig";

/** Builds the LLM config the video importer's scene analyst uses, or null when no model is configured. */
export function useVideoImportLlmConfig() {
  const { settings, updateSetting, loaded } = useSettings();

  return useCallback(async () => {
    if (!loaded) return null;
    const selectedProvider = defaultProvider(settings);
    const providerInput = selectedProvider
      ? providerToConfigInput(
          selectedProvider,
          settings,
          selectedProvider.id === settings.aiActiveProviderId
            ? { apiKey: settings.aiApiKey, accessToken: settings.aiAccessToken }
            : await loadProviderSecrets(selectedProvider.id),
        )
      : activeProviderInput(settings);

    if (!isProviderInputConfigured(providerInput)) return null;

    let freshBearerToken = settings.aiAuthMode === "azure_oauth" ? settings.aiAccessToken : null;
    if (settings.aiAuthMode === "azure_oauth" && settings.aiRefreshToken) {
      try {
        const tokenResult = await authIpc.refreshAzureToken(
          settings.aiTenantId || "",
          settings.aiRefreshToken,
          settings.aiClientId || null,
        );
        if (tokenResult.accessToken) {
          freshBearerToken = tokenResult.accessToken;
          await updateSetting("aiAccessToken", tokenResult.accessToken);
          if (tokenResult.refreshToken) {
            await updateSetting("aiRefreshToken", tokenResult.refreshToken);
          }
        }
      } catch {
        console.warn("[auth] Video import OAuth refresh failed; trying cached credentials.");
      }
    }

    const config = buildProviderConfig(providerInput);
    if (freshBearerToken && selectedProvider?.id === settings.aiActiveProviderId) {
      config.bearer_token = freshBearerToken;
    }
    return config;
  }, [settings, loaded, updateSetting]);
}
