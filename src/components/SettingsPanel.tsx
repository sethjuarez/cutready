import { useCallback, useEffect, useState, type ReactNode } from "react";
import { X, MessageSquare, Download, Search, MonitorCog, Palette, Bot, Brain, Mic2, MessageCircleWarning, GitBranch, DownloadCloud, FlaskConical, Keyboard, SlidersHorizontal, Plug, AudioLines, Eye, Captions } from "lucide-react";
import { useAppStore } from "../stores/appStore";
import { useSettings } from "../hooks/useSettings";
import { invoke } from "../services/tauri";
import { open as shellOpen } from "@tauri-apps/plugin-shell";
import { buildProviderConfig, canFetchModelsFor } from "../utils/providerConfig";
import { persistConnectionTokens, clearConnectionTokens } from "../utils/agentProvider";
import { AIProviderTab } from "./settings/AIProviderTab";
import { AgentsTab, HarnessPicker } from "./settings/AgentsTab";
import { DisplayTab } from "./settings/DisplayTab";
import { ExportTab } from "./settings/ExportTab";
import { FeedbackListTab, CUTREADY_FEEDBACK_REPO } from "./settings/FeedbackListTab";
import { MemoryTab } from "./settings/MemoryTab";
import { NarrationTab } from "./settings/NarrationTab";
import { PresentationTab } from "./settings/PresentationTab";
import { RecordingTab } from "./settings/RecordingTab";
import { RepositoryTab } from "./settings/RepositoryTab";
import { ThemesTab } from "./settings/ThemesTab";
import { UpdatesTab } from "./settings/UpdatesTab";
import { VoiceTab } from "./settings/VoiceTab";
import { ExperimentalTab } from "./settings/ExperimentalTab";
import type { AiInnerTab, AuthCodeFlowInit, ModelInfo, SettingsTab, TokenResponse } from "./settings/types";

export { CUTREADY_FEEDBACK_REPO, HarnessPicker };

const REQUESTED_SETTINGS_TAB_KEY = "cutready:requested-settings-tab";
const SETTINGS_TABS: SettingsTab[] = ["ai", "agents", "memory", "display", "themes", "presentation", "narration", "recording", "export", "feedback", "repository", "updates", "experimental"];

function consumeRequestedSettingsTab(): SettingsTab | null {
  const requested = localStorage.getItem(REQUESTED_SETTINGS_TAB_KEY);
  localStorage.removeItem(REQUESTED_SETTINGS_TAB_KEY);
  return SETTINGS_TABS.includes(requested as SettingsTab) ? requested as SettingsTab : null;
}

