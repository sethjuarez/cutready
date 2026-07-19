import { useEffect } from "react";
import { create } from "zustand";
import { LazyStore } from "@tauri-apps/plugin-store";
import { invoke } from "../services/tauri";
import {
  getProviderSecret,
  isSecretKey,
  loadAllSecrets,
  setProviderSecret,
  setSecret,
  type ProviderSecretName,
  type SecretKey,
} from "./useSecretStore";
import { DEFAULT_TERMINAL_CUSTOM_THEME, type TerminalColorMode, type TerminalCustomTheme } from "../theme/terminalThemes";

export interface AgentPreset {
  id: string;
  name: string;
  prompt: string;
  /** Short one-line description shown in the agent picker. */
  description?: string;
  /** Optional model override — if set, this agent uses a different model than the global setting. */
  modelOverride?: string;
  /** Optional provider override — if set, this agent uses a different provider than the default. */
  providerOverride?: string;
}

export type AiProviderKind = "microsoft_foundry" | "azure_openai" | "openai" | "anthropic";
export type AiAuthMode = "api_key" | "azure_oauth";
export type AiApplyMode = "ask" | "auto";
export type NarrationConnectionMode = "reuse_active_foundry" | "dedicated";

export interface AiProviderConfig {
  id: string;
  name: string;
  provider: AiProviderKind;
  authMode: AiAuthMode;
  endpoint: string;
  model: string;
  contextLength: number;
  modelSupportsVision: "" | "true" | "false";
  tenantId: string;
  clientId: string;
  subscriptionId: string;
  resourceGroup: string;
  resourceName: string;
}

export interface BackgroundMusicTrack {
  id: string;
  name: string;
  path: string;
  durationSeconds?: number;
}

// ── Global settings (stored in Tauri app data) ────────────────────

