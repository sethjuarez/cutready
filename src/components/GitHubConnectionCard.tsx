import { useEffect, useState } from "react";
import { open as shellOpen } from "@tauri-apps/plugin-shell";
import { CheckCircle, Copy, GitBranch, LogOut, RefreshCw, ShieldCheck } from "lucide-react";
import {
  getGitHubAuthStatus,
  pollGitHubDeviceCode,
  signOutGitHub,
  startGitHubDeviceCode,
  type GitHubAuthStatus,
  type GitHubDeviceCodeStartResult,
} from "../services/githubSetup";

export function GitHubConnectionCard({ compact = false }: { compact?: boolean }) {
  const [status, setStatus] = useState<GitHubAuthStatus | null>(null);
  const [deviceCode, setDeviceCode] = useState<GitHubDeviceCodeStartResult | null>(null);
  const [phase, setPhase] = useState<"idle" | "loading" | "waiting" | "connected" | "error">("loading");
  const [error, setError] = useState("");

  const refresh = async () => {
    setError("");
    try {
      const next = await getGitHubAuthStatus();
      setStatus(next);
      setPhase(next.connected ? "connected" : "idle");
    } catch (err) {
      setError(String(err));
      setPhase("error");
    }
  };

  useEffect(() => {
    void refresh();
  }, []);

  const connect = async () => {
    setPhase("loading");
    setError("");
    try {
      const started = await startGitHubDeviceCode();
      setDeviceCode(started);
      setPhase("waiting");
      try {
        await shellOpen(started.verificationUri);
      } catch {
        // The code remains visible for manual opening/copying.
      }
      await pollGitHubDeviceCode(started.deviceCode, started.interval, started.expiresIn);
      setDeviceCode(null);
      await refresh();
    } catch (err) {
      setError(String(err));
      setPhase("error");
    }
  };

  const disconnect = async () => {
    setPhase("loading");
    setError("");
    try {
      await signOutGitHub();
      setDeviceCode(null);
      await refresh();
    } catch (err) {
      setError(String(err));
      setPhase("error");
    }
  };

  const copyCode = async () => {
    if (!deviceCode) return;
    await navigator.clipboard?.writeText(deviceCode.userCode).catch(() => undefined);
  };

  const connectedWithCutReady = status?.connected && status.credentialSource === "cutready";
  const connectedWithGh = status?.connected && status.credentialSource === "gh_cli";
  const isBusy = phase === "loading" || phase === "waiting";

  return (
    <section
      data-testid="github-connection-card"
      className={`rounded-xl border border-[rgb(var(--color-border))] bg-[rgb(var(--color-surface-alt))] ${compact ? "p-3" : "p-4"}`}
    >
      <div className="flex items-start gap-3">
        <div className="grid h-9 w-9 shrink-0 place-items-center rounded-lg bg-[rgb(var(--color-accent))]/12 text-[rgb(var(--color-accent))]">
          <GitBranch className="h-4 w-4" />
        </div>
        <div className="min-w-0 flex-1">
          <div className="flex items-center gap-2">
            <h3 className="text-sm font-semibold text-[rgb(var(--color-text))]">GitHub account</h3>
            {connectedWithCutReady && <CheckCircle className="h-3.5 w-3.5 text-success" />}
            {connectedWithGh && <ShieldCheck className="h-3.5 w-3.5 text-[rgb(var(--color-accent))]" />}
          </div>
          <p className="mt-1 text-xs leading-5 text-[rgb(var(--color-text-secondary))]">
            {connectedWithCutReady && status.account
              ? `Connected as ${status.account.login}. CutReady can sync workspaces and file feedback without GitHub CLI.`
              : connectedWithGh
                ? "Using your existing GitHub CLI sign-in as a fallback."
                : "Connect GitHub once so CutReady can clone, sync, and share collaborative workspaces."}
          </p>
        </div>
      </div>

      {deviceCode && phase === "waiting" && (
        <div className="mt-3 rounded-lg border border-[rgb(var(--color-accent))]/20 bg-[rgb(var(--color-accent))]/8 p-3">
          <div className="text-xs text-[rgb(var(--color-text-secondary))]">
            Enter this code at <span className="font-medium text-[rgb(var(--color-text))]">{deviceCode.verificationUri}</span>
          </div>
          <div className="mt-2 flex items-center gap-2">
            <code className="rounded-md bg-[rgb(var(--color-surface))] px-2 py-1 font-mono text-lg font-semibold tracking-[0.18em] text-[rgb(var(--color-text))]">
              {deviceCode.userCode}
            </code>
            <button
              type="button"
              onClick={copyCode}
              className="grid h-8 w-8 place-items-center rounded-lg text-[rgb(var(--color-text-secondary))] hover:bg-[rgb(var(--color-surface))] hover:text-[rgb(var(--color-text))]"
              aria-label="Copy GitHub sign-in code"
              title="Copy code"
            >
              <Copy className="h-3.5 w-3.5" />
            </button>
          </div>
          <div className="mt-2 flex items-center gap-1.5 text-xs text-[rgb(var(--color-accent))]">
            <RefreshCw className="h-3 w-3 animate-spin" />
            Waiting for GitHub approval...
          </div>
        </div>
      )}

      {error && (
        <p className="mt-3 text-xs leading-5 text-error">{error}</p>
      )}

      <div className="mt-3 flex flex-wrap items-center gap-2">
        {connectedWithCutReady ? (
          <button
            type="button"
            data-testid="github-disconnect-button"
            onClick={disconnect}
            disabled={isBusy}
            className="inline-flex items-center gap-1.5 rounded-lg px-3 py-1.5 text-xs font-medium text-[rgb(var(--color-text-secondary))] transition-colors hover:bg-[rgb(var(--color-surface))] hover:text-[rgb(var(--color-text))] disabled:opacity-50"
          >
            <LogOut className="h-3.5 w-3.5" />
            Disconnect
          </button>
        ) : (
          <button
            type="button"
            data-testid="github-connect-button"
            onClick={connect}
            disabled={isBusy || status?.clientConfigured === false}
            className="inline-flex items-center gap-1.5 rounded-lg bg-[rgb(var(--color-accent))] px-3 py-1.5 text-xs font-medium text-[rgb(var(--color-accent-fg))] transition-opacity hover:opacity-90 disabled:opacity-50"
          >
            {isBusy ? <RefreshCw className="h-3.5 w-3.5 animate-spin" /> : <GitBranch className="h-3.5 w-3.5" />}
            {phase === "waiting" ? "Connecting..." : "Connect GitHub"}
          </button>
        )}
        <button
          type="button"
          data-testid="github-refresh-button"
          onClick={refresh}
          disabled={isBusy}
          className="rounded-lg px-3 py-1.5 text-xs font-medium text-[rgb(var(--color-text-secondary))] transition-colors hover:bg-[rgb(var(--color-surface))] hover:text-[rgb(var(--color-text))] disabled:opacity-50"
        >
          Refresh
        </button>
      </div>

      {status?.clientConfigured === false && (
        <p className="mt-3 text-xs text-warning">
          GitHub OAuth is not configured for this build.
        </p>
      )}
    </section>
  );
}
