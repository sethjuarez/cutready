import { useState } from "react";
import { useSettings, type AgentPreset } from "../hooks/useSettings";
import { invoke } from "@tauri-apps/api/core";
import { open as shellOpen } from "@tauri-apps/plugin-shell";
import { BUILT_IN_AGENTS } from "./ChatPanel";
import { ImageManagerTab } from "./ImageManagerTab";

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

type SettingsTab = "general" | "ai" | "agents" | "display" | "images";

const inputClass =
  "px-3 py-2 rounded-lg bg-[var(--color-surface-alt)] border border-[var(--color-border)] text-sm text-[var(--color-text)] placeholder:text-[var(--color-text-secondary)]/50 focus:outline-none focus:ring-2 focus:ring-[var(--color-accent)]/40";

const tabBtnClass = (active: boolean) =>
  `px-4 py-2 text-sm font-medium transition-colors border-b-2 -mb-px ${
    active
      ? "border-[var(--color-accent)] text-[var(--color-text)]"
      : "border-transparent text-[var(--color-text-secondary)] hover:text-[var(--color-text)] hover:border-[var(--color-text-secondary)]/30"
  }`;

export function SettingsPanel() {
  const { settings, updateSetting, loaded } = useSettings();
  const [activeTab, setActiveTab] = useState<SettingsTab>("general");
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

  return (
    <div className="max-w-xl mx-auto px-6 py-10">
      <h1 className="text-2xl font-semibold tracking-tight mb-2">Settings</h1>
      <p className="text-sm text-[var(--color-text-secondary)] mb-6">
        Configure CutReady preferences.
      </p>

      {/* Tab bar */}
      <div className="flex items-stretch border-b border-[var(--color-border)] mb-6">
        <button className={tabBtnClass(activeTab === "general")} onClick={() => setActiveTab("general")}>General</button>
        <button className={tabBtnClass(activeTab === "display")} onClick={() => setActiveTab("display")}>Display</button>
        <button className={tabBtnClass(activeTab === "ai")} onClick={() => setActiveTab("ai")}>AI Provider</button>
        <button className={tabBtnClass(activeTab === "agents")} onClick={() => setActiveTab("agents")}>Agents</button>
        <button className={tabBtnClass(activeTab === "images")} onClick={() => setActiveTab("images")}>Images</button>
      </div>

      {/* Tab content */}
      {activeTab === "general" && (
        <GeneralTab settings={settings} updateSetting={updateSetting} />
      )}
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
      {activeTab === "images" && (
        <ImageManagerTab />
      )}
    </div>
  );
}

// ── General Tab ──────────────────────────────────────────────────

function GeneralTab({ settings, updateSetting }: {
  settings: ReturnType<typeof useSettings>["settings"];
  updateSetting: ReturnType<typeof useSettings>["updateSetting"];
}) {
  return (
    <div className="flex flex-col gap-6">
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
        </select>
      </fieldset>

      {/* Endpoint */}
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

      {/* API Key */}
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
            className="px-3 py-2 rounded-lg border border-[var(--color-border)] bg-[var(--color-surface-alt)] text-sm text-[var(--color-text-secondary)] hover:text-[var(--color-text)] hover:border-[var(--color-accent)]/40 disabled:opacity-40 transition-colors"
            title={models.length > 0 ? "Clear list" : "Fetch available models"}
          >
            {loadingModels ? (
              <svg className="w-4 h-4 animate-spin" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                <path d="M12 2v4m0 12v4m-7.07-3.93l2.83-2.83m8.48-8.48l2.83-2.83M2 12h4m12 0h4M4.93 4.93l2.83 2.83m8.48 8.48l2.83 2.83" />
              </svg>
            ) : models.length > 0 ? (
              <svg className="w-4 h-4" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round">
                <path d="M18 6L6 18M6 6l12 12" />
              </svg>
            ) : (
              <svg className="w-4 h-4" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                <path d="M21 12a9 9 0 11-6.22-8.56" />
                <path d="M21 3v5h-5" />
              </svg>
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
                      className="text-[11px] text-red-400 hover:text-red-500 transition-colors"
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
