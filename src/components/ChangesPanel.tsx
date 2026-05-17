import { useCallback, useEffect, useState, type ReactNode } from "react";
import {
  FilePlus,
  FileMinus,
  FileEdit,
  Camera,
  ChevronDown,
  ChevronRight,
  Search,
  Clock,
  Save,
  GitPullRequestArrow,
  X,
  MoreHorizontal,
  Trash2,
  Share2,
} from "lucide-react";
import { useAppStore } from "../stores/appStore";
import { SnapshotGraph } from "./SnapshotGraph";
import { SnapshotDiffPanel } from "./SnapshotDiffPanel";
import { SyncBar } from "./SyncBar";
import { TimelineSelector } from "./TimelineSelector";
import type { DiffEntry } from "../types/sketch";

export function ChangesPanel() {
  const changedFiles = useAppStore((s) => s.changedFiles);
  const isDirty = useAppStore((s) => s.isDirty);
  const promptSnapshot = useAppStore((s) => s.promptSnapshot);
  const refreshChangedFiles = useAppStore((s) => s.refreshChangedFiles);
  const graphNodes = useAppStore((s) => s.graphNodes);
  const isRewound = useAppStore((s) => s.isRewound);
  const checkDirty = useAppStore((s) => s.checkDirty);
  const openTab = useAppStore((s) => s.openTab);
  const checkRewound = useAppStore((s) => s.checkRewound);
  const navigateToSnapshot = useAppStore((s) => s.navigateToSnapshot);
  const discardChanges = useAppStore((s) => s.discardChanges);
  const loadGraphData = useAppStore((s) => s.loadGraphData);
  const timelines = useAppStore((s) => s.timelines);
  const loadTimelines = useAppStore((s) => s.loadTimelines);
  const squashSnapshots = useAppStore((s) => s.squashSnapshots);
  const currentRemote = useAppStore((s) => s.currentRemote);
  const shareChanges = useAppStore((s) => s.shareChanges);
  const saving = useAppStore((s) => s.saving);
  const currentProject = useAppStore((s) => s.currentProject);
  const isMultiProject = useAppStore((s) => s.isMultiProject);
  const hasRemote = !!currentRemote;

  const [changesExpanded, setChangesExpanded] = useState(true);
  const [historyExpanded, setHistoryExpanded] = useState(true);
  const [pendingNavTarget, setPendingNavTarget] = useState<string | null>(null);
  const [confirmDiscard, setConfirmDiscard] = useState(false);
  const [discarding, setDiscarding] = useState(false);
  const [searchQuery, setSearchQuery] = useState("");
  const [authorFilter, setAuthorFilter] = useState("all");
  const [showSearch, setShowSearch] = useState(false);
  const [squashMode, setSquashMode] = useState(false);
  const [selectedForSquash, setSelectedForSquash] = useState<Set<string>>(new Set());
  const [squashLabel, setSquashLabel] = useState("");
  const [squashError, setSquashError] = useState<string | null>(null);
  const [squashing, setSquashing] = useState(false);
  const [showAdvanced, setShowAdvanced] = useState(false);

  const activeTimeline = timelines.find((t) => t.is_active);
  const activeNodes = (() => {
    if (!activeTimeline) return graphNodes;
    const branchNodes = graphNodes.filter((n) => n.timeline === activeTimeline.name);
    const nodeMap = new Map(graphNodes.map((n) => [n.id, n]));
    const branchIds = new Set(branchNodes.map((n) => n.id));
    const ancestorIds = new Set<string>();
    const frontier: string[] = [];

    for (const node of branchNodes) {
      for (const parentId of node.parents) {
        if (!branchIds.has(parentId) && nodeMap.has(parentId)) frontier.push(parentId);
      }
    }

    while (frontier.length > 0) {
      const id = frontier.pop()!;
      if (ancestorIds.has(id)) continue;
      ancestorIds.add(id);
      const node = nodeMap.get(id);
      if (!node) continue;
      for (const parentId of node.parents) {
        if (!ancestorIds.has(parentId) && nodeMap.has(parentId)) frontier.push(parentId);
      }
    }

    const ancestors = graphNodes.filter((n) => ancestorIds.has(n.id));
    return [...branchNodes, ...ancestors];
  })();

  const timelineMap = new Map(
    timelines.map((t) => [t.name, { label: t.label, colorIndex: t.color_index }]),
  );

  const historyAuthors = Array.from(
    new Set(activeNodes.map((node) => node.author).filter((author): author is string => !!author)),
  ).sort((a, b) => a.localeCompare(b));
  const filteredNodes = activeNodes.filter((node) => {
    const matchesSearch = searchQuery
      ? node.message.toLowerCase().includes(searchQuery.toLowerCase())
      : true;
    const matchesAuthor = authorFilter === "all" || node.author === authorFilter;
    return matchesSearch && matchesAuthor;
  });

  const selectedNodes = activeNodes
    .filter((node) => selectedForSquash.has(node.id))
    .sort((a, b) => +new Date(b.timestamp) - +new Date(a.timestamp));
  const selectedHead = selectedNodes.find((node) => node.is_head);
  const selectedOldest = selectedNodes[selectedNodes.length - 1];
  const canSquash = selectedNodes.length >= 2 && !!selectedHead && !hasRemote && !isRewound;

  useEffect(() => {
    loadGraphData();
    loadTimelines();
    checkDirty();
    checkRewound();
    refreshChangedFiles();
  }, [loadGraphData, loadTimelines, checkDirty, checkRewound, refreshChangedFiles]);

  useEffect(() => {
    if (isDirty && changedFiles.length > 0) setChangesExpanded(true);
  }, [isDirty, changedFiles.length]);

  const handleNodeClick = useCallback(async (commitId: string, isHead: boolean) => {
    if (isHead) return;
    const dirty = useAppStore.getState().isDirty;
    if (dirty) {
      setPendingNavTarget(commitId);
      return;
    }
    await navigateToSnapshot(commitId);
    await loadGraphData();
    await loadTimelines();
  }, [navigateToSnapshot, loadGraphData, loadTimelines]);

  const handleNavSave = useCallback(async () => {
    const target = pendingNavTarget;
    if (!target) return;
    setPendingNavTarget(null);
    useAppStore.setState({ pendingNavAfterSave: target, snapshotPromptOpen: true });
  }, [pendingNavTarget]);

  const handleNavDiscard = useCallback(async () => {
    const target = pendingNavTarget;
    if (!target) return;
    setPendingNavTarget(null);
    await navigateToSnapshot(target);
    await loadGraphData();
    await loadTimelines();
  }, [pendingNavTarget, navigateToSnapshot, loadGraphData, loadTimelines]);

  const handleDiscard = useCallback(async () => {
    setDiscarding(true);
    await discardChanges();
    setConfirmDiscard(false);
    setDiscarding(false);
    await loadGraphData();
    await loadTimelines();
  }, [discardChanges, loadGraphData, loadTimelines]);

  const toggleSquashSelection = useCallback((commitId: string) => {
    setSelectedForSquash((prev) => {
      const next = new Set(prev);
      if (next.has(commitId)) next.delete(commitId);
      else next.add(commitId);
      return next;
    });
    setSquashError(null);
  }, []);

  const cancelSquash = useCallback(() => {
    setSquashMode(false);
    setSelectedForSquash(new Set());
    setSquashLabel("");
    setSquashError(null);
    setShowAdvanced(false);
  }, []);

  const handleSquash = useCallback(async () => {
    if (!selectedHead || !selectedOldest || !squashLabel.trim()) return;
    setSquashing(true);
    setSquashError(null);
    try {
      await squashSnapshots(selectedOldest.id, selectedHead.id, squashLabel.trim());
      cancelSquash();
    } catch (err) {
      setSquashError(String(err));
    } finally {
      setSquashing(false);
    }
  }, [cancelSquash, selectedHead, selectedOldest, squashLabel, squashSnapshots]);

  const added = changedFiles.filter((f) => f.status === "added");
  const modified = changedFiles.filter((f) => f.status === "modified");
  const deleted = changedFiles.filter((f) => f.status === "deleted");
  const sectionBodyClass = "min-h-0 flex-1 overflow-y-auto";
  const workspaceName = currentProject ? getPathBasename(currentProject.repo_root) : "workspace";
  const activeProjectName = currentProject?.name ?? "project";
  const remoteUrl = currentRemote?.url ?? null;
  const remoteLabel = remoteUrl ? formatRemoteLabel(remoteUrl) : null;

  return (
    <div className="flex h-full flex-col overflow-hidden bg-[rgb(var(--color-surface-inset))]">
      <div className="flex min-h-10 shrink-0 items-center justify-between gap-2 border-b border-[rgb(var(--color-border))] px-3 py-1">
        <div className="min-w-0">
          <div className="text-[11px] font-semibold uppercase tracking-wider text-[rgb(var(--color-text-secondary))]">
            Changes
          </div>
          {remoteLabel && (
            <div
              className="flex min-w-0 items-center gap-1 text-[9px] leading-tight text-[rgb(var(--color-text-secondary))]/60"
              title={remoteUrl ?? undefined}
            >
              <span className="h-1.5 w-1.5 shrink-0 rounded-full bg-success" />
              <span className="truncate">{remoteLabel}</span>
            </div>
          )}
        </div>
        <div className="flex min-w-0 items-center gap-1">
          <SyncBar variant="compact" />
          {currentRemote && (
            <button
              onClick={() => shareChanges()}
              disabled={saving}
              className="rounded p-1 text-[rgb(var(--color-text-secondary))] transition-colors hover:bg-[rgb(var(--color-accent))]/10 hover:text-[rgb(var(--color-accent))] disabled:pointer-events-none disabled:opacity-30"
              title="Share changes safely"
            >
              <Share2 className="h-3 w-3" />
            </button>
          )}
          {isDirty && !pendingNavTarget && (
            <button
              onClick={() => setConfirmDiscard(true)}
              className="rounded p-1 text-[rgb(var(--color-text-secondary))] transition-colors hover:bg-error/10 hover:text-error"
              title="Discard active project changes"
            >
              <Trash2 className="h-3 w-3" />
            </button>
          )}
          <button
            onClick={() => promptSnapshot()}
            disabled={!isDirty || saving}
            className="rounded p-1 text-[rgb(var(--color-text-secondary))] transition-colors hover:bg-[rgb(var(--color-accent))]/10 hover:text-[rgb(var(--color-accent))] disabled:pointer-events-none disabled:opacity-30"
            title="Take Snapshot (Ctrl+S)"
          >
            {saving ? (
              <svg className="h-3 w-3 animate-spin text-[rgb(var(--color-accent))]" viewBox="0 0 24 24" fill="none">
                <circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="3" />
                <path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4z" />
              </svg>
            ) : (
              <Save className="h-3 w-3" />
            )}
          </button>
        </div>
      </div>

      <SectionHeader
        title="Project"
        count={changedFiles.length}
        scope={isMultiProject ? activeProjectName : undefined}
        scopeTitle={isMultiProject ? `Active project: ${activeProjectName}` : undefined}
        expanded={changesExpanded}
        onToggle={() => setChangesExpanded(!changesExpanded)}
      />

      {confirmDiscard && (
        <div className="border-b border-error/20 bg-error/5 px-3 py-2">
          <div className="mb-1.5 text-[10px] font-medium text-error">
            Discard changes in {isMultiProject ? activeProjectName : "this project"} since the last snapshot?
          </div>
          <div className="flex gap-1.5">
            <button
              onClick={handleDiscard}
              disabled={discarding}
              className="flex-1 rounded-md bg-error px-2 py-1 text-[10px] font-medium text-accent-fg transition-colors hover:bg-error/80 disabled:opacity-40"
            >
              {discarding ? "Discarding..." : "Discard"}
            </button>
            <button
              onClick={() => setConfirmDiscard(false)}
              className="rounded-md px-2 py-1 text-[10px] text-[rgb(var(--color-text-secondary))] transition-colors hover:text-[rgb(var(--color-text))]"
            >
              Cancel
            </button>
          </div>
        </div>
      )}

      {pendingNavTarget && (
        <div className="border-b border-warning/20 bg-warning/5 px-3 py-2">
          <div className="mb-1.5 text-[10px] font-medium text-warning">
            You have unsaved changes
          </div>
          <div className="flex gap-1.5">
            <button
              onClick={handleNavSave}
              className="flex-1 rounded-md bg-[rgb(var(--color-accent))] px-2 py-1 text-[10px] font-medium text-[rgb(var(--color-accent-fg))] transition-colors hover:bg-[rgb(var(--color-accent-hover))]"
            >
              Save first
            </button>
            <button
              onClick={handleNavDiscard}
              className="flex-1 rounded-md border border-[rgb(var(--color-border))] px-2 py-1 text-[10px] font-medium text-[rgb(var(--color-text-secondary))] transition-colors hover:border-error/30 hover:text-error"
            >
              Discard
            </button>
            <button
              onClick={() => setPendingNavTarget(null)}
              className="rounded-md px-2 py-1 text-[10px] text-[rgb(var(--color-text-secondary))] transition-colors hover:text-[rgb(var(--color-text))]"
            >
              Cancel
            </button>
          </div>
        </div>
      )}

      {changesExpanded && (
        <div className={`${sectionBodyClass} px-1 py-1`}>
          {changedFiles.length === 0 ? (
            <div className="flex items-center gap-2 px-2 py-3 text-[10px] text-[rgb(var(--color-text-secondary))]">
              <Camera className="h-3.5 w-3.5 opacity-40" />
              No {isMultiProject ? "project " : ""}changes since last snapshot
            </div>
          ) : (
            <>
              {added.length > 0 && <FileGroup label="Added" files={added} icon={<FilePlus className="h-3 w-3 text-success" />} />}
              {modified.length > 0 && <FileGroup label="Modified" files={modified} icon={<FileEdit className="h-3 w-3 text-warning" />} />}
              {deleted.length > 0 && <FileGroup label="Deleted" files={deleted} icon={<FileMinus className="h-3 w-3 text-error" />} />}
            </>
          )}
        </div>
      )}

      <SectionHeader
        title="History"
        scope={isMultiProject ? "Workspace" : undefined}
        scopeTitle={isMultiProject ? `Workspace history: ${workspaceName}` : undefined}
        expanded={historyExpanded}
        onToggle={() => setHistoryExpanded(!historyExpanded)}
        actions={historyExpanded ? (
          <>
            {timelines.length > 1 && <TimelineSelector />}
            <button
              onClick={() => {
                setShowSearch(!showSearch);
                if (showSearch) setSearchQuery("");
              }}
              className={`grid h-5 w-5 place-items-center rounded-md transition-colors ${showSearch ? "text-[rgb(var(--color-accent))] bg-[rgb(var(--color-accent))]/10" : "text-[rgb(var(--color-text-secondary))] hover:bg-[rgb(var(--color-surface-alt))] hover:text-[rgb(var(--color-text))]"}`}
              title="Search snapshots"
            >
              <Search className="h-3 w-3" />
            </button>
            <button
              onClick={() => setShowAdvanced(!showAdvanced)}
              className={`grid h-5 w-5 place-items-center rounded-md transition-colors ${showAdvanced ? "text-[rgb(var(--color-accent))] bg-[rgb(var(--color-accent))]/10" : "text-[rgb(var(--color-text-secondary))] hover:bg-[rgb(var(--color-surface-alt))] hover:text-[rgb(var(--color-text))]"}`}
              title="More actions"
            >
              <MoreHorizontal className="h-3 w-3" />
            </button>
          </>
        ) : null}
      />

      {showAdvanced && !squashMode && (
        <div className="space-y-0.5 border-b border-[rgb(var(--color-border))] px-3 py-1">
          <button
            onClick={() => {
              openTab({ type: "history", path: "__history__", title: "History" });
              setShowAdvanced(false);
            }}
            className="flex w-full items-center gap-1.5 rounded px-2 py-1 text-[10px] text-[rgb(var(--color-text-secondary))] transition-colors hover:bg-[rgb(var(--color-surface-alt))] hover:text-[rgb(var(--color-text))]"
          >
            <Clock className="h-3 w-3" />
            Open full history
          </button>
          <button
            onClick={() => {
              setSquashMode(true);
              setShowAdvanced(false);
            }}
            className="flex w-full items-center gap-1.5 rounded px-2 py-1 text-[10px] text-[rgb(var(--color-text-secondary))] transition-colors hover:bg-[rgb(var(--color-surface-alt))] hover:text-[rgb(var(--color-text))]"
          >
            <GitPullRequestArrow className="h-3 w-3" />
            Squash snapshots
          </button>
          {historyAuthors.length > 1 && (
            <label className="flex items-center gap-1.5 rounded px-2 py-1 text-[10px] text-[rgb(var(--color-text-secondary))]">
              Author
              <select
                value={authorFilter}
                onChange={(event) => setAuthorFilter(event.target.value)}
                className="min-w-0 flex-1 rounded border border-[rgb(var(--color-border))] bg-[rgb(var(--color-surface-alt))] px-1 py-0.5 text-[10px] text-[rgb(var(--color-text))] outline-none"
              >
                <option value="all">Everyone</option>
                {historyAuthors.map((author) => (
                  <option key={author} value={author}>{author}</option>
                ))}
              </select>
            </label>
          )}
        </div>
      )}

      {squashMode && (
        <div className="space-y-2 border-b border-[rgb(var(--color-accent))]/20 bg-[rgb(var(--color-accent))]/5 px-3 py-2">
          <div className="flex items-start gap-2">
            <div className="flex-1">
              <div className="text-[10px] font-medium text-[rgb(var(--color-accent))]">
                Select recent snapshots ending at HEAD
              </div>
              <div className="text-[10px] leading-relaxed text-[rgb(var(--color-text-secondary))]">
                Combine selected snapshots into one.
              </div>
            </div>
            <button
              onClick={cancelSquash}
              className="rounded p-0.5 text-[rgb(var(--color-text-secondary))] transition-colors hover:text-[rgb(var(--color-text))]"
              title="Cancel"
            >
              <X className="h-3 w-3" />
            </button>
          </div>
          <input
            value={squashLabel}
            onChange={(e) => setSquashLabel(e.target.value)}
            placeholder="Combined snapshot name..."
            className="w-full rounded border border-[rgb(var(--color-border))] bg-[rgb(var(--color-surface))] px-2 py-1 text-[10px] text-[rgb(var(--color-text))] outline-none placeholder:text-[rgb(var(--color-text-secondary))]/50 focus:border-[rgb(var(--color-accent))]"
          />
          {(hasRemote || isRewound) && (
            <div className="text-[10px] text-warning">
              Squashing is only available on local timeline tips.
            </div>
          )}
          {squashError && <div className="text-[10px] text-error">{squashError}</div>}
          <button
            onClick={handleSquash}
            disabled={!canSquash || !squashLabel.trim() || squashing}
            className="w-full rounded-md bg-[rgb(var(--color-accent))] px-2 py-1 text-[10px] font-medium text-[rgb(var(--color-accent-fg))] transition-colors hover:bg-[rgb(var(--color-accent-hover))] disabled:pointer-events-none disabled:opacity-40"
          >
            {squashing ? "Squashing..." : `Squash ${selectedNodes.length || ""} snapshots`}
          </button>
        </div>
      )}

      {showSearch && historyExpanded && (
        <div className="border-b border-[rgb(var(--color-border))] px-3 py-1.5">
          <input
            type="text"
            value={searchQuery}
            onChange={(e) => setSearchQuery(e.target.value)}
            placeholder="Filter snapshots…"
            className="w-full rounded border border-[rgb(var(--color-border))] bg-[rgb(var(--color-surface-alt))] px-2 py-1 text-[10px] text-[rgb(var(--color-text))] outline-none placeholder:text-[rgb(var(--color-text-secondary))]/50 focus:border-[rgb(var(--color-accent))]"
            autoFocus
          />
        </div>
      )}

      {historyExpanded && (
        <div className={sectionBodyClass}>
          {activeNodes.length === 0 ? (
            <div className="flex flex-col items-center justify-center px-4 py-8 text-center">
              <div className="mb-2 flex h-8 w-8 items-center justify-center rounded-full bg-[rgb(var(--color-accent))]/10">
                <Clock className="h-4 w-4 text-[rgb(var(--color-accent))]" />
              </div>
              <p className="mb-0.5 text-[11px] font-medium text-[rgb(var(--color-text))]">No snapshots yet</p>
              <p className="max-w-[200px] text-[10px] leading-relaxed text-[rgb(var(--color-text-secondary))]">
                Press <kbd className="rounded border border-[rgb(var(--color-border))] bg-[rgb(var(--color-surface-alt))] px-1 py-0.5 text-[9px] font-mono">Ctrl+S</kbd> to save a workspace snapshot.
              </p>
            </div>
          ) : (
            <div className="py-1">
              <SnapshotGraph
                nodes={filteredNodes}
                isDirty={isDirty}
                isRewound={isRewound}
                timelineMap={timelineMap}
                hasMultipleTimelines={timelines.length > 1}
                showRemoteBadges={hasRemote}
                selectionMode={squashMode}
                selectedIds={selectedForSquash}
                onToggleSelect={toggleSquashSelection}
                onNodeClick={handleNodeClick}
              />
              {searchQuery && filteredNodes.length === 0 && (
                <div className="px-4 py-4 text-center text-[10px] text-[rgb(var(--color-text-secondary))]">
                  No snapshots match "{searchQuery}"
                </div>
              )}
            </div>
          )}
        </div>
      )}

      <SnapshotDiffPanel />
    </div>
  );
}

