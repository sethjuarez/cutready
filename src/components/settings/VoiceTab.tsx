import { useCallback, useEffect, useRef, useState } from "react";
import { convertFileSrc, invoke } from "../../services/tauri";
import { useSettings } from "../../hooks/useSettings";
import { useToastStore } from "../../stores/toastStore";
import { createAiProviderConfig } from "../../utils/providerConfig";
import { ensureCachedNarrationVoicePreview, NARRATION_VOICE_SAMPLE } from "../../services/narrationVoicePreview";
import { inputClass } from "../../styles";

const NARRATION_VOICE_OPTIONS = [
  { value: "en-US-Harper:MAI-Voice-2", label: "Harper (MAI Voice 2)", description: "Expressive presenter voice for polished demos." },
  { value: "en-US-AvaMultilingualNeural", label: "Ava Multilingual Neural", description: "Warm, clear, general-purpose narration." },
  { value: "en-US-AndrewMultilingualNeural", label: "Andrew Multilingual Neural", description: "Calm, professional male narration." },
  { value: "en-US-EmmaMultilingualNeural", label: "Emma Multilingual Neural", description: "Friendly, concise presenter voice." },
  { value: "en-US-BrianMultilingualNeural", label: "Brian Multilingual Neural", description: "Measured, technical walkthrough voice." },
] as const;
const NARRATION_OUTPUT_FORMAT_OPTIONS = [
  { value: "riff-24khz-16bit-mono-pcm", label: "WAV, 24 kHz, 16-bit mono", description: "Best edit-friendly default." },
  { value: "riff-48khz-16bit-mono-pcm", label: "WAV, 48 kHz, 16-bit mono", description: "Video timeline friendly." },
  { value: "audio-24khz-160kbitrate-mono-mp3", label: "MP3, 24 kHz, 160 kbps mono", description: "Smaller preview files." },
  { value: "audio-48khz-192kbitrate-mono-mp3", label: "MP3, 48 kHz, 192 kbps mono", description: "Compact high-rate export audio." },
] as const;

