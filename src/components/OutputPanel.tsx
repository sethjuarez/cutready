import { useCallback, useEffect, useState } from "react";
import { invoke } from "../services/tauri";
import { useAppStore, type ActivityEntry } from "../stores/appStore";
import { TerminalPanel } from "./TerminalPanel";
import {
  BarChart2,
  Bug,
  Download,
  Trash2,
  ChevronDown,
  XCircle,
  MessageSquare,
  Plus,
  Check,
  Clock,
  FileText,
  Users,
  Wrench,
  RefreshCw,
  AlertTriangle,
} from "lucide-react";

/** Format activity log as plain text and copy to clipboard / save to file. */
async function exportActivity(entries: ActivityEntry[]) {
  if (entries.length === 0) return;
  const lines = entries.map(
    (e) =>
      `[${e.timestamp.toISOString()}] [${e.level.toUpperCase().padEnd(7)}] [${e.source}] ${e.content}`
  );
  const text = lines.join("\n");

  // Try clipboard first
  try {
    await navigator.clipboard.writeText(text);
  } catch {
    // Clipboard may not be available in all contexts — fall through to download
  }

  // Also trigger a file download
  const blob = new Blob([text], { type: "text/plain" });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = `cutready-activity-${new Date().toISOString().replace(/[:.]/g, "-")}.log`;
  document.body.appendChild(a);
  a.click();
  document.body.removeChild(a);
  URL.revokeObjectURL(url);
}

async function exportAuditaurDiagnostics(summary: AuditaurDiagnosticsSummary | null) {
  if (!summary) return;
  const text = JSON.stringify(summary, null, 2);

  try {
    await navigator.clipboard.writeText(text);
  } catch {
    // Clipboard may not be available in all contexts — fall through to download
  }

  const blob = new Blob([text], { type: "application/json" });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = `cutready-debug-diagnostics-${new Date().toISOString().replace(/[:.]/g, "-")}.json`;
  document.body.appendChild(a);
  a.click();
  document.body.removeChild(a);
  URL.revokeObjectURL(url);
}

export type DebugFilter = "all" | "frontend" | "ipc" | "trace" | "log";

export type DebugStreamItem = AuditaurDiagnosticItem & { category: DebugFilter | "legacy" };

/** Malformed timestamps sort last rather than throwing out of BigInt(). */
function debugTimestamp(value: string): bigint {
  try {
    return BigInt(value);
  } catch {
    return 0n;
  }
}

/** Merges Auditaur diagnostics and legacy activity entries into one newest-first stream. */
export function buildDebugStream(
  summary: Pick<
    AuditaurDiagnosticsSummary,
    "frontend_errors" | "failed_ipc" | "failed_traces" | "warning_logs"
  >,
  legacyDebugEntries: ActivityEntry[],
  legacyLimit = 50,
): DebugStreamItem[] {
  return [
    ...summary.frontend_errors.map((item) => ({ ...item, category: "frontend" as const })),
    ...summary.failed_ipc.map((item) => ({ ...item, category: "ipc" as const })),
    ...summary.failed_traces.map((item) => ({ ...item, category: "trace" as const })),
    ...summary.warning_logs.map((item) => ({ ...item, category: "log" as const })),
    ...legacyDebugEntries.slice(-legacyLimit).map((entry) => ({
      timestamp_unix_nanos: (entry.timestamp.getTime() * 1_000_000).toString(),
      source: entry.source,
      kind: entry.level,
      title: entry.content,
      detail: null,
      status: entry.level,
      trace_id: null,
      span_id: null,
      window_label: null,
      category: "legacy" as const,
    })),
  ].sort((a, b) => {
    const left = debugTimestamp(a.timestamp_unix_nanos);
    const right = debugTimestamp(b.timestamp_unix_nanos);
    if (left === right) return 0;
    return left < right ? 1 : -1;
  });
}

