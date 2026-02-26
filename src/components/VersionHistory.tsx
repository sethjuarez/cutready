import { useCallback, useEffect, useState } from "react";
import { useAppStore } from "../stores/appStore";

export function VersionHistory() {
  const versions = useAppStore((s) => s.versions);
  const isDirty = useAppStore((s) => s.isDirty);
  const loadVersions = useAppStore((s) => s.loadVersions);
  const saveVersion = useAppStore((s) => s.saveVersion);
  const checkoutSnapshot = useAppStore((s) => s.checkoutSnapshot);
  const returnToLatest = useAppStore((s) => s.returnToLatest);
  const viewingSnapshotId = useAppStore((s) => s.viewingSnapshotId);
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

  const handleCircleClick = useCallback(async (commitId: string, idx: number) => {
    const isViewing = useAppStore.getState().viewingSnapshotId !== null;

    // Clicking the latest: return to latest
    if (idx === 0) {
      if (isViewing) await returnToLatest();
      return;
    }

    // Clicking an older snapshot: ask to stash if dirty
    const dirty = useAppStore.getState().isDirty;
    if (dirty && !isViewing) {
      const stash = confirm("You have unsaved changes. Save a snapshot before navigating?");
      if (stash) {
        await saveVersion("Auto-save before browsing");
      }
    }
    await checkoutSnapshot(commitId);
  }, [checkoutSnapshot, returnToLatest, saveVersion]);

  const handleKeep = useCallback(async () => {
    if (!viewingSnapshotId) return;
    // Files are already checked out — just clear the "viewing" state.
    // The user can save a snapshot when they're ready.
    useAppStore.setState({ viewingSnapshotId: null, isDirty: true });
  }, [viewingSnapshotId]);

  const isViewing = viewingSnapshotId !== null;
  const showDirtyNode = isDirty && !isViewing;

  // Border on the side facing the editor
  const borderClass = sidebarPosition === "left" ? "border-l" : "border-r";

  return (
    <div className={`flex flex-col h-full ${borderClass} border-[var(--color-border)]`}>
      {/* Header */}
      <div className="flex items-center justify-between px-3 h-9 shrink-0 border-b border-[var(--color-border)]">
        <span className="text-xs font-medium text-[var(--color-text-secondary)] uppercase tracking-wider">
          Snapshots
        </span>
        <button
          onClick={() => setShowLabelInput(true)}
          className="group/btn flex items-center gap-1 p-1 rounded text-[var(--color-text-secondary)] hover:text-[var(--color-accent)] transition-colors"
          title="Save Project Snapshot (Ctrl+S)"
        >
          <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" className="shrink-0">
            <path d="M19 21H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h11l5 5v11a2 2 0 0 1-2 2z" />
            <polyline points="17 21 17 13 7 13 7 21" />
            <polyline points="7 3 7 8 15 8" />
          </svg>
          <span className="max-w-0 overflow-hidden group-hover/btn:max-w-[10rem] transition-all duration-200 whitespace-nowrap text-[10px]">
            Save
          </span>
        </button>
      </div>

      {/* Snapshot name input (shown when saving) */}
      {showLabelInput && (
        <div className="px-3 py-2 border-b border-[var(--color-border)]">
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
        </div>
      )}

      {/* Viewing older snapshot banner */}
      {isViewing && (
        <div className="px-3 py-2 border-b border-[var(--color-accent)]/20 bg-[var(--color-accent)]/5">
          <div className="text-[10px] text-[var(--color-accent)] font-medium mb-1.5">
            Viewing older snapshot
          </div>
          <div className="flex gap-1.5">
            <button
              onClick={handleKeep}
              className="flex-1 px-2 py-1 rounded-md text-[10px] font-medium bg-[var(--color-accent)] text-white hover:bg-[var(--color-accent-hover)] transition-colors"
            >
              Keep this version
            </button>
            <button
              onClick={returnToLatest}
              className="flex-1 px-2 py-1 rounded-md text-[10px] font-medium text-[var(--color-text-secondary)] hover:text-[var(--color-text)] border border-[var(--color-border)] hover:border-[var(--color-text-secondary)] transition-colors"
            >
              Back to latest
            </button>
          </div>
        </div>
      )}

      {/* Commit graph */}
      <div className="flex-1 overflow-y-auto">
        {versions.length === 0 && !showDirtyNode ? (
          <div className="px-3 py-8 text-center">
            <div className="text-[var(--color-text-secondary)] text-xs">No snapshots yet</div>
            <div className="text-[var(--color-text-secondary)]/60 text-[10px] mt-1">
              Save a snapshot of the entire project
            </div>
          </div>
        ) : (
          <div className="py-1">
            {/* Dirty / unsaved changes node */}
            {showDirtyNode && (
              <div className="group relative flex" style={{ minHeight: 36 }}>
                <div className="w-8 shrink-0 relative flex items-center justify-center">
                  {versions.length > 0 && (
                    <div
                      className="absolute left-1/2 -translate-x-1/2 w-px border-l border-dashed border-[var(--color-text-secondary)]/30"
                      style={{ top: "50%", bottom: 0 }}
                    />
                  )}
                  <div
                    className="relative z-10 shrink-0 w-2.5 h-2.5 rounded-full border-2 border-dashed border-[var(--color-text-secondary)]/60 bg-[var(--color-surface)]"
                    style={{ boxShadow: "0 0 0 2px var(--color-surface)" }}
                  />
                </div>
                <div className="flex-1 min-w-0 pr-3 flex items-center py-1.5">
                  <span className="text-xs italic text-[var(--color-text-secondary)]">
                    Unsaved changes
                  </span>
                </div>
              </div>
            )}

            {/* Committed snapshots */}
            {versions.map((version, idx) => {
              const isFirst = idx === 0;
              const isLast = idx === versions.length - 1;
              const isSingle = versions.length === 1 && !showDirtyNode;
              const isActive = isViewing
                ? version.id === viewingSnapshotId
                : isFirst && !showDirtyNode;
              return (
                <div key={version.id} className="group relative flex" style={{ minHeight: isFirst ? 44 : 36 }}>
                  {/* Graph column */}
                  <div className="w-8 shrink-0 relative flex items-center justify-center">
                    {/* Continuous vertical line */}
                    {!isSingle && (
                      <div
                        className="absolute left-1/2 -translate-x-1/2 w-px bg-[var(--color-border)]"
                        style={{
                          top: (isFirst && !showDirtyNode) ? "50%" : 0,
                          bottom: isLast ? "50%" : 0,
                        }}
                      />
                    )}
                    {/* Dot — click to navigate */}
                    <button
                      onClick={() => handleCircleClick(version.id, idx)}
                      className={`relative z-10 shrink-0 rounded-full border-2 transition-colors cursor-pointer ${
                        isActive
                          ? "w-3 h-3 bg-[var(--color-accent)] border-[var(--color-accent)]"
                          : "w-2.5 h-2.5 bg-[var(--color-surface)] border-[var(--color-text-secondary)] hover:bg-[var(--color-accent)] hover:border-[var(--color-accent)]"
                      }`}
                      style={{ boxShadow: "0 0 0 2px var(--color-surface)" }}
                      title={isActive ? "Currently viewing" : isFirst ? "Back to latest" : "View this snapshot"}
                    />
                  </div>

                  {/* Content */}
                  <div className={`flex-1 min-w-0 pr-3 flex flex-col justify-center ${isFirst ? "py-2" : "py-1.5"}`}>
                    <div className={`text-xs truncate ${isActive ? "font-medium text-[var(--color-text)]" : "text-[var(--color-text-secondary)]"}`}>
                      {version.message}
                    </div>
                    <div className="text-[10px] text-[var(--color-text-secondary)]/70 mt-0.5">
                      {formatRelativeDate(version.timestamp)}
                    </div>
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