export function SettingsPanel({ onClose }: { onClose?: () => void }) {
  const { settings, updateSetting, loaded } = useSettings();
  const currentProject = useAppStore((s) => s.currentProject);
  const setView = useAppStore((s) => s.setView);
  const [requestedTab] = useState<SettingsTab | null>(() => consumeRequestedSettingsTab());
  const [scope, setScope] = useState<"app" | "workspace">(
    requestedTab && !["repository", "memory"].includes(requestedTab)
      ? "app"
      : requestedTab && ["repository", "memory"].includes(requestedTab)
        ? "workspace"
        : import.meta.env.DEV && import.meta.env.VITE_CUTREADY_STARTUP_SETTINGS_TAB === "repository"
      ? "workspace"
      : "app",
  );
  const [activeTab, setActiveTab] = useState<SettingsTab>(
    (requestedTab === "agents" || requestedTab === "memory" ? "ai" : requestedTab)
      ?? (import.meta.env.DEV && import.meta.env.VITE_CUTREADY_STARTUP_SETTINGS_TAB === "repository"
      ? "repository"
      : "display"),
  );
  const [activeAiTab, setActiveAiTab] = useState<AiInnerTab>(
    requestedTab === "agents" ? "agent" : requestedTab === "memory" ? "memory" : "connections",
  );
  const [settingsFilter, setSettingsFilter] = useState("");
  const [models, setModels] = useState<ModelInfo[]>([]);
  const [loadingModels, setLoadingModels] = useState(false);
  const [modelError, setModelError] = useState("");
  const [modelFilter, setModelFilter] = useState("");

  const closeSettings = useCallback(() => {
    if (onClose) {
      onClose();
      return;
    }
    setView(currentProject ? "project" : "home");
  }, [currentProject, onClose, setView]);

  const globalTabs: SettingsTab[] = settings.featureRecording
    ? ["display", "themes", "presentation", "narration", "recording", "export", "ai", "feedback", "updates", "experimental"]
    : ["display", "themes", "presentation", "narration", "export", "ai", "feedback", "updates", "experimental"];
  const workspaceTabs: SettingsTab[] = ["repository", "display", "themes", "export", "ai"];
  const tabs: SettingsTab[] = scope === "workspace" ? workspaceTabs : globalTabs;

  const aiInnerTabs: AiInnerTab[] = scope === "workspace"
    ? ["connections", "agent", "memory"]
    : ["connections", "agent", "voice"];
  const aiInnerMeta: Record<AiInnerTab, { label: string; description: string; icon: ReactNode }> = {
    connections: {
      label: "Connections",
      description: "Credentialed endpoints shared across every AI capability.",
      icon: <Plug className="h-3.5 w-3.5" />,
    },
    agent: {
      label: "Agent",
      description: "Planner, writer, editor, designer, and tool-application defaults.",
      icon: <SlidersHorizontal className="h-3.5 w-3.5" />,
    },
    voice: {
      label: "Voice",
      description: "Generate spoken narration with an Azure Speech voice bound to a connection.",
      icon: <AudioLines className="h-3.5 w-3.5" />,
    },
    memory: {
      label: "Memory",
      description: "Local agent recall and workspace memory stored with this project.",
      icon: <Brain className="h-3.5 w-3.5" />,
    },
  };
  const currentAiTab: AiInnerTab = aiInnerTabs.includes(activeAiTab) ? activeAiTab : "connections";

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

  useEffect(() => {
    if (!aiInnerTabs.includes(activeAiTab)) {
      setActiveAiTab("connections");
    }
  }, [aiInnerTabs, activeAiTab]);

  useEffect(() => {
    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        event.preventDefault();
        closeSettings();
      }
    };

    window.addEventListener("keydown", handleKeyDown);
    return () => window.removeEventListener("keydown", handleKeyDown);
  }, [closeSettings]);

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
    // Bind this sign-in to the connection that initiated it. If the user switches
    // the active connection during the (up to 300s) browser flow, the minted
    // tokens must still land in this connection, not whichever is active later.
    const initiatingProviderId = settings.aiActiveProviderId || settings.aiDefaultProviderId || "";
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
      console.info({
        type: "cutready.ai.oauth",
        phase: "complete_resolved",
        access_token_len: token.accessToken?.length ?? 0,
        has_refresh: Boolean(token.refreshToken),
        scope: token.scope ?? null,
      });
      await persistConnectionTokens(
        initiatingProviderId,
        { accessToken: token.accessToken, refreshToken: token.refreshToken || undefined },
        updateSetting,
      );
      console.info({
        type: "cutready.ai.oauth",
        phase: "tokens_persisted",
        active_provider: settings.aiActiveProviderId,
        initiating_provider: initiatingProviderId,
      });
      setOauthStatus("success");
    } catch (e) {
      console.warn({ type: "cutready.ai.oauth", phase: "error", error: String(e) });
      setOauthError(String(e));
      setOauthStatus("error");
    }
  };

  const signOut = async () => {
    // Bind sign-out to the connection that initiated it so switching mid-flow
    // cannot leave the original connection's vault tokens stale (#262).
    const initiatingProviderId = settings.aiActiveProviderId || settings.aiDefaultProviderId || "";
    await clearConnectionTokens(initiatingProviderId, updateSetting);
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
    presentation: {
      label: "Presentation",
      eyebrow: "Demo controls",
      description: "Capture global hotkeys for controlling preview and teleprompter from a Stream Deck.",
      icon: <Keyboard className="h-4 w-4" />,
      keywords: "presentation preview teleprompter hotkeys shortcuts stream deck elgato",
    },
    recording: {
      label: "Recording",
      eyebrow: "Capture defaults",
      description: "Set default devices, tracks, countdowns, and output quality for new recording takes.",
      icon: <Mic2 className="h-4 w-4" />,
      keywords: "recording microphone camera audio capture ffmpeg",
    },
    narration: {
      label: "Narration",
      eyebrow: "Voice capture and generation",
      description: "Choose the microphone for recorded narration and tune generated Azure Speech voice settings.",
      icon: <MessageSquare className="h-4 w-4" />,
      keywords: "narration microphone mic voice audio row record permission azure speech tts ssml output format",
    },
    export: {
      label: "Export",
      eyebrow: "Video output",
      description: "Tune the sketch-to-MP4 timing rhythm, transitions, motion, frame shape, and codec defaults.",
      icon: <Download className="h-4 w-4" />,
      keywords: "export video mp4 timing title card lead row transition final hold dip black motion zoom codec crf fps resolution",
    },
    ai: {
      label: "AI",
      eyebrow: "Models & capabilities",
      description: "Manage connections and the capabilities that use them — agent, voice, and memory.",
      icon: <Bot className="h-4 w-4" />,
      keywords: "ai provider connection connections model foundry azure openai anthropic oauth token agent agents planner writer editor designer voice tts speech narration memory recall transcription vision",
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
  return (
    <div className="cr-modal-backdrop h-full overflow-hidden px-5 py-6">
      <div
        role="dialog"
        aria-modal="true"
        aria-labelledby="settings-panel-title"
        className="cr-modal-surface mx-auto flex h-full max-w-7xl overflow-hidden rounded-xl"
      >
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

        </aside>

        <main className="flex min-w-0 flex-1 flex-col overflow-hidden">
          <div className="shrink-0 border-b border-[rgb(var(--color-border-subtle))] bg-[rgb(var(--color-surface))] px-6 py-4">
            <div className="flex items-start justify-between gap-4">
              <div>
                <div className="text-[11px] font-semibold uppercase tracking-[0.16em] text-[rgb(var(--color-accent))]">
                  {activeMeta.eyebrow}
                </div>
                <h1 id="settings-panel-title" className="mt-0.5 text-xl font-semibold tracking-tight text-[rgb(var(--color-text))]">
                  {activeMeta.label}
                </h1>
                <p className="mt-1 max-w-3xl text-sm leading-5 text-[rgb(var(--color-text-secondary))]">
                  {activeMeta.description}
                </p>
              </div>
              <button
                type="button"
                data-testid="settings-close"
                onClick={closeSettings}
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
              {activeTab === "presentation" && (
                <PresentationTab settings={settings} updateSetting={updateSetting} />
              )}
              {activeTab === "recording" && (
                <RecordingTab settings={settings} updateSetting={updateSetting} />
              )}
              {activeTab === "export" && (
                <ExportTab settings={settings} updateSetting={updateSetting} scope={scope} />
              )}
              {activeTab === "narration" && (
                <NarrationTab settings={settings} updateSetting={updateSetting} />
              )}
              {activeTab === "ai" && (
                <div className="flex flex-col gap-5">
                  <div className="flex flex-wrap items-center gap-1.5">
                    {aiInnerTabs.map((tab) => {
                      const meta = aiInnerMeta[tab];
                      const active = currentAiTab === tab;
                      return (
                        <button
                          key={tab}
                          type="button"
                          onClick={() => setActiveAiTab(tab)}
                          data-testid={`settings-ai-tab-${tab}`}
                          className={`inline-flex items-center gap-1.5 rounded-lg border px-3 py-1.5 text-xs font-medium transition-colors ${
                            active
                              ? "border-[rgb(var(--color-accent))] bg-[rgb(var(--color-accent))]/10 text-[rgb(var(--color-text))]"
                              : "border-[rgb(var(--color-border))] bg-[rgb(var(--color-surface))] text-[rgb(var(--color-text-secondary))] hover:border-[rgb(var(--color-border-strong))] hover:text-[rgb(var(--color-text))]"
                          }`}
                        >
                          {meta.icon}
                          {meta.label}
                        </button>
                      );
                    })}
                    {(["transcription", "vision"] as const).map((soon) => (
                      <span
                        key={soon}
                        title="Coming soon"
                        className="inline-flex items-center gap-1.5 rounded-lg border border-dashed border-[rgb(var(--color-border))] px-3 py-1.5 text-xs font-medium text-[rgb(var(--color-text-secondary))] opacity-60"
                      >
                        {soon === "transcription" ? <Captions className="h-3.5 w-3.5" /> : <Eye className="h-3.5 w-3.5" />}
                        {soon === "transcription" ? "Transcription" : "Vision"}
                        <span className="ml-0.5 rounded-full bg-[rgb(var(--color-surface-alt))] px-1.5 py-0.5 text-[9px] uppercase tracking-wide">Soon</span>
                      </span>
                    ))}
                  </div>
                  <p className="text-xs text-[rgb(var(--color-text-secondary))]">
                    {aiInnerMeta[currentAiTab].description}
                  </p>
                  {currentAiTab === "connections" && (
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
                  {currentAiTab === "agent" && (
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
                  {currentAiTab === "voice" && (
                    <VoiceTab settings={settings} updateSetting={updateSetting} />
                  )}
                  {currentAiTab === "memory" && (
                    <MemoryTab />
                  )}
                </div>
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