export interface GlobalSettings {
  outputDirectory: string;
  /** "microsoft_foundry" | "azure_openai" | "openai" | "anthropic" */
  aiProvider: string;
  /** "api_key" or "azure_oauth" */
  aiAuthMode: string;
  /** Azure/Foundry: resource endpoint. OpenAI: leave empty for default. Anthropic: ignored. */
  aiEndpoint: string;
  /** API key for the selected provider. */
  aiApiKey: string;
  /** Model / deployment name. */
  aiModel: string;
  /** Azure tenant ID for OAuth (default: "organizations"). */
  aiTenantId: string;
  /** Custom OAuth client ID (leave empty for default Azure PowerShell). */
  aiClientId: string;
  /** Azure OAuth access token (stored ephemerally). */
  aiAccessToken: string;
  /** Azure OAuth refresh token (for silent re-auth). */
  aiRefreshToken: string;
  /** ARM management token (for Foundry resource/project discovery). */
  aiManagementToken: string;
  /** Selected Azure subscription ID (Foundry). */
  aiSubscriptionId: string;
  /** Selected Azure resource group (Foundry). */
  aiResourceGroup: string;
  /** Selected Azure AI resource name (Foundry). */
  aiResourceName: string;
  audioDevice: string;
  /** Currently selected agent ID (default: "planner"). */
  aiSelectedAgent: string;
  /** User-created custom agents (name + prompt). */
  aiAgents: AgentPreset[];
  /** Per-agent model overrides for built-in agents. Empty/missing means use the global model. */
  aiAgentModelOverrides: Record<string, string>;
  /* ── Display settings ────────────────────────── */
  /** Editor text size in px (13–18, default 14). */
  displayFontSize: number;
  /** Chat panel text size in px (13–18, default 14). */
  displayChatFontSize: number;
  /** Row density: "compact" | "comfortable" | "spacious" (default "comfortable"). */
  displayRowDensity: string;
  /** Row color palette: "neutral" | "pastel" | "vivid" (default "vivid"). */
  displayRowColors: string;
  /** Editor width: "centered" | "full" (default "centered"). */
  displayEditorWidth: string;
  /** Font family: "system" | "sans" | "serif" | "mono" (default "system"). */
  displayFontFamily: string;
  /** Theme palette: token set applied across light/dark modes. */
  displayThemePalette: string;
  /** Terminal font stack; use a Nerd Font to render Powerline glyphs. */
  displayTerminalFontFamily: string;
  /** Terminal text size in px. */
  displayTerminalFontSize: number;
  /** Terminal color mode: built-in schemes plus "custom". */
  displayTerminalColorMode: TerminalColorMode;
  /** Custom terminal key colors used when displayTerminalColorMode is "custom". */
  displayTerminalCustomTheme: TerminalCustomTheme;
  /** Global hotkey for advancing presentation preview or teleprompter. */
  presentationNextHotkey: string;
  /** Global hotkey for moving backward in presentation preview or teleprompter. */
  presentationPreviousHotkey: string;
  /** Global hotkey for starting/stopping teleprompter auto-scroll. */
  presentationPlayPauseHotkey: string;
  /** Global hotkey for increasing teleprompter auto-scroll speed. */
  presentationSpeedUpHotkey: string;
  /** Global hotkey for decreasing teleprompter auto-scroll speed. */
  presentationSlowDownHotkey: string;
  /** Global hotkey for switching between preview and teleprompter presentation modes. */
  presentationToggleModeHotkey: string;
  /** Global hotkey for exiting the active presentation preview. */
  presentationExitHotkey: string;
  /** API-reported context window (tokens) for the selected model. */
  aiContextLength: number;
  /** Vision mode: "off", "notes", or "notes_and_sketches". */
  aiVisionMode: "off" | "notes" | "notes_and_sketches";
  /** Whether the selected model supports vision (set when model is picked). */
  aiModelSupportsVision: string;
  /** Web search access for chat agents: "disabled" or "enabled". */
  aiWebAccess: "disabled" | "enabled";
  /** Maximum agent tool-call rounds before stopping a run. */
  aiMaxToolRounds: number;
  /** Whether write-capable AI shortcuts prompt before mutating project files. */
  aiApplyMode: AiApplyMode;
  /** Named AI provider configurations. Secrets are stored separately in Stronghold. */
  aiProviders: AiProviderConfig[];
  /** Provider used by chat/model fetching unless an override is selected. */
  aiActiveProviderId: string;
  /** Default provider for agents that do not override provider selection. */
  aiDefaultProviderId: string;
  /** Per-agent provider overrides. Empty/missing means use the default provider. */
  aiAgentProviderOverrides: Record<string, string>;
  /** Default recording source: "full_screen", "region", or "window". */
  recorderCaptureSource: "full_screen" | "region" | "window";
  /** Default microphone device id; empty means system default. */
  recorderMicDeviceId: string;
  /** WebView microphone device id for row-level narration recording; empty means system default. */
  narrationMicDeviceId: string;
  /** Software gain for microphone recording, 0-200 where 100 is unity. */
  recorderMicVolume: number;
  /** Last selected recorder monitor preference. */
  recorderMonitorPreference: string;
  /** Default countdown before recording starts. */
  recorderCountdownSeconds: number;
  /** Default recording frame rate. */
  recorderFrameRate: number;
  /** Whether the cursor should be included in screen recordings by default. */
  recorderIncludeCursor: boolean;
  /** Default recording quality: "lossless", "high", or "compact". */
  recorderOutputQuality: "lossless" | "high" | "compact";
  /** Whether sketch video export includes a title card. */
  videoExportIncludeTitleCard: boolean;
  /** Sketch video export title card duration in seconds. */
  videoExportTitleCardDurationSeconds: number;
  /** Sketch video export first screenshot hold after the title card in seconds. */
  videoExportTitleToFirstRowHoldSeconds: number;
  /** Sketch video export transition duration between rows in seconds. */
  videoExportRowTransitionHoldSeconds: number;
  /** Sketch video export final screenshot hold duration in seconds. */
  videoExportFinalHoldSeconds: number;
  /** Sketch video export dip-to-black fade duration in seconds. */
  videoExportRowTransitionDipSeconds: number;
  /** Extra tail hold after row narration audio in seconds. */
  videoExportNarrationTailHoldSeconds: number;
  /** Maximum generated camera push scale for screenshot motion. */
  videoExportMotionMaxScale: number;
  /** MP4 export width in pixels. */
  videoExportWidth: number;
  /** MP4 export height in pixels. */
  videoExportHeight: number;
  /** MP4 export frame rate. */
  videoExportFps: number;
  /** FFmpeg video encoder used for MP4 export. */
  videoExportEncoder: string;
  /** FFmpeg pixel format used for MP4 export. */
  videoExportPixelFormat: string;
  /** FFmpeg CRF/quality value used for MP4 export. */
  videoExportCrf: string;
  /** Default font family for newly created typing overlays. */
  typingOverlayFontFamily: "sans" | "serif" | "mono";
  /** Default size multiplier for newly created typing overlays. */
  typingOverlayFontScale: number;
  /** App-wide reusable background music tracks stored in app data. */
  videoExportBackgroundMusicTracks: BackgroundMusicTrack[];
  /** Selected app-wide background music track ID. Empty means none. */
  videoExportBackgroundMusicTrackId: string;
  /** Background music gain in dB. */
  videoExportBackgroundMusicVolumeDb: number;
  /** Whether background music is ducked under narration. */
  videoExportBackgroundMusicDuckNarration: boolean;
  /** Background music fade in/out duration in seconds. */
  videoExportBackgroundMusicFadeSeconds: number;
  /** How generated narration chooses its Azure/Foundry speech connection. */
  narrationConnectionMode: NarrationConnectionMode;
  /** Dedicated AI provider ID used for narration when narrationConnectionMode is dedicated. */
  narrationProviderId: string;
  /** Azure Speech voice used for generated narration. */
  narrationVoiceName: string;
  /** Azure Speech output format used for generated narration. */
  narrationSpeechOutputFormat: string;
  /** Additional style direction for the narration SSML agent. */
  narrationStylePrompt: string;
  /** Custom FFmpeg executable path. Empty means auto-detect. */
  ffmpegExecutablePath: string;
  /** Custom FFprobe executable path. Empty means auto-detect. */
  ffprobeExecutablePath: string;
  /** Future default: capture camera as a separate asset. */
  recorderCameraEnabled: boolean;
  /** Last selected camera device id for separate camera.mp4 capture. */
  recorderCameraDeviceId: string;
  /** Future default: capture system audio as a separate asset. */
  recorderSystemAudioEnabled: boolean;
  /** Software gain for system audio recording, 0-200 where 100 is unity. */
  recorderSystemAudioVolume: number;
  /** Feature flag: show recording UI (experimental, default false). */
  featureRecording: boolean;
  /** Enable full diagnostics capture on the next app launch. */
  auditaurDiagnosticsEnabled: boolean;
  // Legacy fields (migrated on load)
  llmApiKey?: string;
  llmEndpoint?: string;
  llmDeployment?: string;
}

