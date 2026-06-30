import { useState, useEffect, useRef, type ReactNode } from "react";
import { useAppStore } from "../stores/appStore";
import { useSettings, useSettingsStore, type AgentPreset } from "../hooks/useSettings";
import { useRecordingDevices } from "../hooks/useRecordingDevices";
import { useTheme, type ThemePreference } from "../hooks/useTheme";
import { invoke } from "../services/tauri";
import { getVersion } from "@tauri-apps/api/app";
import { open as shellOpen } from "@tauri-apps/plugin-shell";
import { relaunch } from "@tauri-apps/plugin-process";
import { BUILT_IN_AGENTS } from "../agents/builtInAgents";
import { useToastStore } from "../stores/toastStore";
import { useUpdateStore } from "../stores/updateStore";
import { ReleaseNotesMarkdown } from "./UpdateAvailableButton";
import { Dialog } from "./Dialog";
import { useConfirmDialog } from "./ConfirmDialog";
import { agentChat } from "../services/agentChat";
import { addDraftlineRemote, listDraftlineRemotes } from "../services/draftlineVersioning";
import {
  X,
  RefreshCw,
  MessageSquare,
  Check,
  ClipboardList,
  Trash2,
  LayoutGrid,
  Info,
  Download,
  CheckCircle,
  ExternalLink,
  Image,
  Search,
  MonitorCog,
  Palette,
  Bot,
  Brain,
  Mic2,
  MessageCircleWarning,
  GitBranch,
  DownloadCloud,
  FlaskConical,
  SlidersHorizontal,
  FolderGit2,
} from "lucide-react";

