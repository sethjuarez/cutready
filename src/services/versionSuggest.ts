import type { ChangeSummary } from "../domain/changes";
import {
  mergeSuggestionMessages,
  parseSuggestion,
  suggestionMessages,
  type IncomingVersion,
  type VersionSuggestion,
} from "../domain/versioning";
import { useSettingsStore, type AgentPreset, type GlobalSettings } from "../hooks/useSettings";
import { buildEffectiveProviderInput, buildRefreshedProviderInput } from "../utils/agentProvider";
import { buildProviderConfig, isProviderInputConfigured } from "../utils/providerConfig";
import { agentChat } from "./agentChat";

const SUGGEST_TIMEOUT_MS = 30_000;

/** No overrides, so Suggest uses the default connection and model. */
const SUGGEST_AGENT: AgentPreset = { id: "version-suggest", name: "Version suggest", prompt: "" };

/** Side-effect free: no token refresh and no vault writes. */
export async function isSuggestConfigured(settings: GlobalSettings = useSettingsStore.getState().settings): Promise<boolean> {
  try {
    return isProviderInputConfigured(await buildEffectiveProviderInput(settings, SUGGEST_AGENT));
  } catch {
    return false;
  }
}

/** Asks the default model for a version name and comment. Null when the reply is unusable. */
export async function suggestVersion(summary: ChangeSummary): Promise<VersionSuggestion | null> {
  return requestSuggestion(suggestionMessages(summary));
}

/** Asks the default model to name a merge from the versions it brings in. */
export async function suggestMergeName(source: string, versions: readonly IncomingVersion[]): Promise<VersionSuggestion | null> {
  return requestSuggestion(mergeSuggestionMessages(source, versions));
}

async function requestSuggestion(messages: ReturnType<typeof suggestionMessages>): Promise<VersionSuggestion | null> {
  const { settings, updateSetting } = useSettingsStore.getState();
  const input = await buildRefreshedProviderInput(settings, SUGGEST_AGENT, updateSetting);
  if (!isProviderInputConfigured(input)) return null;
  const config = buildProviderConfig(input, "prompty");
  const reply = await agentChat(config, messages, { timeoutMs: SUGGEST_TIMEOUT_MS });
  return parseSuggestion(reply.content);
}
