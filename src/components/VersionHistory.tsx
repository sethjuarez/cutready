import { useCallback, useEffect, useState } from "react";
import { useAppStore } from "../stores/appStore";

export function VersionHistory() {
  const versions = useAppStore((s) => s.versions);
  const loadVersions = useAppStore((s) => s.loadVersions);
  const saveVersion = useAppStore((s) => s.saveVersion);
  const restoreVersion = useAppStore((s) => s.restoreVersion);

  const [labelInput, setLabelInput] = useState("");
  const [showLabelInput, setShowLabelInput] = useState(false);

  useEffect(() => {
    loadVersions();
  }, [loadVersions]);

  const handleSave = useCallback(async () => {
    const label = labelInput.trim();
    if (!label) return;
    await saveVersion(label);
    setLabelInput("");
    setShowLabelInput(false);
  }, [labelInput, saveVersion]);

  return (
    <div className="flex flex-col h-full border-l border-[var(--color-border)]" style={{ width: 280 }}>
      {/* Header */}
      <div className="flex items-center justify-between px-3 py-3 border-b border-[var(--color-border)]">
        <span className="text-xs font-medium text-[var(--color-text-secondary)] uppercase tracking-wider">
          Version History
        </span>
        <button
          onClick={() => setShowLabelInput(true)}
          className="text-xs px-2 py-1 rounded-md bg-[var(--color-accent)] text-white hover:bg-[var(--color-accent-hover)] transition-colors"
        >
          Save Version
        </button>
      </div>

      {/* Save label input */}
      {showLabelInput && (
        <div className="px-3 py-2 border-b border-[var(--color-border)]">
          <input
            type="text"
            value={labelInput}
            onChange={(e) => setLabelInput(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter") handleSave();
              if (e.key === "Escape") { setShowLabelInput(false); setLabelInput(""); }
            }}
            placeholder="Version label (e.g., v1.0)"
            autoFocus
            className="w-full px-2 py-1.5 rounded-md bg-[var(--color-surface)] border border-[var(--color-border)] text-xs text-[var(--color-text)] placeholder:text-[var(--color-text-secondary)]/50 focus:outline-none focus:ring-1 focus:ring-[var(--color-accent)]/40"
          />
        </div>
      )}

      {/* Timeline */}
      <div className="flex-1 overflow-y-auto py-2">
        {versions.length === 0 ? (
          <div className="px-3 py-6 text-center text-xs text-[var(--color-text-secondary)]">
            No versions yet
          </div>
        ) : (
          <div className="relative pl-6 pr-3">
            {/* Timeline line */}
            <div className="absolute left-[15px] top-2 bottom-2 w-px bg-[var(--color-border)]" />

            {versions.map((version, idx) => (
              <div key={version.id} className="group relative pb-4">
                {/* Timeline dot */}
                <div
                  className={`absolute left-[-15px] top-1 w-2.5 h-2.5 rounded-full border-2 ${
                    idx === 0
                      ? "border-[var(--color-accent)] bg-[var(--color-accent)]"
                      : "border-[var(--color-border)] bg-[var(--color-surface-alt)]"
                  }`}
                />

                <div className="ml-1">
                  <div className="text-xs font-medium truncate">{version.message}</div>
                  <div className="text-[10px] text-[var(--color-text-secondary)] mt-0.5">
                    {formatRelativeDate(version.timestamp)}
                  </div>

                  {/* Restore button */}
                  {idx > 0 && (
                    <button
                      onClick={() => {
                        if (confirm("Restore this version? Current changes will be saved as a new version.")) {
                          restoreVersion(version.id);
                        }
                      }}
                      className="opacity-0 group-hover:opacity-100 mt-1 text-[10px] text-[var(--color-accent)] hover:underline transition-opacity"
                    >
                      Restore this version
                    </button>
                  )}
                </div>
              </div>
            ))}
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