interface ModelInfo {
  id: string;
  created?: number;
  owned_by?: string;
  capabilities?: Record<string, string>;
  context_length?: number;
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

type SettingsTab = "ai" | "agents" | "memory" | "display" | "themes" | "recording" | "feedback" | "repository" | "updates" | "experimental";

import { inputClass } from "../styles";
import { FoundryResourcePicker } from "./FoundryResourcePicker";
import { THEME_PALETTES, type ThemePalette } from "../theme/appThemePalettes";
import {
  TERMINAL_COLOR_SCHEMES,
  normalizeTerminalColorMode,
  normalizeTerminalCustomTheme,
  type TerminalCustomTheme,
} from "../theme/terminalThemes";
import { sanitizeDiagnosticsLog } from "../utils/diagnosticsSanitizer";
import { activeProvider, buildProviderConfig, canFetchModelsFor, createAiProviderConfig, isAiProviderConfigured } from "../utils/providerConfig";
import {
  appendFeedbackAttachmentsSection,
  formatFeedbackAttachmentSize,
  formatFeedbackAttachmentsMarkdown,
  type FeedbackAttachmentMetadata,
} from "../utils/feedbackAttachments";

export function SettingsPanel({ onClose }: { onClose?: () => void }) {
  const { settings, updateSetting, loaded } = useSettings();
  const currentProject = useAppStore((s) => s.currentProject);
  const setView = useAppStore((s) => s.setView);
  const [scope, setScope] = useState<"app" | "workspace">("app");
  const [activeTab, setActiveTab] = useState<SettingsTab>("display");
  const [settingsFilter, setSettingsFilter] = useState("");
  const [models, setModels] = useState<ModelInfo[]>([]);
  const [loadingModels, setLoadingModels] = useState(false);
  const [modelError, setModelError] = useState("");
  const [modelFilter, setModelFilter] = useState("");

  const globalTabs: SettingsTab[] = settings.featureRecording
    ? ["display", "themes", "recording", "ai", "agents", "feedback", "updates", "experimental"]
    : ["display", "themes", "ai", "agents", "feedback", "updates", "experimental"];
  const workspaceTabs: SettingsTab[] = ["repository", "memory", "display", "themes", "ai", "agents"];
  const tabs: SettingsTab[] = scope === "workspace" ? workspaceTabs : globalTabs;

  // OAuth flow state
  const [oauthStatus, setOauthStatus] = useState<"idle" | "waiting" | "polling" | "success" | "error">("idle");
  const [oauthError, setOauthError] = useState("");

  useEffect(() => {
    if (!currentProject && scope !== "app") {
      setScope("app");
      setActiveTab("display");
      return;
    }

    if (!tabs.includes(activeTab)) {
      setActiveTab(scope === "workspace" ? "repository" : "display");
    }
  }, [activeTab, currentProject, scope, tabs]);

  const buildConfig = () => buildProviderConfig(settings);

  const fetchModels = async () => {
    setLoadingModels(true);
    setModelError("");
    const config = buildConfig();
    const traceDetails = {
      type: "cutready.ai.model_fetch",
      provider: config.provider,
      provider_id: config.provider_id ?? null,
      provider_name: config.provider_name ?? null,
      auth_mode: settings.aiAuthMode,
      endpoint_present: Boolean(config.endpoint),
      api_key_present: Boolean(config.api_key),
      bearer_token_present: Boolean(config.bearer_token),
      model: config.model === "unused" ? "" : config.model,
      can_fetch_models: canFetchModels,
    };
    console.info({ ...traceDetails, phase: "start" });
    try {
      const result = await invoke<ModelInfo[]>("list_models", {
        config,
      });
      console.info({ ...traceDetails, phase: "success", model_count: result.length });
      setModels(result);
    } catch (e) {
      console.warn({ ...traceDetails, phase: "error", error: String(e) });
      setModelError(String(e));
    } finally {
      setLoadingModels(false);
    }
  };

  const startOAuthFlow = async () => {
    setOauthStatus("waiting");
    setOauthError("");
    try {
      const init = await invoke<AuthCodeFlowInit>("azure_browser_auth_start", {
        tenantId: settings.aiTenantId || "",
        clientId: settings.aiClientId || null,
      });
      try {
        await shellOpen(init.auth_url);
      } catch {
        // Fallback: user can still copy/paste the URL
      }
      setOauthStatus("polling");
      const token = await invoke<TokenResponse>("azure_browser_auth_complete", {
        tenantId: settings.aiTenantId || "",
        clientId: settings.aiClientId || null,
        timeout: 300,
      });
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
    await updateSetting("aiManagementToken", "");
    await updateSetting("aiSubscriptionId", "");
    await updateSetting("aiResourceGroup", "");
    await updateSetting("aiResourceName", "");
    setOauthStatus("idle");
  };

  if (!loaded) {
    return (
      <div className="flex items-center justify-center h-full text-[rgb(var(--color-text-secondary))]">
        Loading settings...
      </div>
    );
  }

  const isAzure = settings.aiProvider === "azure_openai";
  const isFoundry = settings.aiProvider === "microsoft_foundry";
  const isAnthropic = settings.aiProvider === "anthropic";
  const isOAuth =
    (isAzure || isFoundry) && settings.aiAuthMode === "azure_oauth";
  const hasToken = !!settings.aiAccessToken;
  const canFetchModels = canFetchModelsFor(settings);

  const tabMeta: Record<SettingsTab, {
    label: string;
    eyebrow: string;
    description: string;
    icon: ReactNode;
    keywords: string;
  }> = {
    display: {
      label: "Display",
      eyebrow: "Studio ergonomics",
      description: "Tune density, typography, terminal colors, and how CutReady presents your work.",
      icon: <MonitorCog className="h-4 w-4" />,
      keywords: "display font size density editor terminal rows",
    },
    themes: {
      label: "Themes",
      eyebrow: "Visual language",
      description: "Choose the warm CutReady palette and row color system for your demo workspace.",
      icon: <Palette className="h-4 w-4" />,
      keywords: "theme palette colors appearance light dark",
    },
    recording: {
      label: "Recording",
      eyebrow: "Capture defaults",
      description: "Set default devices, tracks, countdowns, and output quality for new recording takes.",
      icon: <Mic2 className="h-4 w-4" />,
      keywords: "recording microphone camera audio capture ffmpeg",
    },
    ai: {
      label: "AI providers",
      eyebrow: "Model connection",
      description: "Connect Foundry, Azure OpenAI, OpenAI-compatible, or Anthropic providers.",
      icon: <Bot className="h-4 w-4" />,
      keywords: "ai provider model foundry azure openai anthropic oauth token",
    },
    agents: {
      label: "Agents",
      eyebrow: "Assistant behavior",
      description: "Customize planner, writer, editor, designer, and tool-application defaults.",
      icon: <SlidersHorizontal className="h-4 w-4" />,
      keywords: "agents planner writer editor designer apply behavior",
    },
    memory: {
      label: "Memory",
      eyebrow: "Project recall",
      description: "Inspect local agent recall and workspace memory stored with this project.",
      icon: <Brain className="h-4 w-4" />,
      keywords: "memory recall agent state database",
    },
    feedback: {
      label: "Feedback",
      eyebrow: "Diagnostics",
      description: "Review feedback drafts, attachments, and diagnostic capture preferences.",
      icon: <MessageCircleWarning className="h-4 w-4" />,
      keywords: "feedback diagnostics logs attachments auditaur",
    },
    repository: {
      label: "Git remote",
      eyebrow: "Collaboration",
      description: "Manage the Draftline-backed remote used for syncing this CutReady project.",
      icon: <GitBranch className="h-4 w-4" />,
      keywords: "git remote repository draftline sync collaboration",
    },
    updates: {
      label: "Updates",
      eyebrow: "App freshness",
      description: "Check the installed version and control automatic update behavior.",
      icon: <DownloadCloud className="h-4 w-4" />,
      keywords: "updates version release auto update",
    },
    experimental: {
      label: "Experimental",
      eyebrow: "Preview switches",
      description: "Enable feature previews that are still being shaped and tested.",
      icon: <FlaskConical className="h-4 w-4" />,
      keywords: "experimental feature flags preview recording",
    },
  };
  const activeMeta = tabMeta[activeTab];
  const normalizedFilter = settingsFilter.trim().toLowerCase();
  const visibleTabs = normalizedFilter
    ? tabs.filter((tab) => {
        const meta = tabMeta[tab];
        return `${meta.label} ${meta.eyebrow} ${meta.description} ${meta.keywords}`
          .toLowerCase()
          .includes(normalizedFilter);
      })
    : tabs;
  const projectLocation = currentProject?.root ?? "Open a project to configure workspace settings.";

  return (
    <div className="h-full overflow-hidden bg-[rgb(var(--color-overlay-scrim))]/12 px-5 py-6 backdrop-blur-[2px]">
      <div className="mx-auto flex h-full max-w-7xl overflow-hidden rounded-xl border border-[rgb(var(--color-border))] bg-[rgb(var(--color-surface))] shadow-2xl shadow-[rgb(var(--color-overlay-scrim)/0.18)]">
        <aside className="flex w-[19rem] shrink-0 flex-col border-r border-[rgb(var(--color-border-subtle))] bg-[rgb(var(--color-surface-alt))]">
          <div className="border-b border-[rgb(var(--color-border-subtle))] p-5">
            <div className="flex items-start gap-3">
              <img
                src="/cutready-mark.svg"
                alt=""
                aria-hidden="true"
                draggable={false}
                className="h-11 w-11 shrink-0 drop-shadow-lg"
              />
              <div className="min-w-0">
                <div className="truncate text-sm font-semibold text-[rgb(var(--color-text))]">
                  CutReady
                </div>
                <div className="mt-0.5 truncate text-xs text-[rgb(var(--color-text-secondary))]">
                  Demo production settings
                </div>
              </div>
            </div>

            <div className="relative mt-5">
              <Search className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-[rgb(var(--color-text-secondary))]" />
              <input
                value={settingsFilter}
                onChange={(event) => setSettingsFilter(event.target.value)}
                placeholder="Search settings..."
                data-testid="settings-search"
                className="w-full rounded-lg border border-[rgb(var(--color-border))] bg-[rgb(var(--color-surface))] py-2 pl-9 pr-3 text-sm text-[rgb(var(--color-text))] placeholder:text-[rgb(var(--color-text-secondary))]/60 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[rgb(var(--color-accent))]/35"
              />
            </div>

            {currentProject && (
              <div className="mt-4 grid grid-cols-2 gap-1 rounded-lg bg-[rgb(var(--color-surface-inset))] p-1">
                <button
                  type="button"
                  data-testid="settings-scope-app"
                  onClick={() => {
                    setScope("app");
                    setActiveTab("display");
                  }}
                  className={`rounded-md px-3 py-2 text-xs font-medium transition-colors ${
                    scope === "app"
                      ? "bg-[rgb(var(--color-surface))] text-[rgb(var(--color-text))] shadow-sm"
                      : "text-[rgb(var(--color-text-secondary))] hover:text-[rgb(var(--color-text))]"
                  }`}
                >
                  App
                </button>
                <button
                  type="button"
                  data-testid="settings-scope-workspace"
                  onClick={() => {
                    setScope("workspace");
                    setActiveTab("repository");
                  }}
                  className={`rounded-md px-3 py-2 text-xs font-medium transition-colors ${
                    scope === "workspace"
                      ? "bg-[rgb(var(--color-surface))] text-[rgb(var(--color-text))] shadow-sm"
                      : "text-[rgb(var(--color-text-secondary))] hover:text-[rgb(var(--color-text))]"
                  }`}
                >
                  Workspace
                </button>
              </div>
            )}
          </div>

          <div className="min-h-0 flex-1 overflow-y-auto p-3">
            <div className="mb-2 px-2 text-[11px] font-semibold uppercase tracking-[0.14em] text-[rgb(var(--color-text-secondary))]">
              {scope === "workspace" ? "Workspace" : "General"}
            </div>
            <div className="space-y-1">
              {visibleTabs.map((tab) => {
                const meta = tabMeta[tab];
                const active = activeTab === tab;
                return (
                  <button
                    key={tab}
                    type="button"
                    onClick={() => setActiveTab(tab)}
                    data-testid={`settings-tab-${tab}`}
                    className={`group flex w-full items-center gap-3 rounded-lg px-3 py-2.5 text-left transition-colors ${
                      active
                        ? "bg-[rgb(var(--color-surface))] text-[rgb(var(--color-text))] shadow-sm"
                        : "text-[rgb(var(--color-text-secondary))] hover:bg-[rgb(var(--color-surface))] hover:text-[rgb(var(--color-text))]"
                    }`}
                  >
                    <span className={`grid h-8 w-8 shrink-0 place-items-center rounded-lg border transition-colors ${
                      active
                        ? "border-[rgb(var(--color-accent))]/30 bg-[rgb(var(--color-accent))]/12 text-[rgb(var(--color-accent))]"
                        : "border-[rgb(var(--color-border-subtle))] bg-[rgb(var(--color-surface))] text-[rgb(var(--color-text-secondary))] group-hover:text-[rgb(var(--color-text))]"
                    }`}>
                      {meta.icon}
                    </span>
                    <span className="min-w-0">
                      <span className="block truncate text-sm font-medium">{meta.label}</span>
                      <span className="block truncate text-[11px] text-[rgb(var(--color-text-secondary))]">
                        {meta.eyebrow}
                      </span>
                    </span>
                  </button>
                );
              })}
            </div>
            {visibleTabs.length === 0 && (
              <div className="rounded-lg border border-dashed border-[rgb(var(--color-border))] px-3 py-5 text-center text-xs text-[rgb(var(--color-text-secondary))]">
                No settings match "{settingsFilter}".
              </div>
            )}
          </div>

          <div className="border-t border-[rgb(var(--color-border-subtle))] p-4">
            <div className="flex items-center gap-2 rounded-lg bg-[rgb(var(--color-surface))] p-3 text-xs text-[rgb(var(--color-text-secondary))]">
              <FolderGit2 className="h-4 w-4 shrink-0 text-[rgb(var(--color-accent))]" />
              <div className="min-w-0">
                <div className="font-medium text-[rgb(var(--color-text))]">
                  {currentProject?.name ?? "No project open"}
                </div>
                <div className="truncate">{projectLocation}</div>
              </div>
            </div>
          </div>
        </aside>

        <main className="flex min-w-0 flex-1 flex-col overflow-hidden">
          <div className="shrink-0 border-b border-[rgb(var(--color-border-subtle))] bg-[rgb(var(--color-surface))] px-6 py-4">
            <div className="flex items-start justify-between gap-4">
              <div>
                <div className="text-[11px] font-semibold uppercase tracking-[0.16em] text-[rgb(var(--color-accent))]">
                  {activeMeta.eyebrow}
                </div>
                <h1 className="mt-0.5 text-xl font-semibold tracking-tight text-[rgb(var(--color-text))]">
                  {activeMeta.label}
                </h1>
                <p className="mt-1 max-w-3xl text-sm leading-5 text-[rgb(var(--color-text-secondary))]">
                  {activeMeta.description}
                </p>
              </div>
              <button
                type="button"
                data-testid="settings-close"
                onClick={() => {
                  if (onClose) {
                    onClose();
                    return;
                  }
                  setView(currentProject ? "project" : "home");
                }}
                className="grid h-9 w-9 shrink-0 place-items-center rounded-lg text-[rgb(var(--color-text-secondary))] transition-colors hover:bg-[rgb(var(--color-surface-alt))] hover:text-[rgb(var(--color-text))]"
                aria-label="Close settings"
              >
                <X className="h-4 w-4" />
              </button>
            </div>
          </div>

          <div className="min-h-0 flex-1 overflow-y-auto px-6 py-5">
            <div className="mx-auto max-w-5xl">
              {activeTab === "display" && (
                <DisplayTab settings={settings} updateSetting={updateSetting} />
              )}
              {activeTab === "themes" && (
                <ThemesTab settings={settings} updateSetting={updateSetting} />
              )}
              {activeTab === "recording" && (
                <RecordingTab settings={settings} updateSetting={updateSetting} />
              )}
              {activeTab === "ai" && (
                <AIProviderTab
                  settings={settings}
                  updateSetting={updateSetting}
                  isAzure={isAzure}
                  isFoundry={isFoundry}
                  isAnthropic={isAnthropic}
                  isOAuth={isOAuth}
                  hasToken={hasToken}
                  canFetchModels={canFetchModels}
                  models={models}
                  setModels={setModels}
                  loadingModels={loadingModels}
                  modelFilter={modelFilter}
                  setModelFilter={setModelFilter}
                  modelError={modelError}
                  fetchModels={fetchModels}
                  oauthStatus={oauthStatus}
                  oauthError={oauthError}
                  startOAuthFlow={startOAuthFlow}
                  signOut={signOut}
                />
              )}
              {activeTab === "agents" && (
                <AgentsTab
                  settings={settings}
                  updateSetting={updateSetting}
                  models={models}
                  loadingModels={loadingModels}
                  canFetchModels={canFetchModels}
                  fetchModels={fetchModels}
                  modelError={modelError}
                />
              )}
              {activeTab === "memory" && (
                <MemoryTab />
              )}
              {activeTab === "feedback" && (
                <FeedbackListTab />
              )}
              {activeTab === "repository" && (
                <RepositoryTab settings={settings} updateSetting={updateSetting} />
              )}
              {activeTab === "updates" && (
                <UpdatesTab />
              )}
              {activeTab === "experimental" && (
                <ExperimentalTab settings={settings} updateSetting={updateSetting} />
              )}
            </div>
          </div>
        </main>
      </div>
    </div>
  );
}

// ── Display Tab ──────────────────────────────────────────────────

const fontSizes = [
  { value: 13, label: "Small (13px)" },
  { value: 14, label: "Medium (14px)" },
  { value: 16, label: "Large (16px)" },
  { value: 18, label: "XL (18px)" },
];

const terminalFontSizes = [
  { value: 11, label: "Small (11px)" },
  { value: 12, label: "Medium (12px)" },
  { value: 14, label: "Large (14px)" },
  { value: 16, label: "XL (16px)" },
];

const terminalCustomColorFields: Array<{
  key: keyof TerminalCustomTheme;
  label: string;
}> = [
  { key: "background", label: "Background" },
  { key: "foreground", label: "Foreground" },
  { key: "cursor", label: "Cursor" },
  { key: "selectionBackground", label: "Selection" },
];

function tokenRgb(value: string): string {
  return `rgb(${value})`;
}

// ── Recording Tab ─────────────────────────────────────────────────

function RecordingTab({
  settings,
  updateSetting,
}: {
  settings: ReturnType<typeof useSettings>["settings"];
  updateSetting: ReturnType<typeof useSettings>["updateSetting"];
}) {
  const { discovery, microphones, cameras, systemAudioDevices, loading, error, refresh } = useRecordingDevices();
  const [clearingRecordings, setClearingRecordings] = useState(false);
  const { confirm, confirmationDialog } = useConfirmDialog();
  const deviceError = error ?? (discovery.devices.length === 0 ? discovery.ffmpeg.error : null);

  const clearRecordings = async () => {
    const confirmed = await confirm({
      title: "Clear local recordings?",
      message: "Clear all local recording takes for this project? This cannot be undone.",
      confirmLabel: "Clear recordings",
      variant: "error",
    });
    if (!confirmed) return;

    setClearingRecordings(true);
    try {
      const removed = await invoke<number>("clear_local_recordings");
      useToastStore.getState().show(
        removed === 1 ? "Cleared 1 local recording item." : `Cleared ${removed} local recording items.`,
        3000,
        "info",
      );
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      useToastStore.getState().show(`Unable to clear recordings: ${message}`, 4000, "error");
    } finally {
      setClearingRecordings(false);
    }
  };

  return (
    <div className="flex flex-col gap-6">
      <p className="text-xs text-[rgb(var(--color-text-secondary))]">
        These defaults apply to new sketch and storyboard recording takes. Each take stores a snapshot of the effective settings used for that recording.
      </p>

      <div className="grid gap-4 md:grid-cols-2">
        <label className="block space-y-1.5">
          <span className="text-xs font-medium text-[rgb(var(--color-text-secondary))]">Default source</span>
          <select
            value="full_screen"
            onChange={(e) => updateSetting("recorderCaptureSource", e.target.value as typeof settings.recorderCaptureSource)}
            className={`${inputClass} w-full`}
          >
            <option value="full_screen">Full screen</option>
            <option value="region" disabled>Region (coming next)</option>
            <option value="window" disabled>Window (coming next)</option>
          </select>
          <p className="text-[10px] text-[rgb(var(--color-text-secondary))]">
            This build records a chosen monitor. Region and window capture will reuse CutReady's capture picker in a follow-up slice.
          </p>
        </label>

        <label className="block space-y-1.5">
          <span className="text-xs font-medium text-[rgb(var(--color-text-secondary))]">Default microphone</span>
          <select
            value={settings.recorderMicDeviceId || "default"}
            onChange={(e) => updateSetting("recorderMicDeviceId", e.target.value === "default" ? "" : e.target.value)}
            className={`${inputClass} w-full`}
          >
            <option value="default">No microphone</option>
            {microphones.map((device) => (
              <option key={device.id} value={device.id}>
                {device.is_default ? `${device.label} (default)` : device.label}
              </option>
            ))}
          </select>
          <div className="flex items-center justify-between gap-2 text-[10px] text-[rgb(var(--color-text-secondary))]">
            <span>
              {recordingDeviceStatusText(loading, deviceError, microphones.length)}
            </span>
            <button
              type="button"
              onClick={refresh}
              disabled={loading}
              className="font-medium text-[rgb(var(--color-accent))] transition-colors hover:text-[rgb(var(--color-accent-hover))] disabled:cursor-not-allowed disabled:opacity-60"
            >
              Refresh
            </button>
          </div>
        </label>

        <label className="block space-y-1.5">
          <span className="text-xs font-medium text-[rgb(var(--color-text-secondary))]">Default camera</span>
          <select
            value={settings.recorderCameraEnabled ? settings.recorderCameraDeviceId || "" : ""}
            onChange={(e) => {
              void updateSetting("recorderCameraDeviceId", e.target.value);
              void updateSetting("recorderCameraEnabled", e.target.value !== "");
            }}
            className={`${inputClass} w-full`}
          >
            <option value="">No camera</option>
            {cameras.map((device) => (
              <option key={device.id} value={device.id}>
                {device.label}
              </option>
            ))}
          </select>
          <p className="text-[10px] text-[rgb(var(--color-text-secondary))]">
            Optional separate camera.mp4 track for edit-ready timelines.
          </p>
        </label>

        <label className="block space-y-1.5">
          <span className="text-xs font-medium text-[rgb(var(--color-text-secondary))]">Countdown</span>
          <select
            value={settings.recorderCountdownSeconds}
            onChange={(e) => updateSetting("recorderCountdownSeconds", Number(e.target.value))}
            className={`${inputClass} w-full`}
          >
            <option value={0}>None</option>
            <option value={3}>3 seconds</option>
            <option value={5}>5 seconds</option>
          </select>
        </label>

        <label className="block space-y-1.5">
          <span className="text-xs font-medium text-[rgb(var(--color-text-secondary))]">Frame rate</span>
          <select
            value={settings.recorderFrameRate}
            onChange={(e) => updateSetting("recorderFrameRate", Number(e.target.value))}
            className={`${inputClass} w-full`}
          >
            <option value={30}>30 fps</option>
            <option value={60}>60 fps</option>
          </select>
        </label>

        <label className="block space-y-1.5">
          <span className="text-xs font-medium text-[rgb(var(--color-text-secondary))]">Output quality</span>
          <select
            value={settings.recorderOutputQuality}
            onChange={(e) => updateSetting("recorderOutputQuality", e.target.value as typeof settings.recorderOutputQuality)}
            className={`${inputClass} w-full`}
          >
            <option value="high">High - smooth MP4 (recommended)</option>
            <option value="compact">Compact - smaller MP4</option>
            <option value="lossless">Lossless - heavy MKV master</option>
          </select>
          <p className="text-[10px] text-[rgb(var(--color-text-secondary))]">
            Use High for smooth capture and playback. Lossless keeps an edit master but can be heavy on real-time capture.
          </p>
        </label>
      </div>

      <div className="rounded-xl border border-[rgb(var(--color-border))] bg-[rgb(var(--color-surface-alt))]/50 p-4">
        <div className="mb-3 text-sm font-medium text-[rgb(var(--color-text))]">Tracks</div>
        <div className="grid gap-3 md:grid-cols-3">
          <label className="flex items-center justify-between gap-3 rounded-lg bg-[rgb(var(--color-surface))] px-3 py-2">
            <span className="text-xs text-[rgb(var(--color-text))]">Include cursor</span>
            <input
              type="checkbox"
              checked={settings.recorderIncludeCursor}
              onChange={(e) => updateSetting("recorderIncludeCursor", e.target.checked)}
              className="h-4 w-4 accent-[rgb(var(--color-accent))]"
            />
          </label>
          <label className="flex items-center justify-between gap-3 rounded-lg bg-[rgb(var(--color-surface))] px-3 py-2">
            <span>
              <span className="block text-xs text-[rgb(var(--color-text))]">Camera asset</span>
              <span className="text-[10px] text-[rgb(var(--color-text-secondary))]">Separate camera.mp4</span>
            </span>
            <input
              type="checkbox"
              checked={settings.recorderCameraEnabled}
              onChange={(e) => {
                void updateSetting("recorderCameraEnabled", e.target.checked);
                if (e.target.checked && !settings.recorderCameraDeviceId && cameras[0]) {
                  void updateSetting("recorderCameraDeviceId", cameras[0].id);
                }
              }}
              disabled={cameras.length === 0}
              className="h-4 w-4 accent-[rgb(var(--color-accent))] disabled:opacity-40"
              aria-label="Camera asset default"
            />
          </label>
          <label className="flex items-center justify-between gap-3 rounded-lg bg-[rgb(var(--color-surface))] px-3 py-2">
            <span>
              <span className="block text-xs text-[rgb(var(--color-text))]">System audio asset</span>
              <span className="text-[10px] text-[rgb(var(--color-text-secondary))]">
                {systemAudioDevices.length > 0 ? "Separate system-audio.wav" : "Uses Windows default output"}
              </span>
            </span>
            <input
              type="checkbox"
              checked={settings.recorderSystemAudioEnabled}
              onChange={(e) => updateSetting("recorderSystemAudioEnabled", e.target.checked)}
              className="h-4 w-4 accent-[rgb(var(--color-accent))]"
              aria-label="System audio asset default"
            />
          </label>
        </div>
      </div>

      <div className="rounded-xl border border-[rgb(var(--color-border))] bg-[rgb(var(--color-surface-alt))]/50 p-4">
        <div className="flex items-start justify-between gap-4">
          <div>
            <div className="text-sm font-medium text-[rgb(var(--color-text))]">Local recording storage</div>
            <p className="mt-1 text-xs text-[rgb(var(--color-text-secondary))]">
              Recording media stays in this project under .cutready/recordings and is excluded from git.
            </p>
          </div>
          <button
            type="button"
            onClick={clearRecordings}
            disabled={clearingRecordings}
            className="inline-flex items-center gap-2 rounded-lg border border-[rgb(var(--color-border))] px-3 py-2 text-xs font-medium text-[rgb(var(--color-text))] transition-colors hover:bg-[rgb(var(--color-surface))] disabled:cursor-not-allowed disabled:opacity-60"
          >
            <Trash2 className="h-3.5 w-3.5" />
            {clearingRecordings ? "Clearing..." : "Clear local recordings"}
          </button>
        </div>
      </div>
      {confirmationDialog}
    </div>
  );
}

function recordingDeviceStatusText(
  loading: boolean,
  error: string | null,
  microphoneCount: number,
) {
  if (loading) return "Detecting Windows audio devices...";
  if (error) return "Could not detect recording devices.";
  if (microphoneCount === 0) return "No active Windows microphones were detected.";
  return `${microphoneCount} Windows microphone${microphoneCount === 1 ? "" : "s"} detected`;
}

function ThemePaletteCard({
  palette,
  selected,
  onSelect,
  theme,
}: {
  palette: ThemePalette;
  selected: boolean;
  onSelect: () => void;
  theme: "light" | "dark";
}) {
  const preview = palette[theme];
  const swatches = [preview.surface, preview.surfaceAlt, preview.accent, preview.secondary].map(tokenRgb);
  return (
    <button
      onClick={onSelect}
      className={`group overflow-hidden rounded-xl border text-left transition-all ${
        selected
          ? "border-[rgb(var(--color-accent))] ring-1 ring-[rgb(var(--color-accent))]/40"
          : "border-[rgb(var(--color-border))] hover:border-[rgb(var(--color-accent))]/60"
      }`}
      aria-pressed={selected}
    >
      <div
        className="h-24 p-3"
        style={{
          backgroundColor: tokenRgb(preview.surface),
          color: tokenRgb(preview.text),
        }}
      >
        <div className="flex items-center gap-1.5">
          <span className="h-1.5 w-1.5 rounded-full" style={{ backgroundColor: tokenRgb(preview.textSecondary) }} />
          <span className="h-1.5 w-1.5 rounded-full" style={{ backgroundColor: tokenRgb(preview.textSecondary) }} />
          <span className="h-1.5 w-1.5 rounded-full" style={{ backgroundColor: tokenRgb(preview.textSecondary) }} />
          <span className="ml-auto h-2 w-8 rounded-full" style={{ backgroundColor: tokenRgb(preview.accent) }} />
        </div>
        <div className="mt-4 grid grid-cols-[0.65fr_1fr] gap-3">
          <div className="space-y-2">
            <div className="h-2 w-16 rounded-full" style={{ backgroundColor: tokenRgb(preview.surfaceAlt) }} />
            <div className="h-2 w-12 rounded-full" style={{ backgroundColor: tokenRgb(preview.surfaceAlt) }} />
            <div className="h-2 w-9 rounded-full" style={{ backgroundColor: tokenRgb(preview.surfaceAlt) }} />
          </div>
          <div className="space-y-2">
            <div className="h-2 w-full rounded-full" style={{ backgroundColor: tokenRgb(preview.borderSubtle) }} />
            <div className="h-2 w-5/6 rounded-full" style={{ backgroundColor: tokenRgb(preview.borderSubtle) }} />
            <div className="flex flex-wrap gap-1">
              {swatches.map((swatch) => (
                <span key={swatch} className="h-1.5 flex-1 rounded-full" style={{ backgroundColor: swatch }} />
              ))}
            </div>
          </div>
        </div>
      </div>
      <div className="flex items-center gap-2 bg-[rgb(var(--color-surface-alt))] px-3 py-2">
        <div className="min-w-0">
          <div className="truncate text-sm font-medium text-[rgb(var(--color-text))]">{palette.name}</div>
          <div className="truncate text-[10px] text-[rgb(var(--color-text-secondary))]">{palette.description}</div>
        </div>
        {selected && (
          <span className="ml-auto rounded-full bg-[rgb(var(--color-accent))]/10 px-2 py-0.5 text-[10px] font-medium text-[rgb(var(--color-accent))]">
            Active
          </span>
        )}
      </div>
    </button>
  );
}

function ThemesTab({ settings, updateSetting }: {
  settings: ReturnType<typeof useSettings>["settings"];
  updateSetting: ReturnType<typeof useSettings>["updateSetting"];
}) {
  const { preference, theme, setTheme } = useTheme();

  return (
    <div className="flex flex-col gap-6">
      <fieldset className="flex flex-col gap-3">
        <div>
          <label className="text-sm font-medium">Theme Mode</label>
          <p className="mt-1 text-xs text-[rgb(var(--color-text-secondary))]">Choose light, dark, or follow your system appearance.</p>
        </div>
        <div className="inline-flex w-fit rounded-xl bg-[rgb(var(--color-surface-alt))] p-1 border border-[rgb(var(--color-border))]">
          {(["system", "light", "dark"] as ThemePreference[]).map((mode) => (
            <button
              key={mode}
              onClick={() => setTheme(mode)}
              className={`px-3 py-1.5 rounded-lg text-sm font-medium capitalize transition-colors ${
                preference === mode
                  ? "bg-[rgb(var(--color-surface))] text-[rgb(var(--color-text))] shadow-sm"
                  : "text-[rgb(var(--color-text-secondary))] hover:text-[rgb(var(--color-text))]"
              }`}
            >
              {mode}
            </button>
          ))}
        </div>
      </fieldset>

      <fieldset className="flex flex-col gap-3">
        <div>
          <label className="text-sm font-medium">Theme Palette</label>
          <p className="mt-1 text-xs text-[rgb(var(--color-text-secondary))]">Pick the token palette used across app surfaces, borders, text, and accent states.</p>
        </div>
        <div className="grid grid-cols-1 gap-3 sm:grid-cols-2 xl:grid-cols-3">
          {THEME_PALETTES.map((palette) => (
            <ThemePaletteCard
              key={palette.id}
              palette={palette}
              selected={settings.displayThemePalette === palette.id}
              onSelect={() => updateSetting("displayThemePalette", palette.id)}
              theme={theme}
            />
          ))}
        </div>
      </fieldset>

    </div>
  );
}

function DisplayTab({ settings, updateSetting }: {
  settings: ReturnType<typeof useSettings>["settings"];
  updateSetting: ReturnType<typeof useSettings>["updateSetting"];
}) {
  const terminalColorMode = normalizeTerminalColorMode(settings.displayTerminalColorMode);
  const terminalCustomTheme = normalizeTerminalCustomTheme(settings.displayTerminalCustomTheme);
  const updateTerminalCustomColor = (key: keyof TerminalCustomTheme, value: string) => {
    void updateSetting("displayTerminalCustomTheme", { ...terminalCustomTheme, [key]: value });
  };

  return (
    <div className="flex flex-col gap-6">
      {/* Font family */}
      <fieldset className="flex flex-col gap-2">
        <label className="text-sm font-medium">Font</label>
        <div className="flex gap-2">
          {([
            { id: "system", label: "System", preview: "Geist Sans" },
            { id: "sans", label: "Sans", preview: "Inter" },
            { id: "serif", label: "Serif", preview: "Lora" },
            { id: "mono", label: "Mono", preview: "Geist Mono" },
          ] as const).map((f) => (
            <button
              key={f.id}
              onClick={() => updateSetting("displayFontFamily", f.id)}
              className={`flex-1 flex flex-col items-center gap-1 px-3 py-2.5 rounded-lg text-sm transition-colors border ${
                settings.displayFontFamily === f.id
                  ? "bg-[rgb(var(--color-accent))] text-[rgb(var(--color-accent-fg))] border-[rgb(var(--color-accent))]"
                  : "bg-[rgb(var(--color-surface-alt))] border-[rgb(var(--color-border))] text-[rgb(var(--color-text-secondary))] hover:text-[rgb(var(--color-text))]"
              }`}
            >
              <span
                className="text-base leading-none"
                style={{ fontFamily: f.id === "system" ? "var(--app-font-family)" :
                  f.id === "sans" ? '"Inter", "Helvetica Neue", sans-serif' :
                  f.id === "serif" ? '"Lora", Georgia, serif' :
                  '"Geist Mono", "Cascadia Code", monospace' }}
              >
                Aa
              </span>
              <span className="text-[10px]">{f.label}</span>
            </button>
          ))}
        </div>
        <p className="text-xs text-[rgb(var(--color-text-secondary))]">Font used throughout the app. Serif and Sans require web fonts to be available.</p>
      </fieldset>

      {/* Editor text size */}
      <fieldset className="flex flex-col gap-2">
        <label className="text-sm font-medium">Editor Text Size</label>
        <select
          value={settings.displayFontSize}
          onChange={(e) => updateSetting("displayFontSize", Number(e.target.value))}
          className={inputClass}
        >
          {fontSizes.map((s) => (
            <option key={s.value} value={s.value}>{s.label}</option>
          ))}
        </select>
        <p className="text-xs text-[rgb(var(--color-text-secondary))]">Text size for the sketch editor and planning table.</p>
      </fieldset>

      {/* Chat text size */}
      <fieldset className="flex flex-col gap-2">
        <label className="text-sm font-medium">Chat Text Size</label>
        <select
          value={settings.displayChatFontSize}
          onChange={(e) => updateSetting("displayChatFontSize", Number(e.target.value))}
          className={inputClass}
        >
          {fontSizes.map((s) => (
            <option key={s.value} value={s.value}>{s.label}</option>
          ))}
        </select>
        <p className="text-xs text-[rgb(var(--color-text-secondary))]">Text size for the chat panel.</p>
      </fieldset>

      {/* Terminal appearance */}
      <fieldset className="flex flex-col gap-3 rounded-xl border border-[rgb(var(--color-border))] bg-[rgb(var(--color-surface-alt))]/40 p-4">
        <div>
          <label className="text-sm font-medium">Terminal Appearance</label>
          <p className="mt-1 text-xs text-[rgb(var(--color-text-secondary))]">
            Use a Nerd Font for prompt glyphs, then choose a built-in terminal palette or customize key colors.
          </p>
        </div>

        <label className="flex flex-col gap-1.5">
          <span className="text-xs font-medium text-[rgb(var(--color-text-secondary))]">Terminal Font Family</span>
          <input
            value={settings.displayTerminalFontFamily}
            onChange={(e) => updateSetting("displayTerminalFontFamily", e.target.value)}
            className={inputClass}
            spellCheck={false}
            placeholder={'"CaskaydiaCove Nerd Font", "Cascadia Code", Consolas, monospace'}
          />
        </label>

        <div className="grid gap-3 sm:grid-cols-2">
          <label className="flex flex-col gap-1.5">
            <span className="text-xs font-medium text-[rgb(var(--color-text-secondary))]">Terminal Text Size</span>
            <select
              value={settings.displayTerminalFontSize}
              onChange={(e) => updateSetting("displayTerminalFontSize", Number(e.target.value))}
              className={inputClass}
            >
              {terminalFontSizes.map((s) => (
                <option key={s.value} value={s.value}>{s.label}</option>
              ))}
            </select>
          </label>

          <div className="flex flex-col gap-1.5">
            <span className="text-xs font-medium text-[rgb(var(--color-text-secondary))]">Terminal Colors</span>
            <div className="grid grid-cols-2 gap-2">
              {TERMINAL_COLOR_SCHEMES.map((mode) => (
                <button
                  key={mode.id}
                  onClick={() => updateSetting("displayTerminalColorMode", mode.id)}
                  title={mode.description}
                  className={`rounded-lg border px-3 py-2 text-left text-xs font-medium transition-colors ${
                    terminalColorMode === mode.id
                      ? "border-[rgb(var(--color-accent))] bg-[rgb(var(--color-accent))] text-[rgb(var(--color-accent-fg))]"
                      : "border-[rgb(var(--color-border))] bg-[rgb(var(--color-surface))] text-[rgb(var(--color-text-secondary))] hover:text-[rgb(var(--color-text))]"
                  }`}
                >
                  {mode.label}
                </button>
              ))}
            </div>
          </div>
        </div>

        {terminalColorMode === "custom" && (
          <div className="grid gap-3 rounded-lg border border-[rgb(var(--color-border))] bg-[rgb(var(--color-surface))] p-3 sm:grid-cols-2">
            {terminalCustomColorFields.map((field) => (
              <label key={field.key} className="flex items-center justify-between gap-3 text-xs font-medium text-[rgb(var(--color-text-secondary))]">
                <span>{field.label}</span>
                <input
                  type="color"
                  value={terminalCustomTheme[field.key]}
                  onChange={(event) => updateTerminalCustomColor(field.key, event.target.value)}
                  className="h-8 w-14 cursor-pointer rounded border border-[rgb(var(--color-border))] bg-[rgb(var(--color-surface-alt))]"
                  aria-label={`Terminal ${field.label.toLowerCase()} color`}
                />
              </label>
            ))}
          </div>
        )}
      </fieldset>

      {/* Row density */}
      <fieldset className="flex flex-col gap-2">
        <label className="text-sm font-medium">Row Density</label>
        <div className="flex gap-2">
          {(["compact", "comfortable", "spacious"] as const).map((d) => (
            <button
              key={d}
              onClick={() => updateSetting("displayRowDensity", d)}
              className={`px-3 py-1.5 rounded-lg text-sm capitalize transition-colors border ${
                settings.displayRowDensity === d
                  ? "bg-[rgb(var(--color-accent))] text-[rgb(var(--color-accent-fg))] border-[rgb(var(--color-accent))]"
                  : "bg-[rgb(var(--color-surface-alt))] border-[rgb(var(--color-border))] text-[rgb(var(--color-text-secondary))] hover:text-[rgb(var(--color-text))]"
              }`}
            >
              {d}
            </button>
          ))}
        </div>
        <p className="text-xs text-[rgb(var(--color-text-secondary))]">Controls padding and line-height in planning table rows.</p>
      </fieldset>

      {/* Row colors */}
      <fieldset className="flex flex-col gap-2">
        <label className="text-sm font-medium">Row Color Palette</label>
        <div className="flex gap-2">
          {(["neutral", "pastel", "vivid"] as const).map((c) => (
            <button
              key={c}
              onClick={() => updateSetting("displayRowColors", c)}
              className={`px-3 py-1.5 rounded-lg text-sm capitalize transition-colors border ${
                settings.displayRowColors === c
                  ? "bg-[rgb(var(--color-accent))] text-[rgb(var(--color-accent-fg))] border-[rgb(var(--color-accent))]"
                  : "bg-[rgb(var(--color-surface-alt))] border-[rgb(var(--color-border))] text-[rgb(var(--color-text-secondary))] hover:text-[rgb(var(--color-text))]"
              }`}
            >
              {c}
            </button>
          ))}
        </div>
        <p className="text-xs text-[rgb(var(--color-text-secondary))]">Color intensity of the left stripe on planning rows.</p>
      </fieldset>

      {/* Editor width */}
      <fieldset className="flex flex-col gap-2">
        <label className="text-sm font-medium">Editor Width</label>
        <div className="flex gap-2">
          {(["centered", "full"] as const).map((w) => (
            <button
              key={w}
              onClick={() => updateSetting("displayEditorWidth", w)}
              className={`px-3 py-1.5 rounded-lg text-sm capitalize transition-colors border ${
                settings.displayEditorWidth === w
                  ? "bg-[rgb(var(--color-accent))] text-[rgb(var(--color-accent-fg))] border-[rgb(var(--color-accent))]"
                  : "bg-[rgb(var(--color-surface-alt))] border-[rgb(var(--color-border))] text-[rgb(var(--color-text-secondary))] hover:text-[rgb(var(--color-text))]"
              }`}
            >
              {w === "centered" ? "Centered (896px)" : "Full Width"}
            </button>
          ))}
        </div>
        <p className="text-xs text-[rgb(var(--color-text-secondary))]">Whether document editors use a max-width or expand to fill available space.</p>
      </fieldset>
    </div>
  );
}

// ── AI Provider Tab ──────────────────────────────────────────────

function AIProviderTab({ settings, updateSetting, isAzure, isFoundry, isAnthropic, isOAuth, hasToken, canFetchModels, models, setModels, loadingModels, modelFilter, setModelFilter, modelError, fetchModels, oauthStatus, oauthError, startOAuthFlow, signOut }: {
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
  const providerOptions: Array<{ value: "microsoft_foundry" | "azure_openai" | "openai" | "anthropic"; label: string; description: string }> = [
    { value: "microsoft_foundry", label: "Microsoft Foundry", description: "Entra or key-based Azure AI projects" },
    { value: "azure_openai", label: "Azure OpenAI", description: "Azure-hosted OpenAI deployments" },
    { value: "openai", label: "OpenAI", description: "OpenAI platform models and compatible endpoints" },
    { value: "anthropic", label: "Anthropic", description: "Claude models through Anthropic" },
  ];
  const [newProviderKind, setNewProviderKind] = useState<typeof providerOptions[number]["value"]>("openai");
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
            <h3 className="text-sm font-semibold text-[rgb(var(--color-text))]">Connected AI providers</h3>
            <p className="mt-1 text-xs leading-5 text-[rgb(var(--color-text-secondary))]">
              Manage provider connections here. Selecting a card only edits that connection; the Default badge controls runtime routing for chat, notes, and agents.
            </p>
          </div>
          <div className="flex flex-col gap-2 rounded-xl border border-[rgb(var(--color-border))] bg-[rgb(var(--color-surface))] p-2 sm:flex-row sm:items-center">
            <select
              value={newProviderKind}
              onChange={(e) => setNewProviderKind(e.target.value as typeof newProviderKind)}
              className={inputClass + " min-w-44 text-xs"}
              aria-label="Provider type to add"
            >
              {providerOptions.map((option) => (
                <option key={option.value} value={option.value}>{option.label}</option>
              ))}
            </select>
            <button
              type="button"
              onClick={() => void addProvider(newProviderKind)}
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
          value={settings.aiProvider}
          onChange={(e) => {
            updateSetting("aiProvider", e.target.value);
            setModels([]);
            if (
              e.target.value !== "azure_openai" &&
              e.target.value !== "microsoft_foundry"
            ) {
              updateSetting("aiAuthMode", "api_key");
            }
          }}
          className={inputClass}
        >
          <option value="microsoft_foundry">Microsoft Foundry</option>
          <option value="azure_openai">Azure OpenAI</option>
          <option value="openai">OpenAI</option>
          <option value="anthropic">Anthropic</option>
        </select>
      </fieldset>

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

      {/* Endpoint — hidden for Anthropic, auto-set for Foundry OAuth */}
      {!isAnthropic && !(isFoundry && isOAuth) && (
        <fieldset className="flex flex-col gap-2">
          <label className="text-sm font-medium">
            {isAzure ? "Endpoint" : "Endpoint (optional)"}
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
    </div>
  );
}

// ── Agents Tab ───────────────────────────────────────────────────

function AgentsTab({ settings, updateSetting, models, loadingModels, canFetchModels, fetchModels, modelError }: {
  settings: ReturnType<typeof useSettings>["settings"];
  updateSetting: ReturnType<typeof useSettings>["updateSetting"];
  models: ModelInfo[];
  loadingModels: boolean;
  canFetchModels: boolean;
  fetchModels: () => void;
  modelError: string;
}) {
  const [editingId, setEditingId] = useState<string | null>(null);
  const [newName, setNewName] = useState("");
  const [newPrompt, setNewPrompt] = useState("");
  const customAgents = settings.aiAgents || [];
  const agentModelOverrides = settings.aiAgentModelOverrides || {};
  const agentProviderOverrides = settings.aiAgentProviderOverrides || {};
  const providers = settings.aiProviders || [];
  const modelOptions = models.map((m) => m.id);

  const modelLabel = (model: string) => {
    const info = models.find((m) => m.id === model);
    if (!info) return model;
    const details = [
      info.context_length ? `${Math.round(info.context_length / 1000)}k ctx` : "",
      info.capabilities?.vision === "true" ? "vision" : "",
      info.capabilities?.responses_api === "true" ? "responses" : "",
    ].filter(Boolean).join(" · ");
    return details ? `${model} (${details})` : model;
  };

  const optionValues = (current: string) => {
    const values = [...modelOptions];
    if (current && !values.includes(current)) values.unshift(current);
    return values;
  };

  const updateBuiltInModel = (id: string, model: string) => {
    const next = { ...agentModelOverrides };
    if (model) {
      next[id] = model;
    } else {
      delete next[id];
    }
    updateSetting("aiAgentModelOverrides", next);
  };

  const updateBuiltInProvider = (id: string, providerId: string) => {
    const nextProviders = { ...agentProviderOverrides };
    const nextModels = { ...agentModelOverrides };
    if (providerId) {
      nextProviders[id] = providerId;
    } else {
      delete nextProviders[id];
    }
    delete nextModels[id];
    updateSetting("aiAgentProviderOverrides", nextProviders);
    updateSetting("aiAgentModelOverrides", nextModels);
  };

  const providerName = (providerId: string) =>
    providers.find((provider) => provider.id === providerId)?.name || "default provider";

  const AgentProviderSelect = ({
    value,
    onChange,
  }: {
    value: string;
    onChange: (providerId: string) => void;
  }) => (
    <div className="flex flex-col gap-1.5">
      <label className="text-[10px] font-semibold uppercase tracking-wider text-[rgb(var(--color-text-secondary))]">
        Provider
      </label>
      <select
        value={value}
        onChange={(e) => onChange(e.target.value)}
        className={inputClass + " text-xs"}
      >
        <option value="">Use default provider ({providerName(settings.aiDefaultProviderId)})</option>
        {providers.map((provider) => (
          <option key={provider.id} value={provider.id}>
            {provider.name} ({provider.model || "no model"})
          </option>
        ))}
      </select>
    </div>
  );

  const AgentModelSelect = ({
    value,
    onChange,
  }: {
    value: string;
    onChange: (model: string) => void;
  }) => (
    <div className="flex flex-col gap-1.5">
      <label className="text-[10px] font-semibold uppercase tracking-wider text-[rgb(var(--color-text-secondary))]">
        Model
      </label>
      <div className="flex gap-2">
        <select
          value={value}
          onChange={(e) => onChange(e.target.value)}
          className={inputClass + " text-xs flex-1"}
        >
          <option value="">Use provider model ({settings.aiModel || "not selected"})</option>
          {optionValues(value).map((model) => (
            <option key={model} value={model}>{modelLabel(model)}</option>
          ))}
        </select>
        {models.length === 0 && (
          <button
            type="button"
            onClick={fetchModels}
            disabled={loadingModels || !canFetchModels}
            className="px-2.5 py-1.5 rounded-lg border border-[rgb(var(--color-border))] bg-[rgb(var(--color-surface-alt))] text-[11px] text-[rgb(var(--color-text-secondary))] hover:text-[rgb(var(--color-text))] disabled:opacity-40 transition-colors"
          >
            {loadingModels ? "Loading..." : "Fetch"}
          </button>
        )}
      </div>
      {value && models.length === 0 && (
        <p className="text-[10px] text-[rgb(var(--color-text-secondary))]">
          Saved override: <span className="font-medium">{value}</span>
        </p>
      )}
    </div>
  );

  const addAgent = () => {
    const name = newName.trim();
    const prompt = newPrompt.trim();
    if (!name || !prompt) return;
    const id = `custom-${Date.now()}`;
    const agent: AgentPreset = { id, name, prompt };
    updateSetting("aiAgents", [...customAgents, agent]);
    setNewName("");
    setNewPrompt("");
  };

  const updateAgent = (id: string, updates: Partial<AgentPreset>) => {
    updateSetting("aiAgents", customAgents.map((a) =>
      a.id === id ? { ...a, ...updates } : a
    ));
  };

  const deleteAgent = (id: string) => {
    updateSetting("aiAgents", customAgents.filter((a) => a.id !== id));
    if (settings.aiSelectedAgent === id) {
      updateSetting("aiSelectedAgent", "planner");
    }
  };

  return (
    <div className="flex flex-col gap-6">
      <p className="text-xs text-[rgb(var(--color-text-secondary))]">
        Agents are AI personas with different system prompts. Each agent can inherit the default provider or use a dedicated provider and model for its task.
      </p>
      {modelError && (
        <p className="text-xs text-error">{modelError}</p>
      )}

      {/* Built-in agents (read-only) */}
      <div>
        <h3 className="text-xs font-semibold uppercase tracking-wider text-[rgb(var(--color-text-secondary))] mb-3">Built-in Agents</h3>
        <div className="flex flex-col gap-2">
          {BUILT_IN_AGENTS.map((agent) => (
            <div key={agent.id} className="border border-[rgb(var(--color-border))] rounded-lg p-3">
              <div className="flex items-center gap-2 mb-1">
                <span className="text-sm font-medium">{agent.name}</span>
                {settings.aiSelectedAgent === agent.id && (
                  <span className="text-[10px] px-1.5 py-0.5 rounded-full bg-[rgb(var(--color-accent))]/10 text-[rgb(var(--color-accent))] font-medium">Active</span>
                )}
              </div>
              <p className="text-xs text-[rgb(var(--color-text-secondary))] line-clamp-2">
                {agent.prompt.split("\n").find((l) => l.trim() && !l.startsWith("#") && !l.startsWith("You are")) || agent.prompt.slice(0, 120)}
              </p>
              <div className="mt-3">
                <AgentProviderSelect
                  value={agentProviderOverrides[agent.id] || ""}
                  onChange={(providerId) => updateBuiltInProvider(agent.id, providerId)}
                />
              </div>
              <div className="mt-3">
                <AgentModelSelect
                  value={agentModelOverrides[agent.id] || ""}
                  onChange={(model) => updateBuiltInModel(agent.id, model)}
                />
              </div>
            </div>
          ))}
        </div>
      </div>

      {/* Custom agents */}
      <div>
        <h3 className="text-xs font-semibold uppercase tracking-wider text-[rgb(var(--color-text-secondary))] mb-3">Custom Agents</h3>
        {customAgents.length === 0 && (
          <p className="text-xs text-[rgb(var(--color-text-secondary))] italic mb-3">No custom agents yet.</p>
        )}
        <div className="flex flex-col gap-3">
          {customAgents.map((agent) => (
            <div key={agent.id} className="border border-[rgb(var(--color-border))] rounded-lg p-3">
              {editingId === agent.id ? (
                <div className="flex flex-col gap-2">
                  <input
                    type="text"
                    value={agent.name}
                    onChange={(e) => updateAgent(agent.id, { name: e.target.value })}
                    className={inputClass + " text-sm"}
                    placeholder="Agent name"
                  />
                  <textarea
                    value={agent.prompt}
                    onChange={(e) => updateAgent(agent.id, { prompt: e.target.value })}
                    className={inputClass + " text-xs min-h-[120px] resize-y font-mono"}
                    placeholder="System prompt..."
                  />
                  <AgentProviderSelect
                    value={agent.providerOverride || ""}
                    onChange={(providerId) => updateAgent(agent.id, { providerOverride: providerId || undefined, modelOverride: undefined })}
                  />
                  <AgentModelSelect
                    value={agent.modelOverride || ""}
                    onChange={(model) => updateAgent(agent.id, { modelOverride: model || undefined })}
                  />
                  <button
                    onClick={() => setEditingId(null)}
                    className="text-xs text-[rgb(var(--color-accent))] hover:underline self-start"
                  >
                    Done editing
                  </button>
                </div>
              ) : (
                <>
                  <div className="flex items-center gap-2 mb-1">
                    <span className="text-sm font-medium">{agent.name}</span>
                    {settings.aiSelectedAgent === agent.id && (
                      <span className="text-[10px] px-1.5 py-0.5 rounded-full bg-[rgb(var(--color-accent))]/10 text-[rgb(var(--color-accent))] font-medium">Active</span>
                    )}
                    <div className="flex-1" />
                    <button
                      onClick={() => setEditingId(agent.id)}
                      className="text-[11px] text-[rgb(var(--color-text-secondary))] hover:text-[rgb(var(--color-text))] transition-colors"
                    >
                      Edit
                    </button>
                    <button
                      onClick={() => deleteAgent(agent.id)}
                      className="text-[11px] text-error hover:text-error transition-colors"
                    >
                      Delete
                    </button>
                  </div>
                  <p className="text-xs text-[rgb(var(--color-text-secondary))] line-clamp-2">
                    {agent.prompt.slice(0, 150)}{agent.prompt.length > 150 ? "…" : ""}
                  </p>
                  <div className="mt-3">
                    <AgentProviderSelect
                      value={agent.providerOverride || ""}
                      onChange={(providerId) => updateAgent(agent.id, { providerOverride: providerId || undefined, modelOverride: undefined })}
                    />
                  </div>
                  <div className="mt-3">
                    <AgentModelSelect
                      value={agent.modelOverride || ""}
                      onChange={(model) => updateAgent(agent.id, { modelOverride: model || undefined })}
                    />
                  </div>
                </>
              )}
            </div>
          ))}
        </div>
      </div>

      {/* Add new agent */}
      <div className="border border-dashed border-[rgb(var(--color-border))] rounded-lg p-4 flex flex-col gap-3">
        <h4 className="text-xs font-semibold uppercase tracking-wider text-[rgb(var(--color-text-secondary))]">New Agent</h4>
        <input
          type="text"
          value={newName}
          onChange={(e) => setNewName(e.target.value)}
          placeholder="Agent name (e.g. Reviewer)"
          className={inputClass}
        />
        <textarea
          value={newPrompt}
          onChange={(e) => setNewPrompt(e.target.value)}
          placeholder="System prompt — instructions for how this agent should behave..."
          className={inputClass + " min-h-[100px] resize-y font-mono text-xs"}
        />
        <button
          onClick={addAgent}
          disabled={!newName.trim() || !newPrompt.trim()}
          className="px-4 py-2 rounded-lg bg-[rgb(var(--color-accent))] text-[rgb(var(--color-accent-fg))] text-sm font-medium hover:opacity-90 disabled:opacity-40 transition-opacity w-fit"
        >
          Add Agent
        </button>
      </div>
    </div>
  );
}

// ── Feedback List Tab ───────────────────────────────────────────

interface FeedbackEntry {
  category: string;
  feedback: string;
  date: string;
  debug_log?: string;
  system_info?: FeedbackSystemInfo;
  attachments?: FeedbackAttachmentMetadata[];
}

interface IssueReviewDraft {
  entry: FeedbackEntry;
}

interface FeedbackSystemInfo {
  app_version: string;
  os: string;
  os_family: string;
  arch: string;
}

interface CreateGithubIssueResult {
  url: string;
  diagnostics_comments_posted: number;
  diagnostics_comment_error?: string | null;
}

interface DiagnosticsPolicy {
  enabled: boolean;
  release_build: boolean;
  source: string;
  startup_flag_enabled: boolean;
  auditaur_flag_enabled: boolean;
  persisted_setting_enabled: boolean | null;
  settings_path: string | null;
}

interface AuditaurDiagnosticsSummary {
  session: {
    session_id: string;
    service_name: string;
    database_path: string;
    database_size_bytes: number | null;
    session_size_bytes: number | null;
  } | null;
  notes: string[];
}

interface ClearAuditaurLogsResult {
  removed_sessions: number;
  removed_bytes: number;
  skipped_active_session: boolean;
  notes: string[];
}

function formatBytes(bytes: number | null | undefined): string {
  if (bytes === null || bytes === undefined) return "not available";
  if (bytes < 1024) return `${bytes} B`;
  const units = ["KB", "MB", "GB"];
  let value = bytes / 1024;
  let unit = units[0];
  for (let i = 1; i < units.length && value >= 1024; i += 1) {
    value /= 1024;
    unit = units[i];
  }
  return `${value.toFixed(value >= 10 ? 1 : 2)} ${unit}`;
}

function formatSystemInfoLines(systemInfo?: FeedbackSystemInfo): string[] {
  if (!systemInfo) return [];
  return [
    `- App Version: ${systemInfo.app_version}`,
    `- OS: ${systemInfo.os} (${systemInfo.os_family})`,
    `- Architecture: ${systemInfo.arch}`,
  ];
}

const ISSUE_FORMAT_PROMPT = `You are formatting user feedback into a GitHub issue for the CutReady desktop app. Given the feedback below, produce a JSON object with two fields:
- "title": A concise, descriptive issue title (max 80 chars)
- "body": A well-formatted GitHub issue body in markdown. Include:
  - A clear description of the feedback
  - The category as a label suggestion
  - The app version in an "Environment" section
  - Keep it professional and actionable

Respond ONLY with valid JSON, no markdown fences.`;

/** Max URL length for browser safety. */
const MAX_URL_LENGTH = 8000;
const FEEDBACK_ISSUE_FORMAT_TIMEOUT_MS = 20_000;
export const CUTREADY_FEEDBACK_REPO = "sethjuarez/cutready";

function summarizeDiagnostics(debugLog?: string): string[] {
  if (!debugLog?.trim()) return [];
  try {
    type DiagnosticSummaryItem = { kind?: string; title?: string; detail?: string; trace_id?: string };
    const parsed = JSON.parse(debugLog) as {
      session?: { session_id?: string; service_name?: string; database_size_bytes?: number; session_size_bytes?: number };
      counts?: Record<string, number>;
      failed_ipc?: DiagnosticSummaryItem[];
      failed_traces?: DiagnosticSummaryItem[];
      frontend_errors?: DiagnosticSummaryItem[];
      warning_logs?: DiagnosticSummaryItem[];
      notes?: string[];
    };
    const lines: string[] = [];
    if (parsed.session) {
      const sessionParts = [
        parsed.session.service_name ? `service ${parsed.session.service_name}` : null,
        parsed.session.session_id ? `session ${parsed.session.session_id}` : null,
        parsed.session.session_size_bytes ? `session size ${formatBytes(parsed.session.session_size_bytes)}` : null,
        parsed.session.database_size_bytes ? `database ${formatBytes(parsed.session.database_size_bytes)}` : null,
      ].filter(Boolean);
      if (sessionParts.length > 0) {
        lines.push(`- Diagnostics: ${sessionParts.join(", ")}`);
      }
    }
    if (parsed.counts) {
      lines.push(
        `- Counts: frontend errors ${parsed.counts.frontend_errors ?? 0}, failed IPC ${parsed.counts.failed_ipc ?? 0}, failed traces ${parsed.counts.failed_traces ?? 0}, warning/error logs ${parsed.counts.warning_logs ?? 0}`,
      );
    }
    const recentItems = [
      ...(parsed.failed_ipc ?? []),
      ...(parsed.failed_traces ?? []),
      ...(parsed.frontend_errors ?? []),
      ...(parsed.warning_logs ?? []),
    ].slice(0, 5);
    for (const item of recentItems) {
      const title = item.kind || item.title || "diagnostic item";
      const detail = item.detail ? ` — ${item.detail.slice(0, 240)}` : "";
      const trace = item.trace_id ? ` (trace ${item.trace_id})` : "";
      lines.push(`- Recent: ${title}${detail}${trace}`);
    }
    for (const note of (parsed.notes ?? []).slice(0, 3)) {
      lines.push(`- Note: ${note}`);
    }
    return lines;
  } catch {
    return ["- Full diagnostics were captured, but the JSON could not be parsed for a summary."];
  }
}

function appendDiagnosticsSection(body: string, debugLog?: string): string {
  const sanitized = sanitizeDiagnosticsLog(debugLog);
  if (!sanitized) return body;
  const summary = summarizeDiagnostics(sanitized);
  const lines = [
    body.trim(),
    "",
    "## Diagnostics",
    ...(summary.length > 0 ? summary : ["- Debug diagnostics were included."]),
    `- Full sanitized diagnostics JSON will be posted as follow-up comment${sanitized.length > 55_000 ? "s" : ""}.`,
  ];
  return lines.join("\n");
}

function appendSystemInfoSection(body: string, systemInfo?: FeedbackSystemInfo): string {
  const lines = formatSystemInfoLines(systemInfo);
  if (lines.length === 0) return body;
  return [
    body.trim(),
    "",
    "## OS details",
    ...lines,
  ].join("\n");
}

function formatFeedbackEntryMarkdown(entry: FeedbackEntry): string {
  let text = `## ${entry.category}\n**Date:** ${entry.date.split("T")[0]}\n\n${entry.feedback}`;
  if (entry.system_info) text += `\n\n---\n### OS and machine details\n${formatSystemInfoLines(entry.system_info).join("\n")}`;
  if (entry.debug_log) text += `\n\n---\n### Debug Log\n\`\`\`\n${entry.debug_log}\n\`\`\``;
  const attachmentLines = formatFeedbackAttachmentsMarkdown(entry.attachments);
  if (attachmentLines.length > 0) text += `\n\n---\n${attachmentLines.join("\n").trimStart()}`;
  return text;
}

function FeedbackListTab() {
  const { settings, updateSetting } = useSettings();
  const [entries, setEntries] = useState<FeedbackEntry[]>([]);
  const [loading, setLoading] = useState(true);
  const [copied, setCopied] = useState(false);
  const [issuePending, setIssuePending] = useState<number | null>(null);
  const [confirmDelete, setConfirmDelete] = useState<number | null>(null);
  const [issueReview, setIssueReview] = useState<IssueReviewDraft | null>(null);
  const [issueReviewTitle, setIssueReviewTitle] = useState("");
  const [issueReviewBody, setIssueReviewBody] = useState("");
  const [issueSubmitting, setIssueSubmitting] = useState(false);
  const [diagnosticsPolicy, setDiagnosticsPolicy] = useState<DiagnosticsPolicy | null>(null);
  const [auditaurSummary, setAuditaurSummary] = useState<AuditaurDiagnosticsSummary | null>(null);
  const [clearingLogs, setClearingLogs] = useState(false);
  const mountedRef = useRef(true);

  useEffect(() => {
    mountedRef.current = true;
    invoke("list_feedback")
      .then((data) => setEntries(data as FeedbackEntry[]))
      .catch(() => {})
      .finally(() => setLoading(false));
    return () => {
      mountedRef.current = false;
    };
  }, []);

  useEffect(() => {
    let cancelled = false;
    Promise.all([
      invoke<DiagnosticsPolicy>("get_diagnostics_policy"),
      invoke<AuditaurDiagnosticsSummary>("get_auditaur_diagnostics"),
    ])
      .then(([policy, summary]) => {
        if (cancelled) return;
        setDiagnosticsPolicy(policy);
        setAuditaurSummary(summary);
      })
      .catch(() => {
        if (cancelled) return;
        setDiagnosticsPolicy(null);
        setAuditaurSummary(null);
      });
    return () => {
      cancelled = true;
    };
  }, []);

  const copyAll = async () => {
    if (entries.length === 0) return;
    const text = entries
      .map((e) => formatFeedbackEntryMarkdown(e))
      .join("\n\n---\n\n");
    try {
      await navigator.clipboard.writeText(text);
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    } catch { /* ignore */ }
  };

  const copySingle = async (entry: FeedbackEntry) => {
    try {
      await navigator.clipboard.writeText(formatFeedbackEntryMarkdown(entry));
    } catch { /* ignore */ }
  };

  const clearAll = async () => {
    await invoke("clear_feedback").catch(() => {});
    setEntries([]);
  };

  const clearDiagnosticsLogs = async () => {
    setClearingLogs(true);
    try {
      const result = await invoke<ClearAuditaurLogsResult>("clear_auditaur_logs");
      const skipped = result.skipped_active_session ? " Current session is still open." : "";
      useToastStore.getState().show(
        `Cleared ${result.removed_sessions} diagnostics session${result.removed_sessions === 1 ? "" : "s"} (${formatBytes(result.removed_bytes)}).${skipped}`,
        5000,
        "info",
      );
      const summary = await invoke<AuditaurDiagnosticsSummary>("get_auditaur_diagnostics").catch(() => null);
      if (summary) setAuditaurSummary(summary);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      useToastStore.getState().show(`Could not clear diagnostics logs: ${message}`, 5000, "error");
    } finally {
      setClearingLogs(false);
    }
  };

  const deleteSingle = async (realIndex: number) => {
    try {
      await invoke("delete_feedback", { index: realIndex });
      setEntries((prev) => prev.filter((_, i) => i !== realIndex));
    } catch (e) {
      console.error("Failed to delete feedback:", e);
    }
    setConfirmDelete(null);
  };

  /** Build a simple fallback issue (no LLM). */
  const buildFallbackIssue = (entry: FeedbackEntry, version?: string) => {
    const title = `[${entry.category}] Feedback — ${entry.date.split("T")[0]}`;
    let body = `## ${entry.category} Feedback\n\n${entry.feedback}`;
    body += `\n\n---\n**App Version:** ${version || "unknown"}`;
    body = appendSystemInfoSection(body, entry.system_info);
    body = appendDiagnosticsSection(body, entry.debug_log);
    return { title, body: appendFeedbackAttachmentsSection(body, entry.attachments) };
  };

  const openIssueReview = (entry: FeedbackEntry, title: string, body: string) => {
    setIssueReview({ entry });
    setIssueReviewTitle(title);
    setIssueReviewBody(body);
  };

  const closeIssueReview = () => {
    if (issueSubmitting) return;
    setIssueReview(null);
    setIssueReviewTitle("");
    setIssueReviewBody("");
  };

  const submitReviewedIssue = async () => {
    if (!issueReview || !issueReviewTitle.trim() || !issueReviewBody.trim()) return;
    const { entry } = issueReview;
    const title = issueReviewTitle.trim();
    const body = issueReviewBody.trim();
    setIssueSubmitting(true);

    try {
      const labels = [entry.category === "bug" ? "bug" : entry.category === "feature" ? "enhancement" : "feedback"];
      const result = await invoke<CreateGithubIssueResult>("create_github_issue", {
        repo: CUTREADY_FEEDBACK_REPO,
        title,
        body,
        labels,
        diagnosticsAttachment: sanitizeDiagnosticsLog(entry.debug_log) ?? null,
      });
      const url = result.url;
      if (url) {
        try { await shellOpen(url); } catch { /* opened via gh, URL still returned */ }
        const diagnosticsNote = result.diagnostics_comments_posted > 0
          ? ` with ${result.diagnostics_comments_posted} diagnostics comment${result.diagnostics_comments_posted === 1 ? "" : "s"}`
          : "";
        useToastStore.getState().show(`Issue created${diagnosticsNote}: ${url}`, 3000, "info");
        if (result.diagnostics_comment_error) {
          useToastStore.getState().show(`Diagnostics comment failed: ${result.diagnostics_comment_error}`, 6000, "warning");
        }
        setIssueReview(null);
        setIssueReviewTitle("");
        setIssueReviewBody("");
        return;
      }
    } catch (ghErr) {
      console.warn("[feedback] gh issue create failed, falling back to browser:", ghErr);
    } finally {
      setIssueSubmitting(false);
    }

    const baseUrl = `https://github.com/${CUTREADY_FEEDBACK_REPO}/issues/new?title=${encodeURIComponent(title)}&body=`;
    const maxBodyLen = MAX_URL_LENGTH - baseUrl.length;
    const encodedBody = encodeURIComponent(
      body.length > maxBodyLen / 3
        ? body.slice(0, Math.floor(maxBodyLen / 3)) + "\n\n…(truncated)"
        : body,
    );
    const url = baseUrl + encodedBody;

    try {
      await shellOpen(url);
    } catch {
      await navigator.clipboard.writeText(`# ${title}\n\n${body}`).catch(() => {});
      useToastStore.getState().show("Issue draft copied to clipboard", 3000, "info");
    }
    setIssueReview(null);
    setIssueReviewTitle("");
    setIssueReviewBody("");
  };

  /** Try LLM formatting, fall back to simple template. Then show a review modal before submission. */
  const formatAndOpenIssue = async (entry: FeedbackEntry, index: number) => {
    if (issuePending !== null || issueReview || issueSubmitting) return;
    setIssuePending(index);

    // Get app version
    let appVersion = "unknown";
    try {
      const { getVersion } = await import("@tauri-apps/api/app");
      appVersion = await getVersion();
    } catch { /* not available in dev */ }

    let title: string;
    let body: string;

    try {
      const s = useSettingsStore.getState().settings;
      const hasAi = isAiProviderConfigured(s);

      if (hasAi) {
        let bearerToken = s.aiAuthMode === "azure_oauth" ? s.aiAccessToken : null;
        if (s.aiAuthMode === "azure_oauth" && s.aiRefreshToken) {
          try {
            const tokenResult = await invoke<{ access_token: string; refresh_token?: string }>(
              "azure_token_refresh",
              { tenantId: s.aiTenantId || "", refreshToken: s.aiRefreshToken, clientId: s.aiClientId || null },
            );
            if (tokenResult.access_token) bearerToken = tokenResult.access_token;
          } catch { /* use existing token */ }
        }

        const config = {
          ...buildProviderConfig(s),
          bearer_token: bearerToken,
        };

        const userContent = [
          `Target Repository: ${CUTREADY_FEEDBACK_REPO}`,
          `Category: ${entry.category}`,
          `Date: ${entry.date}`,
          `App Version: ${appVersion}`,
          `Feedback: ${entry.feedback}`,
          ...(entry.system_info ? [`OS details:\n${formatSystemInfoLines(entry.system_info).join("\n")}`] : []),
          ...(entry.debug_log ? [`Diagnostics Summary:\n${summarizeDiagnostics(sanitizeDiagnosticsLog(entry.debug_log)).join("\n")}`] : []),
        ].join("\n\n");

        const result = await agentChat(
          config,
          [
            { role: "system", content: ISSUE_FORMAT_PROMPT },
            { role: "user", content: userContent },
          ],
          { timeoutMs: FEEDBACK_ISSUE_FORMAT_TIMEOUT_MS },
        );

        if (result.content) {
          const parsed = JSON.parse(result.content.trim());
          const fallback = buildFallbackIssue(entry, appVersion);
          title = parsed.title || fallback.title;
          body = parsed.body
              ? appendFeedbackAttachmentsSection(
                appendDiagnosticsSection(appendSystemInfoSection(parsed.body, entry.system_info), entry.debug_log),
                entry.attachments,
              )
              : fallback.body;
        } else {
          ({ title, body } = buildFallbackIssue(entry, appVersion));
        }
      } else {
        ({ title, body } = buildFallbackIssue(entry, appVersion));
      }
    } catch (e) {
      ({ title, body } = buildFallbackIssue(entry, appVersion));
      if (String(e).includes("timed out")) {
        useToastStore.getState().show("AI formatting timed out; using a local issue template.", 4000, "warning");
      }
    }

    if (!mountedRef.current) {
      return;
    }
    openIssueReview(entry, title, body);
    setIssuePending(null);
  };

  if (loading) {
    return <p className="text-xs text-[rgb(var(--color-text-secondary))]">Loading…</p>;
  }

  return (
    <div className="space-y-4">
      <div className="rounded-xl border border-[rgb(var(--color-border))] bg-[rgb(var(--color-surface-alt))]/50 p-4">
        <div className="flex items-start justify-between gap-4">
          <div>
            <div className="text-sm font-medium text-[rgb(var(--color-text))]">Diagnostics capture</div>
            <p className="mt-1 text-xs text-[rgb(var(--color-text-secondary))]">
              CutReady can collect local troubleshooting details in a diagnostics database. Full capture is off by default in packaged builds unless enabled here for the next launch, or started with <code className="font-mono">CUTREADY_DIAGNOSTICS=1</code>.
            </p>
          </div>
          <label className="flex shrink-0 items-center gap-2 text-xs text-[rgb(var(--color-text))]">
            <span>Enable next launch</span>
            <input
              type="checkbox"
              checked={settings.auditaurDiagnosticsEnabled}
              onChange={(e) => updateSetting("auditaurDiagnosticsEnabled", e.target.checked)}
              className="h-4 w-4 accent-[rgb(var(--color-accent))]"
            />
          </label>
        </div>

        <div className="mt-3 grid gap-2 text-[11px] text-[rgb(var(--color-text-secondary))] sm:grid-cols-3">
          <div className="rounded-lg bg-[rgb(var(--color-surface))] px-3 py-2">
            <span className="block uppercase tracking-wider opacity-70">Current status</span>
            <span className="mt-0.5 block text-[rgb(var(--color-text))]">
              {diagnosticsPolicy?.enabled ? `On (${diagnosticsPolicy.source})` : "Off"}
            </span>
          </div>
          <div className="rounded-lg bg-[rgb(var(--color-surface))] px-3 py-2">
            <span className="block uppercase tracking-wider opacity-70">Current log size</span>
            <span className="mt-0.5 block text-[rgb(var(--color-text))]">
              {formatBytes(auditaurSummary?.session?.session_size_bytes ?? auditaurSummary?.session?.database_size_bytes)}
            </span>
          </div>
          <div className="rounded-lg bg-[rgb(var(--color-surface))] px-3 py-2">
            <span className="block uppercase tracking-wider opacity-70">Startup flag</span>
            <span className="mt-0.5 block font-mono text-[rgb(var(--color-text))]">CUTREADY_DIAGNOSTICS=1</span>
          </div>
        </div>

        <div className="mt-3 flex items-center justify-between gap-3">
          <p className="text-[11px] text-[rgb(var(--color-text-secondary))]">
            {auditaurSummary?.session
              ? `Session ${auditaurSummary.session.session_id.slice(0, 8)} is active.`
              : "No active diagnostics session was found."}
          </p>
          <button
            type="button"
            onClick={clearDiagnosticsLogs}
            disabled={clearingLogs}
            className="inline-flex items-center gap-1.5 rounded-lg border border-[rgb(var(--color-border))] px-3 py-1.5 text-[11px] font-medium text-[rgb(var(--color-text-secondary))] transition-colors hover:border-error/40 hover:text-error disabled:cursor-not-allowed disabled:opacity-60"
          >
            <Trash2 className="h-3 w-3" />
            {clearingLogs ? "Clearing..." : "Clear old diagnostics logs"}
          </button>
        </div>
      </div>

      <div className="flex items-center justify-between">
        <p className="text-xs text-[rgb(var(--color-text-secondary))]">
          {entries.length === 0
            ? <>No feedback submitted yet. Use the <MessageSquare className="w-3 h-3 inline -mt-0.5" /> button in the activity bar.</>
            : `${entries.length} feedback item${entries.length === 1 ? "" : "s"}`}
        </p>
        {entries.length > 0 && (
          <div className="flex items-center gap-2">
            <button
              onClick={copyAll}
              className={`flex items-center gap-1.5 px-3 py-1.5 text-[11px] rounded-lg font-medium transition-colors border ${
                copied
                  ? "bg-success/15 text-success border-success/30"
                  : "bg-[rgb(var(--color-surface-alt))] text-[rgb(var(--color-text-secondary))] border-[rgb(var(--color-border))] hover:text-[rgb(var(--color-text))] hover:border-[rgb(var(--color-text-secondary))]/40"
              }`}
            >
              {copied ? (
                <>
                  <Check className="w-3 h-3" />
                  Copied All!
                </>
              ) : (
                <>
                  <ClipboardList className="w-3 h-3" />
                  Copy All
                </>
              )}
            </button>
            <button
              onClick={clearAll}
              className="flex items-center gap-1.5 px-3 py-1.5 text-[11px] rounded-lg font-medium transition-colors border bg-[rgb(var(--color-surface-alt))] text-[rgb(var(--color-text-secondary))] border-[rgb(var(--color-border))] hover:text-error hover:border-error/40"
            >
              <Trash2 className="w-3 h-3" />
              Clear All
            </button>
          </div>
        )}
      </div>

      {entries.length > 0 && (
        <div className="space-y-2 max-h-[400px] overflow-y-auto">
          {[...entries].reverse().map((entry, i) => {
            const realIndex = entries.length - 1 - i;
            const isConfirming = confirmDelete === realIndex;
            return (
            <div
              key={i}
              className="group relative px-3 py-2.5 rounded-lg bg-[rgb(var(--color-surface-alt))] border border-[rgb(var(--color-border))]"
            >
              <div className="flex items-center gap-2 mb-1">
                <span className="text-[10px] font-medium px-1.5 py-0.5 rounded bg-[rgb(var(--color-accent))]/10 text-[rgb(var(--color-accent))] border border-[rgb(var(--color-accent))]/20">
                  {entry.category}
                </span>
                <span className="text-[10px] text-[rgb(var(--color-text-secondary))]">
                  {entry.date.split("T")[0]}
                </span>
              </div>
              <p className="text-xs text-[rgb(var(--color-text))] whitespace-pre-wrap">{entry.feedback}</p>
              {entry.debug_log && (
                <div className="mt-1.5 flex items-center gap-1 text-[10px] text-[rgb(var(--color-text-secondary))]">
                  <LayoutGrid className="w-2.5 h-2.5" />
                  Debug log attached ({entry.debug_log.split("\n").length} lines)
                </div>
              )}
              {entry.system_info && (
                <div className="mt-1.5 flex items-center gap-1 text-[10px] text-[rgb(var(--color-text-secondary))]">
                  <Info className="w-2.5 h-2.5" />
                  OS details attached
                </div>
              )}
              {entry.attachments && entry.attachments.length > 0 && (
                <div className="mt-2 rounded-lg border border-[rgb(var(--color-border))] bg-[rgb(var(--color-surface))]/60 px-2.5 py-2">
                  <div className="mb-1.5 flex items-center gap-1 text-[10px] font-medium text-[rgb(var(--color-text-secondary))]">
                    <Image className="h-2.5 w-2.5 text-[rgb(var(--color-accent))]" />
                    {entry.attachments.length} screenshot{entry.attachments.length === 1 ? "" : "s"} preserved for manual upload
                  </div>
                  <div className="space-y-1">
                    {entry.attachments.map((attachment) => (
                      <div key={attachment.id} className="flex items-center justify-between gap-2 text-[10px] text-[rgb(var(--color-text-secondary))]">
                        <span className="truncate text-[rgb(var(--color-text))]">{attachment.file_name}</span>
                        <span className="shrink-0">{formatFeedbackAttachmentSize(attachment.size_bytes)}</span>
                      </div>
                    ))}
                  </div>
                </div>
              )}
              {/* Confirm delete inline */}
              {isConfirming && (
                <div className="mt-2 flex items-center gap-2 p-2 rounded bg-error/10 border border-error/20">
                  <span className="text-[11px] text-error flex-1">Delete this feedback?</span>
                  <button
                    onClick={() => deleteSingle(realIndex)}
                    className="px-2 py-0.5 text-[11px] rounded bg-error/20 text-error hover:bg-error/30 transition-colors"
                  >
                    Delete
                  </button>
                  <button
                    onClick={() => setConfirmDelete(null)}
                    className="px-2 py-0.5 text-[11px] rounded text-[rgb(var(--color-text-secondary))] hover:bg-[rgb(var(--color-surface))] transition-colors"
                  >
                    Cancel
                  </button>
                </div>
              )}
              {/* Action buttons — hover to reveal */}
              <button
                onClick={() => copySingle(entry)}
                className="absolute top-2 right-16 opacity-0 group-hover:opacity-100 p-1 rounded text-[rgb(var(--color-text-secondary))] hover:text-[rgb(var(--color-text))] hover:bg-[rgb(var(--color-surface))] transition-all"
                title="Copy this item"
              >
                <ClipboardList className="w-3 h-3" />
              </button>
              <button
                onClick={() => setConfirmDelete(isConfirming ? null : realIndex)}
                className="absolute top-2 right-9 opacity-0 group-hover:opacity-100 p-1 rounded text-[rgb(var(--color-text-secondary))] hover:text-error hover:bg-[rgb(var(--color-surface))] transition-all"
                title="Delete this item"
              >
                <Trash2 className="w-3 h-3" />
              </button>
              <button
                onClick={() => formatAndOpenIssue(entry, i)}
                disabled={issuePending !== null}
                className={`absolute top-2 right-2 opacity-0 group-hover:opacity-100 p-1 rounded transition-all ${
                  issuePending === i
                    ? "text-[rgb(var(--color-accent))] animate-pulse"
                    : "text-[rgb(var(--color-text-secondary))] hover:text-[rgb(var(--color-text))] hover:bg-[rgb(var(--color-surface))]"
                }`}
                title={`Create GitHub Issue in ${CUTREADY_FEEDBACK_REPO}`}
              >
                {issuePending === i ? (
                  <svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" className="animate-spin">
                    <path d="M21 12a9 9 0 1 1-6.219-8.56" />
                  </svg>
                ) : (
                  <svg width="11" height="11" viewBox="0 0 24 24" fill="currentColor">
                    <path d="M12 0C5.37 0 0 5.37 0 12c0 5.31 3.435 9.795 8.205 11.385.6.105.825-.255.825-.57 0-.285-.015-1.23-.015-2.235-3.015.555-3.795-.735-4.035-1.41-.135-.345-.72-1.41-1.23-1.695-.42-.225-1.02-.78-.015-.795.945-.015 1.62.87 1.845 1.23 1.08 1.815 2.805 1.305 3.495.99.105-.78.42-1.305.765-1.605-2.67-.3-5.46-1.335-5.46-5.925 0-1.305.465-2.385 1.23-3.225-.12-.3-.54-1.53.12-3.18 0 0 1.005-.315 3.3 1.23.96-.27 1.98-.405 3-.405s2.04.135 3 .405c2.295-1.56 3.3-1.23 3.3-1.23.66 1.65.24 2.88.12 3.18.765.84 1.23 1.905 1.23 3.225 0 4.605-2.805 5.625-5.475 5.925.435.375.81 1.095.81 2.22 0 1.605-.015 2.895-.015 3.3 0 .315.225.69.825.57A12.02 12.02 0 0 0 24 12c0-6.63-5.37-12-12-12z" />
                  </svg>
                )}
              </button>
            </div>
            );
          })}
        </div>
      )}

      <Dialog
        isOpen={!!issueReview}
        onClose={closeIssueReview}
        align="top"
        topOffset="12vh"
        width="w-[720px] max-w-[92vw]"
        labelledBy="feedback-issue-review-title"
        backdropClass="bg-[rgb(var(--color-overlay-scrim)/0.4)]"
      >
        <div className="bg-[rgb(var(--color-surface))] border border-[rgb(var(--color-border))] rounded-2xl shadow-2xl overflow-hidden">
          <div className="flex items-start justify-between gap-4 px-5 py-4 border-b border-[rgb(var(--color-border))]">
            <div>
              <h3 id="feedback-issue-review-title" className="text-sm font-semibold text-[rgb(var(--color-text))]">
                Review GitHub issue
              </h3>
              <p className="mt-1 text-xs text-[rgb(var(--color-text-secondary))]">
                This will be submitted to <span className="font-mono text-[rgb(var(--color-text))]">{CUTREADY_FEEDBACK_REPO}</span>.
                {issueReview?.entry.attachments?.length ? " Screenshots are preserved locally and listed for manual upload." : ""}
              </p>
            </div>
            <button
              onClick={closeIssueReview}
              disabled={issueSubmitting}
              className="flex items-center justify-center w-7 h-7 rounded-md text-[rgb(var(--color-text-secondary))] hover:text-[rgb(var(--color-text))] hover:bg-[rgb(var(--color-surface-alt))] disabled:opacity-40 transition-colors"
              title="Close"
            >
              <X className="w-4 h-4" />
            </button>
          </div>

          <div className="px-5 py-4 space-y-4">
            <label className="block space-y-1.5">
              <span className="text-xs font-medium text-[rgb(var(--color-text-secondary))]">Title</span>
              <input
                value={issueReviewTitle}
                onChange={(e) => setIssueReviewTitle(e.target.value)}
                className={`${inputClass} w-full`}
                disabled={issueSubmitting}
                autoFocus
              />
            </label>

            <label className="block space-y-1.5">
              <span className="text-xs font-medium text-[rgb(var(--color-text-secondary))]">Body</span>
              <textarea
                value={issueReviewBody}
                onChange={(e) => setIssueReviewBody(e.target.value)}
                disabled={issueSubmitting}
                className="w-full h-[360px] px-3 py-2 rounded-lg bg-[rgb(var(--color-surface-alt))] border border-[rgb(var(--color-border))] text-sm font-mono leading-relaxed text-[rgb(var(--color-text))] placeholder:text-[rgb(var(--color-text-secondary))]/50 focus:outline-none focus:ring-1 focus:ring-[rgb(var(--color-accent))]/40 resize-y disabled:opacity-60"
              />
            </label>
          </div>

          <div className="flex items-center justify-end gap-2 px-5 py-4 border-t border-[rgb(var(--color-border))] bg-[rgb(var(--color-surface-alt))]/50">
            <button
              onClick={closeIssueReview}
              disabled={issueSubmitting}
              className="px-3 py-1.5 rounded-lg text-xs font-medium border border-[rgb(var(--color-border))] text-[rgb(var(--color-text-secondary))] hover:text-[rgb(var(--color-text))] hover:bg-[rgb(var(--color-surface))] disabled:opacity-40 transition-colors"
            >
              Cancel
            </button>
            <button
              onClick={submitReviewedIssue}
              disabled={issueSubmitting || !issueReviewTitle.trim() || !issueReviewBody.trim()}
              className="px-3 py-1.5 rounded-lg text-xs font-medium bg-[rgb(var(--color-accent))] text-[rgb(var(--color-accent-fg))] hover:bg-[rgb(var(--color-accent-hover))] disabled:opacity-40 disabled:pointer-events-none transition-colors"
            >
              {issueSubmitting ? "Creating issue..." : "Create issue"}
            </button>
          </div>
        </div>
      </Dialog>
    </div>
  );
}

// ── Repository Tab ────────────────────────────────────────────────

function RepositoryTab({ settings, updateSetting }: {
  settings: ReturnType<typeof useSettings>["settings"];
  updateSetting: ReturnType<typeof useSettings>["updateSetting"];
}) {
  const [testStatus, setTestStatus] = useState<"idle" | "testing" | "success" | "error">("idle");
  const [testMessage, setTestMessage] = useState("");
  const [detectedRemote, setDetectedRemote] = useState<{ name: string; url: string } | null>(null);

  useEffect(() => {
    listDraftlineRemotes()
      .then((remotes) => {
        if (Array.isArray(remotes) && remotes.length > 0) {
          const remote = remotes[0];
          setDetectedRemote(remote);
          if (!settings.repoRemoteUrl) {
            updateSetting("repoRemoteUrl", remote.url);
          }
        }
      })
      .catch(() => {});
  }, []);

  const handleTestConnection = async () => {
    setTestStatus("testing");
    setTestMessage("");
    try {
      const remotes = await listDraftlineRemotes();
      const hasOrigin = remotes.some((r) => r.name === "origin");
      if (hasOrigin) {
        setTestStatus("success");
        setTestMessage("Remote is configured and accessible.");
      } else if (settings.repoRemoteUrl) {
        await addDraftlineRemote("origin", settings.repoRemoteUrl);
        setTestStatus("success");
        setTestMessage("Remote 'origin' added successfully.");
      } else {
        setTestStatus("error");
        setTestMessage("Enter a remote URL first.");
      }
    } catch (err) {
      setTestStatus("error");
      setTestMessage(String(err));
    }
  };

  const authOptions = [
    { value: "gh_cli", label: "GitHub CLI (gh)", desc: "Uses your existing GitHub CLI login. Recommended." },
    { value: "pat", label: "Personal Access Token", desc: "Enter a GitHub PAT manually." },
    { value: "ssh", label: "SSH Key", desc: "Uses SSH keys from ~/.ssh/." },
  ];

  return (
    <div className="flex flex-col gap-6">
      <p className="text-xs text-[rgb(var(--color-text-secondary))]">
        Connect to a GitHub remote to collaborate with others. Your snapshots and timelines sync as git commits and branches.
      </p>

      {detectedRemote && !settings.repoRemoteUrl && (
        <div className="flex items-center gap-2 px-3 py-2 rounded-lg bg-[rgb(var(--color-accent))]/10 border border-[rgb(var(--color-accent))]/20 text-xs text-[rgb(var(--color-accent))]">
          <Info className="w-3.5 h-3.5" />
          Detected remote: <strong>{detectedRemote.url}</strong>
          <button
            onClick={() => updateSetting("repoRemoteUrl", detectedRemote.url)}
            className="ml-auto text-[rgb(var(--color-accent))] underline hover:no-underline"
          >
            Use this
          </button>
        </div>
      )}

      <fieldset className="flex flex-col gap-2">
        <label className="text-sm font-medium text-[rgb(var(--color-text))]">Remote URL</label>
        <div className="flex gap-2">
          <input
            type="text"
            value={settings.repoRemoteUrl}
            onChange={(e) => updateSetting("repoRemoteUrl", e.target.value)}
            placeholder="https://github.com/user/repo.git"
            className={inputClass + " flex-1"}
          />
          <button
            onClick={handleTestConnection}
            disabled={testStatus === "testing"}
            className="px-3 py-2 rounded-lg text-xs font-medium bg-[rgb(var(--color-accent))] text-[rgb(var(--color-accent-fg))] hover:opacity-90 transition-opacity disabled:opacity-50"
          >
            {testStatus === "testing" ? "Testing\u2026" : "Test"}
          </button>
        </div>
        {testStatus === "success" && (
          <p className="text-xs text-success">{testMessage}</p>
        )}
        {testStatus === "error" && (
          <p className="text-xs text-error">{testMessage}</p>
        )}
      </fieldset>

      <fieldset className="flex flex-col gap-3">
        <label className="text-sm font-medium text-[rgb(var(--color-text))]">Authentication</label>
        <div className="flex flex-col gap-2">
          {authOptions.map((opt) => (
            <label
              key={opt.value}
              className={`flex items-start gap-3 px-3 py-2.5 rounded-lg border cursor-pointer transition-colors ${
                settings.repoAuthMethod === opt.value
                  ? "border-[rgb(var(--color-accent))] bg-[rgb(var(--color-accent))]/5"
                  : "border-[rgb(var(--color-border))] hover:border-[rgb(var(--color-text-secondary))]/30"
              }`}
            >
              <input
                type="radio"
                name="repoAuth"
                value={opt.value}
                checked={settings.repoAuthMethod === opt.value}
                onChange={() => updateSetting("repoAuthMethod", opt.value)}
                className="mt-0.5 accent-[rgb(var(--color-accent))]"
              />
              <div>
                <span className="text-sm font-medium text-[rgb(var(--color-text))]">{opt.label}</span>
                <p className="text-xs text-[rgb(var(--color-text-secondary))] mt-0.5">{opt.desc}</p>
              </div>
            </label>
          ))}
        </div>
      </fieldset>

      {settings.repoAuthMethod === "pat" && (
        <fieldset className="flex flex-col gap-2">
          <label className="text-sm font-medium text-[rgb(var(--color-text))]">Personal Access Token</label>
          <input
            type="password"
            value={settings.repoToken}
            onChange={(e) => updateSetting("repoToken", e.target.value)}
            placeholder="ghp_xxxxxxxxxxxx"
            className={inputClass}
          />
          <p className="text-xs text-[rgb(var(--color-text-secondary))]">
            Create a token at github.com/settings/tokens with &quot;repo&quot; scope.
          </p>
        </fieldset>
      )}

      <fieldset className="flex flex-col gap-2">
        <label className="text-sm font-medium text-[rgb(var(--color-text))]">Git Identity</label>
        <p className="text-xs text-[rgb(var(--color-text-secondary))] mb-1">
          Name and email used for your snapshots. Leave empty to use system git config.
        </p>
        <div className="grid grid-cols-2 gap-3">
          <input
            type="text"
            value={settings.repoAuthorName}
            onChange={(e) => updateSetting("repoAuthorName", e.target.value)}
            placeholder="Name"
            className={inputClass}
          />
          <input
            type="email"
            value={settings.repoAuthorEmail}
            onChange={(e) => updateSetting("repoAuthorEmail", e.target.value)}
            placeholder="email@example.com"
            className={inputClass}
          />
        </div>
      </fieldset>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Memory Tab
// ---------------------------------------------------------------------------

interface MemoryItem {
  category: string;
  content: string;
  created_at: string;
  tags: string[];
}

function MemoryTab() {
  const [memories, setMemories] = useState<MemoryItem[]>([]);
  const [loading, setLoading] = useState(false);
  const [filter, setFilter] = useState<"all" | "core" | "archival" | "insight">("all");
  const [editingIndex, setEditingIndex] = useState<number | null>(null);
  const [editContent, setEditContent] = useState("");

  const loadMemories = async () => {
    setLoading(true);
    try {
      const result = await invoke<MemoryItem[]>("list_memories");
      setMemories(result);
    } catch {
      setMemories([]);
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => { loadMemories(); }, []);

  const filtered = filter === "all"
    ? memories
    : memories.filter((m) => m.category === filter);

  const handleDelete = async (globalIndex: number) => {
    try {
      await invoke("delete_memory", { index: globalIndex });
      await loadMemories();
    } catch (e) {
      console.error("Failed to delete memory:", e);
    }
  };

  const handleUpdate = async (globalIndex: number) => {
    try {
      await invoke("update_memory", { index: globalIndex, content: editContent });
      setEditingIndex(null);
      setEditContent("");
      await loadMemories();
    } catch (e) {
      console.error("Failed to update memory:", e);
    }
  };

  const handleClear = async (category?: string) => {
    try {
      await invoke("clear_memories", { category: category || null });
      await loadMemories();
    } catch (e) {
      console.error("Failed to clear memories:", e);
    }
  };

  const categoryBadge = (cat: string) => {
    const colors: Record<string, string> = {
      core: "bg-purple-500/20 text-purple-400",
      archival: "bg-accent/20 text-accent",
      insight: "bg-warning/20 text-warning",
    };
    return colors[cat] || "bg-gray-500/20 text-gray-400";
  };

  const globalIndex = (item: MemoryItem) => memories.indexOf(item);

  return (
    <div className="flex flex-col gap-4">
      <div className="flex items-center justify-between">
        <p className="text-xs text-[rgb(var(--color-text-secondary))]">
          {memories.length} {memories.length === 1 ? "memory" : "memories"} stored
        </p>
        <div className="flex items-center gap-2">
          <button
            onClick={loadMemories}
            className="px-2 py-1 text-xs rounded border border-[rgb(var(--color-border))] hover:bg-[rgb(var(--color-surface-alt))] transition-colors"
            title="Refresh"
          >
            ↻
          </button>
          {memories.length > 0 && (
            <button
              onClick={() => handleClear()}
              className="px-2 py-1 text-xs rounded border border-error/30 text-error hover:bg-error/10 transition-colors"
            >
              Clear All
            </button>
          )}
        </div>
      </div>

      {/* Category filter */}
      <div className="flex gap-1">
        {(["all", "core", "archival", "insight"] as const).map((cat) => {
          const count = cat === "all" ? memories.length : memories.filter((m) => m.category === cat).length;
          return (
            <button
              key={cat}
              onClick={() => setFilter(cat)}
              className={`px-2.5 py-1 text-xs rounded-full transition-colors ${
                filter === cat
                  ? "bg-[rgb(var(--color-accent))]/20 text-[rgb(var(--color-accent))]"
                  : "text-[rgb(var(--color-text-secondary))] hover:bg-[rgb(var(--color-surface-alt))]"
              }`}
            >
              {cat === "all" ? "All" : cat.charAt(0).toUpperCase() + cat.slice(1)} ({count})
            </button>
          );
        })}
      </div>

      {/* Memory list */}
      {loading ? (
        <p className="text-xs text-[rgb(var(--color-text-secondary))] py-4 text-center">Loading…</p>
      ) : filtered.length === 0 ? (
        <div className="text-center py-8 text-[rgb(var(--color-text-secondary))]">
          <p className="text-sm">No memories yet</p>
          <p className="text-xs mt-1">The AI assistant will save memories as you chat.</p>
        </div>
      ) : (
        <div className="flex flex-col gap-1.5">
          {filtered.map((m) => {
            const idx = globalIndex(m);
            const isEditing = editingIndex === idx;
            return (
              <div
                key={idx}
                className="group flex flex-col gap-1 p-2.5 rounded-lg border border-[rgb(var(--color-border))] bg-[rgb(var(--color-surface-alt))] hover:border-[rgb(var(--color-text-secondary))]/30 transition-colors"
              >
                <div className="flex items-start justify-between gap-2">
                  <div className="flex items-center gap-2 min-w-0">
                    <span className={`px-1.5 py-0.5 text-[10px] rounded-full font-medium ${categoryBadge(m.category)}`}>
                      {m.category}
                    </span>
                    {m.tags.length > 0 && (
                      <span className="text-[10px] text-[rgb(var(--color-text-secondary))] truncate">
                        {m.tags.join(", ")}
                      </span>
                    )}
                  </div>
                  <div className="flex items-center gap-1 opacity-0 group-hover:opacity-100 transition-opacity shrink-0">
                    <button
                      onClick={() => {
                        if (isEditing) {
                          setEditingIndex(null);
                        } else {
                          setEditingIndex(idx);
                          setEditContent(m.content);
                        }
                      }}
                      className="px-1.5 py-0.5 text-[10px] rounded hover:bg-[rgb(var(--color-accent))]/10 text-[rgb(var(--color-text-secondary))]"
                    >
                      {isEditing ? "Cancel" : "Edit"}
                    </button>
                    <button
                      onClick={() => handleDelete(idx)}
                      className="px-1.5 py-0.5 text-[10px] rounded hover:bg-error/10 text-error"
                    >
                      Delete
                    </button>
                  </div>
                </div>
                {isEditing ? (
                  <div className="flex gap-1.5 mt-1">
                    <input
                      type="text"
                      value={editContent}
                      onChange={(e) => setEditContent(e.target.value)}
                      onKeyDown={(e) => { if (e.key === "Enter") handleUpdate(idx); if (e.key === "Escape") setEditingIndex(null); }}
                      className="flex-1 px-2 py-1 text-xs rounded bg-[rgb(var(--color-surface))] border border-[rgb(var(--color-border))] text-[rgb(var(--color-text))] focus:outline-none focus:ring-1 focus:ring-[rgb(var(--color-accent))]/40"
                      autoFocus
                    />
                    <button
                      onClick={() => handleUpdate(idx)}
                      className="px-2 py-1 text-xs rounded bg-[rgb(var(--color-accent))]/20 text-[rgb(var(--color-accent))] hover:bg-[rgb(var(--color-accent))]/30"
                    >
                      Save
                    </button>
                  </div>
                ) : (
                  <p className="whitespace-pre-wrap break-words text-xs leading-relaxed text-[rgb(var(--color-text))]">{m.content}</p>
                )}
                <span className="text-[10px] text-[rgb(var(--color-text-secondary))]/50">
                  {new Date(m.created_at).toLocaleDateString()}
                </span>
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
}


function UpdatesTab() {
  const update = useUpdateStore((s) => s.update);
  const checking = useUpdateStore((s) => s.checking);
  const checkForUpdate = useUpdateStore((s) => s.checkForUpdate);
  const [currentVersion, setCurrentVersion] = useState<string | null>(null);
  const [installing, setInstalling] = useState(false);
  const [progress, setProgress] = useState("");
  const [checked, setChecked] = useState(false);

  useEffect(() => {
    getVersion().then(setCurrentVersion).catch(() => {});
  }, []);

  const handleCheck = async () => {
    await checkForUpdate();
    setChecked(true);
  };

  const handleInstall = async () => {
    if (!update) return;
    setInstalling(true);
    try {
      let downloaded = 0;
      await update.downloadAndInstall((event) => {
        switch (event.event) {
          case "Started": setProgress("Downloading…"); break;
          case "Progress":
            downloaded += event.data.chunkLength;
            setProgress(`Downloading… ${(downloaded / 1024 / 1024).toFixed(1)} MB`);
            break;
          case "Finished": setProgress("Installing…"); break;
        }
      });
      await relaunch();
    } catch {
      setProgress("Installation failed.");
      setInstalling(false);
    }
  };

  return (
    <div className="max-w-xl">
      {/* Current version + actions */}
      <div className="flex items-center justify-between mb-6 p-4 rounded-xl bg-[rgb(var(--color-surface-alt))] border border-[rgb(var(--color-border))]">
        <div>
          <p className="text-xs text-[rgb(var(--color-text-secondary))] uppercase tracking-wider mb-0.5">Installed</p>
          <p className="text-sm font-semibold text-[rgb(var(--color-text))]">
            {currentVersion ? `v${currentVersion}` : "…"}
          </p>
        </div>
        <div className="flex items-center gap-2">
          {!update && checked && (
            <div className="flex items-center gap-1.5 text-xs text-success">
              <CheckCircle className="w-3.5 h-3.5" />
              Up to date
            </div>
          )}
          <button
            onClick={handleCheck}
            disabled={checking}
            className="flex items-center gap-1.5 px-2.5 py-1.5 rounded-lg text-xs font-medium border border-[rgb(var(--color-border))] text-[rgb(var(--color-text-secondary))] hover:text-[rgb(var(--color-text))] hover:border-[rgb(var(--color-text-secondary))]/40 transition-colors disabled:opacity-50"
          >
            <RefreshCw className={`w-3 h-3 ${checking ? "animate-spin" : ""}`} />
            {checking ? "Checking…" : "Check for Updates"}
          </button>
        </div>
      </div>

      {/* Update available */}
      {update ? (
        <div className="rounded-xl border border-[rgb(var(--color-accent))]/30 bg-[rgb(var(--color-accent))]/5 overflow-hidden">
          <div className="flex items-center justify-between px-4 py-3 border-b border-[rgb(var(--color-accent))]/20">
            <div>
              <p className="text-xs text-[rgb(var(--color-text-secondary))] uppercase tracking-wider mb-0.5">Update Available</p>
              <p className="text-sm font-semibold text-[rgb(var(--color-accent))]">v{update.version}</p>
            </div>
            {installing ? (
              <span className="text-xs text-[rgb(var(--color-accent))]">{progress}</span>
            ) : (
              <button
                onClick={handleInstall}
                className="flex items-center gap-1.5 px-3 py-1.5 rounded-lg text-xs font-medium bg-[rgb(var(--color-accent))] text-[rgb(var(--color-accent-fg))] hover:bg-[rgb(var(--color-accent-hover))] transition-colors"
              >
                <Download className="w-3.5 h-3.5" />
                Download &amp; Install
              </button>
            )}
          </div>
          {update.body && (
            <div className="px-4 py-3 max-h-[420px] overflow-y-auto">
              <p className="text-xs text-[rgb(var(--color-text-secondary))] uppercase tracking-wider mb-2">Release Notes</p>
              <ReleaseNotesMarkdown>{update.body}</ReleaseNotesMarkdown>
            </div>
          )}
        </div>
      ) : (
        <div className="flex flex-col gap-2">
          <p className="text-sm text-[rgb(var(--color-text-secondary))]">
            CutReady checks for updates automatically. You'll see a notification in the activity bar when one is available.
          </p>
          <a
            href="https://github.com/sethjuarez/cutready/blob/main/CHANGELOG.md"
            target="_blank"
            rel="noreferrer"
            className="inline-flex items-center gap-1.5 text-xs text-[rgb(var(--color-accent))] hover:underline"
          >
            <ExternalLink className="w-3 h-3" />
            View full changelog on GitHub
          </a>
        </div>
      )}
    </div>
  );
}

// ── Experimental Tab ────────────────────────────────────────────

function ExperimentalTab({ settings, updateSetting }: {
  settings: ReturnType<typeof useSettings>["settings"];
  updateSetting: ReturnType<typeof useSettings>["updateSetting"];
}) {
  return (
    <div className="flex flex-col gap-6">
      <p className="text-sm text-[rgb(var(--color-text-secondary))]">
        These features are still in development. They may be incomplete or unstable.
      </p>

      <fieldset className="flex flex-col gap-2">
        <legend className="text-sm font-medium mb-1">Feature Flags</legend>

        <label className="flex items-center justify-between gap-3 rounded-lg bg-[rgb(var(--color-surface))] px-3 py-2">
          <span>
            <span className="block text-xs text-[rgb(var(--color-text))]">Recording</span>
            <span className="block text-[11px] text-[rgb(var(--color-text-secondary))]">Screen, camera, and audio capture for demo recordings</span>
          </span>
          <input
            type="checkbox"
            checked={settings.featureRecording}
            onChange={(e) => updateSetting("featureRecording", e.target.checked)}
            className="h-4 w-4 accent-[rgb(var(--color-accent))]"
          />
        </label>

      </fieldset>
    </div>
  );
}
