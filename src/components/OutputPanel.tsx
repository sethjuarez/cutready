import { useCallback, useEffect, useRef, useState } from "react";
import { invoke } from "../services/tauri";
import { useAppStore, type ActivityEntry } from "../stores/appStore";
import {
  BarChart2,
  Bug,
  Download,
  Trash2,
  ChevronDown,
  XCircle,
  MessageSquare,
  Check,
  Clock,
  FileText,
  Users,
  Wrench,
  SquareTerminal,
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
  a.download = `cutready-auditaur-diagnostics-${new Date().toISOString().replace(/[:.]/g, "-")}.json`;
  document.body.appendChild(a);
  a.click();
  document.body.removeChild(a);
  URL.revokeObjectURL(url);
}

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
  if (loading && !summary) {
    return (
      <div className="text-center text-[rgb(var(--color-text-secondary))] py-8">
        Loading Auditaur diagnostics…
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
        No active Auditaur session found for this CutReady process.
      </div>
    );
  }

  return (
    <div className="space-y-3">
      <div className="rounded-lg border border-[rgb(var(--color-border))] bg-[rgb(var(--color-surface))] p-2 font-sans">
        <div className="flex flex-wrap items-center gap-2 text-[11px] text-[rgb(var(--color-text-secondary))]">
          <span className="font-medium text-[rgb(var(--color-text))]">{summary.session.service_name}</span>
          <span>PID {summary.session.pid ?? "unknown"}</span>
          <span>Session {summary.session.session_id.slice(0, 8)}</span>
          {summary.session.last_heartbeat_at && <span>Heartbeat {summary.session.last_heartbeat_at}</span>}
        </div>
        <div className="mt-1 truncate font-mono text-[10px] text-[rgb(var(--color-text-secondary))]" title={summary.session.database_path}>
          {summary.session.database_path}
        </div>
      </div>

      <div className="grid grid-cols-4 gap-2 font-sans">
        <DebugCount label="Frontend errors" value={summary.counts.frontend_errors} />
        <DebugCount label="Failed IPC" value={summary.counts.failed_ipc} />
        <DebugCount label="Failed traces" value={summary.counts.failed_traces} />
        <DebugCount label="Warnings/errors" value={summary.counts.warning_logs} />
      </div>

      {summary.notes.map((note) => (
        <div key={note} className="text-[rgb(var(--color-text-secondary))] font-sans text-[11px]">
          {note}
        </div>
      ))}

      <DebugSection title="Recent frontend errors" items={summary.frontend_errors} />
      <DebugSection title="Recent failed IPC" items={summary.failed_ipc} />
      <DebugSection title="Recent failed traces" items={summary.failed_traces} />
      <DebugSection title="Recent warn/error logs" items={summary.warning_logs} />

      {legacyDebugEntries.length > 0 && (
        <DebugSection
          title="Legacy in-memory debug entries"
          items={legacyDebugEntries.slice(-10).reverse().map((entry) => ({
            timestamp_unix_nanos: (entry.timestamp.getTime() * 1_000_000).toString(),
            source: entry.source,
            kind: entry.level,
            title: entry.content,
            detail: null,
            status: entry.level,
            trace_id: null,
            span_id: null,
            window_label: null,
          }))}
        />
      )}
    </div>
  );
}

function DebugCount({ label, value }: { label: string; value: number }) {
  const hasIssues = value > 0;
  return (
    <div className="rounded-lg border border-[rgb(var(--color-border))] bg-[rgb(var(--color-surface))] p-2">
      <div className={hasIssues ? "text-error text-lg font-semibold" : "text-[rgb(var(--color-text))] text-lg font-semibold"}>
        {value}
      </div>
      <div className="text-[10px] text-[rgb(var(--color-text-secondary))]">{label}</div>
    </div>
  );
}

function DebugSection({ title, items }: { title: string; items: AuditaurDiagnosticItem[] }) {
  return (
    <section>
      <h3 className="mb-1 font-sans text-[11px] font-medium text-[rgb(var(--color-text-secondary))]">
        {title}
      </h3>
      {items.length === 0 ? (
        <div className="rounded-lg border border-[rgb(var(--color-border))] bg-[rgb(var(--color-surface))] px-2 py-1.5 text-[rgb(var(--color-text-secondary))]">
          None
        </div>
      ) : (
        <div className="space-y-1">
          {items.map((item, index) => (
            <DebugItemRow key={`${item.source}-${item.trace_id ?? item.timestamp_unix_nanos}-${index}`} item={item} />
          ))}
        </div>
      )}
    </section>
  );
}

