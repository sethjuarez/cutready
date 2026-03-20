import { useState, useEffect, useCallback, useRef } from "react";
import { useSettings, useSettingsStore, type AgentPreset } from "../hooks/useSettings";
import { invoke } from "@tauri-apps/api/core";
import { open as shellOpen } from "@tauri-apps/plugin-shell";
import { BUILT_IN_AGENTS } from "./ChatPanel";
import { ImageManagerTab } from "./ImageManagerTab";
import { useToastStore } from "../stores/toastStore";
import {
  XMarkIcon,
  ArrowPathIcon,
  ChatBubbleLeftIcon,
  CheckIcon,
  ClipboardDocumentIcon,
  TrashIcon,
  Squares2X2Icon,
  InformationCircleIcon,
} from "@heroicons/react/24/outline";

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

type SettingsTab = "ai" | "agents" | "memory" | "display" | "images" | "feedback" | "repository";

import { inputClass, tabBtnClass } from "../styles";

export function SettingsPanel({ mode = "global" }: { mode?: "global" | "workspace" }) {
  const { settings, updateSetting, loaded } = useSettings();
  const [activeTab, setActiveTab] = useState<SettingsTab>(mode === "workspace" ? "repository" : "display");
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

  // Tabs depend on mode
  const globalTabs = ["display", "ai", "agents", "feedback"] as const;
  const workspaceTabs = ["repository", "memory", "images", "ai", "agents", "display"] as const;
  const tabs = mode === "workspace" ? workspaceTabs : globalTabs;
  const tabLabels: Record<string, string> = {
    display: "Display",
    ai: "AI Provider",
    agents: "Agents",
    memory: "Memory",
    images: "Images",
    feedback: "Feedback",
    repository: "Git Remote",
  };

  return (
    <div className="max-w-4xl mx-auto px-6 py-10">
      <h1 className="text-2xl font-semibold tracking-tight mb-2">
        {mode === "workspace" ? "Workspace Settings" : "Settings"}
      </h1>
      <p className="text-sm text-[var(--color-text-secondary)] mb-6">
        {mode === "workspace"
          ? "Settings for this workspace. Overrides apply only here."
          : "Global preferences that apply to all workspaces."}
      </p>

      {/* Tab bar */}
      <div className="flex items-stretch border-b border-[var(--color-border)] mb-6">
        {tabs.map((tab) => (
          <button
            key={tab}
            className={tabBtnClass(activeTab === tab)}
            onClick={() => setActiveTab(tab as SettingsTab)}
          >
            {tabLabels[tab]}
            {mode === "workspace" && tab !== "repository" && (
              <span className="ml-1.5 text-[10px] text-[var(--color-text-secondary)]" title="Override global setting for this workspace">⟳</span>
            )}
          </button>
        ))}
      </div>

      {/* Tab content */}
      {activeTab === "display" && (
        <DisplayTab settings={settings} updateSetting={updateSetting} />
      )}
      {activeTab === "ai" && (
        <AIProviderTab
          settings={settings}
          updateSetting={updateSetting}
          isAzure={isAzure}
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
        <AgentsTab settings={settings} updateSetting={updateSetting} />
      )}
      {activeTab === "memory" && (
        <MemoryTab />
      )}
      {activeTab === "images" && (
        <ImageManagerTab />
      )}
      {activeTab === "feedback" && (
        <FeedbackListTab />
      )}
      {activeTab === "repository" && (
        <RepositoryTab settings={settings} updateSetting={updateSetting} />
      )}
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

function DisplayTab({ settings, updateSetting }: {
  settings: ReturnType<typeof useSettings>["settings"];
  updateSetting: ReturnType<typeof useSettings>["updateSetting"];
}) {
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
                  ? "bg-[var(--color-accent)] text-white border-[var(--color-accent)]"
                  : "bg-[var(--color-surface-alt)] border-[var(--color-border)] text-[var(--color-text-secondary)] hover:text-[var(--color-text)]"
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
        <p className="text-xs text-[var(--color-text-secondary)]">Font used throughout the app. Serif and Sans require web fonts to be available.</p>
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
        <p className="text-xs text-[var(--color-text-secondary)]">Text size for the sketch editor and planning table.</p>
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
        <p className="text-xs text-[var(--color-text-secondary)]">Text size for the chat panel.</p>
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
                  ? "bg-[var(--color-accent)] text-white border-[var(--color-accent)]"
                  : "bg-[var(--color-surface-alt)] border-[var(--color-border)] text-[var(--color-text-secondary)] hover:text-[var(--color-text)]"
              }`}
            >
              {d}
            </button>
          ))}
        </div>
        <p className="text-xs text-[var(--color-text-secondary)]">Controls padding and line-height in planning table rows.</p>
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
                  ? "bg-[var(--color-accent)] text-white border-[var(--color-accent)]"
                  : "bg-[var(--color-surface-alt)] border-[var(--color-border)] text-[var(--color-text-secondary)] hover:text-[var(--color-text)]"
              }`}
            >
              {c}
            </button>
          ))}
        </div>
        <p className="text-xs text-[var(--color-text-secondary)]">Color intensity of the left stripe on planning rows.</p>
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
                  ? "bg-[var(--color-accent)] text-white border-[var(--color-accent)]"
                  : "bg-[var(--color-surface-alt)] border-[var(--color-border)] text-[var(--color-text-secondary)] hover:text-[var(--color-text)]"
              }`}
            >
              {w === "centered" ? "Centered (896px)" : "Full Width"}
            </button>
          ))}
        </div>
        <p className="text-xs text-[var(--color-text-secondary)]">Whether the sketch editor uses a max-width or expands to fill available space.</p>
      </fieldset>
    </div>
  );
}

// ── Copilot Status Sub-component ─────────────────────────────────

interface CopilotCliStatus {
  available: boolean;
  version?: string;
  protocol_version?: number;
}

interface CopilotModelInfo {
  id: string;
  name: string;
  supports_vision: boolean;
  supports_reasoning: boolean;
  billing?: string;
}

function CopilotStatus({ setModels }: {
  fetchModels: () => void;
  setModels: (m: ModelInfo[]) => void;
}) {
  const [status, setStatus] = useState<CopilotCliStatus | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const checkAvailability = useCallback(() => {
    invoke<CopilotCliStatus>("check_copilot_available")
      .then(setStatus)
      .catch(() => setStatus({ available: false }));
  }, []);

  // Check on mount
  useEffect(() => { checkAvailability(); }, [checkAvailability]);

  // Re-check when window regains focus (user may have installed CLI in another window)
  useEffect(() => {
    if (status?.available) return;
    const onFocus = () => checkAvailability();
    window.addEventListener("focus", onFocus);
    return () => window.removeEventListener("focus", onFocus);
  }, [status?.available, checkAvailability]);

  const loadCopilotModels = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const models = await invoke<CopilotModelInfo[]>("list_copilot_models");
      setModels(models.map(m => ({
        id: m.id,
        owned_by: "github-copilot",
        capabilities: {
          ...(m.supports_vision ? { vision: "true" } : {}),
          ...(m.supports_reasoning ? { reasoning: "true" } : {}),
        },
      })));
    } catch (e) {
      console.error("Failed to load Copilot models:", e);
      setError(String(e));
    } finally {
      setLoading(false);
    }
  }, [setModels]);

  // Auto-load models once CLI is detected
  const autoLoaded = useRef(false);
  useEffect(() => {
    if (status?.available && !autoLoaded.current) {
      autoLoaded.current = true;
      loadCopilotModels();
    }
  }, [status?.available, loadCopilotModels]);

  return (
    <div className="rounded-lg border border-[var(--color-border)] bg-[var(--color-surface-alt)] p-3 flex flex-col gap-2">
      <div className="flex items-center gap-2">
        <svg className="w-4 h-4 text-[var(--color-text-secondary)]" viewBox="0 0 16 16" fill="currentColor">
          <path d="M8 0c4.42 0 8 3.58 8 8a8.013 8.013 0 0 1-5.45 7.59c-.4.08-.55-.17-.55-.38 0-.27.01-1.13.01-2.2 0-.75-.25-1.23-.54-1.48 1.78-.2 3.65-.88 3.65-3.95 0-.88-.31-1.59-.82-2.15.08-.2.36-1.02-.08-2.12 0 0-.67-.22-2.2.82-.64-.18-1.32-.27-2-.27-.68 0-1.36.09-2 .27-1.53-1.03-2.2-.82-2.2-.82-.44 1.1-.16 1.92-.08 2.12-.51.56-.82 1.28-.82 2.15 0 3.06 1.86 3.75 3.64 3.95-.23.2-.44.55-.51 1.07-.46.21-1.61.55-2.33-.66-.15-.24-.6-.83-1.23-.82-.67.01-.27.38.01.53.34.19.73.9.82 1.13.16.45.68 1.31 2.69.94 0 .67.01 1.3.01 1.49 0 .21-.15.45-.55.38A7.995 7.995 0 0 1 0 8c0-4.42 3.58-8 8-8Z"/>
        </svg>
        {status === null ? (
          <span className="text-sm text-[var(--color-text-secondary)]">Checking Copilot CLI…</span>
        ) : status.available ? (
          <span className="text-sm text-success font-medium">
            ✓ Copilot CLI{status.version ? ` v${status.version}` : ""}{status.protocol_version ? ` (protocol ${status.protocol_version})` : ""}
          </span>
        ) : (
          <span className="text-sm text-warning">Copilot CLI not found — looking for it… (install from github.com/github/copilot)</span>
        )}
      </div>
      <p className="text-xs text-[var(--color-text-secondary)]">
        Uses your GitHub CLI credentials (<code className="text-[var(--color-accent)]">gh auth login</code>). No API key needed.
      </p>
      {status?.available && (
        <button
          onClick={loadCopilotModels}
          disabled={loading}
          className="w-fit px-3 py-1.5 rounded-lg text-xs font-medium bg-[var(--color-accent)] text-accent-fg hover:bg-[var(--color-accent-hover)] disabled:opacity-50 transition-colors"
        >
          {loading ? "Loading models…" : "Reload models"}
        </button>
      )}
      {!status?.available && status !== null && (
        <button
          onClick={checkAvailability}
          className="w-fit px-3 py-1.5 rounded-lg text-xs font-medium text-[var(--color-text-secondary)] hover:text-[var(--color-text)] border border-[var(--color-border)] hover:bg-[var(--color-surface-alt)] transition-colors"
        >
          Check again
        </button>
      )}
      {error && (
        <p className="text-xs text-error">Failed to load models: {error}</p>
      )}
    </div>
  );
}

// ── AI Provider Tab ──────────────────────────────────────────────

function AIProviderTab({ settings, updateSetting, isAzure, isOAuth, hasToken, canFetchModels, models, setModels, loadingModels, modelFilter, setModelFilter, modelError, fetchModels, oauthStatus, oauthError, startOAuthFlow, signOut }: {
  settings: ReturnType<typeof useSettings>["settings"];
  updateSetting: ReturnType<typeof useSettings>["updateSetting"];
  isAzure: boolean;
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
  return (
    <div className="flex flex-col gap-4">
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
          <option value="copilot_sdk">GitHub Copilot</option>
        </select>
      </fieldset>

      {/* GitHub Copilot Status */}
      {settings.aiProvider === "copilot_sdk" && (
        <CopilotStatus fetchModels={fetchModels} setModels={setModels} />
      )}

      {/* Endpoint (not shown for Copilot) */}
      {settings.aiProvider !== "copilot_sdk" && (
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
      )}

      {/* Auth Mode (Azure only, not Copilot) */}
      {isAzure && settings.aiProvider !== "copilot_sdk" && (
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

      {/* API Key (not for OAuth or Copilot) */}
      {!isOAuth && settings.aiProvider !== "copilot_sdk" && (
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

          {hasToken ? (
            <div className="flex items-center gap-3">
              <span className="text-sm text-success font-medium">
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
                <p className="text-xs text-error">{oauthError}</p>
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
            className="px-3 py-2 rounded-lg border border-[var(--color-border)] bg-[var(--color-surface-alt)] text-sm text-[var(--color-text-secondary)] hover:text-[var(--color-text)] hover:border-[var(--color-accent)]/40 disabled:opacity-40 transition-colors"
            title={models.length > 0 ? "Clear list" : "Fetch available models"}
          >
            {loadingModels ? (
              <svg className="w-4 h-4 animate-spin" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                <path d="M12 2v4m0 12v4m-7.07-3.93l2.83-2.83m8.48-8.48l2.83-2.83M2 12h4m12 0h4M4.93 4.93l2.83 2.83m8.48 8.48l2.83 2.83" />
              </svg>
            ) : models.length > 0 ? (
              <XMarkIcon className="w-4 h-4" />
            ) : (
              <ArrowPathIcon className="w-4 h-4" />
            )}
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
                    if (m.context_length) {
                      updateSetting("aiContextLength", m.context_length);
                    }
                    // Track vision capability for the selected model
                    updateSetting("aiModelSupportsVision", m.capabilities?.vision === "true" ? "true" : "false");
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
          <p className="text-xs text-error">{modelError}</p>
        )}
      </fieldset>

      {/* Vision Mode */}
      <fieldset className="flex flex-col gap-2">
        <label className="text-sm font-medium">Image Vision</label>
        <select
          value={settings.aiVisionMode || "notes_and_sketches"}
          onChange={(e) => updateSetting("aiVisionMode", e.target.value as "off" | "notes" | "notes_and_sketches")}
          className="bg-[var(--color-surface)] border border-[var(--color-border)] rounded px-3 py-1.5 text-sm"
        >
          <option value="off">Off — text only</option>
          <option value="notes">Notes only — images in markdown notes</option>
          <option value="notes_and_sketches">Notes + Sketches — all workspace images</option>
        </select>
        <p className="text-xs text-[var(--color-text-secondary)]">
          When enabled and the model supports vision, images referenced in notes and sketches are sent to the AI.
        </p>
        {settings.aiModelSupportsVision === "false" && settings.aiVisionMode && settings.aiVisionMode !== "off" && (
          <p className="text-xs text-warning">
            ⚠ The selected model does not support vision — images will be ignored.
          </p>
        )}
      </fieldset>
    </div>
  );
}

// ── Agents Tab ───────────────────────────────────────────────────

function AgentsTab({ settings, updateSetting }: {
  settings: ReturnType<typeof useSettings>["settings"];
  updateSetting: ReturnType<typeof useSettings>["updateSetting"];
}) {
  const [editingId, setEditingId] = useState<string | null>(null);
  const [newName, setNewName] = useState("");
  const [newPrompt, setNewPrompt] = useState("");
  const customAgents = settings.aiAgents || [];

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
      <p className="text-xs text-[var(--color-text-secondary)]">
        Agents are AI personas with different system prompts. Select an agent in the chat toolbar to change how the AI responds. Built-in agents ship with CutReady; custom agents are yours to create.
      </p>

      {/* Built-in agents (read-only) */}
      <div>
        <h3 className="text-xs font-semibold uppercase tracking-wider text-[var(--color-text-secondary)] mb-3">Built-in Agents</h3>
        <div className="flex flex-col gap-2">
          {BUILT_IN_AGENTS.map((agent) => (
            <div key={agent.id} className="border border-[var(--color-border)] rounded-lg p-3">
              <div className="flex items-center gap-2 mb-1">
                <span className="text-sm font-medium">{agent.name}</span>
                {settings.aiSelectedAgent === agent.id && (
                  <span className="text-[10px] px-1.5 py-0.5 rounded-full bg-[var(--color-accent)]/10 text-[var(--color-accent)] font-medium">Active</span>
                )}
              </div>
              <p className="text-xs text-[var(--color-text-secondary)] line-clamp-2">
                {agent.prompt.split("\n").find((l) => l.trim() && !l.startsWith("#") && !l.startsWith("You are")) || agent.prompt.slice(0, 120)}
              </p>
            </div>
          ))}
        </div>
      </div>

      {/* Custom agents */}
      <div>
        <h3 className="text-xs font-semibold uppercase tracking-wider text-[var(--color-text-secondary)] mb-3">Custom Agents</h3>
        {customAgents.length === 0 && (
          <p className="text-xs text-[var(--color-text-secondary)] italic mb-3">No custom agents yet.</p>
        )}
        <div className="flex flex-col gap-3">
          {customAgents.map((agent) => (
            <div key={agent.id} className="border border-[var(--color-border)] rounded-lg p-3">
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
                  <button
                    onClick={() => setEditingId(null)}
                    className="text-xs text-[var(--color-accent)] hover:underline self-start"
                  >
                    Done editing
                  </button>
                </div>
              ) : (
                <>
                  <div className="flex items-center gap-2 mb-1">
                    <span className="text-sm font-medium">{agent.name}</span>
                    {settings.aiSelectedAgent === agent.id && (
                      <span className="text-[10px] px-1.5 py-0.5 rounded-full bg-[var(--color-accent)]/10 text-[var(--color-accent)] font-medium">Active</span>
                    )}
                    <div className="flex-1" />
                    <button
                      onClick={() => setEditingId(agent.id)}
                      className="text-[11px] text-[var(--color-text-secondary)] hover:text-[var(--color-text)] transition-colors"
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
                  <p className="text-xs text-[var(--color-text-secondary)] line-clamp-2">
                    {agent.prompt.slice(0, 150)}{agent.prompt.length > 150 ? "…" : ""}
                  </p>
                </>
              )}
            </div>
          ))}
        </div>
      </div>

      {/* Add new agent */}
      <div className="border border-dashed border-[var(--color-border)] rounded-lg p-4 flex flex-col gap-3">
        <h4 className="text-xs font-semibold uppercase tracking-wider text-[var(--color-text-secondary)]">New Agent</h4>
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
          className="px-4 py-2 rounded-lg bg-[var(--color-accent)] text-white text-sm font-medium hover:opacity-90 disabled:opacity-40 transition-opacity w-fit"
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
}

const GITHUB_REPO = "sethjuarez/cutready";
const ISSUE_FORMAT_PROMPT = `You are formatting user feedback into a GitHub issue. Given the feedback below, produce a JSON object with two fields:
- "title": A concise, descriptive issue title (max 80 chars)
- "body": A well-formatted GitHub issue body in markdown. Include:
  - A clear description of the feedback
  - The category as a label suggestion
  - The app version in an "Environment" section
  - If debug log is provided, include it in a collapsible <details> section
  - Keep it professional and actionable