// ── Workspace settings (stored per-workspace in .cutready/settings.json) ──

export interface WorkspaceSettings {
  /** Git remote URL (e.g. https://github.com/user/repo.git). */
  repoRemoteUrl: string;
  /** Auth method: "github" | "gh_cli" | "pat" | "ssh" (default "github"). */
  repoAuthMethod: string;
  /** Personal Access Token (when repoAuthMethod is "pat"). */
  repoToken: string;
  /** Git author name for commits. */
  repoAuthorName: string;
  /** Git author email for commits. */
  repoAuthorEmail: string;
  /** Override app-level sketch video export timing for this workspace. */
  videoExportOverrideEnabled: boolean;
  /** Workspace override: whether sketch video export includes a title card. */
  workspaceVideoExportIncludeTitleCard: boolean;
  /** Workspace override: sketch video export title card duration in seconds. */
  workspaceVideoExportTitleCardDurationSeconds: number;
  /** Workspace override: first screenshot hold after the title card in seconds. */
  workspaceVideoExportTitleToFirstRowHoldSeconds: number;
  /** Workspace override: transition duration between rows in seconds. */
  workspaceVideoExportRowTransitionHoldSeconds: number;
  /** Workspace override: final screenshot hold duration in seconds. */
  workspaceVideoExportFinalHoldSeconds: number;
  /** Workspace override: dip-to-black fade duration in seconds. */
  workspaceVideoExportRowTransitionDipSeconds: number;
  /** Workspace override: extra tail hold after row narration audio in seconds. */
  workspaceVideoExportNarrationTailHoldSeconds: number;
  /** Workspace override: maximum generated camera push scale for screenshot motion. */
  workspaceVideoExportMotionMaxScale: number;
  /** Workspace override: MP4 export width in pixels. */
  workspaceVideoExportWidth: number;
  /** Workspace override: MP4 export height in pixels. */
  workspaceVideoExportHeight: number;
  /** Workspace override: MP4 export frame rate. */
  workspaceVideoExportFps: number;
  /** Workspace override: FFmpeg video encoder used for MP4 export. */
  workspaceVideoExportEncoder: string;
  /** Workspace override: FFmpeg pixel format used for MP4 export. */
  workspaceVideoExportPixelFormat: string;
  /** Workspace override: FFmpeg CRF/quality value used for MP4 export. */
  workspaceVideoExportCrf: string;
  /** Whether this workspace overrides the app-level typing overlay typography. */
  typingOverlayOverrideEnabled: boolean;
  /** Workspace default font family for newly created typing overlays. */
  workspaceTypingOverlayFontFamily: "sans" | "serif" | "mono";
  /** Workspace default size multiplier for newly created typing overlays. */
  workspaceTypingOverlayFontScale: number;
  /** Project-local reusable loopable WAV files for sketch video background music. */
  workspaceVideoExportBackgroundMusicTracks: BackgroundMusicTrack[];
  /** Selected project-local background music track ID. Empty means none. */
  workspaceVideoExportBackgroundMusicTrackId: string;
  /** Background music gain in dB. */
  workspaceVideoExportBackgroundMusicVolumeDb: number;
  /** Whether background music is ducked under narration. */
  workspaceVideoExportBackgroundMusicDuckNarration: boolean;
  /** Background music fade in/out duration in seconds. */
  workspaceVideoExportBackgroundMusicFadeSeconds: number;
}

/** Combined view for backward compatibility — consumers that need both. */
export type AppSettings = GlobalSettings & WorkspaceSettings;

