import { useState } from "react";
import { useSettings } from "../hooks/useSettings";
import { invoke } from "@tauri-apps/api/core";

interface ModelInfo {
  id: string;
  created?: number;
  owned_by?: string;
}

const inputClass =
  "px-3 py-2 rounded-lg bg-[var(--color-surface-alt)] border border-[var(--color-border)] text-sm text-[var(--color-text)] placeholder:text-[var(--color-text-secondary)]/50 focus:outline-none focus:ring-2 focus:ring-[var(--color-accent)]/40";

export function SettingsPanel() {
  const { settings, updateSetting, loaded } = useSettings();
  const [models, setModels] = useState<ModelInfo[]>([]);
  const [loadingModels, setLoadingModels] = useState(false);
  const [modelError, setModelError] = useState("");

  const fetchModels = async () => {
    setLoadingModels(true);
    setModelError("");
    try {
      const result = await invoke<ModelInfo[]>("list_models", {
        config: {
          provider: settings.aiProvider,
          endpoint: settings.aiEndpoint,
          api_key: settings.aiApiKey,
          model: settings.aiModel || "unused",
        },
      });
      setModels(result);
    } catch (e) {
      setModelError(String(e));
    } finally {
      setLoadingModels(false);
    }
  };

  if (!loaded) {
    return (
      <div className="flex items-center justify-center h-full text-[var(--color-text-secondary)]">
        Loading settings...
      </div>
    );
  }

  const isAzure = settings.aiProvider === "azure_openai";

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

          {/* API Key */}
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

          {/* Model Selection */}
          <fieldset className="flex flex-col gap-2">
            <label className="text-sm font-medium">Model</label>
            <div className="flex gap-2">
              {models.length > 0 ? (
                <select
                  value={settings.aiModel}
                  onChange={(e) => updateSetting("aiModel", e.target.value)}
                  className={inputClass + " flex-1"}
                >
                  <option value="">Select a model…</option>
                  {models.map((m) => (
                    <option key={m.id} value={m.id}>
                      {m.id}
                    </option>
                  ))}
                </select>
              ) : (
                <input
                  type="text"
                  value={settings.aiModel}
                  onChange={(e) => updateSetting("aiModel", e.target.value)}
                  placeholder={isAzure ? "gpt-4o" : "gpt-4o"}
                  className={inputClass + " flex-1"}
                />
              )}
              <button
                onClick={fetchModels}
                disabled={loadingModels || !settings.aiApiKey}
                className="px-3 py-2 rounded-lg bg-[var(--color-accent)] text-white text-sm font-medium hover:opacity-90 disabled:opacity-40 transition-opacity"
                title="Fetch available models"
              >
                {loadingModels ? "…" : "🔄"}
              </button>
            </div>
            {modelError && (
              <p className="text-xs text-red-500">{modelError}</p>
            )}
            <p className="text-xs text-[var(--color-text-secondary)]">
              Enter a model name or click 🔄 to fetch available models.
            </p>
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