export function VoiceTab({
  settings,
  updateSetting,
}: {
  settings: ReturnType<typeof useSettings>["settings"];
  updateSetting: ReturnType<typeof useSettings>["updateSetting"];
}) {
  const [voicePreviewPath, setVoicePreviewPath] = useState<string | null>(null);
  const [generatingVoicePreview, setGeneratingVoicePreview] = useState(false);
  const voicePreviewAudioRef = useRef<HTMLAudioElement>(null);
  const playGeneratedVoicePreview = useRef(false);

  const providers = settings.aiProviders ?? [];
  const activeFoundryProvider = providers.find((provider) =>
    provider.id === settings.aiActiveProviderId &&
    (provider.provider === "microsoft_foundry" || provider.provider === "azure_openai") &&
    provider.endpoint
  );
  const narrationProviders = providers.filter((provider) =>
    (provider.provider === "microsoft_foundry" || provider.provider === "azure_openai") && provider.endpoint
  );
  const selectedNarrationProvider =
    narrationProviders.find((provider) => provider.id === settings.narrationProviderId)
    ?? narrationProviders[0]
    ?? null;
  const addNarrationProvider = async () => {
    const next = {
      ...createAiProviderConfig("microsoft_foundry", providers.length + 1),
      name: `Narration Foundry${providers.length > 0 ? ` ${providers.length + 1}` : ""}`,
      authMode: "azure_oauth" as const,
    };
    await updateSetting("aiProviders", [...providers, next]);
    await updateSetting("narrationConnectionMode", "dedicated");
    await updateSetting("narrationProviderId", next.id);
    useToastStore.getState().show("Narration connection added. Select it in Connections to sign in and choose its Foundry resource.", 5000, "info");
  };

  const loadCachedVoicePreview = useCallback(async () => {
    try {
      const path = await invoke<string | null>("get_narration_voice_preview", {
        voiceName: settings.narrationVoiceName,
        outputFormat: settings.narrationSpeechOutputFormat,
      });
      setVoicePreviewPath(path);
    } catch (err) {
      console.warn("[SettingsPanel] Failed to load narration voice preview:", err);
      setVoicePreviewPath(null);
    }
  }, [settings.narrationSpeechOutputFormat, settings.narrationVoiceName]);

  useEffect(() => {
    void loadCachedVoicePreview();
  }, [loadCachedVoicePreview]);

  useEffect(() => {
    if (!voicePreviewPath || !playGeneratedVoicePreview.current) return;
    playGeneratedVoicePreview.current = false;
    void voicePreviewAudioRef.current?.play().catch((err) => {
      useToastStore.getState().show(`Could not play voice sample: ${err}`, 5000, "error");
    });
  }, [voicePreviewPath]);

  const generateVoicePreview = async (playAfterGeneration = false) => {
    setGeneratingVoicePreview(true);
    try {
      const { path } = await ensureCachedNarrationVoicePreview({
        settings,
        updateSetting,
        force: true,
      });
      playGeneratedVoicePreview.current = playAfterGeneration;
      setVoicePreviewPath(path);
      useToastStore.getState().show("Voice sample generated and saved for this app.", 3500, "success");
    } catch (err) {
      useToastStore.getState().show(`Could not generate voice sample: ${err}`, 6000, "error");
    } finally {
      setGeneratingVoicePreview(false);
    }
  };

  const playVoicePreview = () => {
    if (!voicePreviewPath) {
      void generateVoicePreview(true);
      return;
    }
    void voicePreviewAudioRef.current?.play().catch((err) => {
      useToastStore.getState().show(`Could not play voice sample: ${err}`, 5000, "error");
    });
  };

  return (
    <div className="flex flex-col gap-6">
      <p className="text-xs text-[rgb(var(--color-text-secondary))]">
        Generate spoken narration from your script using an Azure Speech voice, bound to a Foundry or Azure OpenAI connection.
      </p>

      <fieldset className="flex flex-col gap-3 rounded-xl border border-[rgb(var(--color-border))] bg-[rgb(var(--color-surface-alt))]/40 p-4">
        <div>
          <label className="text-sm font-medium">Generated narration</label>
          <p className="mt-1 text-xs text-[rgb(var(--color-text-secondary))]">
            Choose whether speech synthesis reuses the current Foundry/Azure connection or gets its own connection.
          </p>
        </div>

        <div className="grid gap-2 md:grid-cols-2">
          <button
            type="button"
            disabled={!activeFoundryProvider}
            onClick={() => updateSetting("narrationConnectionMode", "reuse_active_foundry")}
            className={`rounded-lg border px-3 py-2.5 text-left transition-colors ${
              settings.narrationConnectionMode === "reuse_active_foundry"
                ? "border-[rgb(var(--color-accent))] bg-[rgb(var(--color-accent))]/10"
                : "border-[rgb(var(--color-border))] bg-[rgb(var(--color-surface))] hover:border-[rgb(var(--color-border-strong))]"
            } disabled:cursor-not-allowed disabled:opacity-60`}
          >
            <span className="block text-xs font-semibold text-[rgb(var(--color-text))]">Reuse current Foundry connection</span>
            <span className="mt-1 block text-[11px] leading-4 text-[rgb(var(--color-text-secondary))]">
              {activeFoundryProvider
                ? `${activeFoundryProvider.name} (${activeFoundryProvider.resourceName || activeFoundryProvider.endpoint})`
                : "Set up and select a Foundry or Azure OpenAI provider first."}
            </span>
          </button>
          <button
            type="button"
            onClick={() => {
              void updateSetting("narrationConnectionMode", "dedicated");
              if (!settings.narrationProviderId && selectedNarrationProvider) {
                void updateSetting("narrationProviderId", selectedNarrationProvider.id);
              }
            }}
            className={`rounded-lg border px-3 py-2.5 text-left transition-colors ${
              settings.narrationConnectionMode === "dedicated"
                ? "border-[rgb(var(--color-accent))] bg-[rgb(var(--color-accent))]/10"
                : "border-[rgb(var(--color-border))] bg-[rgb(var(--color-surface))] hover:border-[rgb(var(--color-border-strong))]"
            }`}
          >
            <span className="block text-xs font-semibold text-[rgb(var(--color-text))]">Use a narration connection</span>
            <span className="mt-1 block text-[11px] leading-4 text-[rgb(var(--color-text-secondary))]">
              Select or create a Foundry/Azure connection just for generated narration.
            </span>
          </button>
        </div>

        {settings.narrationConnectionMode === "dedicated" && (
          <div className="rounded-lg border border-[rgb(var(--color-border))] bg-[rgb(var(--color-surface))] px-3 py-2.5">
            <div className="flex flex-col gap-3 md:flex-row md:items-center">
              <label className="flex-1">
                <span className="block text-xs font-semibold text-[rgb(var(--color-text))]">Narration connection</span>
                <span className="mt-0.5 block text-[11px] leading-4 text-[rgb(var(--color-text-secondary))]">
                  Pick an existing Foundry/Azure provider. Its selected resource is used to derive the Speech endpoint.
                </span>
                <select
                  value={settings.narrationProviderId || selectedNarrationProvider?.id || ""}
                  onChange={(event) => updateSetting("narrationProviderId", event.target.value)}
                  className={`${inputClass} mt-2 w-full`}
                >
                  <option value="">Select a Foundry/Azure provider</option>
                  {narrationProviders.map((provider) => (
                    <option key={provider.id} value={provider.id}>
                      {provider.name} ({provider.resourceName || provider.endpoint})
                    </option>
                  ))}
                </select>
              </label>
              <button
                type="button"
                onClick={() => void addNarrationProvider()}
                className="rounded-lg border border-[rgb(var(--color-border))] bg-[rgb(var(--color-surface-alt))] px-3 py-2 text-xs font-medium text-[rgb(var(--color-text))] transition-colors hover:border-[rgb(var(--color-border-strong))]"
              >
                Create narration connection
              </button>
            </div>
            <p className="mt-2 text-[11px] leading-4 text-[rgb(var(--color-text-secondary))]">
              New narration connections are configured in Connections so endpoint, sign-in, and selected resource stay in one place.
            </p>
          </div>
        )}

        <div className="grid gap-2">
          <label className="grid gap-3 rounded-lg border border-[rgb(var(--color-border))] bg-[rgb(var(--color-surface))] px-3 py-2.5 md:grid-cols-[minmax(0,1fr)_18rem] md:items-start">
            <span className="min-w-0">
              <span className="block text-xs font-semibold text-[rgb(var(--color-text))]">Voice</span>
              <span className="mt-0.5 block text-[11px] leading-4 text-[rgb(var(--color-text-secondary))]">
                {NARRATION_VOICE_OPTIONS.find((voice) => voice.value === settings.narrationVoiceName)?.description ?? "Azure Speech voice used in generated SSML."}
              </span>
            </span>
            <select
              value={settings.narrationVoiceName}
              onChange={(event) => updateSetting("narrationVoiceName", event.target.value)}
              className={`${inputClass} min-w-0`}
            >
              {NARRATION_VOICE_OPTIONS.map((voice) => (
                <option key={voice.value} value={voice.value}>{voice.label}</option>
              ))}
            </select>
          </label>
          <div className="rounded-lg border border-[rgb(var(--color-border))] bg-[rgb(var(--color-surface))] px-3 py-2.5">
            <div className="flex flex-col gap-3 md:flex-row md:items-center md:justify-between">
              <span className="min-w-0">
                <span className="block text-xs font-semibold text-[rgb(var(--color-text))]">Voice sample</span>
                <span className="mt-0.5 block text-[11px] leading-4 text-[rgb(var(--color-text-secondary))]">
                  “{NARRATION_VOICE_SAMPLE}”
                </span>
              </span>
              <button
                type="button"
                onClick={playVoicePreview}
                disabled={generatingVoicePreview}
                className="inline-flex shrink-0 items-center justify-center rounded-lg border border-[rgb(var(--color-border))] bg-[rgb(var(--color-surface-alt))] px-3 py-2 text-xs font-medium text-[rgb(var(--color-text))] transition-colors hover:border-[rgb(var(--color-accent))] disabled:cursor-not-allowed disabled:opacity-60"
              >
                {generatingVoicePreview ? "Generating..." : voicePreviewPath ? "Play sample" : "Generate & play"}
              </button>
            </div>
            {voicePreviewPath ? (
              <div className="mt-3 flex flex-col gap-2">
                <audio ref={voicePreviewAudioRef} controls preload="metadata" src={convertFileSrc(voicePreviewPath)} className="h-8 w-full" />
                <button
                  type="button"
                  onClick={() => void generateVoicePreview()}
                  disabled={generatingVoicePreview}
                  className="self-start text-[11px] font-medium text-[rgb(var(--color-accent))] transition-colors hover:text-[rgb(var(--color-accent-hover))] disabled:cursor-not-allowed disabled:opacity-60"
                >
                  Refresh saved sample
                </button>
              </div>
            ) : (
              <p className="mt-3 text-[11px] leading-4 text-[rgb(var(--color-text-secondary))]">
                Generate this voice once; CutReady saves it locally and reuses it until you refresh it.
              </p>
            )}
          </div>
          <label className="grid gap-3 rounded-lg border border-[rgb(var(--color-border))] bg-[rgb(var(--color-surface))] px-3 py-2.5 md:grid-cols-[minmax(0,1fr)_18rem] md:items-start">
            <span className="min-w-0">
              <span className="block text-xs font-semibold text-[rgb(var(--color-text))]">Speech output format</span>
              <span className="mt-0.5 block text-[11px] leading-4 text-[rgb(var(--color-text-secondary))]">
                {NARRATION_OUTPUT_FORMAT_OPTIONS.find((format) => format.value === settings.narrationSpeechOutputFormat)?.description ?? "Azure Speech audio format sent to the TTS endpoint."}
              </span>
            </span>
            <select
              value={settings.narrationSpeechOutputFormat}
              onChange={(event) => updateSetting("narrationSpeechOutputFormat", event.target.value)}
              className={`${inputClass} min-w-0`}
            >
              {NARRATION_OUTPUT_FORMAT_OPTIONS.map((format) => (
                <option key={format.value} value={format.value}>{format.label}</option>
              ))}
            </select>
          </label>
        </div>
        <label className="rounded-lg border border-[rgb(var(--color-border))] bg-[rgb(var(--color-surface))] px-3 py-2.5">
          <span className="block text-xs font-semibold text-[rgb(var(--color-text))]">Narration style direction</span>
          <span className="mt-0.5 block text-[11px] leading-4 text-[rgb(var(--color-text-secondary))]">
            Extra instruction passed to the Narration Director when it writes SSML.
          </span>
          <textarea
            value={settings.narrationStylePrompt}
            onChange={(event) => updateSetting("narrationStylePrompt", event.target.value)}
            rows={5}
            className={`${inputClass} mt-3 w-full min-w-0 resize-y`}
          />
        </label>
      </fieldset>
    </div>
  );
}

// ── Recording Tab ─────────────────────────────────────────────────
