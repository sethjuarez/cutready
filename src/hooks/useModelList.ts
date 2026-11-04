// Loads the agent-compatible models for a provider connection, shared by the chat and home
// model pickers. Results are cached per connection for a few minutes.
import { useEffect, useState } from "react";
import { modelsIpc } from "../ipc/models";
import { loadProviderSecrets } from "./useSecretStore";
import type { AiProviderConfig, GlobalSettings } from "./useSettings";
import {
  activeProviderInput,
  buildProviderConfig,
  filterAgentCompatibleModels,
  providerById,
  providerToConfigInput,
} from "../utils/providerConfig";

const MODEL_CACHE_TTL = 5 * 60 * 1000;
const modelCache: { key: string; models: string[]; ts: number } = { key: "", models: [], ts: 0 };

function cacheKeyFor(settings: GlobalSettings, provider: AiProviderConfig | null): string {
  return provider
    ? `${provider.id}|${provider.provider}|${provider.endpoint}|${provider.authMode}`
    : `${settings.aiProvider}|${settings.aiEndpoint}|${settings.aiAuthMode}`;
}

/** Models for `providerId` (or the active flat connection), falling back to the current model on error. */
export function useModelList(
  settings: GlobalSettings,
  providerId: string | undefined,
  currentModel: string,
  enabled = true,
): { models: string[]; loading: boolean } {
  const [models, setModels] = useState<string[]>(modelCache.models);
  const [loading, setLoading] = useState(false);
  const provider = providerId ? providerById(settings, providerId) : null;

  useEffect(() => {
    if (!enabled) return;
    let cancelled = false;
    const cacheKey = cacheKeyFor(settings, provider);
    if (modelCache.key === cacheKey && modelCache.models.length > 0 && Date.now() - modelCache.ts < MODEL_CACHE_TTL) {
      setModels(modelCache.models);
      return;
    }

    async function load() {
      setLoading(true);
      try {
        const secrets = provider && provider.id !== settings.aiActiveProviderId
          ? await loadProviderSecrets(provider.id)
          : { apiKey: settings.aiApiKey, accessToken: settings.aiAccessToken };
        const providerInput = provider
          ? providerToConfigInput(provider, settings, { apiKey: secrets.apiKey, accessToken: secrets.accessToken })
          : activeProviderInput(settings);
        const config = buildProviderConfig(providerInput, settings.aiAgentExecutionEngine || "prompty");
        const result = await modelsIpc.list(config);
        if (!cancelled) {
          const ids = filterAgentCompatibleModels(result, config.provider).map((m) => m.id || m.name);
          modelCache.key = cacheKey;
          modelCache.models = ids;
          modelCache.ts = Date.now();
          setModels(ids);
        }
      } catch {
        if (!cancelled && currentModel) setModels([currentModel]);
      } finally {
        if (!cancelled) setLoading(false);
      }
    }
    void load();
    return () => { cancelled = true; };
  }, [settings, currentModel, provider, enabled]);

  return { models, loading };
}

/** The settings change that selects `model` for `providerId` (or the flat connection). */
export function modelSelectionUpdate(
  settings: GlobalSettings,
  providerId: string | undefined,
  model: string,
): { key: "aiProviders"; value: AiProviderConfig[] } | { key: "aiModel"; value: string } {
  if (providerId && settings.aiProviders?.some((candidate) => candidate.id === providerId)) {
    return {
      key: "aiProviders",
      value: settings.aiProviders.map((candidate) => (candidate.id === providerId ? { ...candidate, model } : candidate)),
    };
  }
  return { key: "aiModel", value: model };
}