const defaultGlobalSettings: GlobalSettings = {
  outputDirectory: "",
  aiProvider: "azure_openai",
  aiAuthMode: "api_key",
  aiEndpoint: "",
  aiApiKey: "",
  aiModel: "",
  aiTenantId: "",
  aiClientId: "",
  aiAccessToken: "",
  aiRefreshToken: "",
  aiManagementToken: "",
  aiSubscriptionId: "",
  aiResourceGroup: "",
  aiResourceName: "",
  audioDevice: "",
  aiSelectedAgent: "planner",
  aiAgents: [],
  aiAgentModelOverrides: {},
  displayFontSize: 14,
  displayChatFontSize: 14,
  displayRowDensity: "comfortable",
  displayRowColors: "vivid",
  displayEditorWidth: "centered",
  displayFontFamily: "system",
  displayThemePalette: "cutready",
  displayTerminalFontFamily: '"CaskaydiaCove Nerd Font", "CaskaydiaMono Nerd Font", "Cascadia Code PL", "Cascadia Code", Consolas, monospace',
  displayTerminalFontSize: 12,
  displayTerminalColorMode: "console",
  displayTerminalCustomTheme: DEFAULT_TERMINAL_CUSTOM_THEME,
  presentationNextHotkey: "CmdOrControl+Alt+Shift+ArrowRight",
  presentationPreviousHotkey: "CmdOrControl+Alt+Shift+ArrowLeft",
  presentationPlayPauseHotkey: "CmdOrControl+Alt+Shift+Space",
  presentationSpeedUpHotkey: "CmdOrControl+Alt+Shift+BracketRight",
  presentationSlowDownHotkey: "CmdOrControl+Alt+Shift+BracketLeft",
  presentationToggleModeHotkey: "CmdOrControl+Alt+Shift+T",
  presentationExitHotkey: "CmdOrControl+Alt+Shift+Q",
  aiContextLength: 0,
  aiVisionMode: "notes_and_sketches",
  aiModelSupportsVision: "",
  aiWebAccess: "disabled",
  aiMaxToolRounds: 50,
  aiApplyMode: "ask",
  aiProviders: [],
  aiActiveProviderId: "",
  aiDefaultProviderId: "",
  aiAgentProviderOverrides: {},
  recorderCaptureSource: "full_screen",
  recorderMicDeviceId: "",
  narrationMicDeviceId: "",
  recorderMicVolume: 100,
  recorderMonitorPreference: "",
  recorderCountdownSeconds: 3,
  recorderFrameRate: 30,
  recorderIncludeCursor: true,
  recorderOutputQuality: "high",
  videoExportIncludeTitleCard: true,
  videoExportTitleCardDurationSeconds: 3,
  videoExportTitleToFirstRowHoldSeconds: 0.5,
  videoExportRowTransitionHoldSeconds: 1,
  videoExportFinalHoldSeconds: 3,
  videoExportRowTransitionDipSeconds: 0.35,
  videoExportNarrationTailHoldSeconds: 0.35,
  videoExportMotionMaxScale: 1.65,
  videoExportWidth: 1920,
  videoExportHeight: 1080,
  videoExportFps: 30,
  videoExportEncoder: "libx264rgb",
  videoExportPixelFormat: "rgb24",
  videoExportCrf: "0",
  typingOverlayFontFamily: "sans",
  typingOverlayFontScale: 1,
  videoExportBackgroundMusicTracks: [],
  videoExportBackgroundMusicTrackId: "",
  videoExportBackgroundMusicVolumeDb: -24,
  videoExportBackgroundMusicDuckNarration: true,
  videoExportBackgroundMusicFadeSeconds: 0.5,
  narrationConnectionMode: "reuse_active_foundry",
  narrationProviderId: "",
  narrationVoiceName: "en-US-Harper:MAI-Voice-2",
  narrationSpeechOutputFormat: "riff-24khz-16bit-mono-pcm",
  narrationStylePrompt: "Natural presenter delivery: short sentences, clean transitions, light emphasis, and no hype.",
  ffmpegExecutablePath: "",
  ffprobeExecutablePath: "",
  recorderCameraEnabled: false,
  recorderCameraDeviceId: "",
  recorderSystemAudioEnabled: false,
  recorderSystemAudioVolume: 100,
  featureRecording: false,
  auditaurDiagnosticsEnabled: import.meta.env.DEV || import.meta.env.VITE_CUTREADY_DIAGNOSTICS === "1",
};

function getInitialGlobalSettings(): GlobalSettings {
  try {
    const cachedPalette = localStorage.getItem("cutready-theme-palette");
    if (cachedPalette) {
      return { ...defaultGlobalSettings, displayThemePalette: cachedPalette };
    }
  } catch {
    // localStorage may be unavailable in tests or restricted webviews.
  }
  return defaultGlobalSettings;
}

export const defaultWorkspaceSettings: WorkspaceSettings = {
  repoRemoteUrl: "",
  repoAuthMethod: "github",
  repoToken: "",
  repoAuthorName: "",
  repoAuthorEmail: "",
  videoExportOverrideEnabled: false,
  workspaceVideoExportIncludeTitleCard: true,
  workspaceVideoExportTitleCardDurationSeconds: 3,
  workspaceVideoExportTitleToFirstRowHoldSeconds: 0.5,
  workspaceVideoExportRowTransitionHoldSeconds: 1,
  workspaceVideoExportFinalHoldSeconds: 3,
  workspaceVideoExportRowTransitionDipSeconds: 0.35,
  workspaceVideoExportNarrationTailHoldSeconds: 0.35,
  workspaceVideoExportMotionMaxScale: 1.65,
  workspaceVideoExportWidth: 1920,
  workspaceVideoExportHeight: 1080,
  workspaceVideoExportFps: 30,
  workspaceVideoExportEncoder: "libx264rgb",
  workspaceVideoExportPixelFormat: "rgb24",
  workspaceVideoExportCrf: "0",
  typingOverlayOverrideEnabled: false,
  workspaceTypingOverlayFontFamily: "sans",
  workspaceTypingOverlayFontScale: 1,
  workspaceVideoExportBackgroundMusicTracks: [],
  workspaceVideoExportBackgroundMusicTrackId: "",
  workspaceVideoExportBackgroundMusicVolumeDb: -24,
  workspaceVideoExportBackgroundMusicDuckNarration: true,
  workspaceVideoExportBackgroundMusicFadeSeconds: 0.5,
};

