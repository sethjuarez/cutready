import { useCallback, useEffect, useState } from "react";
import { Bot, Check, CheckCircle, Copy, ExternalLink, FlaskConical, Info, LogIn, RefreshCw } from "lucide-react";
import { open as shellOpen } from "@tauri-apps/plugin-shell";
import { useSettings, type AgentPreset } from "../../hooks/useSettings";
import { invoke } from "../../services/tauri";
import { inputClass } from "../../styles";
import { BUILT_IN_AGENTS } from "../../agents/builtInAgents";
import type { ModelInfo } from "./types";

type HarnessOwnership = "requires" | "provides" | "augments";

interface HarnessContract {
  provider: HarnessOwnership;
  personas: HarnessOwnership;
  tools: HarnessOwnership;
  memory: HarnessOwnership;
}

interface HarnessDescriptor {
  id: string;
  display_name: string;
  streaming: boolean;
  tool_calls: boolean;
  vision: boolean;
  web_search: boolean;
  delegation: boolean;
  steering: boolean;
  cancellation: boolean;
  durable_state: boolean;
  contract: HarnessContract;
  available: boolean;
  stability?: "stable" | "experimental";
}

const HARNESS_CAPABILITY_LABELS: { key: keyof HarnessDescriptor; label: string }[] = [
  { key: "streaming", label: "Streaming" },
  { key: "tool_calls", label: "Tools" },
  { key: "vision", label: "Vision" },
  { key: "web_search", label: "Web" },
  { key: "delegation", label: "Delegation" },
  { key: "steering", label: "Steering" },
  { key: "cancellation", label: "Cancellation" },
  { key: "durable_state", label: "Durable state" },
];

/** Canonical id of the GitHub Copilot (copilot-sdk) harness. */
const COPILOT_HARNESS_ID = "copilot-sdk";

/** Canonical id of the always-linked Prompty harness (the app's backbone runtime). */
const PROMPTY_HARNESS_ID = "prompty";

/** Live install + sign-in snapshot returned by the `copilot_auth_status` command. */
interface CopilotAuthStatus {
  installed: boolean;
  authenticated: boolean;
  login?: string | null;
  message?: string | null;
  cliVersion?: string | null;
}

const COPILOT_INSTALL_COMMAND = "npm install -g @github/copilot";
const COPILOT_LOGIN_COMMAND = "copilot login";
const COPILOT_CLI_DOCS_URL = "https://docs.github.com/copilot/how-tos/copilot-cli";

/** A small copy-to-clipboard command chip with inline "copied" feedback. */
function CommandCopyRow({
  command,
  copiedKey,
  onCopy,
  copyKey,
  ariaLabel,
}: {
  command: string;
  copiedKey: string | null;
  onCopy: (text: string, key: string) => void;
  copyKey: string;
  ariaLabel: string;
}) {
  const copied = copiedKey === copyKey;
  return (
    <div className="flex items-center gap-1.5">
      <code className="min-w-0 flex-1 truncate rounded-md bg-[rgb(var(--color-surface))] px-2 py-1 font-mono text-[11px] text-[rgb(var(--color-text))]">
        {command}
      </code>
      <button
        type="button"
        onClick={() => onCopy(command, copyKey)}
        aria-label={ariaLabel}
        title={copied ? "Copied" : "Copy"}
        className="grid h-7 w-7 shrink-0 place-items-center rounded-md text-[rgb(var(--color-text-secondary))] transition-colors hover:bg-[rgb(var(--color-surface))] hover:text-[rgb(var(--color-text))]"
      >
        {copied ? <Check className="h-3.5 w-3.5 text-success" /> : <Copy className="h-3.5 w-3.5" />}
      </button>
    </div>
  );
}

/**
 * Live GitHub Copilot connection panel for the copilot-sdk harness card.
 *
 * Probes the CLI's install + sign-in state on mount and on an explicit Recheck
 * (never on a timer), and guides a non-technical user from "not installed" →
 * "not signed in" → "signed in as @user" without leaving the app. Sign-in
 * launches the CLI's own browser flow; guided steps + Recheck are always
 * available as a fallback.
 */
