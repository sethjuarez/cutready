import { useEffect } from "react";
import { FilePlus, FileMinus, FileEdit, Camera, FolderSync } from "lucide-react";
import { useAppStore } from "../stores/appStore";
import type { DiffEntry } from "../types/sketch";

/**
 * ChangesPanel — Activity bar panel showing files changed since last snapshot.
 * Provides a clear view of what's been modified and a quick path to snapshot.
 */
export function ChangesPanel() {
  const changedFiles = useAppStore((s) => s.changedFiles);
  const isDirty = useAppStore((s) => s.isDirty);
  const promptSnapshot = useAppStore((s) => s.promptSnapshot);
  const refreshChangedFiles = useAppStore((s) => s.refreshChangedFiles);
  const syncStatus = useAppStore((s) => s.syncStatus);
  const currentRemote = useAppStore((s) => s.currentRemote);
  const syncWithRemote = useAppStore((s) => s.syncWithRemote);
  const isSyncing = useAppStore((s) => s.isSyncing);

  // Refresh on mount
  useEffect(() => {
    refreshChangedFiles();
  }, [refreshChangedFiles]);

  const added = changedFiles.filter((f) => f.status === "added");
  const modified = changedFiles.filter((f) => f.status === "modified");
  const deleted = changedFiles.filter((f) => f.status === "deleted");

  return (
    <div className="h-full flex flex-col overflow-hidden bg-[rgb(var(--color-bg))]">
      {/* Header */}
      <div className="flex items-center justify-between px-3 py-2.5 border-b border-[rgb(var(--color-border))]">
        <div className="flex items-center gap-2">
          <h2 className="text-[11px] font-semibold uppercase tracking-wider text-[rgb(var(--color-text-secondary))]">
            Changes
          </h2>
          {changedFiles.length > 0 && (
            <span className="px-1.5 py-0.5 text-[10px] font-medium rounded-full bg-[rgb(var(--color-accent))]/15 text-[rgb(var(--color-accent))]">
              {changedFiles.length}
            </span>
          )}
        </div>
      </div>

      {/* Sync status banner (compact, non-polling) */}
      {currentRemote && syncStatus && (syncStatus.ahead > 0 || syncStatus.behind > 0) && (
        <div className="px-3 py-2 border-b border-[rgb(var(--color-border))] bg-[rgb(var(--color-surface))]/50">
          <div className="flex items-center justify-between">
            <div className="flex items-center gap-2 text-[10px] text-[rgb(var(--color-text-secondary))]">
              {syncStatus.behind > 0 && (
                <span className="text-warning">↓ {syncStatus.behind} incoming</span>
              )}
              {syncStatus.ahead > 0 && (
                <span className="text-[rgb(var(--color-accent))]">↑ {syncStatus.ahead} to publish</span>
              )}
            </div>
            <button
              onClick={() => syncWithRemote()}
              disabled={isSyncing}
              className="px-2 py-0.5 rounded text-[10px] font-medium bg-[rgb(var(--color-accent))]/10 text-[rgb(var(--color-accent))] hover:bg-[rgb(var(--color-accent))]/20 transition-colors disabled:opacity-40"
            >
              <FolderSync className="w-3 h-3 inline mr-1" />
              Sync
            </button>
          </div>
        </div>
      )}

      {/* File list */}
      <div className="flex-1 overflow-y-auto px-1 py-1">
        {changedFiles.length === 0 ? (
          <div className="flex flex-col items-center justify-center h-full text-center px-4">
            <div className="w-10 h-10 rounded-full bg-[rgb(var(--color-surface-alt))] flex items-center justify-center mb-3">
              <Camera className="w-5 h-5 text-[rgb(var(--color-text-secondary))]/50" />
            </div>
            <p className="text-[11px] text-[rgb(var(--color-text-secondary))]">
              No changes since the last snapshot
            </p>
          </div>
        ) : (
          <>
            {added.length > 0 && (
              <FileGroup label="Added" files={added} icon={<FilePlus className="w-3 h-3 text-success" />} />
            )}
            {modified.length > 0 && (
              <FileGroup label="Modified" files={modified} icon={<FileEdit className="w-3 h-3 text-warning" />} />
            )}
            {deleted.length > 0 && (
              <FileGroup label="Deleted" files={deleted} icon={<FileMinus className="w-3 h-3 text-error" />} />
            )}
          </>
        )}
      </div>

      {/* Take Snapshot button */}
      {isDirty && (
        <div className="px-3 py-2.5 border-t border-[rgb(var(--color-border))]">
          <button
            onClick={() => promptSnapshot()}
            className="w-full flex items-center justify-center gap-1.5 px-3 py-1.5 rounded-md text-[11px] font-medium bg-[rgb(var(--color-accent))] text-[rgb(var(--color-accent-fg))] hover:opacity-90 transition-opacity"
          >
            <Camera className="w-3.5 h-3.5" />
            Take Snapshot
          </button>
        </div>
      )}
    </div>
  );
}

function FileGroup({ label, files, icon }: { label: string; files: DiffEntry[]; icon: React.ReactNode }) {
  return (
    <div className="mb-1">
      <div className="flex items-center gap-1.5 px-2 py-1 text-[10px] font-medium uppercase tracking-wider text-[rgb(var(--color-text-secondary))]">
        {icon}
        {label} ({files.length})
      </div>
      {files.map((file) => (
        <div
          key={file.path}
          className="flex items-center gap-2 px-2 py-1 rounded hover:bg-[rgb(var(--color-surface-alt))] transition-colors group"
          title={file.path}
        >
          <span className="text-[11px] text-[rgb(var(--color-text))] truncate flex-1">
            {formatPath(file.path)}
          </span>
          {(file.additions > 0 || file.deletions > 0) && (
            <span className="text-[9px] text-[rgb(var(--color-text-secondary))] shrink-0 opacity-0 group-hover:opacity-100 transition-opacity">
              {file.additions > 0 && <span className="text-success">+{file.additions}</span>}
              {file.additions > 0 && file.deletions > 0 && " "}
              {file.deletions > 0 && <span className="text-error">-{file.deletions}</span>}
            </span>
          )}
        </div>
      ))}
    </div>
  );
}

/** Show just the filename, with parent directory as a subtle prefix. */
function formatPath(path: string): string {
  const parts = path.split("/");
  if (parts.length <= 1) return path;
  return parts[parts.length - 1];
}