function DebugItemRow({ item }: { item: AuditaurDiagnosticItem }) {
  const [expanded, setExpanded] = useState(false);
  const detail = item.detail?.trim();
  const isWarning = item.status?.toUpperCase().includes("WARN") || item.kind.toUpperCase().includes("WARN");
  const Icon = isWarning ? AlertTriangle : XCircle;
  const iconClass = isWarning ? "text-warning" : "text-error";
  return (
    <div className="rounded-lg border border-[rgb(var(--color-border))] bg-[rgb(var(--color-surface))] px-2 py-1.5">
      <div className="flex items-start gap-1.5">
        <span className="shrink-0 text-[rgb(var(--color-text-secondary))] tabular-nums">
          {formatUnixNanos(item.timestamp_unix_nanos)}
        </span>
        <Icon className={`mt-px h-3 w-3 shrink-0 ${iconClass}`} />
        <span className="shrink-0 text-[rgb(var(--color-text-secondary))]">{item.source}</span>
        <span className="min-w-0 flex-1 truncate text-[rgb(var(--color-text))]">
          {item.kind}: {item.title}
        </span>
        {detail && (
          <button
            onClick={() => setExpanded(!expanded)}
            className="shrink-0 text-[10px] text-[rgb(var(--color-accent))] hover:underline"
          >
            {expanded ? "collapse" : "details"}
          </button>
        )}
      </div>
      {item.trace_id && (
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

type OutputTab = "activity" | "debug" | "terminal";

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

type AuditaurDiagnosticItem = {
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
  const [activeTab, setActiveTab] = useState<OutputTab>("activity");
  const outputs = useAppStore((s) => s.activityLog);
  const debugEntries = useAppStore((s) => s.debugLog);
  const clearActivityLog = useAppStore((s) => s.clearActivityLog);
  const currentProject = useAppStore((s) => s.currentProject);
  const [auditaurSummary, setAuditaurSummary] = useState<AuditaurDiagnosticsSummary | null>(null);
  const [debugLoading, setDebugLoading] = useState(false);
  const [debugError, setDebugError] = useState<string | null>(null);
  const scrollRef = useRef<HTMLDivElement>(null);
  // No auto-scroll needed — newest entries render at top via flex-col-reverse

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

  return (
    <div className="flex flex-col h-full bg-[rgb(var(--color-surface-inset))] border-t border-[rgb(var(--color-border))]">
      {/* Header */}
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
          <TabButton
            active={activeTab === "terminal"}
            onClick={() => setActiveTab("terminal")}
          >
            <SquareTerminal className="w-3 h-3" />
            Terminal
          </TabButton>
        </div>
        <div className="flex items-center gap-1">
          {activeTab !== "terminal" && (
            <>
              <button
                onClick={() => activeTab === "activity" ? exportActivity(outputs) : exportAuditaurDiagnostics(auditaurSummary)}
                className="p-1 rounded text-[rgb(var(--color-text-secondary))] hover:text-[rgb(var(--color-text))] hover:bg-[rgb(var(--color-surface-alt))] transition-colors"
                title={activeTab === "activity" ? "Export activity log" : "Export Auditaur diagnostics"}
              >
                <Download className="w-3 h-3" />
              </button>
              <button
                onClick={() => activeTab === "activity" ? clearActivityLog() : loadAuditaurDiagnostics()}
                className="p-1 rounded text-[rgb(var(--color-text-secondary))] hover:text-[rgb(var(--color-text))] hover:bg-[rgb(var(--color-surface-alt))] transition-colors"
                title={activeTab === "activity" ? "Clear" : "Refresh Auditaur diagnostics"}
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
      <div ref={scrollRef} className="flex-1 overflow-y-auto p-2 text-xs font-mono">
        {activeTab === "activity" && (
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
        )}
        {activeTab === "debug" && (
          <AuditaurDebugView
            summary={auditaurSummary}
            loading={debugLoading}
            error={debugError}
            legacyDebugEntries={debugEntries}
          />
        )}
        {activeTab === "terminal" && (
          <div className="flex flex-col items-center justify-center h-full gap-3 text-center px-4">
            <SquareTerminal className="w-6 h-6 text-[rgb(var(--color-text-secondary))]/40" />
            <div>
              <p className="text-[rgb(var(--color-text-secondary))] text-xs mb-0.5">
                {currentProject ? currentProject.root : "No project open"}
              </p>
              {currentProject && (
                <button
                  onClick={() => invoke("open_in_terminal", { path: currentProject.root })}
                  className="mt-2 flex items-center gap-1.5 px-3 py-1.5 rounded-lg text-xs font-medium bg-[rgb(var(--color-surface-alt))] border border-[rgb(var(--color-border))] text-[rgb(var(--color-text-secondary))] hover:text-[rgb(var(--color-text))] hover:border-[rgb(var(--color-text-secondary))]/40 transition-colors mx-auto"
                >
                  <SquareTerminal className="w-3 h-3" />
                  Open in Terminal
                </button>
              )}
            </div>
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
