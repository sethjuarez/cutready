import { useState } from "react";

type OutputTab = "activity" | "problems";

export interface OutputEntry {
  id: string;
  timestamp: Date;
  source: string;
  content: string;
  level: "info" | "warn" | "error" | "success";
}

interface OutputPanelProps {
  outputs: OutputEntry[];
  onClear: () => void;
  onCollapse: () => void;
}

/**
 * OutputPanel — bottom panel with tabs for AI activity and problems.
 */
export function OutputPanel({ outputs, onClear, onCollapse }: OutputPanelProps) {
  const [activeTab, setActiveTab] = useState<OutputTab>("activity");

  return (
    <div className="flex flex-col h-full bg-[var(--color-surface)] border-t border-[var(--color-border)]">
      {/* Header */}
      <div className="no-select flex items-center justify-between px-3 h-9 shrink-0 border-b border-[var(--color-border)]">
        <div className="flex items-center gap-1">
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
            onClick={onClear}
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

      {/* Content */}
      <div className="flex-1 overflow-y-auto p-2 text-xs font-mono">
        {activeTab === "activity" && (
          <>
            {outputs.length === 0 ? (
              <div className="text-center text-[var(--color-text-secondary)] py-8">
                No activity yet — AI agent output will appear here
              </div>
            ) : (
              outputs.map((entry) => (
                <div
                  key={entry.id}
                  className={`flex gap-2 py-0.5 ${
                    entry.level === "error"
                      ? "text-red-400"
                      : entry.level === "warn"
                        ? "text-amber-400"
                        : entry.level === "success"
                          ? "text-emerald-400"
                          : "text-[var(--color-text-secondary)]"
                  }`}
                >
                  <span className="shrink-0 text-[var(--color-text-secondary)]">
                    {entry.timestamp.toLocaleTimeString()}
                  </span>
                  <span className="shrink-0">[{entry.source}]</span>
                  <span className="text-[var(--color-text)]">{entry.content}</span>
                </div>
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
      className={`flex items-center gap-1 px-2 py-1 rounded text-[11px] font-medium transition-colors ${
        active
          ? "text-[var(--color-text)] bg-[var(--color-surface-alt)]"
          : "text-[var(--color-text-secondary)] hover:text-[var(--color-text)]"
      }`}
    >
      {children}
    </button>
  );
}