const defaultSettings: AppSettings = {
  ...getInitialGlobalSettings(),
  ...defaultWorkspaceSettings,
};

const STORE_PATH = "settings.json";
const PROVIDER_SECRET_TO_FLAT_KEY: Record<ProviderSecretName, keyof GlobalSettings> = {
  apiKey: "aiApiKey",
  accessToken: "aiAccessToken",
  refreshToken: "aiRefreshToken",
  managementToken: "aiManagementToken",
};
const FLAT_SECRET_TO_PROVIDER_SECRET: Partial<Record<keyof GlobalSettings, ProviderSecretName>> = {
  aiApiKey: "apiKey",
  aiAccessToken: "accessToken",
  aiRefreshToken: "refreshToken",
  aiManagementToken: "managementToken",
};
const FLAT_PROVIDER_FIELDS: Partial<Record<keyof GlobalSettings, keyof AiProviderConfig>> = {
  aiProvider: "provider",
  aiAuthMode: "authMode",
  aiEndpoint: "endpoint",
  aiModel: "model",
  aiContextLength: "contextLength",
  aiModelSupportsVision: "modelSupportsVision",
  aiTenantId: "tenantId",
  aiClientId: "clientId",
  aiSubscriptionId: "subscriptionId",
  aiResourceGroup: "resourceGroup",
  aiResourceName: "resourceName",
};

const WORKSPACE_KEYS: (keyof WorkspaceSettings)[] = [
  "repoRemoteUrl",
  "repoAuthMethod",
  "repoToken",
  "repoAuthorName",
  "repoAuthorEmail",
  "videoExportOverrideEnabled",
  "workspaceVideoExportIncludeTitleCard",
  "workspaceVideoExportTitleCardDurationSeconds",
  "workspaceVideoExportTitleToFirstRowHoldSeconds",
  "workspaceVideoExportRowTransitionHoldSeconds",
  "workspaceVideoExportFinalHoldSeconds",
  "workspaceVideoExportRowTransitionDipSeconds",
  "workspaceVideoExportNarrationTailHoldSeconds",
  "workspaceVideoExportMotionMaxScale",
  "workspaceVideoExportWidth",
  "workspaceVideoExportHeight",
  "workspaceVideoExportFps",
  "workspaceVideoExportEncoder",
  "workspaceVideoExportPixelFormat",
  "workspaceVideoExportCrf",
  "typingOverlayOverrideEnabled",
  "workspaceTypingOverlayFontFamily",
  "workspaceTypingOverlayFontScale",
  "workspaceVideoExportBackgroundMusicTracks",
  "workspaceVideoExportBackgroundMusicTrackId",
  "workspaceVideoExportBackgroundMusicVolumeDb",
  "workspaceVideoExportBackgroundMusicDuckNarration",
  "workspaceVideoExportBackgroundMusicFadeSeconds",
];

function providerLabel(provider: AiProviderKind): string {
  switch (provider) {
    case "microsoft_foundry": return "Microsoft Foundry";
    case "azure_openai": return "Azure OpenAI";
    case "openai": return "OpenAI";
    case "anthropic": return "Anthropic";
  }
}

function normalizeProviderKind(provider: string): AiProviderKind {
  if (provider === "microsoft_foundry" || provider === "openai" || provider === "anthropic") {
    return provider;
  }
  return "azure_openai";
}

function normalizeAuthMode(authMode: string, provider: AiProviderKind): AiAuthMode {
  if ((provider === "azure_openai" || provider === "microsoft_foundry") && authMode === "azure_oauth") {
    return "azure_oauth";
  }
  return "api_key";
}

function legacyProviderId(provider: AiProviderKind): string {
  return `legacy-${provider}`;
}

function createProviderFromFlat(settings: GlobalSettings): AiProviderConfig {
  const provider = normalizeProviderKind(settings.aiProvider);
  return {
    id: settings.aiActiveProviderId || legacyProviderId(provider),
    name: providerLabel(provider),
    provider,
    authMode: normalizeAuthMode(settings.aiAuthMode, provider),
    endpoint: settings.aiEndpoint || "",
    model: settings.aiModel || "",
    contextLength: settings.aiContextLength || 0,
    modelSupportsVision: settings.aiModelSupportsVision === "true" || settings.aiModelSupportsVision === "false"
      ? settings.aiModelSupportsVision
      : "",
    tenantId: settings.aiTenantId || "",
    clientId: settings.aiClientId || "",
    subscriptionId: settings.aiSubscriptionId || "",
    resourceGroup: settings.aiResourceGroup || "",
    resourceName: settings.aiResourceName || "",
  };
}

