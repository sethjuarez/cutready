import { useEffect, useRef, useState } from "react";
import { Check, ClipboardList, Image, Info, LayoutGrid, MessageSquare, Trash2, X } from "lucide-react";
import { open as shellOpen } from "@tauri-apps/plugin-shell";
import { useSettings, useSettingsStore } from "../../hooks/useSettings";
import { invoke } from "../../services/tauri";
import { useToastStore } from "../../stores/toastStore";
import { agentChat } from "../../services/agentChat";
import { buildProviderConfig, isAiProviderConfigured } from "../../utils/providerConfig";
import { sanitizeDiagnosticsLog } from "../../utils/diagnosticsSanitizer";
import { appendFeedbackAttachmentsSection, formatFeedbackAttachmentSize, formatFeedbackAttachmentsMarkdown, type FeedbackAttachmentMetadata } from "../../utils/feedbackAttachments";
import { Dialog } from "../Dialog";
import { inputClass } from "../../styles";

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

export function FeedbackListTab() {
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
    } catch (issueErr) {
      console.warn("[feedback] GitHub issue create failed, falling back to browser:", issueErr);
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
      >
        <div className="cr-modal-surface rounded-2xl overflow-hidden">
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
