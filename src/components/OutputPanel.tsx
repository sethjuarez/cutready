import { useEffect, useRef, useState } from "react";
import { useAppStore, type ActivityEntry } from "../stores/appStore";

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

type OutputTab = "activity" | "problems";

interface OutputPanelProps {
  onCollapse: () => void;
}

/**
 * OutputPanel — bottom panel with tabs for AI activity and problems.
 */
export function OutputPanel({ onCollapse }: OutputPanelProps) {
  const [activeTab, setActiveTab] = useState<OutputTab>("activity");
  const outputs = useAppStore((s) => s.activityLog);
  const clearActivityLog = useAppStore((s) => s.clearActivityLog);
  const scrollRef = useRef<HTMLDivElement>(null);

  // Auto-scroll to bottom when new entries arrive
  useEffect(() => {
    const el = scrollRef.current;
    if (el) el.scrollTop = el.scrollHeight;
  }, [outputs.length]);

  return (
    <div className="flex flex-col h-full bg-[var(--color-surface-inset)] border-t border-[var(--color-border)]">
      {/* Header */}
      <div className="no-select flex items-center justify-between px-3 shrink-0 border-b border-[var(--color-border)]">
        <div className="flex items-stretch gap-0">
          <TabButton
            active={activeTab === "activity"}
            onClick={() => setActiveTab("activity")}
          >
            <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
              <polyline points="22 12 18 12 15 21 9 3 6 12 2 12" />
            </svg>
            Activity
          </TabButton>
          <TabButton
            active={activeTab === "problems"}
            onClick={() => setActiveTab("problems")}
          >
            Problems
          </TabButton>
        </div>
        <div className="flex items-center gap-1">
          <button
            onClick={() => exportActivity(outputs)}
            className="p-1 rounded text-[var(--color-text-secondary)] hover:text-[var(--color-text)] hover:bg-[var(--color-surface-alt)] transition-colors"
            title="Export activity log"
          >
            <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
              <path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4" />
              <polyline points="7 10 12 15 17 10" />
              <line x1="12" y1="15" x2="12" y2="3" />
            </svg>
          </button>
          <button
            onClick={clearActivityLog}
            className="p-1 rounded text-[var(--color-text-secondary)] hover:text-[var(--color-text)] hover:bg-[var(--color-surface-alt)] transition-colors"
            title="Clear"
          >
            <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
              <path d="M3 6h18M8 6V4h8v2M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6" />
            </svg>
          </button>
          <button
            onClick={onCollapse}
            className="p-1 rounded text-[var(--color-text-secondary)] hover:text-[var(--color-text)] hover:bg-[var(--color-surface-alt)] transition-colors"
            title="Collapse panel"
          >
            <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
              <polyline points="6 9 12 15 18 9" />
            </svg>
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
              outputs.map((entry) => (
                <ActivityRow key={entry.id} entry={entry} />
              ))
            )}
          </>
        )}
        {activeTab === "problems" && (
          <div className="text-center text-[var(--color-text-secondary)] py-8">
            No problems
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
    entry.level === "error" ? "text-red-400"
    : entry.level === "warn" ? "text-amber-400"
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

const S = 11; // icon size for activity rows
const iconProps = { width: S, height: S, viewBox: "0 0 24 24", fill: "none", stroke: "currentColor", strokeWidth: 2, strokeLinecap: "round" as const, strokeLinejoin: "round" as const };

function ActivityIcon({ source, level }: { source: string; level: string }) {
  const cls = "shrink-0 mt-px";
  if (level === "error") return <svg className={cls} {...iconProps}><circle cx="12" cy="12" r="10" /><path d="m15 9-6 6M9 9l6 6" /></svg>;
  if (source === "chat") return <svg className={cls} {...iconProps}><path d="M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z" /></svg>;
  if (source === "response") return <svg className={cls} {...iconProps}><polyline points="20 6 9 17 4 12" /></svg>;
  if (source === "status") return <svg className={cls} {...iconProps}><circle cx="12" cy="12" r="10" /><polyline points="12 6 12 12 16 14" /></svg>;
  if (source.startsWith("result")) return <svg className={cls} {...iconProps}><path d="M15 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V7Z" /><path d="M14 2v4a2 2 0 0 0 2 2h4" /></svg>;
  if (source.startsWith("delegate")) return <svg className={cls} {...iconProps}><path d="M16 21v-2a4 4 0 0 0-4-4H6a4 4 0 0 0-4 4v2" /><circle cx="9" cy="7" r="4" /><path d="M22 21v-2a4 4 0 0 0-3-3.87" /><path d="M16 3.13a4 4 0 0 1 0 7.75" /></svg>;
  // Default: wrench for tool calls
  return <svg className={cls} {...iconProps}><path d="M14.7 6.3a1 1 0 0 0 0 1.4l1.6 1.6a1 1 0 0 0 1.4 0l3.77-3.77a6 6 0 0 1-7.94 7.94l-6.91 6.91a2.12 2.12 0 0 1-3-3l6.91-6.91a6 6 0 0 1 7.94-7.94l-3.76 3.76z" /></svg>;
}
