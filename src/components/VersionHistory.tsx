import { useCallback, useEffect, useState } from "react";
import { useAppStore } from "../stores/appStore";

export function VersionHistory() {
  const versions = useAppStore((s) => s.versions);
  const loadVersions = useAppStore((s) => s.loadVersions);
  const saveVersion = useAppStore((s) => s.saveVersion);
  const restoreVersion = useAppStore((s) => s.restoreVersion);
  const sidebarPosition = useAppStore((s) => s.sidebarPosition);
  const snapshotPromptOpen = useAppStore((s) => s.snapshotPromptOpen);

  const [labelInput, setLabelInput] = useState("");
  const [showLabelInput, setShowLabelInput] = useState(false);
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    loadVersions();
  }, [loadVersions]);

  // React to Ctrl+S prompt trigger
  useEffect(() => {
    if (snapshotPromptOpen) {
      setShowLabelInput(true);
      useAppStore.setState({ snapshotPromptOpen: false });
    }
  }, [snapshotPromptOpen]);

  const handleSave = useCallback(async () => {
    const label = labelInput.trim();
    if (!label) return;
    setSaving(true);
    await saveVersion(label);
    setLabelInput("");
    setShowLabelInput(false);
    setSaving(false);
  }, [labelInput, saveVersion]);

  // Border on the side facing the editor
  const borderClass = sidebarPosition === "left" ? "border-l" : "border-r";

  return (
    <div className={`flex flex-col h-full ${borderClass} border-[var(--color-border)]`}>
      {/* Header */}
      <div className="flex items-center justify-between px-3 h-9 shrink-0 border-b border-[var(--color-border)]">
        <span className="text-xs font-medium text-[var(--color-text-secondary)] uppercase tracking-wider">
          Snapshots
        </span>
      </div>

      {/* Save snapshot area */}
      <div className="px-3 py-2.5 border-b border-[var(--color-border)]">
        {showLabelInput ? (
          <div className="flex gap-1.5">
            <input
              type="text"
              value={labelInput}
              onChange={(e) => setLabelInput(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === "Enter") handleSave();
                if (e.key === "Escape") { setShowLabelInput(false); setLabelInput(""); }
              }}
              placeholder="Snapshot name..."
              autoFocus
              className="flex-1 min-w-0 px-2 py-1 rounded-md bg-[var(--color-surface)] border border-[var(--color-border)] text-xs text-[var(--color-text)] placeholder:text-[var(--color-text-secondary)]/50 focus:outline-none focus:ring-1 focus:ring-[var(--color-accent)]/40"
            />
            <button
              onClick={handleSave}
              disabled={!labelInput.trim() || saving}
              className="px-2 py-1 rounded-md text-xs font-medium bg-[var(--color-accent)] text-white hover:bg-[var(--color-accent-hover)] disabled:opacity-40 transition-colors"
            >
              {saving ? "..." : "Save"}
            </button>
          </div>
        ) : (
          <button
            onClick={() => setShowLabelInput(true)}
            className="group/btn w-full flex items-center justify-center gap-1.5 px-2 py-1.5 rounded-md text-xs text-[var(--color-text-secondary)] hover:text-[var(--color-accent)] border border-dashed border-[var(--color-border)] hover:border-[var(--color-accent)]/40 transition-colors"
          >
            <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" className="shrink-0">
              <path d="M19 21H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h11l5 5v11a2 2 0 0 1-2 2z" />
              <polyline points="17 21 17 13 7 13 7 21" />
              <polyline points="7 3 7 8 15 8" />
            </svg>
            <span className="max-w-0 overflow-hidden group-hover/btn:max-w-[10rem] transition-all duration-200 whitespace-nowrap">
              Save Project Snapshot
            </span>
          </button>
        )}
      </div>

      {/* Commit graph */}
      <div className="flex-1 overflow-y-auto">
        {versions.length === 0 ? (
          <div className="px-3 py-8 text-center">
            <div className="text-[var(--color-text-secondary)] text-xs">No snapshots yet</div>
            <div className="text-[var(--color-text-secondary)]/60 text-[10px] mt-1">
              Save a snapshot of the entire project
            </div>
          </div>
        ) : (
          <div className="py-1">
            {versions.map((version, idx) => {
              const isLatest = idx === 0;
              const isLast = idx === versions.length - 1;
              return (
                <div key={version.id} className="group relative flex">
                  {/* Graph column */}
                  <div className="w-8 shrink-0 flex flex-col items-center">
                    {/* Line above dot */}
                    {!isLatest && (
                      <div className="w-px flex-1 bg-[var(--color-border)]" />
                    )}
                    {isLatest && <div className="flex-1" />}
                    {/* Commit dot */}
                    <div
                      className={`shrink-0 rounded-full ${
                        isLatest
                          ? "w-3 h-3 bg-[var(--color-accent)] ring-2 ring-[var(--color-accent)]/20"
                          : "w-2 h-2 bg-[var(--color-text-secondary)]/40"
                      }`}
                    />
                    {/* Line below dot */}
                    {!isLast && (
                      <div className="w-px flex-1 bg-[var(--color-border)]" />
                    )}
                    {isLast && <div className="flex-1" />}
                  </div>

                  {/* Content */}
                  <div className={`flex-1 min-w-0 pr-3 ${isLatest ? "py-2" : "py-1.5"}`}>
                    <div className={`text-xs truncate ${isLatest ? "font-medium text-[var(--color-text)]" : "text-[var(--color-text-secondary)]"}`}>
                      {version.message}
                    </div>
                    <div className="text-[10px] text-[var(--color-text-secondary)]/70 mt-0.5">
                      {formatRelativeDate(version.timestamp)}
                    </div>
                    {idx > 0 && (
                      <button
                        onClick={() => {
                          if (confirm("Restore the entire project to this snapshot? Your current state will be saved as a new snapshot first.")) {
                            restoreVersion(version.id);
                          }
                        }}
                        className="hidden group-hover:block mt-0.5 text-[10px] text-[var(--color-accent)] hover:underline"
                      >
                        Restore
                      </button>
                    )}
                  </div>
                </div>
              );
            })}
          </div>
        )}
      </div>
    </div>
  );
}

function formatRelativeDate(isoString: string): string {
  const date = new Date(isoString);
  const now = new Date();
  const diffMs = now.getTime() - date.getTime();
  const diffMins = Math.floor(diffMs / 60000);

  if (diffMins < 1) return "just now";
  if (diffMins < 60) return `${diffMins}m ago`;

  const diffHours = Math.floor(diffMins / 60);
  if (diffHours < 24) return `${diffHours}h ago`;

  const diffDays = Math.floor(diffHours / 24);
  if (diffDays < 7) return `${diffDays}d ago`;

  return date.toLocaleDateString();
}