function CopilotConnect() {
  const [status, setStatus] = useState<CopilotAuthStatus | null>(null);
  const [phase, setPhase] = useState<"loading" | "ready" | "signing">("loading");
  const [error, setError] = useState("");
  const [copiedKey, setCopiedKey] = useState<string | null>(null);

  const probe = useCallback(async () => {
    setError("");
    try {
      const next = await invoke<CopilotAuthStatus>("copilot_auth_status");
      setStatus(next);
    } catch (e) {
      setError(String(e));
    } finally {
      setPhase("ready");
    }
  }, []);

  useEffect(() => {
    void probe();
  }, [probe]);

  const copy = useCallback(async (text: string, key: string) => {
    try {
      await navigator.clipboard?.writeText(text);
      setCopiedKey(key);
      window.setTimeout(() => setCopiedKey((current) => (current === key ? null : current)), 1500);
    } catch {
      /* clipboard unavailable (e.g. dev web shim) */
    }
  }, []);

  const recheck = useCallback(() => {
    setPhase("loading");
    void probe();
  }, [probe]);

  const signIn = useCallback(async () => {
    setPhase("signing");
    setError("");
    try {
      await invoke("copilot_sign_in");
    } catch (e) {
      setError(String(e));
    }
    setPhase("loading");
    await probe();
  }, [probe]);

  const isSigningIn = phase === "signing";

  const RecheckButton = (
    <button
      type="button"
      data-testid="copilot-recheck"
      onClick={recheck}
      disabled={phase === "loading" || isSigningIn}
      className="inline-flex items-center gap-1.5 rounded-md px-2 py-1 text-[11px] font-medium text-[rgb(var(--color-text-secondary))] transition-colors hover:bg-[rgb(var(--color-surface))] hover:text-[rgb(var(--color-text))] disabled:opacity-50"
    >
      <RefreshCw className={`h-3 w-3 ${phase === "loading" ? "animate-spin" : ""}`} /> Recheck
    </button>
  );

  if (phase === "loading" && !status) {
    return (
      <div
        data-testid="copilot-connect"
        data-state="loading"
        className="flex items-center gap-1.5 text-[11px] text-[rgb(var(--color-text-secondary))]"
      >
        <RefreshCw className="h-3 w-3 animate-spin" /> Checking GitHub Copilot…
      </div>
    );
  }

  const notInstalled = !!status && !status.installed;
  const needsSignIn = !!status && status.installed && !status.authenticated;
  const signedIn = !!status && status.installed && status.authenticated;
  const connectState = signedIn
    ? "signed-in"
    : needsSignIn
      ? "needs-sign-in"
      : notInstalled
        ? "not-installed"
        : "unknown";

  return (
    <div data-testid="copilot-connect" data-state={connectState} className="flex flex-col gap-2">
      {/* Status chip */}
      <div className="flex items-center gap-2">
        {signedIn && (
          <span className="inline-flex items-center gap-1.5 rounded-full bg-success/10 px-2 py-0.5 text-[11px] font-medium text-success">
            <span className="h-1.5 w-1.5 rounded-full bg-success" />
            Signed in{status?.login ? ` as @${status.login}` : ""}
          </span>
        )}
        {needsSignIn && (
          <span className="inline-flex items-center gap-1.5 rounded-full bg-warning/10 px-2 py-0.5 text-[11px] font-medium text-warning">
            <span className="h-1.5 w-1.5 rounded-full bg-warning" />
            Installed — not signed in
          </span>
        )}
        {notInstalled && (
          <span className="inline-flex items-center gap-1.5 rounded-full bg-error/10 px-2 py-0.5 text-[11px] font-medium text-error">
            <span className="h-1.5 w-1.5 rounded-full bg-error" />
            Copilot CLI not installed
          </span>
        )}
        {status?.cliVersion && signedIn && (
          <span className="text-[10px] font-mono text-[rgb(var(--color-text-secondary))]">
            CLI {status.cliVersion}
          </span>
        )}
      </div>

      {/* Signed in: reassure that no chat provider is needed. */}
      {signedIn && (
        <p className="flex items-start gap-1.5 text-[11px] leading-snug text-[rgb(var(--color-text-secondary))]">
          <CheckCircle className="mt-0.5 h-3 w-3 shrink-0 text-success" />
          <span>
            GitHub Copilot brings its own model for agent turns, so you don&apos;t need to configure a
            chat provider for the agent.
          </span>
        </p>
      )}

      {/* Not signed in: one-click browser sign-in + a terminal fallback. */}
      {needsSignIn && (
        <div className="flex flex-col gap-2">
          <p className="text-[11px] leading-snug text-[rgb(var(--color-text-secondary))]">
            Sign in with your GitHub account to use Copilot for agent turns. This opens your browser
            to finish authorizing.
          </p>
          <div className="flex flex-wrap items-center gap-2">
            <button
              type="button"
              data-testid="copilot-sign-in"
              onClick={signIn}
              disabled={isSigningIn}
              className="inline-flex items-center gap-1.5 rounded-md bg-[rgb(var(--color-accent))] px-2.5 py-1 text-[11px] font-medium text-[rgb(var(--color-accent-fg))] transition-opacity hover:opacity-90 disabled:opacity-50"
            >
              {isSigningIn ? (
                <RefreshCw className="h-3.5 w-3.5 animate-spin" />
              ) : (
                <LogIn className="h-3.5 w-3.5" />
              )}
              {isSigningIn ? "Waiting for browser…" : "Sign in"}
            </button>
            {RecheckButton}
          </div>
          <div className="flex flex-col gap-1">
            <span className="text-[10px] text-[rgb(var(--color-text-secondary))]">
              Or run this in a terminal, then Recheck:
            </span>
            <CommandCopyRow
              command={COPILOT_LOGIN_COMMAND}
              copiedKey={copiedKey}
              onCopy={copy}
              copyKey="login"
              ariaLabel="Copy Copilot sign-in command"
            />
          </div>
        </div>
      )}

      {/* Not installed: concise install guidance + docs link. */}
      {notInstalled && (
        <div className="flex flex-col gap-2">
          <p className="text-[11px] leading-snug text-[rgb(var(--color-text-secondary))]">
            Install the GitHub Copilot CLI, then Recheck:
          </p>
          <CommandCopyRow
            command={COPILOT_INSTALL_COMMAND}
            copiedKey={copiedKey}
            onCopy={copy}
            copyKey="install"
            ariaLabel="Copy Copilot CLI install command"
          />
          <div className="flex flex-wrap items-center gap-2">
            <button
              type="button"
              onClick={() => {
                void shellOpen(COPILOT_CLI_DOCS_URL);
              }}
              className="inline-flex items-center gap-1.5 rounded-md px-2 py-1 text-[11px] font-medium text-[rgb(var(--color-accent))] transition-colors hover:bg-[rgb(var(--color-accent))]/10"
            >
              <ExternalLink className="h-3 w-3" /> Installation guide
            </button>
            {RecheckButton}
          </div>
        </div>
      )}

      {/* Recheck is always reachable, even in the signed-in state. */}
      {signedIn && <div className="flex items-center">{RecheckButton}</div>}

      {status?.message && (needsSignIn || notInstalled) && (
        <p className="text-[10px] leading-snug text-[rgb(var(--color-text-secondary))]">
          {status.message}
        </p>
      )}
      {error && <p className="text-[11px] leading-snug text-error">{error}</p>}
    </div>
  );
}