function SectionHeader({
  title,
  count,
  scope,
  scopeTitle,
  expanded,
  onToggle,
  actions,
}: {
  title: string;
  count?: number;
  scope?: string;
  scopeTitle?: string;
  expanded: boolean;
  onToggle: () => void;
  actions?: ReactNode;
}) {
  return (
    <div className="flex h-8 min-w-0 shrink-0 items-center justify-between gap-2 border-b border-[rgb(var(--color-border))] px-3">
      <button
        onClick={onToggle}
        className="flex min-w-0 flex-1 items-center gap-1 text-[11px] font-semibold uppercase tracking-wider text-[rgb(var(--color-text-secondary))] transition-colors hover:text-[rgb(var(--color-text))]"
      >
        {expanded ? <ChevronDown className="h-3 w-3 shrink-0" /> : <ChevronRight className="h-3 w-3 shrink-0" />}
        <span className="truncate">{title}</span>
        {scope && (
          <span
            className="min-w-0 max-w-[4.75rem] shrink truncate rounded-full border border-[rgb(var(--color-border))] px-1.5 py-0 text-[9px] font-medium normal-case tracking-normal text-[rgb(var(--color-text-secondary))]/80"
            title={scopeTitle}
          >
            {scope}
          </span>
        )}
        {count !== undefined && count > 0 && (
          <span className="ml-1 rounded-full bg-[rgb(var(--color-accent))]/15 px-1 py-0 text-[9px] font-medium text-[rgb(var(--color-accent))]">
            {count}
          </span>
        )}
      </button>
      <div className="flex shrink-0 items-center gap-1">{actions}</div>
    </div>
  );
}