const DEBUG_FILTERS: {
  id: Exclude<DebugFilter, "all">;
  label: string;
  countKey: keyof AuditaurDiagnosticsSummary["counts"];
}[] = [
  { id: "frontend", label: "Frontend errors", countKey: "frontend_errors" },
  { id: "ipc", label: "Failed IPC", countKey: "failed_ipc" },
  { id: "trace", label: "Failed traces", countKey: "failed_traces" },
  { id: "log", label: "Warn / error logs", countKey: "warning_logs" },
];

function AuditaurDebugView({
  summary,
  loading,
  error,
  legacyDebugEntries,
}: {
  summary: AuditaurDiagnosticsSummary | null;
  loading: boolean;
  error: string | null;
  legacyDebugEntries: ActivityEntry[];
}) {
  const [filter, setFilter] = useState<DebugFilter>("all");

  if (loading && !summary) {
    return (
      <div className="text-center text-[rgb(var(--color-text-secondary))] py-8">
        Loading debug diagnostics...
      </div>
    );
  }

  if (error) {
    return (
      <div className="text-error whitespace-pre-wrap py-2">
        {error}
      </div>
    );
  }

  if (!summary?.session) {
    return (
      <div className="text-center text-[rgb(var(--color-text-secondary))] py-8">
        No active diagnostics session found for this CutReady process.
      </div>
    );
  }

  const stream = buildDebugStream(summary, legacyDebugEntries);

  const visible = filter === "all" ? stream : stream.filter((item) => item.category === filter);

  return (
    <div className="flex h-full min-h-0">
      <div className="min-w-0 flex-1 overflow-y-auto p-2">
        {visible.length === 0 ? (
          <div className="py-8 text-center text-[rgb(var(--color-text-secondary))]">No entries.</div>
        ) : (
          visible.map((item, index) => (
            <DebugLine key={`${item.category}-${item.timestamp_unix_nanos}-${index}`} item={item} />
          ))
        )}
      </div>

      <aside className="w-52 shrink-0 overflow-y-auto border-l border-[rgb(var(--color-border))] p-2 font-sans text-[11px]">
        <div className="font-medium text-[rgb(var(--color-text))]">{summary.session.service_name}</div>
        <div className="mt-0.5 text-[rgb(var(--color-text-secondary))]">
          PID {summary.session.pid ?? "unknown"} · {summary.session.session_id.slice(0, 8)}
        </div>
        {summary.session.last_heartbeat_at && (
          <div className="text-[rgb(var(--color-text-secondary))]">
            Heartbeat {summary.session.last_heartbeat_at}
          </div>
        )}
        <div
          className="mt-0.5 truncate font-mono text-[10px] text-[rgb(var(--color-text-secondary))]"
          title={summary.session.database_path}
        >
          {summary.session.database_path}
        </div>

        <div className="mt-3 flex flex-col gap-0.5">
          <DebugFilterRow
            label="All"
            count={stream.length}
            active={filter === "all"}
            onClick={() => setFilter("all")}
          />
          {DEBUG_FILTERS.map((entry) => (
            <DebugFilterRow
              key={entry.id}
              label={entry.label}
              count={summary.counts[entry.countKey]}
              active={filter === entry.id}
              onClick={() => setFilter(entry.id)}
            />
          ))}
        </div>

        {summary.notes.length > 0 && (
          <div className="mt-3 flex flex-col gap-1 text-[rgb(var(--color-text-secondary))]">
            {summary.notes.map((note) => (
              <div key={note}>{note}</div>
            ))}
          </div>
        )}
      </aside>
    </div>
  );
}

function DebugFilterRow({
  label,
  count,
  active,
  onClick,
}: {
  label: string;
  count: number;
  active: boolean;
  onClick: () => void;
}) {
  return (
    <button
      onClick={onClick}
      className={`flex items-center justify-between gap-2 rounded px-2 py-1 text-left transition-colors ${
        active
          ? "bg-[rgb(var(--color-surface-alt))] text-[rgb(var(--color-text))]"
          : "text-[rgb(var(--color-text-secondary))] hover:bg-[rgb(var(--color-surface-alt))] hover:text-[rgb(var(--color-text))]"
      }`}
    >
      <span className="truncate">{label}</span>
      <span className={`shrink-0 tabular-nums ${count > 0 ? "text-error" : ""}`}>{count}</span>
    </button>
  );
}