function normalizeProviderConfig(input: Partial<AiProviderConfig>, fallback: AiProviderConfig): AiProviderConfig {
  const provider = normalizeProviderKind(input.provider || fallback.provider);
  return {
    id: String(input.id || fallback.id),
    name: String(input.name || providerLabel(provider)),
    provider,
    authMode: normalizeAuthMode(input.authMode || fallback.authMode, provider),
    endpoint: String(input.endpoint ?? fallback.endpoint ?? ""),
    model: String(input.model ?? fallback.model ?? ""),
    contextLength: Number(input.contextLength ?? fallback.contextLength ?? 0) || 0,
    modelSupportsVision: input.modelSupportsVision === "true" || input.modelSupportsVision === "false"
      ? input.modelSupportsVision
      : "",
    tenantId: String(input.tenantId ?? fallback.tenantId ?? ""),
    clientId: String(input.clientId ?? fallback.clientId ?? ""),
    subscriptionId: String(input.subscriptionId ?? fallback.subscriptionId ?? ""),
    resourceGroup: String(input.resourceGroup ?? fallback.resourceGroup ?? ""),
    resourceName: String(input.resourceName ?? fallback.resourceName ?? ""),
  };
}

async function loadProviderSecretsIntoFlat(result: GlobalSettings, providerId: string) {
  for (const [secretName, flatKey] of Object.entries(PROVIDER_SECRET_TO_FLAT_KEY) as Array<[ProviderSecretName, keyof GlobalSettings]>) {
    const value = await getProviderSecret(providerId, secretName);
    (result as unknown as Record<string, unknown>)[flatKey] = value;
  }
}

function applyProviderToFlat(result: GlobalSettings, provider: AiProviderConfig) {
  result.aiProvider = provider.provider;
  result.aiAuthMode = provider.authMode;
  result.aiEndpoint = provider.endpoint;
  result.aiModel = provider.model;
  result.aiContextLength = provider.contextLength;
  result.aiModelSupportsVision = provider.modelSupportsVision;
  result.aiTenantId = provider.tenantId;
  result.aiClientId = provider.clientId;
  result.aiSubscriptionId = provider.subscriptionId;
  result.aiResourceGroup = provider.resourceGroup;
  result.aiResourceName = provider.resourceName;
}

function providersWithUpdatedActive(
  settings: GlobalSettings,
  updates: Partial<AiProviderConfig>,
): AiProviderConfig[] {
  const fallback = createProviderFromFlat(settings);
  const activeId = settings.aiActiveProviderId || settings.aiDefaultProviderId || fallback.id;
  const providers = settings.aiProviders.length > 0 ? settings.aiProviders : [fallback];
  return providers.map((provider) => {
    if (provider.id !== activeId) return provider;
    return normalizeProviderConfig({ ...provider, ...updates }, provider);
  });
}

async function migrateProviderSettings(result: GlobalSettings, legacySecrets: Record<SecretKey, string>, store: LazyStore) {
  const fallback = createProviderFromFlat(result);
  const loadedProviders = Array.isArray(result.aiProviders) ? result.aiProviders : [];
  const providers = loadedProviders.length > 0
    ? loadedProviders.map((provider) => normalizeProviderConfig(provider, fallback))
    : [fallback];

  const activeProviderId = providers.some((provider) => provider.id === result.aiActiveProviderId)
    ? result.aiActiveProviderId
    : providers[0].id;
  const defaultProviderId = providers.some((provider) => provider.id === result.aiDefaultProviderId)
    ? result.aiDefaultProviderId
    : activeProviderId;

  result.aiProviders = providers;
  result.aiActiveProviderId = activeProviderId;
  result.aiDefaultProviderId = defaultProviderId;

  if (loadedProviders.length === 0) {
    const activeProvider = providers[0];
    const migrations: Array<[ProviderSecretName, keyof GlobalSettings]> = [
      ["apiKey", "aiApiKey"],
      ["accessToken", "aiAccessToken"],
      ["refreshToken", "aiRefreshToken"],
      ["managementToken", "aiManagementToken"],
    ];
    for (const [providerSecret, flatSecret] of migrations) {
      const legacyValue = flatSecret in legacySecrets
        ? legacySecrets[flatSecret as SecretKey]
        : "";
      const value = legacyValue || (result as unknown as Record<string, unknown>)[flatSecret];
      if (typeof value === "string" && value) {
        await setProviderSecret(activeProvider.id, providerSecret, value);
      }
    }
    await store.set("aiProviders", providers);
    await store.set("aiActiveProviderId", activeProvider.id);
    await store.set("aiDefaultProviderId", activeProvider.id);
    await store.save();
  }

  const activeProvider = providers.find((provider) => provider.id === activeProviderId) ?? providers[0];
  applyProviderToFlat(result, activeProvider);
  await loadProviderSecretsIntoFlat(result, activeProvider.id);
}