/**
 * Runtime harness picker. Lists every harness the backend registry advertises,
 * shows honest capability metadata, and lets the user switch which runtime
 * executes agent turns. Unavailable harnesses are shown but not selectable.
 */
export function HarnessPicker({ value, onChange }: { value: string; onChange: (id: string) => void }) {
  const [harnesses, setHarnesses] = useState<HarnessDescriptor[]>([]);
  const [error, setError] = useState("");

  useEffect(() => {
    let active = true;
    invoke<HarnessDescriptor[]>("list_agent_harnesses")
      .then((list) => { if (active) setHarnesses(list); })
      .catch((e) => { if (active) setError(String(e)); });
    return () => { active = false; };
  }, []);

  // Mirror the backend's canonical_id normalization (trim; empty → Prompty) so a
  // blank or whitespace-padded stored value isn't falsely flagged as unavailable.
  const effectiveValue = value.trim() || PROMPTY_HARNESS_ID;
  const selectedKnown = harnesses.some((h) => h.id === effectiveValue);

  return (
    <div data-testid="harness-picker">
      <h3 className="text-xs font-semibold uppercase tracking-wider text-[rgb(var(--color-text-secondary))] mb-1 flex items-center gap-1.5">
        <Bot className="w-3.5 h-3.5" /> Runtime Harness
      </h3>
      <p className="text-xs text-[rgb(var(--color-text-secondary))] mb-3">
        The engine that drives agent turns. Capabilities are reported by each harness — differences are explicit, never silently downgraded.
      </p>
      {error && <p className="text-xs text-error mb-2">Could not load harnesses: {error}</p>}
      <div className="flex flex-col gap-2">
        {harnesses.map((harness) => {
          const selected = harness.id === value;
          const selectable = harness.available;
          const isCopilot = harness.id === COPILOT_HARNESS_ID;
          const isExperimental = harness.stability === "experimental";
          const baseCardClass = `border rounded-lg p-3 transition-colors ${
            selected
              ? "border-[rgb(var(--color-accent))] bg-[rgb(var(--color-accent))]/5"
              : "border-[rgb(var(--color-border))]"
          }`;
          const cardBody = (
            <>
              <div className="flex items-center gap-2 mb-1.5">
                <span className="text-sm font-medium">{harness.display_name}</span>
                <span className="text-[10px] font-mono text-[rgb(var(--color-text-secondary))]">{harness.id}</span>
                {selected && (
                  <span className="text-[10px] px-1.5 py-0.5 rounded-full bg-[rgb(var(--color-accent))]/10 text-[rgb(var(--color-accent))] font-medium flex items-center gap-1">
                    <Check className="w-3 h-3" /> Active
                  </span>
                )}
                {!harness.available && (
                  <span
                    className="text-[10px] px-1.5 py-0.5 rounded-full bg-[rgb(var(--color-text-secondary))]/10 text-[rgb(var(--color-text-secondary))] font-medium flex items-center gap-1"
                    title="This harness is wired but can't run here right now (its runtime or CLI isn't available on this system)."
                  >
                    <FlaskConical className="w-3 h-3" /> Unavailable
                  </span>
                )}
                {isExperimental && (
                  <span
                    data-testid={`harness-experimental-${harness.id}`}
                    className="text-[10px] px-1.5 py-0.5 rounded-full bg-warning/15 text-warning font-medium flex items-center gap-1"
                    title="Experimental: this harness is wired and runnable but still maturing — its full capability set isn't proven end-to-end yet."
                  >
                    <FlaskConical className="w-3 h-3" /> Experimental
                  </span>
                )}
              </div>
              <div className="flex flex-wrap gap-1">
                {HARNESS_CAPABILITY_LABELS.map(({ key, label }) => {
                  const on = harness[key] as boolean;
                  return (
                    <span
                      key={key}
                      className={`text-[10px] px-1.5 py-0.5 rounded ${
                        on
                          ? "bg-[rgb(var(--color-accent))]/10 text-[rgb(var(--color-accent))]"
                          : "bg-[rgb(var(--color-text-secondary))]/8 text-[rgb(var(--color-text-secondary))] line-through"
                      }`}
                    >
                      {label}
                    </span>
                  );
                })}
              </div>
              {selected && harness.contract && harness.contract.provider !== "requires" && (
                <p className="text-[11px] leading-snug text-[rgb(var(--color-text-secondary))] mt-2 flex items-start gap-1.5">
                  <Info className="w-3 h-3 mt-0.5 shrink-0" />
                  <span>
                    {harness.contract.provider === "provides"
                      ? "Signed in with GitHub Copilot — this harness brings its own model provider for agent turns, so you don't need to configure a chat provider for the agent. A bring-your-own-key provider is optional."
                      : "This harness layers your provider over its own for agent turns, so configuring a chat provider for the agent is optional."}
                    {" "}The Connections below are still used for narration and voice.
                  </span>
                </p>
              )}
              {selected && isExperimental && (
                <p
                  data-testid={`harness-experimental-note-${harness.id}`}
                  className="text-[11px] leading-snug text-warning mt-2 flex items-start gap-1.5"
                >
                  <FlaskConical className="w-3 h-3 mt-0.5 shrink-0" />
                  <span>
                    This harness is experimental — it runs, but its full capability set isn't
                    proven end-to-end yet. Prefer a stable harness for production demos.
                  </span>
                </p>
              )}
            </>
          );

          // The Copilot card carries an interactive connect block (Sign in /
          // Recheck / Copy buttons), so it can't be a single <button> — nesting
          // buttons is invalid. Wrap it in a <div> with the selection <button>
          // and the connect block as siblings. The connect block stays
          // full-opacity even when the CLI is unavailable, so users can act on
          // the install guidance.
          if (isCopilot) {
            return (
              <div key={harness.id} data-testid={`harness-option-${harness.id}`} data-selected={selected} className={`${baseCardClass} ${selectable ? "hover:border-[rgb(var(--color-accent))]/60" : ""}`}>
                <button
                  type="button"
                  disabled={!selectable}
                  onClick={() => selectable && onChange(harness.id)}
                  className={`w-full text-left ${selectable ? "cursor-pointer" : "opacity-60 cursor-not-allowed"}`}
                >
                  {cardBody}
                </button>
                <div className="mt-2.5 pt-2.5 border-t border-[rgb(var(--color-border))]">
                  <CopilotConnect />
                </div>
              </div>
            );
          }

          return (
            <button
              key={harness.id}
              type="button"
              data-testid={`harness-option-${harness.id}`}
              data-selected={selected}
              disabled={!selectable}
              onClick={() => selectable && onChange(harness.id)}
              className={`text-left ${baseCardClass} ${selectable ? "hover:border-[rgb(var(--color-accent))]/60 cursor-pointer" : "opacity-60 cursor-not-allowed"}`}
            >
              {cardBody}
            </button>
          );
        })}
      </div>
      {harnesses.length > 0 && !selectedKnown && (() => {
        // The saved selection isn't one of the harnesses compiled into this
        // build. It may still be a backend-resolvable alias, so we don't
        // silently switch it (differences are explicit, never downgraded) —
        // instead we surface the risk and offer a one-click move to a harness
        // we can see. Prompty is the always-linked backbone, so prefer it.
        const fallback =
          harnesses.find((h) => h.id === PROMPTY_HARNESS_ID) ??
          harnesses.find((h) => h.available) ??
          harnesses[0];
        return (
          <div data-testid="harness-unavailable-warning" className="mt-2 rounded-lg border border-[rgb(var(--color-border))] bg-[rgb(var(--color-text-secondary))]/5 p-2.5">
            <p className="text-xs text-[rgb(var(--color-text-secondary))] flex items-start gap-1.5">
              <Info className="w-3.5 h-3.5 mt-0.5 shrink-0" />
              <span>
                Current selection <span className="font-mono">{value}</span> isn't one of
                the harnesses available in this build. If the backend can't resolve it when
                a run starts, the run will fail — switch to a listed harness to be sure.
              </span>
            </p>
            {fallback && fallback.id !== value && (
              <button
                type="button"
                data-testid="harness-switch-fallback"
                onClick={() => onChange(fallback.id)}
                className="mt-2 text-xs px-2 py-1 rounded-md border border-[rgb(var(--color-accent))] text-[rgb(var(--color-accent))] hover:bg-[rgb(var(--color-accent))]/10 transition-colors"
              >
                Switch to {fallback.display_name}
              </button>
            )}
          </div>
        );
      })()}
    </div>
  );
}

export function AgentsTab({ settings, updateSetting, models, loadingModels, canFetchModels, fetchModels, modelError }: {
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

      {/* Runtime harness selector */}
      <HarnessPicker
        value={settings.aiAgentExecutionEngine}
        onChange={(id) => updateSetting("aiAgentExecutionEngine", id)}
      />

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