function DebugLine({ item }: { item: DebugStreamItem }) {
  const [expanded, setExpanded] = useState(false);
  const detail = item.detail?.trim();
  const isWarning = item.status?.toUpperCase().includes("WARN") || item.kind.toUpperCase().includes("WARN");
  const Icon = isWarning ? AlertTriangle : XCircle;
  const iconClass = isWarning ? "text-warning" : "text-error";
  return (
    <div className="py-0.5">
      <div className="flex items-start gap-1.5">
        <span className="shrink-0 text-[rgb(var(--color-text-secondary))] tabular-nums">
          {formatUnixNanos(item.timestamp_unix_nanos)}
        </span>
        <Icon className={`mt-px h-3 w-3 shrink-0 ${iconClass}`} />
        <span className="shrink-0 text-[rgb(var(--color-text-secondary))]">{item.source}</span>
        <span
          className={`min-w-0 flex-1 text-[rgb(var(--color-text))] ${expanded ? "whitespace-pre-wrap break-words" : "truncate"}`}
        >
          {item.kind}: {item.title}
        </span>
        {(detail || item.trace_id) && (
          <button
            onClick={() => setExpanded(!expanded)}
            className="shrink-0 text-[10px] text-[rgb(var(--color-accent))] hover:underline"
          >
            {expanded ? "collapse" : "details"}
          </button>
        )}
      </div>
      {expanded && item.trace_id && (
        <div className="mt-0.5 truncate pl-[4.5rem] text-[10px] text-[rgb(var(--color-text-secondary))]">
          trace {item.trace_id}
        </div>
      )}
      {expanded && detail && (
        <pre className="mt-1 max-h-40 overflow-auto whitespace-pre-wrap rounded bg-[rgb(var(--color-surface-inset))] p-2 text-[10px] text-[rgb(var(--color-text-secondary))]">
          {detail}
        </pre>
      )}
    </div>
  );
}

function formatUnixNanos(value: string) {
  const millis = Number(BigInt(value) / 1_000_000n);
  return new Date(millis).toLocaleTimeString();
}

type AuditaurDiagnosticsSummary = {
  session: {
    session_id: string;
    service_name: string;
    app_identifier: string | null;
    pid: number | null;
    database_path: string;
    last_heartbeat_at: string | null;
  } | null;
  counts: {
    frontend_errors: number;
    failed_ipc: number;
    failed_traces: number;
    warning_logs: number;
  };
  frontend_errors: AuditaurDiagnosticItem[];
  failed_ipc: AuditaurDiagnosticItem[];
  failed_traces: AuditaurDiagnosticItem[];
  warning_logs: AuditaurDiagnosticItem[];
  notes: string[];
};

export type AuditaurDiagnosticItem = {
  timestamp_unix_nanos: string;
  source: string;
  kind: string;
  title: string;
  detail: string | null;
  status: string | null;
  trace_id: string | null;
  span_id: string | null;
  window_label: string | null;
};

interface OutputPanelProps {
  onCollapse: () => void;
}

/**
 * OutputPanel — bottom panel with tabs for AI activity and problems.
 */
