import { useMemo, useState } from "react";
import { Brain, RefreshCw, X } from "lucide-react";
import { useSettings, type AiReasoningEffort } from "../../hooks/useSettings";
import { inputClass } from "../../styles";
import { FoundryResourcePicker } from "../FoundryResourcePicker";
import { activeProvider, createAiProviderConfig, normalizeReasoningEffort, supportedReasoningEfforts } from "../../utils/providerConfig";
import type { ModelInfo } from "./types";

export function AIProviderTab({ settings, updateSetting, isAzure, isFoundry, isAnthropic, isOAuth, hasToken, canFetchModels, models, setModels, loadingModels, modelFilter, setModelFilter, modelError, fetchModels, oauthStatus, oauthError, startOAuthFlow, signOut }: {
  settings: ReturnType<typeof useSettings>["settings"];
  updateSetting: ReturnType<typeof useSettings>["updateSetting"];
  isAzure: boolean;
  isFoundry: boolean;
  isAnthropic: boolean;
  isOAuth: boolean;
  hasToken: boolean;
  canFetchModels: boolean;
  models: ModelInfo[];
  setModels: (m: ModelInfo[]) => void;
  loadingModels: boolean;
  modelFilter: string;
  setModelFilter: (f: string) => void;
  modelError: string;
  fetchModels: () => void;
  oauthStatus: string;
  oauthError: string;
  startOAuthFlow: () => void;
  signOut: () => void;
}) {
  const providers = settings.aiProviders?.length ? settings.aiProviders : [];
  const selectedProvider = activeProvider(settings);
  const defaultProvider = providers.find((provider) => provider.id === settings.aiDefaultProviderId) ?? selectedProvider;
  const activeModel = selectedProvider?.model || settings.aiModel || "";
  const reasoningEfforts = useMemo(
    () => supportedReasoningEfforts(selectedProvider?.provider, activeModel, settings.aiModelReasoningEfforts),
    [activeModel, selectedProvider?.provider, settings.aiModelReasoningEfforts],
  );
  const effectiveReasoningEffort = normalizeReasoningEffort(
    settings.aiReasoningEffort,
    selectedProvider?.provider,
    activeModel,
    settings.aiModelReasoningEfforts,
  );
  // Persisted per-connection "kind" values are unchanged wire values. The two
  // Azure kinds (microsoft_foundry, azure_openai) are surfaced as one "Microsoft
  // Foundry (Azure)" family in the UI; a connection-method toggle picks between
  // them, so labels/descriptions below fold both under the same family name.
  const providerOptions: Array<{ value: "microsoft_foundry" | "azure_openai" | "openai" | "anthropic"; label: string; description: string }> = [
    { value: "microsoft_foundry", label: "Microsoft Foundry (Azure)", description: "Foundry resource · Entra or key" },
    { value: "azure_openai", label: "Microsoft Foundry (Azure)", description: "Azure OpenAI endpoint" },
    { value: "openai", label: "OpenAI", description: "OpenAI platform models and compatible endpoints" },
    { value: "anthropic", label: "Anthropic", description: "Claude models through Anthropic" },
  ];
  type ProviderFamily = "azure" | "openai" | "anthropic";
  const providerFamilies: Array<{ value: ProviderFamily; label: string; description: string }> = [
    { value: "azure", label: "Microsoft Foundry (Azure)", description: "Azure AI Foundry or Azure OpenAI" },
    { value: "openai", label: "OpenAI", description: "OpenAI platform models and compatible endpoints" },
    { value: "anthropic", label: "Anthropic", description: "Claude models through Anthropic" },
  ];
  const familyOf = (kind: string): ProviderFamily =>
    kind === "microsoft_foundry" || kind === "azure_openai" ? "azure" : (kind as ProviderFamily);
  const familyToKind = (family: ProviderFamily): "microsoft_foundry" | "openai" | "anthropic" =>
    family === "azure" ? "microsoft_foundry" : family;
  const [newProviderFamily, setNewProviderFamily] = useState<ProviderFamily>("azure");
  const providerLabel = (provider: string) =>
    providerOptions.find((option) => option.value === provider)?.label ?? provider.replace(/_/g, " ");
  const providerDescription = (provider: string) =>
    providerOptions.find((option) => option.value === provider)?.description ?? "Custom provider connection";
  const authStatusLabel = (provider: typeof providers[number]) => {
    if (provider.authMode === "azure_oauth") {
      if (provider.id !== settings.aiActiveProviderId) return "OAuth connection";
      return settings.aiAccessToken ? "Signed in" : "Needs sign-in";
    }
    if (provider.id === settings.aiActiveProviderId) {
      return settings.aiApiKey ? "Key saved" : "Needs API key";
    }
    return provider.provider === "microsoft_foundry" && provider.endpoint ? "Endpoint saved" : "Saved";
  };
  const addProvider = async (provider: "microsoft_foundry" | "azure_openai" | "openai" | "anthropic" = "openai") => {
    const next = createAiProviderConfig(provider, providers.length + 1);
    await updateSetting("aiProviders", [...providers, next]);
    await updateSetting("aiActiveProviderId", next.id);
    setModels([]);
  };
  const duplicateProvider = async () => {
    if (!selectedProvider) return;
    const next = {
      ...selectedProvider,
      id: crypto.randomUUID(),
      name: `${selectedProvider.name} Copy`,
      model: selectedProvider.model,
    };
    await updateSetting("aiProviders", [...providers, next]);
    await updateSetting("aiActiveProviderId", next.id);
    setModels([]);
  };
  const updateProviderName = (name: string) => {
    if (!selectedProvider) return;
    void updateSetting("aiProviders", providers.map((provider) =>
      provider.id === selectedProvider.id ? { ...provider, name } : provider
    ));
  };
  const deleteProvider = async () => {
    if (!selectedProvider || providers.length <= 1) return;
    const remaining = providers.filter((provider) => provider.id !== selectedProvider.id);
    await updateSetting("aiProviders", remaining);
    await updateSetting("aiActiveProviderId", remaining[0].id);
    if (settings.aiDefaultProviderId === selectedProvider.id) {
      await updateSetting("aiDefaultProviderId", remaining[0].id);
    }
    setModels([]);
  };

  return (
    <div className="flex flex-col gap-4">
      <div className="rounded-2xl border border-[rgb(var(--color-border))] bg-[rgb(var(--color-surface-alt))]/40 p-4">
        <div className="flex flex-col gap-3 md:flex-row md:items-center md:justify-between">
          <div>
            <h3 className="text-sm font-semibold text-[rgb(var(--color-text))]">AI apply behavior</h3>
            <p className="mt-1 text-xs leading-5 text-[rgb(var(--color-text-secondary))]">
              Control whether write-capable AI shortcuts stop for approval or apply changes automatically.
            </p>
          </div>
          <select
            value={settings.aiApplyMode}
            onChange={(event) => void updateSetting("aiApplyMode", event.target.value as typeof settings.aiApplyMode)}
            className={inputClass + " min-w-56 text-xs"}
          >
            <option value="ask">Ask before applying</option>
            <option value="auto">Auto-apply AI changes</option>
          </select>
        </div>
      </div>

      <div className="rounded-2xl border border-[rgb(var(--color-border))] bg-[rgb(var(--color-surface-alt))]/40 p-4">
        <div className="mb-4 flex flex-col gap-3 lg:flex-row lg:items-start lg:justify-between">
          <div className="max-w-xl">
            <h3 className="text-sm font-semibold text-[rgb(var(--color-text))]">Connections</h3>
            <p className="mt-1 text-xs leading-5 text-[rgb(var(--color-text-secondary))]">
              Manage provider connections here. Selecting a card only edits that connection; the Default badge controls runtime routing for chat, notes, and agents.
            </p>
          </div>
          <div className="flex flex-col gap-2 rounded-xl border border-[rgb(var(--color-border))] bg-[rgb(var(--color-surface))] p-2 sm:flex-row sm:items-center">
            <select
              value={newProviderFamily}
              onChange={(e) => setNewProviderFamily(e.target.value as ProviderFamily)}
              className={inputClass + " min-w-44 text-xs"}
              aria-label="Provider type to add"
            >
              {providerFamilies.map((option) => (
                <option key={option.value} value={option.value}>{option.label}</option>
              ))}
            </select>
            <button
              type="button"
              onClick={() => void addProvider(familyToKind(newProviderFamily))}
              className="rounded-lg bg-[rgb(var(--color-accent))] px-3 py-2 text-xs font-semibold text-[rgb(var(--color-accent-fg))] transition-opacity hover:opacity-90"
            >
              Add provider
            </button>
          </div>
        </div>

        <div className="grid gap-3 md:grid-cols-2">
          {providers.map((provider) => {
            const selected = provider.id === settings.aiActiveProviderId;
            const defaultProvider = provider.id === settings.aiDefaultProviderId;
            return (
              <button
                key={provider.id}
                type="button"
                onClick={() => {
                  void updateSetting("aiActiveProviderId", provider.id);
                  setModels([]);
                }}
                className={`rounded-xl border p-3 text-left transition-colors ${
                  selected
                    ? "border-[rgb(var(--color-accent))] bg-[rgb(var(--color-accent))]/10"
                    : "border-[rgb(var(--color-border))] bg-[rgb(var(--color-surface))] hover:border-[rgb(var(--color-accent))]/50"
                }`}
              >
                <div className="flex items-start gap-2">
                  <span className="truncate text-sm font-medium text-[rgb(var(--color-text))]">{provider.name}</span>
                  <div className="flex-1" />
                  {selected && <span className="rounded-full bg-[rgb(var(--color-accent))]/15 px-1.5 py-0.5 text-[10px] font-medium text-[rgb(var(--color-accent))]">Editing</span>}
                  {defaultProvider && <span className="rounded-full bg-[rgb(var(--color-surface-alt))] px-1.5 py-0.5 text-[10px] text-[rgb(var(--color-text-secondary))]">Default</span>}
                </div>
                <div className="mt-1 text-xs text-[rgb(var(--color-text-secondary))]">
                  {providerLabel(provider.provider)} · {provider.model || "No model selected"}
                </div>
                <div className="mt-2 flex items-center justify-between gap-3 text-[11px] text-[rgb(var(--color-text-secondary))]">
                  <span>{authStatusLabel(provider)}</span>
                  <span>{providerDescription(provider.provider)}</span>
                </div>
              </button>
            );
          })}
        </div>

        {selectedProvider && (
          <div className="mt-4 rounded-xl border border-[rgb(var(--color-border))] bg-[rgb(var(--color-surface))] p-3">
            <div className="flex flex-col gap-3 sm:flex-row sm:items-end">
              <label className="block flex-1 space-y-1.5">
                <span className="text-xs font-medium text-[rgb(var(--color-text-secondary))]">Connection name</span>
                <input
                  value={selectedProvider.name}
                  onChange={(e) => updateProviderName(e.target.value)}
                  className={inputClass}
                />
              </label>
              <button
                type="button"
                onClick={() => updateSetting("aiDefaultProviderId", selectedProvider.id)}
                disabled={settings.aiDefaultProviderId === selectedProvider.id}
                className="rounded-lg border border-[rgb(var(--color-border))] px-3 py-2 text-xs font-medium text-[rgb(var(--color-text))] transition-colors hover:bg-[rgb(var(--color-surface-alt))] disabled:opacity-50"
              >
                {settings.aiDefaultProviderId === selectedProvider.id ? "Default provider" : "Set as default"}
              </button>
              <button
                type="button"
                onClick={() => void duplicateProvider()}
                disabled={!selectedProvider}
                className="rounded-lg border border-[rgb(var(--color-border))] px-3 py-2 text-xs font-medium text-[rgb(var(--color-text-secondary))] transition-colors hover:text-[rgb(var(--color-text))] disabled:opacity-40"
              >
                Duplicate
              </button>
              <button
                type="button"
                onClick={() => void deleteProvider()}
                disabled={providers.length <= 1}
                className="rounded-lg border border-[rgb(var(--color-border))] px-3 py-2 text-xs font-medium text-error transition-colors hover:bg-error/10 disabled:cursor-not-allowed disabled:opacity-40"
              >
                Delete
              </button>
            </div>
          </div>
        )}
      </div>

      {defaultProvider && (
        <div className="rounded-xl border border-[rgb(var(--color-border))] bg-[rgb(var(--color-surface))] p-3">
          <div className="text-[10px] font-semibold uppercase tracking-wider text-[rgb(var(--color-text-secondary))]">Runtime default</div>
          <div className="mt-1 text-sm text-[rgb(var(--color-text))]">
            {defaultProvider.name} <span className="text-[rgb(var(--color-text-secondary))]">· {defaultProvider.model || "No model selected"}</span>
          </div>
          <p className="mt-1 text-xs text-[rgb(var(--color-text-secondary))]">
            Chat, note cleanup, and agents use this provider unless an agent override is configured.
          </p>
        </div>
      )}

      {/* Provider Selector */}
      <fieldset className="flex flex-col gap-2 rounded-xl border border-[rgb(var(--color-border))] bg-[rgb(var(--color-surface))] p-3">
        <label className="text-sm font-medium">Editing connection type</label>
        <select
          value={familyOf(settings.aiProvider)}
          onChange={(e) => {
            const family = e.target.value as ProviderFamily;
            if (family === "azure") {
              // Default a fresh Azure connection to the recommended Foundry path;
              // keep the current Azure kind when already in the family.
              if (familyOf(settings.aiProvider) !== "azure") {
                updateSetting("aiProvider", "microsoft_foundry");
              }
            } else {
              updateSetting("aiProvider", family);
              updateSetting("aiAuthMode", "api_key");
            }
            setModels([]);
          }}
          className={inputClass}
        >
          {providerFamilies.map((option) => (
            <option key={option.value} value={option.value}>{option.label}</option>
          ))}
        </select>
        {(isAzure || isFoundry) && (
          <p className="text-xs text-[rgb(var(--color-text-secondary))]">
            Azure AI Foundry unifies Foundry resources and Azure OpenAI deployments. Pick the connection method below.
          </p>
        )}
      </fieldset>

      {/* Connection method (Azure family): Foundry resource vs Azure OpenAI endpoint */}
      {(isAzure || isFoundry) && (
        <fieldset className="flex flex-col gap-2">
          <label className="text-sm font-medium">Connection method</label>
          <div className="flex gap-2">
            {([
              { kind: "microsoft_foundry", label: "Foundry resource", hint: "Recommended" },
              { kind: "azure_openai", label: "Azure OpenAI endpoint", hint: "" },
            ] as const).map((method) => (
              <button
                key={method.kind}
                type="button"
                onClick={() => {
                  if (settings.aiProvider === method.kind) return;
                  updateSetting("aiProvider", method.kind);
                  // Both methods live under the Azure AI Foundry umbrella and can
                  // share a services.ai.azure.com endpoint, so preserve the
                  // endpoint (a wrong one surfaces at discovery) and only drop the
                  // method-specific discovered models.
                  setModels([]);
                }}
                className={`flex-1 px-3 py-1.5 rounded-lg text-sm transition-colors border ${
                  settings.aiProvider === method.kind
                    ? "bg-[rgb(var(--color-accent))] text-[rgb(var(--color-accent-fg))] border-[rgb(var(--color-accent))]"
                    : "bg-[rgb(var(--color-surface-alt))] border-[rgb(var(--color-border))] text-[rgb(var(--color-text-secondary))] hover:text-[rgb(var(--color-text))]"
                }`}
              >
                {method.label}
                {method.hint ? <span className="ml-1 text-[10px] opacity-70">({method.hint})</span> : null}
              </button>
            ))}
          </div>
          <p className="text-xs text-[rgb(var(--color-text-secondary))]">
            {isFoundry
              ? "Discover models from an Azure AI Foundry resource (services.ai.azure.com) using Entra sign-in or a key."
              : "Point directly at an Azure OpenAI deployment endpoint (openai.azure.com)."}
          </p>
        </fieldset>
      )}

      {/* Auth Mode (Azure OpenAI + Foundry — both support API Key and Entra) */}
      {(isAzure || isFoundry) && (
        <fieldset className="flex flex-col gap-2">
          <label className="text-sm font-medium">Authentication</label>
          <div className="flex gap-2">
            {(["api_key", "azure_oauth"] as const).map((mode) => (
              <button
                key={mode}
                onClick={() => updateSetting("aiAuthMode", mode)}
                className={`px-3 py-1.5 rounded-lg text-sm transition-colors border ${
                  settings.aiAuthMode === mode
                    ? "bg-[rgb(var(--color-accent))] text-[rgb(var(--color-accent-fg))] border-[rgb(var(--color-accent))]"
                    : "bg-[rgb(var(--color-surface-alt))] border-[rgb(var(--color-border))] text-[rgb(var(--color-text-secondary))] hover:text-[rgb(var(--color-text))]"
                }`}
              >
                {mode === "api_key" ? "API Key" : "Azure Sign-in"}
              </button>
            ))}
          </div>
        </fieldset>
      )}

      {/* Endpoint — hidden for Anthropic. In Foundry OAuth mode the endpoint is
          normally set by the resource picker, but fall back to an editable field
          when it is empty so the user can paste a project endpoint directly
          instead of being stranded. */}
      {!isAnthropic && !(isFoundry && isOAuth && !!settings.aiEndpoint) && (
        <fieldset className="flex flex-col gap-2">
          <label className="text-sm font-medium">
            {(isAzure || isFoundry) ? "Endpoint" : "Endpoint (optional)"}
          </label>
          <input
            type="text"
            value={settings.aiEndpoint}
            onChange={(e) => updateSetting("aiEndpoint", e.target.value)}
            placeholder={
              isFoundry
                ? "https://your-resource.services.ai.azure.com"
                : isAzure
                  ? "https://your-resource.openai.azure.com"
                  : "https://api.openai.com (default)"
            }
            className={inputClass}
          />
          {isFoundry && isOAuth && (
            <p className="text-xs text-[rgb(var(--color-text-secondary))]">
              Paste a Foundry project endpoint, or pick a resource below to set it automatically.
            </p>
          )}
        </fieldset>
      )}

      {/* Foundry endpoint (read-only, set by resource picker — only in OAuth mode) */}
      {isFoundry && isOAuth && settings.aiEndpoint && (
        <fieldset className="flex flex-col gap-2">
          <label className="text-sm font-medium">Endpoint</label>
          <input
            type="text"
            value={settings.aiEndpoint}
            readOnly
            className={inputClass + " opacity-60 cursor-not-allowed"}
          />
          <p className="text-xs text-[rgb(var(--color-text-secondary))]">
            Set automatically from resource selection below.
          </p>
        </fieldset>
      )}

      {/* API Key (OpenAI / Anthropic / Azure+Foundry api_key mode) */}
      {!isOAuth && (
        <fieldset className="flex flex-col gap-2">
          <label className="text-sm font-medium">API Key</label>
          <input
            type="password"
            value={settings.aiApiKey}
            onChange={(e) => updateSetting("aiApiKey", e.target.value)}
            placeholder={isAnthropic ? "sk-ant-..." : "Enter your API key"}
            className={inputClass}
          />
        </fieldset>
      )}

      {/* Azure / Foundry OAuth Flow */}
      {isOAuth && (
        <div className="flex flex-col gap-3">
          {/* Tenant/Client — show for both Azure OAuth and Foundry */}
          <fieldset className="flex flex-col gap-2">
            <label className="text-sm font-medium">
              Tenant ID{" "}
              <span className="text-[rgb(var(--color-text-secondary))] font-normal">
                (optional — defaults to &quot;organizations&quot;)
              </span>
            </label>
            <input
              type="text"
              value={settings.aiTenantId}
              onChange={(e) => updateSetting("aiTenantId", e.target.value)}
              placeholder="organizations"
              className={inputClass}
            />
          </fieldset>

          <fieldset className="flex flex-col gap-2">
            <label className="text-sm font-medium">
              Client ID{" "}
              <span className="text-[rgb(var(--color-text-secondary))] font-normal">
                (optional — defaults to Azure PowerShell)
              </span>
            </label>
            <input
              type="text"
              value={settings.aiClientId}
              onChange={(e) => updateSetting("aiClientId", e.target.value)}
              placeholder="1950a258-227b-4e31-a9cf-717495945fc2"
              className={inputClass}
            />
          </fieldset>

          {hasToken ? (
            <div className="flex items-center gap-3">
              <span className="text-sm text-success font-medium">
                ✓ Signed in
              </span>
              <button
                onClick={signOut}
                className="px-3 py-1.5 rounded-lg border border-[rgb(var(--color-border))] text-sm hover:bg-[rgb(var(--color-surface-alt))] transition-colors"
              >
                Sign out
              </button>
            </div>
          ) : (
            <div className="flex flex-col gap-2">
              <button
                onClick={startOAuthFlow}
                disabled={oauthStatus === "waiting" || oauthStatus === "polling"}
                className="px-4 py-2 rounded-lg bg-[rgb(var(--color-accent))] text-[rgb(var(--color-accent-fg))] text-sm font-medium hover:bg-[rgb(var(--color-accent-hover))] disabled:opacity-50 transition-colors w-fit"
              >
                {oauthStatus === "waiting"
                  ? "Starting…"
                  : oauthStatus === "polling"
                    ? "Waiting for browser sign-in…"
                    : isFoundry
                      ? "Sign in with Microsoft Entra"
                      : "Sign in with Azure"}
              </button>

              {oauthStatus === "polling" && (
                <p className="text-xs text-[rgb(var(--color-text-secondary))]">
                  Complete sign-in in your browser. This page will update automatically.
                </p>
              )}

              {oauthError && (
                <p className="text-xs text-error">{oauthError}</p>
              )}
            </div>
          )}
        </div>
      )}

      {/* Foundry Resource Picker */}
      {isFoundry && hasToken && (
        <FoundryResourcePicker
          settings={settings}
          updateSetting={updateSetting}
        />
      )}

      {/* Model Selection */}
      <fieldset className="flex flex-col gap-2">
        <label className="text-sm font-medium">Model</label>
        <div className="flex gap-2">
          <input
            type="text"
            value={models.length > 0 ? modelFilter : settings.aiModel}
            onChange={(e) => {
              if (models.length > 0) {
                setModelFilter(e.target.value);
              } else {
                updateSetting("aiModel", e.target.value);
                updateSetting("aiModelReasoningEfforts", "");
              }
            }}
            placeholder={models.length > 0 ? "Filter models…" : (isAnthropic ? "claude-sonnet-4-6" : "gpt-4o")}
            className={inputClass + " flex-1"}
          />
          <button
            onClick={() => {
              if (models.length > 0) {
                setModels([]);
                setModelFilter("");
              } else {
                fetchModels();
              }
            }}
            disabled={loadingModels || (!canFetchModels && models.length === 0)}
            className="px-3 py-2 rounded-lg border border-[rgb(var(--color-border))] bg-[rgb(var(--color-surface-alt))] text-sm text-[rgb(var(--color-text-secondary))] hover:text-[rgb(var(--color-text))] hover:border-[rgb(var(--color-accent))]/40 disabled:opacity-40 transition-colors"
            title={models.length > 0 ? "Clear list" : "Fetch available models"}
          >
            {loadingModels ? (
              <svg className="w-4 h-4 animate-spin" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                <path d="M12 2v4m0 12v4m-7.07-3.93l2.83-2.83m8.48-8.48l2.83-2.83M2 12h4m12 0h4M4.93 4.93l2.83 2.83m8.48 8.48l2.83 2.83" />
              </svg>
            ) : models.length > 0 ? (
              <X className="w-4 h-4" />
            ) : (
              <RefreshCw className="w-4 h-4" />
            )}
          </button>
        </div>
        {models.length > 0 && (
          <div className="max-h-48 overflow-y-auto rounded-lg border border-[rgb(var(--color-border))] bg-[rgb(var(--color-surface-alt))]">
            {models
              .filter((m) =>
                m.id.toLowerCase().includes(modelFilter.toLowerCase())
              )
              .map((m) => (
                <button
                  key={m.id}
                  onClick={() => {
                    updateSetting("aiModel", m.id);
                    if (m.context_length) {
                      updateSetting("aiContextLength", m.context_length);
                    }
                    // Track vision capability for the selected model
                    updateSetting("aiModelSupportsVision", m.capabilities?.vision === "true" ? "true" : "false");
                    updateSetting("aiModelReasoningEfforts", m.capabilities?.reasoning_efforts ?? "");
                    setModels([]);
                    setModelFilter("");
                  }}
                  className={`w-full text-left px-3 py-1.5 text-sm hover:bg-[rgb(var(--color-accent))]/10 transition-colors ${
                    settings.aiModel === m.id
                      ? "text-[rgb(var(--color-accent))] font-medium"
                      : "text-[rgb(var(--color-text))]"
                  }`}
                >
                  {m.id}
                  <span className="ml-2 text-[10px] text-[rgb(var(--color-text-secondary))]">
                    {m.context_length ? `${Math.round(m.context_length / 1000)}k ctx` : "ctx ?"}
                    {m.capabilities?.vision === "true" ? " · vision" : ""}
                    {m.capabilities?.responses_api === "true" ? " · responses" : ""}
                    {m.capabilities?.reasoning_effort === "true" ? " · reasoning" : ""}
                  </span>
                </button>
              ))}
          </div>
        )}
        {settings.aiModel && models.length === 0 && (
          <p className="text-xs text-[rgb(var(--color-text-secondary))]">
            Selected: <span className="font-medium">{settings.aiModel}</span>
          </p>
        )}
        {modelError && (
          <p className="text-xs text-error">{modelError}</p>
        )}
      </fieldset>

      {reasoningEfforts.length > 0 && (
        <fieldset className="flex flex-col gap-2">
          <label className="flex items-center gap-2 text-sm font-medium">
            <Brain className="h-4 w-4 text-[rgb(var(--color-accent))]" />
            Reasoning effort
          </label>
          <select
            value={effectiveReasoningEffort}
            onChange={(event) => updateSetting("aiReasoningEffort", event.target.value as AiReasoningEffort)}
            className="bg-[rgb(var(--color-surface))] border border-[rgb(var(--color-border))] rounded px-3 py-1.5 text-sm"
          >
            <option value="">Default — let the model decide</option>
            {reasoningEfforts.map((effort) => (
              <option key={effort} value={effort}>
                {effort === "xhigh" ? "X-high" : effort[0].toUpperCase() + effort.slice(1)}
              </option>
            ))}
          </select>
          <p className="text-xs text-[rgb(var(--color-text-secondary))]">
            Applies to reasoning-capable OpenAI-compatible models. Higher effort can improve hard planning but may take longer.
          </p>
        </fieldset>
      )}

      {/* Vision Mode */}
      <fieldset className="flex flex-col gap-2">
        <label className="text-sm font-medium">Image Vision</label>
        <select
          value={settings.aiVisionMode || "notes_and_sketches"}
          onChange={(e) => updateSetting("aiVisionMode", e.target.value as "off" | "notes" | "notes_and_sketches")}
          className="bg-[rgb(var(--color-surface))] border border-[rgb(var(--color-border))] rounded px-3 py-1.5 text-sm"
        >
          <option value="off">Off — text only</option>
          <option value="notes">Notes only — images in markdown notes</option>
          <option value="notes_and_sketches">Notes + Sketches — all workspace images</option>
        </select>
        <p className="text-xs text-[rgb(var(--color-text-secondary))]">
          When enabled and the model supports vision, images referenced in notes and sketches are sent to the AI.
        </p>
        {settings.aiModelSupportsVision === "false" && settings.aiVisionMode && settings.aiVisionMode !== "off" && (
          <p className="text-xs text-warning">
            ⚠ The selected model does not support vision — images will be ignored.
          </p>
        )}
      </fieldset>

      <fieldset className="flex flex-col gap-2">
        <label className="text-sm font-medium">Internet Search</label>
        <select
          value={settings.aiWebAccess || "disabled"}
          onChange={(e) => updateSetting("aiWebAccess", e.target.value as "disabled" | "enabled")}
          className="bg-[rgb(var(--color-surface))] border border-[rgb(var(--color-border))] rounded px-3 py-1.5 text-sm"
        >
          <option value="disabled">Disabled — no public web search tool</option>
          <option value="enabled">Enabled — agents may search when requested</option>
        </select>
        <p className="text-xs text-[rgb(var(--color-text-secondary))]">
          When enabled, agents can call a web search tool for current public information. Project content is not sent unless you explicitly ask for it.
        </p>
      </fieldset>

      <fieldset className="flex flex-col gap-2">
        <label className="text-sm font-medium">Maximum tool rounds</label>
        <input
          type="number"
          min={1}
          max={200}
          step={1}
          value={settings.aiMaxToolRounds || 50}
          onChange={(event) => {
            const next = Math.max(1, Math.min(200, Number(event.target.value) || 50));
            void updateSetting("aiMaxToolRounds", next);
          }}
          className={inputClass}
        />
        <p className="text-xs text-[rgb(var(--color-text-secondary))]">
          Limits agent tool-call rounds before CutReady stops a runaway loop. Higher values help long editing sessions that need many read/write/review cycles.
        </p>
      </fieldset>
    </div>
  );
}

// ── Agents Tab ───────────────────────────────────────────────────

/** Per-concern ownership stance a harness declares (mirrors the backend enum). */