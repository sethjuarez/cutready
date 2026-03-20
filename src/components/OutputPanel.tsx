import { useRef, useState } from "react";
import { useAppStore, type ActivityEntry } from "../stores/appStore";
import {
  ChartBarIcon,
  BugAntIcon,
  ArrowDownTrayIcon,
  TrashIcon,
  ChevronDownIcon,
  XCircleIcon,
  ChatBubbleLeftIcon,
  CheckIcon,
  ClockIcon,
  DocumentIcon,
  UserGroupIcon,
  WrenchIcon,
} from "@heroicons/react/24/outline";

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

type OutputTab = "activity" | "debug";

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
  const clearDebugLog = useAppStore((s) => s.clearDebugLog);
  const scrollRef = useRef<HTMLDivElement>(null);
  // No auto-scroll needed — newest entries render at top via flex-col-reverse


  return (
    <div className="flex flex-col h-full bg-[var(--color-surface-inset)] border-t border-[var(--color-border)]">
      {/* Header */}
      <div className="no-select flex items-center justify-between px-3 shrink-0 border-b border-[var(--color-border)]">
        <div className="flex items-stretch gap-0">
          <TabButton
            active={activeTab === "activity"}
            onClick={() => setActiveTab("activity")}
          >
            <ChartBarIcon className="w-3 h-3" />
            Activity
          </TabButton>
          <TabButton
            active={activeTab === "debug"}
            onClick={() => setActiveTab("debug")}
          >
            <BugAntIcon className="w-3 h-3" />
            Debug
          </TabButton>
        </div>
        <div className="flex items-center gap-1">
          <button
            onClick={() => activeTab === "activity" ? exportActivity(outputs) : exportActivity(debugEntries)}
            className="p-1 rounded text-[var(--color-text-secondary)] hover:text-[var(--color-text)] hover:bg-[var(--color-surface-alt)] transition-colors"
            title={activeTab === "activity" ? "Export activity log" : "Export debug log"}
          >
            <ArrowDownTrayIcon className="w-3 h-3" />
          </button>
          <button
            onClick={() => activeTab === "activity" ? clearActivityLog() : clearDebugLog()}
            className="p-1 rounded text-[var(--color-text-secondary)] hover:text-[var(--color-text)] hover:bg-[var(--color-surface-alt)] transition-colors"
            title="Clear"
          >
            <TrashIcon className="w-3 h-3" />
          </button>
          <button
            onClick={onCollapse}
            className="p-1 rounded text-[var(--color-text-secondary)] hover:text-[var(--color-text)] hover:bg-[var(--color-surface-alt)] transition-colors"
            title="Collapse panel"
          >
            <ChevronDownIcon className="w-3 h-3" />
          </button>
        </div>
      </div>

      {/* Content — auto-scrolls to latest */}
      <div ref={scrollRef} className="flex-1 overflow-y-auto p-2 text-xs font-mono">
        {activeTab === "activity" && (
          <>
            {outputs.length === 0 ? (
              <div className="text-center text-[var(--color-text-secondary)] py-8">
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
          <>
            {debugEntries.length === 0 ? (
              <div className="text-center text-[var(--color-text-secondary)] py-8">
                No debug messages yet — backend and frontend logs will appear here
              </div>
            ) : (
              [...debugEntries].reverse().map((entry) => (
                <ActivityRow key={entry.id} entry={entry} />
              ))
            )}
          </>
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
    : "text-[var(--color-text)]";

  return (
    <div className="flex items-start gap-1.5 py-0.5">
      <span className="shrink-0 text-[var(--color-text-secondary)] tabular-nums">
        {entry.timestamp.toLocaleTimeString()}
      </span>
      <ActivityIcon source={entry.source} level={entry.level} />
      <span className="shrink-0 text-[var(--color-text-secondary)]">{entry.source}</span>
      <span
        className={`${colorCls} min-w-0 ${expanded ? "whitespace-pre-wrap break-words" : "truncate"} ${isTruncatable ? "cursor-pointer hover:text-[var(--color-accent)]" : ""}`}
        onClick={isTruncatable ? () => setExpanded(!expanded) : undefined}
        title={isTruncatable ? (expanded ? "Click to collapse" : "Click to expand") : undefined}
      >
        {entry.content}
      </span>
      {isTruncatable && !expanded && (
        <button
          onClick={() => setExpanded(true)}
          className="shrink-0 text-[10px] text-[var(--color-accent)] hover:underline"
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
          ? "border-[var(--color-accent)] text-[var(--color-text)]"
          : "border-transparent text-[var(--color-text-secondary)] hover:text-[var(--color-text)] hover:border-[var(--color-text-secondary)]/30"
      }`}
    >
      {children}
    </button>
  );
}

function ActivityIcon({ source, level }: { source: string; level: string }) {
  const cls = "shrink-0 mt-px w-3 h-3";
  if (level === "error") return <XCircleIcon className={cls} />;
  if (source === "chat") return <ChatBubbleLeftIcon className={cls} />;
  if (source === "response") return <CheckIcon className={cls} />;
  if (source === "status") return <ClockIcon className={cls} />;
  if (source.startsWith("result")) return <DocumentIcon className={cls} />;
  if (source.startsWith("delegate")) return <UserGroupIcon className={cls} />;
  // Default: wrench for tool calls
  return <WrenchIcon className={cls} />;
}