export function OutputPanel({ onCollapse }: OutputPanelProps) {
  const activeTab = useAppStore((s) => s.outputActiveTab);
  const setActiveTab = useAppStore((s) => s.showOutputTab);
  const currentProject = useAppStore((s) => s.currentProject);
  const outputs = useAppStore((s) => s.activityLog);
  const debugEntries = useAppStore((s) => s.debugLog);
  const clearActivityLog = useAppStore((s) => s.clearActivityLog);
  const [auditaurSummary, setAuditaurSummary] = useState<AuditaurDiagnosticsSummary | null>(null);
  const [debugLoading, setDebugLoading] = useState(false);
  const [debugError, setDebugError] = useState<string | null>(null);
  const [terminalActivated, setTerminalActivated] = useState(false);
  const [terminalToolbarHost, setTerminalToolbarHost] =
    useState<HTMLDivElement | null>(null);

  const loadAuditaurDiagnostics = useCallback(async () => {
    setDebugLoading(true);
    setDebugError(null);
    try {
      setAuditaurSummary(await invoke<AuditaurDiagnosticsSummary>("get_auditaur_diagnostics"));
    } catch (error) {
      setDebugError(error instanceof Error ? error.message : String(error));
    } finally {
      setDebugLoading(false);
    }
  }, []);

  useEffect(() => {
    if (activeTab === "debug") void loadAuditaurDiagnostics();
  }, [activeTab, loadAuditaurDiagnostics]);

  useEffect(() => {
    if (activeTab === "terminal") setTerminalActivated(true);
  }, [activeTab]);

  return (
    <div className="flex h-full flex-col bg-[rgb(var(--color-surface-inset))] border-t border-[rgb(var(--color-border))]">
      <div className="no-select flex items-center justify-between px-3 shrink-0 border-b border-[rgb(var(--color-border))]">
          <div className="flex items-stretch gap-0">
            <TabButton
              active={activeTab === "activity"}
              onClick={() => setActiveTab("activity")}
            >
              <BarChart2 className="w-3 h-3" />
              Activity
            </TabButton>
            <TabButton
              active={activeTab === "debug"}
              onClick={() => setActiveTab("debug")}
            >
              <Bug className="w-3 h-3" />
              Debug
            </TabButton>
            <div
              ref={setTerminalToolbarHost}
              className={
                terminalActivated && currentProject
                  ? "flex min-w-0 items-center border-l border-[rgb(var(--color-border))] pl-2"
                  : "hidden"
              }
            />
            {!(terminalActivated && currentProject) && (
              <button
                type="button"
                className="ml-1 flex items-center gap-1 rounded-md border border-transparent px-2 py-1 text-[11px] font-medium text-[rgb(var(--color-text-secondary))] transition-colors hover:border-[rgb(var(--color-border))] hover:bg-[rgb(var(--color-surface-alt))] hover:text-[rgb(var(--color-text))]"
                title="New terminal"
                onClick={() => {
                  setTerminalActivated(true);
                  setActiveTab("terminal");
                }}
              >
                <Plus className="h-3.5 w-3.5" />
              </button>
            )}
          </div>
          <div className="flex items-center gap-1">
            {activeTab !== "terminal" && (
              <>
                <button
                  onClick={() => activeTab === "activity" ? exportActivity(outputs) : exportAuditaurDiagnostics(auditaurSummary)}
                  className="p-1 rounded text-[rgb(var(--color-text-secondary))] hover:text-[rgb(var(--color-text))] hover:bg-[rgb(var(--color-surface-alt))] transition-colors"
                  title={activeTab === "activity" ? "Export activity log" : "Export debug diagnostics"}
                >
                  <Download className="w-3 h-3" />
                </button>
                <button
                  onClick={() => activeTab === "activity" ? clearActivityLog() : loadAuditaurDiagnostics()}
                  className="p-1 rounded text-[rgb(var(--color-text-secondary))] hover:text-[rgb(var(--color-text))] hover:bg-[rgb(var(--color-surface-alt))] transition-colors"
                  title={activeTab === "activity" ? "Clear" : "Refresh debug diagnostics"}
                >
                  {activeTab === "activity" ? <Trash2 className="w-3 h-3" /> : <RefreshCw className="w-3 h-3" />}
                </button>
              </>
            )}
            <button
              onClick={onCollapse}
              className="p-1 rounded text-[rgb(var(--color-text-secondary))] hover:text-[rgb(var(--color-text))] hover:bg-[rgb(var(--color-surface-alt))] transition-colors"
              title="Collapse panel"
            >
              <ChevronDown className="w-3 h-3" />
            </button>
          </div>
        </div>

      {/* Content — auto-scrolls to latest */}
      <div className="flex-1 min-h-0 text-xs font-mono">
        <div className={activeTab === "activity" ? "h-full overflow-y-auto p-2" : "hidden"}>
          <>
            {outputs.length === 0 ? (
              <div className="text-center text-[rgb(var(--color-text-secondary))] py-8">
                No activity yet — AI agent output will appear here
              </div>
            ) : (
              [...outputs].reverse().map((entry) => (
                <ActivityRow key={entry.id} entry={entry} />
              ))
            )}
          </>
        </div>
        <div className={activeTab === "debug" ? "h-full min-h-0" : "hidden"}>
          <AuditaurDebugView
            summary={auditaurSummary}
            loading={debugLoading}
            error={debugError}
            legacyDebugEntries={debugEntries}
          />
        </div>
        {terminalActivated && (
          <div
            className={
              activeTab === "terminal" ? "h-full min-h-0 overflow-hidden" : "hidden"
            }
          >
            <TerminalPanel
              active={activeTab === "terminal"}
              onRequestActivate={() => setActiveTab("terminal")}
              toolbarHost={terminalToolbarHost}
            />
          </div>
        )}
      </div>
    </div>
  );
}

