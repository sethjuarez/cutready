import { useSettings } from "../hooks/useSettings";

export function SettingsPanel() {
  const { settings, updateSetting, loaded } = useSettings();

  if (!loaded) {
    return (
      <div className="flex items-center justify-center h-full text-[var(--color-text-secondary)]">
        Loading settings...
      </div>
    );
  }

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
            className="px-3 py-2 rounded-lg bg-[var(--color-surface-alt)] border border-[var(--color-border)] text-sm text-[var(--color-text)] placeholder:text-[var(--color-text-secondary)]/50 focus:outline-none focus:ring-2 focus:ring-[var(--color-accent)]/40"
          />
          <p className="text-xs text-[var(--color-text-secondary)]">
            Where exported packages will be saved.
          </p>
        </fieldset>

        {/* LLM API Key */}
        <fieldset className="flex flex-col gap-2">
          <label className="text-sm font-medium">Azure OpenAI API Key</label>
          <input
            type="password"
            value={settings.llmApiKey}
            onChange={(e) => updateSetting("llmApiKey", e.target.value)}
            placeholder="Enter your API key"
            className="px-3 py-2 rounded-lg bg-[var(--color-surface-alt)] border border-[var(--color-border)] text-sm text-[var(--color-text)] placeholder:text-[var(--color-text-secondary)]/50 focus:outline-none focus:ring-2 focus:ring-[var(--color-accent)]/40"
          />
        </fieldset>

        {/* LLM Endpoint */}
        <fieldset className="flex flex-col gap-2">
          <label className="text-sm font-medium">Azure OpenAI Endpoint</label>
          <input
            type="text"
            value={settings.llmEndpoint}
            onChange={(e) => updateSetting("llmEndpoint", e.target.value)}
            placeholder="https://your-resource.openai.azure.com"
            className="px-3 py-2 rounded-lg bg-[var(--color-surface-alt)] border border-[var(--color-border)] text-sm text-[var(--color-text)] placeholder:text-[var(--color-text-secondary)]/50 focus:outline-none focus:ring-2 focus:ring-[var(--color-accent)]/40"
          />
        </fieldset>

        {/* LLM Deployment */}
        <fieldset className="flex flex-col gap-2">
          <label className="text-sm font-medium">Deployment Name</label>
          <input
            type="text"
            value={settings.llmDeployment}
            onChange={(e) => updateSetting("llmDeployment", e.target.value)}
            placeholder="gpt-4o"
            className="px-3 py-2 rounded-lg bg-[var(--color-surface-alt)] border border-[var(--color-border)] text-sm text-[var(--color-text)] placeholder:text-[var(--color-text-secondary)]/50 focus:outline-none focus:ring-2 focus:ring-[var(--color-accent)]/40"
          />
        </fieldset>

        {/* Audio Device */}
        <fieldset className="flex flex-col gap-2">
          <label className="text-sm font-medium">Audio Input Device</label>
          <input
            type="text"
            value={settings.audioDevice}
            onChange={(e) => updateSetting("audioDevice", e.target.value)}
            placeholder="Microphone (USB Audio)"
            className="px-3 py-2 rounded-lg bg-[var(--color-surface-alt)] border border-[var(--color-border)] text-sm text-[var(--color-text)] placeholder:text-[var(--color-text-secondary)]/50 focus:outline-none focus:ring-2 focus:ring-[var(--color-accent)]/40"
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