function getPathBasename(path: string): string {
  return path.split(/[\\/]/).filter(Boolean).pop() ?? path;
}

function formatRemoteLabel(url: string): string {
  return url
    .replace(/^https?:\/\/(www\.)?github\.com\//, "")
    .replace(/^git@github\.com:/, "")
    .replace(/\.git$/, "");
}

function FileGroup({ label, files, icon }: { label: string; files: DiffEntry[]; icon: ReactNode }) {
  const openTab = useAppStore((s) => s.openTab);
  const discardFile = useAppStore((s) => s.discardFile);

  return (
    <div className="mb-1">
      <div className="flex items-center gap-1.5 px-3 py-1 text-[10px] font-medium uppercase tracking-wider text-[rgb(var(--color-text-secondary))]">
        {icon}
        {label} ({files.length})
      </div>
      <div className="ml-3 border-l border-[rgb(var(--color-border))]/50">
        {files.map((file) => {
          const parts = file.path.split("/");
          const filename = parts.pop() ?? file.path;
          return (
            <div
              key={file.path}
              className="group flex w-full items-center gap-1 rounded-r pr-1 transition-colors hover:bg-[rgb(var(--color-surface-alt))]"
            >
              <button
                onClick={() => openTab({ type: "diff", path: file.path, title: `${filename} (diff)` })}
                className="flex min-w-0 flex-1 cursor-pointer items-center gap-2 px-3 py-1.5 text-left"
                title={`View diff: ${file.path}`}
              >
                <span className="truncate text-[12px] font-medium text-[rgb(var(--color-text))]">{filename}</span>
                {(file.additions > 0 || file.deletions > 0) && (
                  <span className="shrink-0 flex items-center gap-1 text-[10px]">
                    {file.additions > 0 && <span className="text-success">+{file.additions}</span>}
                    {file.deletions > 0 && <span className="text-error">-{file.deletions}</span>}
                  </span>
                )}
              </button>
              <button
                onClick={() => void discardFile(file.path)}
                className="shrink-0 rounded p-0.5 text-[rgb(var(--color-text-secondary))] opacity-0 transition-colors hover:text-error group-hover:opacity-100"
                title={`Discard changes to ${file.path}`}
              >
                <X className="h-3 w-3" />
              </button>
            </div>
          );
        })}
      </div>
    </div>
  );
}