function ActivityRow({ entry }: { entry: ActivityEntry }) {
  const [expanded, setExpanded] = useState(false);
  const isTruncatable = entry.content.length > 80;
  const colorCls =
    entry.level === "error" ? "text-error"
    : entry.level === "warn" ? "text-warning"
    : "text-[rgb(var(--color-text))]";

  return (
    <div className="flex items-start gap-1.5 py-0.5">
      <span className="shrink-0 text-[rgb(var(--color-text-secondary))] tabular-nums">
        {entry.timestamp.toLocaleTimeString()}
      </span>
      <ActivityIcon source={entry.source} level={entry.level} />
      <span className="shrink-0 text-[rgb(var(--color-text-secondary))]">{entry.source}</span>
      <span
        className={`${colorCls} min-w-0 ${expanded ? "whitespace-pre-wrap break-words" : "truncate"} ${isTruncatable ? "cursor-pointer hover:text-[rgb(var(--color-accent))]" : ""}`}
        onClick={isTruncatable ? () => setExpanded(!expanded) : undefined}
        title={isTruncatable ? (expanded ? "Click to collapse" : "Click to expand") : undefined}
      >
        {entry.content}
      </span>
      {isTruncatable && !expanded && (
        <button
          onClick={() => setExpanded(true)}
          className="shrink-0 text-[10px] text-[rgb(var(--color-accent))] hover:underline"
        >
          expand
        </button>
      )}
    </div>
  );
}

function TabButton({
  active,
  onClick,
  children,
}: {
  active: boolean;
  onClick: () => void;
  children: React.ReactNode;
}) {
  return (
    <button
      onClick={onClick}
      className={`flex items-center gap-1 px-3 py-2 text-[11px] font-medium transition-colors border-b-2 -mb-px ${
        active
          ? "border-[rgb(var(--color-accent))] text-[rgb(var(--color-text))]"
          : "border-transparent text-[rgb(var(--color-text-secondary))] hover:text-[rgb(var(--color-text))] hover:border-[rgb(var(--color-text-secondary))]/30"
      }`}
    >
      {children}
    </button>
  );
}

function ActivityIcon({ source, level }: { source: string; level: string }) {
  const cls = "shrink-0 mt-px w-3 h-3";
  if (level === "error") return <XCircle className={cls} />;
  if (source === "chat") return <MessageSquare className={cls} />;
  if (source === "response") return <Check className={cls} />;
  if (source === "status") return <Clock className={cls} />;
  if (source.startsWith("result")) return <FileText className={cls} />;
  if (source.startsWith("delegate")) return <Users className={cls} />;
  // Default: wrench for tool calls
  return <Wrench className={cls} />;
}
