import { useState } from "react";
import { useSettings } from "../hooks/useSettings";
import { invoke } from "@tauri-apps/api/core";
import { open as shellOpen } from "@tauri-apps/plugin-shell";

interface ModelInfo {
  id: string;
  created?: number;
  owned_by?: string;
}

interface TokenResponse {
  access_token: string;
  token_type: string;
  expires_in: number;
  refresh_token?: string;
}

interface AuthCodeFlowInit {
  auth_url: string;
  port: number;
}

const inputClass =
  "px-3 py-2 rounded-lg bg-[var(--color-surface-alt)] border border-[var(--color-border)] text-sm text-[var(--color-text)] placeholder:text-[var(--color-text-secondary)]/50 focus:outline-none focus:ring-2 focus:ring-[var(--color-accent)]/40";

export function SettingsPanel() {
  const { settings, updateSetting, loaded } = useSettings();
  const [models, setModels] = useState<ModelInfo[]>([]);
  const [loadingModels, setLoadingModels] = useState(false);
  const [modelError, setModelError] = useState("");
  const [modelFilter, setModelFilter] = useState("");

  // OAuth flow state
  const [oauthStatus, setOauthStatus] = useState<"idle" | "waiting" | "polling" | "success" | "error">("idle");
  const [oauthError, setOauthError] = useState("");

  const buildConfig = () => ({
    provider: settings.aiProvider,
    endpoint: settings.aiEndpoint,
    api_key: settings.aiApiKey,
    model: settings.aiModel || "unused",
    bearer_token:
      settings.aiAuthMode === "azure_oauth" ? settings.aiAccessToken : null,
  });

  const fetchModels = async () => {
    setLoadingModels(true);
    setModelError("");
    try {
      const result = await invoke<ModelInfo[]>("list_models", {
        config: buildConfig(),
      });
      setModels(result);
    } catch (e) {
      setModelError(String(e));
    } finally {
      setLoadingModels(false);
    }
  };

  const startOAuthFlow = async () => {
    setOauthStatus("waiting");
    setOauthError("");
    try {
      // Start browser-based auth code + PKCE flow
      const init = await invoke<AuthCodeFlowInit>("azure_browser_auth_start", {
        tenantId: settings.aiTenantId || "",
        clientId: settings.aiClientId || null,
      });
      // Open the browser to the auth URL
      try {
        await shellOpen(init.auth_url);
      } catch {
        // Fallback: user can still copy/paste the URL
      }
      setOauthStatus("polling");
      // Wait for the browser callback (blocks until redirect or timeout)
      const token = await invoke<TokenResponse>("azure_browser_auth_complete", {
        tenantId: settings.aiTenantId || "",
        clientId: settings.aiClientId || null,
        timeout: 300,
      });
      // Store tokens
      await updateSetting("aiAccessToken", token.access_token);
      if (token.refresh_token) {
        await updateSetting("aiRefreshToken", token.refresh_token);
      }
      setOauthStatus("success");
    } catch (e) {
      setOauthError(String(e));
      setOauthStatus("error");
    }
  };

  const signOut = async () => {
    await updateSetting("aiAccessToken", "");
    await updateSetting("aiRefreshToken", "");
    setOauthStatus("idle");
  };

  if (!loaded) {
    return (
      <div className="flex items-center justify-center h-full text-[var(--color-text-secondary)]">
        Loading settings...
      </div>
    );
  }

  const isAzure = settings.aiProvider === "azure_openai";
  const isOAuth = isAzure && settings.aiAuthMode === "azure_oauth";
  const hasToken = !!settings.aiAccessToken;
  const canFetchModels = isOAuth ? hasToken : !!settings.aiApiKey;

  return (
    <div className="max-w-xl mx-auto px-6 py-10">
      <h1 className="text-2xl font-semibold tracking-tight mb-2">Settings</h1>
      <p className="text-sm text-[var(--color-text-secondary)] mb-8">
        Configure CutReady preferences.
      </p>

      <div className="flex flex-col gap-6">
        {/* Output Directory */}
        <fieldset className="flex flex-col gap-2">
          <label className="text-sm font-medium">Output Directory</label>
          <input
            type="text"
            value={settings.outputDirectory}
            onChange={(e) => updateSetting("outputDirectory", e.target.value)}
            placeholder="~/Documents/CutReady/output"
            className={inputClass}
          />
          <p className="text-xs text-[var(--color-text-secondary)]">
            Where exported packages will be saved.
          </p>
        </fieldset>

        {/* AI Provider Section */}
        <div className="border border-[var(--color-border)] rounded-xl p-4 flex flex-col gap-4">
          <h2 className="text-sm font-semibold uppercase tracking-wider text-[var(--color-text-secondary)]">
            AI Provider
          </h2>

          {/* Provider Selector */}
          <fieldset className="flex flex-col gap-2">
            <label className="text-sm font-medium">Provider</label>
            <select
              value={settings.aiProvider}
              onChange={(e) => {
                updateSetting("aiProvider", e.target.value);
                setModels([]);
                if (e.target.value !== "azure_openai") {
                  updateSetting("aiAuthMode", "api_key");
                }
              }}
              className={inputClass}
            >
              <option value="azure_openai">Azure OpenAI</option>
              <option value="openai">OpenAI</option>
            </select>
          </fieldset>

          {/* Endpoint (Azure always, OpenAI optional) */}
          <fieldset className="flex flex-col gap-2">
            <label className="text-sm font-medium">
              {isAzure ? "Endpoint" : "Endpoint (optional)"}
            </label>
            <input
              type="text"
              value={settings.aiEndpoint}
              onChange={(e) => updateSetting("aiEndpoint", e.target.value)}
              placeholder={
                isAzure
                  ? "https://your-resource.openai.azure.com"
                  : "https://api.openai.com (default)"
              }
              className={inputClass}
            />
          </fieldset>

          {/* Auth Mode (Azure only) */}
          {isAzure && (
            <fieldset className="flex flex-col gap-2">
              <label className="text-sm font-medium">Authentication</label>
              <select
                value={settings.aiAuthMode}
                onChange={(e) => updateSetting("aiAuthMode", e.target.value)}
                className={inputClass}
              >
                <option value="api_key">API Key</option>
                <option value="azure_oauth">Sign in with Azure (Entra ID)</option>
              </select>
            </fieldset>
          )}

          {/* API Key (when using api_key mode or OpenAI) */}
          {!isOAuth && (
            <fieldset className="flex flex-col gap-2">
              <label className="text-sm font-medium">API Key</label>
              <input
                type="password"
                value={settings.aiApiKey}
                onChange={(e) => updateSetting("aiApiKey", e.target.value)}
                placeholder="Enter your API key"
                className={inputClass}
              />
            </fieldset>
          )}

          {/* Azure OAuth Flow */}
          {isOAuth && (
            <div className="flex flex-col gap-3">
              {/* Tenant ID */}
              <fieldset className="flex flex-col gap-2">
                <label className="text-sm font-medium">
                  Tenant ID{" "}
                  <span className="text-[var(--color-text-secondary)] font-normal">
                    (optional — defaults to "organizations")
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

              {/* Client ID (advanced) */}
              <fieldset className="flex flex-col gap-2">
                <label className="text-sm font-medium">
                  Client ID{" "}
                  <span className="text-[var(--color-text-secondary)] font-normal">
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

              {/* Sign in / Status */}
              {hasToken ? (
                <div className="flex items-center gap-3">
                  <span className="text-sm text-green-600 dark:text-green-400 font-medium">
                    ✓ Signed in
                  </span>
                  <button
                    onClick={signOut}
                    className="px-3 py-1.5 rounded-lg border border-[var(--color-border)] text-sm hover:bg-[var(--color-surface-alt)] transition-colors"
                  >
                    Sign out
                  </button>
                </div>
              ) : (
                <div className="flex flex-col gap-2">
                  <button
                    onClick={startOAuthFlow}
                    disabled={oauthStatus === "waiting" || oauthStatus === "polling"}
                    className="px-4 py-2 rounded-lg bg-[#0078d4] text-white text-sm font-medium hover:bg-[#106ebe] disabled:opacity-50 transition-colors w-fit"
                  >
                    {oauthStatus === "waiting"
                      ? "Starting…"
                      : oauthStatus === "polling"
                        ? "Waiting for browser sign-in…"
                        : "Sign in with Azure"}
                  </button>

                  {oauthStatus === "polling" && (
                    <p className="text-xs text-[var(--color-text-secondary)]">
                      Complete sign-in in your browser. This page will update automatically.
                    </p>
                  )}

                  {oauthError && (
                    <p className="text-xs text-red-500">{oauthError}</p>
                  )}
                </div>
              )}
            </div>
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
                  }
                }}
                placeholder={models.length > 0 ? "Filter models…" : (isAzure ? "gpt-4o" : "gpt-4o")}
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
                className="px-3 py-2 rounded-lg bg-[var(--color-accent)] text-white text-sm font-medium hover:opacity-90 disabled:opacity-40 transition-opacity"
                title={models.length > 0 ? "Clear list" : "Fetch available models"}
              >
                {loadingModels ? "…" : models.length > 0 ? "✕" : "🔄"}
              </button>
            </div>
            {models.length > 0 && (
              <div className="max-h-48 overflow-y-auto rounded-lg border border-[var(--color-border)] bg-[var(--color-surface-alt)]">
                {models
                  .filter((m) =>
                    m.id.toLowerCase().includes(modelFilter.toLowerCase())
                  )
                  .map((m) => (
                    <button
                      key={m.id}
                      onClick={() => {
                        updateSetting("aiModel", m.id);
                        setModels([]);
                        setModelFilter("");
                      }}
                      className={`w-full text-left px-3 py-1.5 text-sm hover:bg-[var(--color-accent)]/10 transition-colors ${
                        settings.aiModel === m.id
                          ? "text-[var(--color-accent)] font-medium"
                          : "text-[var(--color-text)]"
                      }`}
                    >
                      {m.id}
                    </button>
                  ))}
              </div>
            )}
            {settings.aiModel && models.length === 0 && (
              <p className="text-xs text-[var(--color-text-secondary)]">
                Selected: <span className="font-medium">{settings.aiModel}</span>
              </p>
            )}
            {modelError && (
              <p className="text-xs text-red-500">{modelError}</p>
            )}
          </fieldset>
        </div>

        {/* Audio Device */}
        <fieldset className="flex flex-col gap-2">
          <label className="text-sm font-medium">Audio Input Device</label>
          <input
            type="text"
            value={settings.audioDevice}
            onChange={(e) => updateSetting("audioDevice", e.target.value)}
            placeholder="Microphone (USB Audio)"
            className={inputClass}
          />
          <p className="text-xs text-[var(--color-text-secondary)]">
            Device name for narration recording. Audio device enumeration will
            be available in a future update.
          </p>
        </fieldset>
      </div>
    </div>
  );
}