Respond ONLY with valid JSON, no markdown fences.`;

/** Max URL length for browser safety. */
const MAX_URL_LENGTH = 8000;

function FeedbackListTab() {
  const [entries, setEntries] = useState<FeedbackEntry[]>([]);
  const [loading, setLoading] = useState(true);
  const [copied, setCopied] = useState(false);
  const [issuePending, setIssuePending] = useState<number | null>(null);
  const [confirmDelete, setConfirmDelete] = useState<number | null>(null);

  useEffect(() => {
    invoke("list_feedback")
      .then((data) => setEntries(data as FeedbackEntry[]))
      .catch(() => {})
      .finally(() => setLoading(false));
  }, []);

  const copyAll = async () => {
    if (entries.length === 0) return;
    const text = entries
      .map((e) => {
        let t = `## ${e.category}\n**Date:** ${e.date.split("T")[0]}\n\n${e.feedback}`;
        if (e.debug_log) t += `\n\n---\n### Debug Log\n\`\`\`\n${e.debug_log}\n\`\`\``;
        return t;
      })
      .join("\n\n---\n\n");
    try {
      await navigator.clipboard.writeText(text);
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    } catch { /* ignore */ }
  };

   const copySingle = async (entry: FeedbackEntry) => {
    let text = `## ${entry.category}\n**Date:** ${entry.date.split("T")[0]}\n\n${entry.feedback}`;
    if (entry.debug_log) text += `\n\n---\n### Debug Log\n\`\`\`\n${entry.debug_log}\n\`\`\``;
    try {
      await navigator.clipboard.writeText(text);
    } catch { /* ignore */ }
  };

  const clearAll = async () => {
    await invoke("clear_feedback").catch(() => {});
    setEntries([]);
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
    if (entry.debug_log) {
      body += `\n\n<details><summary>Debug Log (${entry.debug_log.split("\n").length} lines)</summary>\n\n\`\`\`\n${entry.debug_log}\n\`\`\`\n</details>`;
    }
    return { title, body };
  };

  /** Try LLM formatting, fall back to simple template. Then submit via gh CLI, fall back to browser. */
  const formatAndOpenIssue = async (entry: FeedbackEntry, index: number) => {
    if (issuePending !== null) return;
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
      // Try to get AI config from settings store
      const s = useSettingsStore.getState().settings;
      const hasAi = s.aiModel && s.aiEndpoint;

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
          provider: s.aiProvider,
          endpoint: s.aiEndpoint,
          api_key: s.aiApiKey,
          model: s.aiModel,
          bearer_token: bearerToken,
        };

        const userContent = [
          `Category: ${entry.category}`,
          `Date: ${entry.date}`,
          `App Version: ${appVersion}`,
          `Feedback: ${entry.feedback}`,
          ...(entry.debug_log ? [`Debug Log:\n${entry.debug_log}`] : []),
        ].join("\n\n");

        let aiContent: string | null = null;

        if (config.provider === "copilot_sdk") {
          try {
            aiContent = await invoke<string>("agent_chat_copilot_simple", {
              model: config.model,
              systemPrompt: ISSUE_FORMAT_PROMPT,
              userMessage: userContent,
            });
          } catch { /* fall through to fallback */ }
        } else {
          const result = await invoke<{ role: string; content: string | null }>("agent_chat", {
            config,
            messages: [
              { role: "system", content: ISSUE_FORMAT_PROMPT },
              { role: "user", content: userContent },
            ],
          });
          aiContent = result.content;
        }

        if (aiContent) {
          const parsed = JSON.parse(aiContent.trim());
          title = parsed.title || buildFallbackIssue(entry, appVersion).title;
          body = parsed.body || buildFallbackIssue(entry, appVersion).body;
        } else {
          ({ title, body } = buildFallbackIssue(entry, appVersion));
        }
      } else {
        ({ title, body } = buildFallbackIssue(entry, appVersion));
      }
    } catch {
      ({ title, body } = buildFallbackIssue(entry, appVersion));
    }

    // Try gh CLI first (no length limits, full body with debug log)
    try {
      const labels = [entry.category === "bug" ? "bug" : entry.category === "feature" ? "enhancement" : "feedback"];
      const url = await invoke<string>("create_github_issue", {
        repo: GITHUB_REPO,
        title,
        body,
        labels,
      });
      if (url) {
        try { await shellOpen(url); } catch { /* opened via gh, URL still returned */ }
        useToastStore.getState().show(`Issue created: ${url}`);
        setIssuePending(null);
        return;
      }
    } catch (ghErr) {
      console.warn("[feedback] gh issue create failed, falling back to browser:", ghErr);
    }

    // Fallback: open browser with URL (may truncate)
    const baseUrl = `https://github.com/${GITHUB_REPO}/issues/new?title=${encodeURIComponent(title)}&body=`;
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
      // Fallback: copy to clipboard
      await navigator.clipboard.writeText(`# ${title}\n\n${body}`).catch(() => {});
    }

    setIssuePending(null);
  };

  if (loading) {
    return <p className="text-xs text-[var(--color-text-secondary)]">Loading…</p>;
  }

  return (
    <div className="space-y-4">
      <div className="flex items-center justify-between">
        <p className="text-xs text-[var(--color-text-secondary)]">
          {entries.length === 0
            ? <>No feedback submitted yet. Use the <ChatBubbleLeftIcon className="w-3 h-3 inline -mt-0.5" /> button in the title bar.</>
            : `${entries.length} feedback item${entries.length === 1 ? "" : "s"}`}
        </p>
        {entries.length > 0 && (
          <div className="flex items-center gap-2">
            <button
              onClick={copyAll}
              className={`flex items-center gap-1.5 px-3 py-1.5 text-[11px] rounded-lg font-medium transition-colors border ${
                copied
                  ? "bg-emerald-500/15 text-emerald-500 border-emerald-500/30"
                  : "bg-[var(--color-surface-alt)] text-[var(--color-text-secondary)] border-[var(--color-border)] hover:text-[var(--color-text)] hover:border-[var(--color-text-secondary)]/40"
              }`}
            >
              {copied ? (
                <>
                  <CheckIcon className="w-3 h-3" />
                  Copied All!
                </>
              ) : (
                <>
                  <ClipboardDocumentIcon className="w-3 h-3" />
                  Copy All
                </>
              )}
            </button>
            <button
              onClick={clearAll}
              className="flex items-center gap-1.5 px-3 py-1.5 text-[11px] rounded-lg font-medium transition-colors border bg-[var(--color-surface-alt)] text-[var(--color-text-secondary)] border-[var(--color-border)] hover:text-error hover:border-error/40"
            >
              <TrashIcon className="w-3 h-3" />
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
              className="group relative px-3 py-2.5 rounded-lg bg-[var(--color-surface-alt)] border border-[var(--color-border)]"
            >
              <div className="flex items-center gap-2 mb-1">
                <span className="text-[10px] font-medium px-1.5 py-0.5 rounded bg-[var(--color-accent)]/10 text-[var(--color-accent)] border border-[var(--color-accent)]/20">
                  {entry.category}
                </span>
                <span className="text-[10px] text-[var(--color-text-secondary)]">
                  {entry.date.split("T")[0]}
                </span>
              </div>
              <p className="text-xs text-[var(--color-text)] whitespace-pre-wrap">{entry.feedback}</p>
              {entry.debug_log && (
                <div className="mt-1.5 flex items-center gap-1 text-[10px] text-[var(--color-text-secondary)]">
                  <Squares2X2Icon className="w-2.5 h-2.5" />
                  Debug log attached ({entry.debug_log.split("\n").length} lines)
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
                    className="px-2 py-0.5 text-[11px] rounded text-[var(--color-text-secondary)] hover:bg-[var(--color-surface)] transition-colors"
                  >
                    Cancel
                  </button>
                </div>
              )}
              {/* Action buttons — hover to reveal */}
              <button
                onClick={() => copySingle(entry)}
                className="absolute top-2 right-16 opacity-0 group-hover:opacity-100 p-1 rounded text-[var(--color-text-secondary)] hover:text-[var(--color-text)] hover:bg-[var(--color-surface)] transition-all"
                title="Copy this item"
              >
                <ClipboardDocumentIcon className="w-3 h-3" />
              </button>
              <button
                onClick={() => setConfirmDelete(isConfirming ? null : realIndex)}
                className="absolute top-2 right-9 opacity-0 group-hover:opacity-100 p-1 rounded text-[var(--color-text-secondary)] hover:text-error hover:bg-[var(--color-surface)] transition-all"
                title="Delete this item"
              >
                <TrashIcon className="w-3 h-3" />
              </button>
              <button
                onClick={() => formatAndOpenIssue(entry, i)}
                disabled={issuePending !== null}
                className={`absolute top-2 right-2 opacity-0 group-hover:opacity-100 p-1 rounded transition-all ${
                  issuePending === i
                    ? "text-[var(--color-accent)] animate-pulse"
                    : "text-[var(--color-text-secondary)] hover:text-[var(--color-text)] hover:bg-[var(--color-surface)]"
                }`}
                title="Create GitHub Issue"
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
    invoke("detect_git_remote")
      .then((info) => {
        if (info && typeof info === "object" && "url" in (info as Record<string, unknown>)) {
          const remote = info as { name: string; url: string };
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
      const remotes = await invoke("list_git_remotes") as { name: string; url: string }[];
      const hasOrigin = remotes.some((r) => r.name === "origin");
      if (hasOrigin) {
        setTestStatus("success");
        setTestMessage("Remote is configured and accessible.");
      } else if (settings.repoRemoteUrl) {
        await invoke("add_git_remote", { name: "origin", url: settings.repoRemoteUrl });
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
      <p className="text-xs text-[var(--color-text-secondary)]">
        Connect to a GitHub remote to collaborate with others. Your snapshots and timelines sync as git commits and branches.
      </p>

      {detectedRemote && !settings.repoRemoteUrl && (
        <div className="flex items-center gap-2 px-3 py-2 rounded-lg bg-[var(--color-accent)]/10 border border-[var(--color-accent)]/20 text-xs text-[var(--color-accent)]">
          <InformationCircleIcon className="w-3.5 h-3.5" />
          Detected remote: <strong>{detectedRemote.url}</strong>
          <button
            onClick={() => updateSetting("repoRemoteUrl", detectedRemote.url)}
            className="ml-auto text-[var(--color-accent)] underline hover:no-underline"
          >
            Use this
          </button>
        </div>
      )}

      <fieldset className="flex flex-col gap-2">
        <label className="text-sm font-medium text-[var(--color-text)]">Remote URL</label>
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
            className="px-3 py-2 rounded-lg text-xs font-medium bg-[var(--color-accent)] text-white hover:opacity-90 transition-opacity disabled:opacity-50"
          >
            {testStatus === "testing" ? "Testing\u2026" : "Test"}
          </button>
        </div>
        {testStatus === "success" && (
          <p className="text-xs text-emerald-600 dark:text-emerald-400">{testMessage}</p>
        )}
        {testStatus === "error" && (
          <p className="text-xs text-error">{testMessage}</p>
        )}
      </fieldset>

      <fieldset className="flex flex-col gap-3">
        <label className="text-sm font-medium text-[var(--color-text)]">Authentication</label>
        <div className="flex flex-col gap-2">
          {authOptions.map((opt) => (
            <label
              key={opt.value}
              className={`flex items-start gap-3 px-3 py-2.5 rounded-lg border cursor-pointer transition-colors ${
                settings.repoAuthMethod === opt.value
                  ? "border-[var(--color-accent)] bg-[var(--color-accent)]/5"
                  : "border-[var(--color-border)] hover:border-[var(--color-text-secondary)]/30"
              }`}
            >
              <input
                type="radio"
                name="repoAuth"
                value={opt.value}
                checked={settings.repoAuthMethod === opt.value}
                onChange={() => updateSetting("repoAuthMethod", opt.value)}
                className="mt-0.5 accent-[var(--color-accent)]"
              />
              <div>
                <span className="text-sm font-medium text-[var(--color-text)]">{opt.label}</span>
                <p className="text-xs text-[var(--color-text-secondary)] mt-0.5">{opt.desc}</p>
              </div>
            </label>
          ))}
        </div>
      </fieldset>

      {settings.repoAuthMethod === "pat" && (
        <fieldset className="flex flex-col gap-2">
          <label className="text-sm font-medium text-[var(--color-text)]">Personal Access Token</label>
          <input
            type="password"
            value={settings.repoToken}
            onChange={(e) => updateSetting("repoToken", e.target.value)}
            placeholder="ghp_xxxxxxxxxxxx"
            className={inputClass}
          />
          <p className="text-xs text-[var(--color-text-secondary)]">
            Create a token at github.com/settings/tokens with &quot;repo&quot; scope.
          </p>
        </fieldset>
      )}

      <fieldset className="flex flex-col gap-2">
        <label className="text-sm font-medium text-[var(--color-text)]">Git Identity</label>
        <p className="text-xs text-[var(--color-text-secondary)] mb-1">
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
      archival: "bg-blue-500/20 text-blue-400",
      insight: "bg-warning/20 text-warning",
    };
    return colors[cat] || "bg-gray-500/20 text-gray-400";
  };

  const globalIndex = (item: MemoryItem) => memories.indexOf(item);

  return (
    <div className="flex flex-col gap-4">
      <div className="flex items-center justify-between">
        <div>
          <h3 className="text-sm font-medium">AI Memory</h3>
          <p className="text-xs text-[var(--color-text-secondary)] mt-0.5">
            {memories.length} {memories.length === 1 ? "memory" : "memories"} stored
          </p>
        </div>
        <div className="flex items-center gap-2">
          <button
            onClick={loadMemories}
            className="px-2 py-1 text-xs rounded border border-[var(--color-border)] hover:bg-[var(--color-surface-alt)] transition-colors"
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
                  ? "bg-[var(--color-accent)]/20 text-[var(--color-accent)]"
                  : "text-[var(--color-text-secondary)] hover:bg-[var(--color-surface-alt)]"
              }`}
            >
              {cat === "all" ? "All" : cat.charAt(0).toUpperCase() + cat.slice(1)} ({count})
            </button>
          );
        })}
      </div>

      {/* Memory list */}
      {loading ? (
        <p className="text-xs text-[var(--color-text-secondary)] py-4 text-center">Loading…</p>
      ) : filtered.length === 0 ? (
        <div className="text-center py-8 text-[var(--color-text-secondary)]">
          <p className="text-sm">No memories yet</p>
          <p className="text-xs mt-1">The AI assistant will save memories as you chat.</p>
        </div>
      ) : (
        <div className="flex flex-col gap-1.5 max-h-[400px] overflow-y-auto">
          {filtered.map((m) => {
            const idx = globalIndex(m);
            const isEditing = editingIndex === idx;
            return (
              <div
                key={idx}
                className="group flex flex-col gap-1 p-2.5 rounded-lg border border-[var(--color-border)] bg-[var(--color-surface-alt)] hover:border-[var(--color-text-secondary)]/30 transition-colors"
              >
                <div className="flex items-start justify-between gap-2">
                  <div className="flex items-center gap-2 min-w-0">
                    <span className={`px-1.5 py-0.5 text-[10px] rounded-full font-medium ${categoryBadge(m.category)}`}>
                      {m.category}
                    </span>
                    {m.tags.length > 0 && (
                      <span className="text-[10px] text-[var(--color-text-secondary)] truncate">
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
                      className="px-1.5 py-0.5 text-[10px] rounded hover:bg-[var(--color-accent)]/10 text-[var(--color-text-secondary)]"
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
                      className="flex-1 px-2 py-1 text-xs rounded bg-[var(--color-surface)] border border-[var(--color-border)] text-[var(--color-text)] focus:outline-none focus:ring-1 focus:ring-[var(--color-accent)]/40"
                      autoFocus
                    />
                    <button
                      onClick={() => handleUpdate(idx)}
                      className="px-2 py-1 text-xs rounded bg-[var(--color-accent)]/20 text-[var(--color-accent)] hover:bg-[var(--color-accent)]/30"
                    >
                      Save
                    </button>
                  </div>
                ) : (
                  <p className="text-xs text-[var(--color-text)] leading-relaxed">{m.content}</p>
                )}
                <span className="text-[10px] text-[var(--color-text-secondary)]/50">
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