interface SettingsStore {
  settings: AppSettings;
  loaded: boolean;
  workspaceLoaded: boolean;
  _store: LazyStore | null;
  _loadSettings: () => Promise<void>;
  _loadWorkspaceSettings: () => Promise<void>;
  _clearWorkspaceSettings: () => void;
  updateSetting: <K extends keyof AppSettings>(key: K, value: AppSettings[K]) => Promise<void>;
}

export const useSettingsStore = create<SettingsStore>((set, get) => ({
  settings: defaultSettings,
  loaded: false,
  workspaceLoaded: false,
  _store: null,

  _loadSettings: async () => {
    if (get().loaded) return;
    try {
      const store = new LazyStore(STORE_PATH);
      set({ _store: store });

      const result = { ...defaultGlobalSettings };
      for (const key of Object.keys(defaultGlobalSettings) as (keyof GlobalSettings)[]) {
        try {
          const val = await store.get(key);
          if (val !== null && val !== undefined) {
            (result as Record<string, unknown>)[key] = val;
          }
        } catch {
          // Individual key read failed — keep default
        }
      }

      // Migrate legacy fields
      if (!result.aiApiKey && result.llmApiKey) {
        result.aiApiKey = result.llmApiKey;
        result.aiEndpoint = result.llmEndpoint || "";
        result.aiModel = result.llmDeployment || "";
        result.aiProvider = "azure_openai";
      }

      let secrets: Record<SecretKey, string> = {
        aiApiKey: "",
        aiAccessToken: "",
        aiRefreshToken: "",
        repoToken: "",
      };

      // Load secrets from Stronghold (encrypted vault)
      try {
        secrets = await loadAllSecrets();

        // Migrate: if stronghold is empty but plain store has secrets, move them over
        let migrated = false;
        for (const sk of Object.keys(secrets) as SecretKey[]) {
          const plainVal = (result as Record<string, unknown>)[sk] as string | undefined;
          if (!secrets[sk] && plainVal) {
            // Secret exists in plain store but not vault — migrate it
            await setSecret(sk, plainVal);
            secrets[sk] = plainVal;
            // Clear from plain store
            await store.set(sk, "");
            migrated = true;
          }
        }
        if (migrated) await store.save();

        // Override result with vault values (vault is authoritative)
        for (const sk of Object.keys(secrets) as SecretKey[]) {
          if (secrets[sk]) {
            (result as Record<string, unknown>)[sk] = secrets[sk];
          }
        }
      } catch {
        // Stronghold unavailable (e.g. browser dev mode) — use plain store values
      }

      try {
        await migrateProviderSettings(result, secrets, store);
      } catch (err) {
        console.warn("[settings] Failed to migrate AI provider settings:", err);
      }

      set({ settings: { ...get().settings, ...result }, loaded: true });

      // Auto-refresh OAuth token on startup if we have a refresh token
      const needsOAuth = result.aiAuthMode === "azure_oauth" &&
        (result.aiProvider === "azure_openai" || result.aiProvider === "microsoft_foundry");
      if (needsOAuth && result.aiRefreshToken) {
        try {
          const tokenResult = await invoke<{ access_token: string; refresh_token?: string }>(
            "azure_token_refresh",
            {
              tenantId: result.aiTenantId || "",
              refreshToken: result.aiRefreshToken,
              clientId: result.aiClientId || null,
            },
          );
          if (tokenResult.access_token) {
            const updates: Partial<GlobalSettings> = { aiAccessToken: tokenResult.access_token };
            if (tokenResult.refresh_token) {
              updates.aiRefreshToken = tokenResult.refresh_token;
            }
            set((state) => ({ settings: { ...state.settings, ...updates } }));
            // Save refreshed tokens to vault
            try {
              await setProviderSecret(result.aiActiveProviderId, "accessToken", tokenResult.access_token);
              if (tokenResult.refresh_token) {
                await setProviderSecret(result.aiActiveProviderId, "refreshToken", tokenResult.refresh_token);
              }
            } catch {
              // Vault unavailable — fall through
            }
          }
        } catch {
          // Token refresh failed silently — user will re-auth when needed
        }
      }
    } catch (err) {
      // Catastrophic settings failure — still mark loaded so the app renders
      console.error("[settings] Failed to load settings, using defaults:", err);
      set({ loaded: true });
    }
  },

  _loadWorkspaceSettings: async () => {
    try {
      const data = await invoke<Record<string, unknown>>("get_workspace_settings");
      const ws = { ...defaultWorkspaceSettings };
      for (const key of WORKSPACE_KEYS) {
        if (data[key] !== null && data[key] !== undefined) {
          (ws as Record<string, unknown>)[key] = data[key];
        }
      }
      set((state) => ({ settings: { ...state.settings, ...ws }, workspaceLoaded: true }));
    } catch {
      // No workspace settings yet — use defaults
      set((state) => ({
        settings: { ...state.settings, ...defaultWorkspaceSettings },
        workspaceLoaded: true,
      }));
    }
  },

  _clearWorkspaceSettings: () => {
    set((state) => ({
      settings: { ...state.settings, ...defaultWorkspaceSettings },
      workspaceLoaded: false,
    }));
  },

  updateSetting: async (key, value) => {
    const current = get().settings;
    let nextSettings: AppSettings = { ...current, [key]: value };
    let providerSecretUpdate: [string, ProviderSecretName, string] | null = null;
    let persistProviderList = false;

    if (key === "aiProviders") {
      const providers = Array.isArray(value) ? value as AiProviderConfig[] : [];
      const fallback = createProviderFromFlat(current);
      const normalized = providers.length > 0
        ? providers.map((provider) => normalizeProviderConfig(provider, fallback))
        : [fallback];
      const activeId = normalized.some((provider) => provider.id === current.aiActiveProviderId)
        ? current.aiActiveProviderId
        : normalized[0].id;
      const defaultId = normalized.some((provider) => provider.id === current.aiDefaultProviderId)
        ? current.aiDefaultProviderId
        : activeId;
      nextSettings = {
        ...nextSettings,
        aiProviders: normalized,
        aiActiveProviderId: activeId,
        aiDefaultProviderId: defaultId,
      };
      applyProviderToFlat(nextSettings, normalized.find((provider) => provider.id === activeId) ?? normalized[0]);
      persistProviderList = true;
    } else if (key === "aiActiveProviderId") {
      const provider = current.aiProviders.find((candidate) => candidate.id === value);
      if (provider) {
        nextSettings = { ...nextSettings, aiActiveProviderId: provider.id };
        applyProviderToFlat(nextSettings, provider);
        try {
          for (const [secretName, flatKey] of Object.entries(PROVIDER_SECRET_TO_FLAT_KEY) as Array<[ProviderSecretName, keyof GlobalSettings]>) {
            (nextSettings as unknown as Record<string, unknown>)[flatKey] = await getProviderSecret(provider.id, secretName);
          }
        } catch {
          // Stronghold unavailable — keep existing in-memory flat secret values.
        }
      }
    } else if (key === "aiDefaultProviderId") {
      const providerId = typeof value === "string" && current.aiProviders.some((provider) => provider.id === value)
        ? value
        : current.aiActiveProviderId;
      nextSettings = { ...nextSettings, aiDefaultProviderId: providerId };
    } else if (key in FLAT_PROVIDER_FIELDS) {
      const providerField = FLAT_PROVIDER_FIELDS[key as keyof GlobalSettings];
      if (providerField) {
        nextSettings.aiProviders = providersWithUpdatedActive(current, {
          [providerField]: value,
        } as Partial<AiProviderConfig>);
        persistProviderList = true;
      }
    } else if (key in FLAT_SECRET_TO_PROVIDER_SECRET) {
      const secretName = FLAT_SECRET_TO_PROVIDER_SECRET[key as keyof GlobalSettings];
      const providerId = current.aiActiveProviderId || current.aiDefaultProviderId;
      if (secretName && providerId) {
        providerSecretUpdate = [providerId, secretName, String(value)];
      }
    }

    set({ settings: nextSettings });
    if (key === "displayThemePalette") {
      try {
        localStorage.setItem("cutready-theme-palette", String(value));
      } catch {
        // The Tauri Store remains authoritative; this cache only prevents startup flashes.
      }
    }

    if (WORKSPACE_KEYS.includes(key as keyof WorkspaceSettings)) {
      // Workspace setting — special handling for repoToken (encrypted)
      if (isSecretKey(key as string)) {
        try { await setSecret(key as SecretKey, value as string); } catch { /* vault unavailable */ }
      }
      try {
        const data = await invoke<Record<string, unknown>>("get_workspace_settings");
        // Don't persist secrets in workspace settings file
        if (!isSecretKey(key as string)) {
          data[key] = value;
        }
        await invoke("set_workspace_settings", { settings: data });
      } catch {
        // No repo open — setting stored in memory only
      }
    } else if (isSecretKey(key as string)) {
      // Global secret → save to encrypted vault
      try {
        await setSecret(key as SecretKey, value as string);
        if (providerSecretUpdate) {
          await setProviderSecret(providerSecretUpdate[0], providerSecretUpdate[1], providerSecretUpdate[2]);
        }
      } catch {
        // Vault unavailable — fall back to plain store
        const store = get()._store;
        if (store) {
          await store.set(key, value);
          await store.save();
        }
      }
    } else {
      // Global non-secret → save to Tauri app data (plaintext)
      const store = get()._store;
      if (store) {
        await store.set(key, value);
        if (persistProviderList) {
          await store.set("aiProviders", nextSettings.aiProviders);
          await store.set("aiActiveProviderId", nextSettings.aiActiveProviderId);
          await store.set("aiDefaultProviderId", nextSettings.aiDefaultProviderId);
        }
        await store.save();
      }
    }
  },
}));

/**
 * Hook for reading and writing application settings.
 * Uses a shared zustand store — all consumers see updates immediately.
 */
export function useSettings() {
  const settings = useSettingsStore((s) => s.settings);
  const loaded = useSettingsStore((s) => s.loaded);
  const updateSetting = useSettingsStore((s) => s.updateSetting);
  const loadSettings = useSettingsStore((s) => s._loadSettings);

  useEffect(() => { loadSettings(); }, [loadSettings]);

  return { settings, updateSetting, loaded };
}
