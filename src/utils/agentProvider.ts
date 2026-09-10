import { invoke } from "../services/tauri";
import { loadProviderSecrets, setProviderSecret } from "../hooks/useSecretStore";
import { useSettingsStore, type AgentPreset, type GlobalSettings } from "../hooks/useSettings";
import {
  activeProviderInput,
  defaultProvider,
  providerById,
  providerToConfigInput,
  type ProviderConfigInput,
} from "./providerConfig";
import type { AiProviderConfig } from "../hooks/useSettings";

/** Resolve the per-agent model override (explicit map entry, then preset field). */
export function resolveAgentModelOverride(
  agent: AgentPreset,
  overrides: Record<string, string> | undefined,
): string {
  return (overrides?.[agent.id] || agent.modelOverride || "").trim();
}

/** Resolve the per-agent provider (connection) override id. */
export function resolveAgentProviderOverride(
  agent: AgentPreset,
  overrides: Record<string, string> | undefined,
): string {
  return (overrides?.[agent.id] || agent.providerOverride || "").trim();
}

/**
 * The connection an agent turn will actually use: the agent's explicit provider
 * override when set, otherwise the configured default connection. Returns null
 * when the pool is empty (caller falls back to the flat active projection).
 */
export function resolveEffectiveProvider(
  settings: GlobalSettings,
  agent: AgentPreset,
): AiProviderConfig | null {
  const providerOverride = resolveAgentProviderOverride(agent, settings.aiAgentProviderOverrides);
  return providerById(settings, providerOverride) ?? defaultProvider(settings);
}

/**
 * Build the provider config input for the effective connection WITHOUT touching
 * credentials. Used by the preflight "is this agent configured?" check, which
 * must stay side-effect free (no token refresh, no vault writes).
 */
export async function buildEffectiveProviderInput(
  settings: GlobalSettings,
  agent: AgentPreset,
): Promise<ProviderConfigInput> {
  const provider = resolveEffectiveProvider(settings, agent);
  if (!provider) return activeProviderInput(settings);

  const secrets = provider.id === settings.aiActiveProviderId
    ? { apiKey: settings.aiApiKey, accessToken: settings.aiAccessToken }
    : await loadProviderSecrets(provider.id);
  return providerToConfigInput(provider, settings, {
    apiKey: secrets.apiKey,
    accessToken: secrets.accessToken,
  });
}

type UpdateSetting = (key: "aiAccessToken" | "aiRefreshToken", value: string) => Promise<void> | void;

/**
 * Persist freshly minted OAuth tokens (from sign-in or refresh) to the specific
 * connection that initiated the flow (#262).
 *
 * Tokens are always written to the owning connection's vault via
 * `setProviderSecret`, so a sign-in/refresh started on connection A can never
 * land in connection B. The flat active projection is mirrored only while that
 * connection is still the active one, guarding against a switch or removal
 * during the (potentially long-running) flow.
 */
export async function persistConnectionTokens(
  providerId: string,
  tokens: { accessToken: string; refreshToken?: string },
  updateSetting: UpdateSetting,
): Promise<void> {
  if (!providerId) {
    // Single-connection / unmanaged pool: fall back to the flat projection.
    await updateSetting("aiAccessToken", tokens.accessToken);
    if (tokens.refreshToken) {
      await updateSetting("aiRefreshToken", tokens.refreshToken);
    }
    return;
  }
  await setProviderSecret(providerId, "accessToken", tokens.accessToken);
  if (tokens.refreshToken) {
    await setProviderSecret(providerId, "refreshToken", tokens.refreshToken);
  }
  // Mirror to the flat projection only while this connection is still active.
  // The live id is re-read before EACH flat write because updateSetting routes
  // by the active connection internally, and a switch can interleave at the
  // await between the two writes — re-checking prevents writing one connection's
  // refresh token onto another.
  const stillActive = () => providerId === useSettingsStore.getState().settings.aiActiveProviderId;
  if (stillActive()) {
    await updateSetting("aiAccessToken", tokens.accessToken);
  }
  if (tokens.refreshToken && stillActive()) {
    await updateSetting("aiRefreshToken", tokens.refreshToken);
  }
}

/**
 * Clear an OAuth connection's credentials, bound to the connection that
 * initiated sign-out (#262). Vault secrets (access, refresh, and management
 * tokens) are always cleared on the owning connection by ID — including the
 * management token, which has no flat-key vault routing — and the flat active
 * projection is cleared only while that connection is still active.
 */
export async function clearConnectionTokens(
  providerId: string,
  updateSetting: (key: "aiAccessToken" | "aiRefreshToken" | "aiManagementToken", value: string) => Promise<void> | void,
): Promise<void> {
  if (!providerId) {
    await updateSetting("aiAccessToken", "");
    await updateSetting("aiRefreshToken", "");
    await updateSetting("aiManagementToken", "");
    return;
  }
  await setProviderSecret(providerId, "accessToken", "");
  await setProviderSecret(providerId, "refreshToken", "");
  await setProviderSecret(providerId, "managementToken", "");
  const stillActive = () => providerId === useSettingsStore.getState().settings.aiActiveProviderId;
  if (stillActive()) await updateSetting("aiAccessToken", "");
  if (stillActive()) await updateSetting("aiRefreshToken", "");
  if (stillActive()) await updateSetting("aiManagementToken", "");
}

/**
 * Build the provider config input for the effective connection for an actual
 * agent turn, refreshing that connection's OAuth credentials first (#262).
 *
 * The effective connection (override, else default) is resolved first, then ITS
 * own tenant/client + refresh token drive the refresh — never the connection
 * currently selected in Settings. Refreshed tokens are written back to the
 * connection that owns them, and mirrored into the flat active projection only
 * while that connection is still the active one, so switching or removing a
 * connection mid-refresh cannot write into another connection.
 */
export async function buildRefreshedProviderInput(
  settings: GlobalSettings,
  agent: AgentPreset,
  updateSetting: UpdateSetting,
): Promise<ProviderConfigInput> {
  const provider = resolveEffectiveProvider(settings, agent);
  if (!provider) return activeProviderInput(settings);

  const secrets = provider.id === settings.aiActiveProviderId
    ? { apiKey: settings.aiApiKey, accessToken: settings.aiAccessToken, refreshToken: settings.aiRefreshToken }
    : await loadProviderSecrets(provider.id);

  let accessToken = secrets.accessToken ?? "";

  if (provider.authMode === "azure_oauth" && secrets.refreshToken) {
    try {
      const tokenResult = await invoke<{ access_token: string; refresh_token?: string }>(
        "azure_token_refresh",
        {
          tenantId: provider.tenantId || "",
          refreshToken: secrets.refreshToken,
          clientId: provider.clientId || null,
        },
      );
      if (tokenResult.access_token) {
        accessToken = tokenResult.access_token;
        // Persist to the connection that owns these credentials, mirroring to
        // the flat projection only while it remains active.
        await persistConnectionTokens(
          provider.id,
          { accessToken: tokenResult.access_token, refreshToken: tokenResult.refresh_token },
          updateSetting,
        );
      }
    } catch {
      // Keep the existing token; the provider request surfaces any auth failure.
    }
  }

  return providerToConfigInput(provider, settings, {
    apiKey: secrets.apiKey,
    accessToken,
  });
}
