import { useCallback, useEffect, useLayoutEffect, useRef, useState, type CSSProperties, type ReactNode, type RefObject } from "react";
import { createPortal } from "react-dom";
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
  X,
  Trash2,
  ArrowUp,
  ArrowDown,
  Check,
  GitBranch,
} from "lucide-react";
import { useAppStore } from "../stores/appStore";
import { SnapshotGraph } from "./SnapshotGraph";
import { SnapshotDiffPanel } from "./SnapshotDiffPanel";
import { IncomingPreview, SyncBar } from "./SyncBar";
import { TimelineSelector } from "./TimelineSelector";
import { useConfirmDialog } from "./ConfirmDialog";
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
  const deleteTimeline = useAppStore((s) => s.deleteTimeline);
  const switchTimeline = useAppStore((s) => s.switchTimeline);
  const loadGraphData = useAppStore((s) => s.loadGraphData);
  const timelines = useAppStore((s) => s.timelines);
  const loadTimelines = useAppStore((s) => s.loadTimelines);
  const renameLegacyMasterTimeline = useAppStore((s) => s.renameLegacyMasterTimeline);
  const currentRemote = useAppStore((s) => s.currentRemote);
  const syncStatus = useAppStore((s) => s.syncStatus);
  const syncError = useAppStore((s) => s.syncError);
  const incomingCommits = useAppStore((s) => s.incomingCommits);
  const saving = useAppStore((s) => s.saving);
  const currentProject = useAppStore((s) => s.currentProject);
  const isMultiProject = useAppStore((s) => s.isMultiProject);
  const projects = useAppStore((s) => s.projects);
  const startedBranchFromSnapshot = useAppStore((s) => s.startedBranchFromSnapshot);
  const hasRemote = !!currentRemote;

  const [changesExpanded, setChangesExpanded] = useState(true);
  const [historyExpanded, setHistoryExpanded] = useState(true);
  const [searchQuery, setSearchQuery] = useState("");
  const [showSearch, setShowSearch] = useState(false);
  const [showIncoming, setShowIncoming] = useState(false);
  const [showOutgoing, setShowOutgoing] = useState(false);
  const [confirmRenameMaster, setConfirmRenameMaster] = useState(false);
  const [renamingMaster, setRenamingMaster] = useState(false);
  const [showProjectFilterMenu, setShowProjectFilterMenu] = useState(false);
  const [projectFilter, setProjectFilter] = useState<string>("all");
  const projectFilterTriggerRef = useRef<HTMLDivElement>(null);
  const projectFilterMenuRef = useRef<HTMLDivElement>(null);
  const outgoingTriggerRef = useRef<HTMLDivElement>(null);
  const incomingTriggerRef = useRef<HTMLDivElement>(null);
  const projectFilterMenuStyle = useAnchoredPopover(showProjectFilterMenu, projectFilterTriggerRef, 224, "left");
  const outgoingPreviewStyle = useAnchoredPopover(showOutgoing, outgoingTriggerRef, 256, "left");
  const incomingPreviewStyle = useAnchoredPopover(showIncoming, incomingTriggerRef, 288, "right");
  const { confirm, confirmationDialog } = useConfirmDialog();

  useEffect(() => {
    if (!showProjectFilterMenu) return;
    const handle = (event: MouseEvent) => {
      const target = event.target as Node;
      if (
        projectFilterTriggerRef.current?.contains(target) ||
        projectFilterMenuRef.current?.contains(target)
      ) {
        return;
      }
      setShowProjectFilterMenu(false);
    };
    window.addEventListener("mousedown", handle);
    return () => window.removeEventListener("mousedown", handle);
  }, [showProjectFilterMenu]);

  useEffect(() => {
    if (!showIncoming && !showOutgoing) return;
    const handleMouseDown = (event: MouseEvent) => {
      const target = event.target as Node;
      if (
        incomingTriggerRef.current?.contains(target) ||
        outgoingTriggerRef.current?.contains(target)
      ) {
        return;
      }
      setShowIncoming(false);
      setShowOutgoing(false);
    };
    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        setShowIncoming(false);
        setShowOutgoing(false);
      }
    };
    window.addEventListener("mousedown", handleMouseDown);
    window.addEventListener("keydown", handleKeyDown);
    return () => {
      window.removeEventListener("mousedown", handleMouseDown);
      window.removeEventListener("keydown", handleKeyDown);
    };
  }, [showIncoming, showOutgoing]);

  const activeTimeline = timelines.find((t) => t.is_active);
  const head = graphNodes.find((node) => node.is_head);
  const emptyStartedBranch = startedBranchFromSnapshot
    && activeTimeline?.name === startedBranchFromSnapshot.branchName
    && head?.id === startedBranchFromSnapshot.snapshotId
    ? startedBranchFromSnapshot
    : null;
  const hasLegacyMasterTimeline = timelines.some((timeline) => timeline.name === "master")
    && !timelines.some((timeline) => timeline.name === "main");
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

  const filteredNodes = activeNodes.filter((node) => {
    const matchesSearch = searchQuery
      ? node.message.toLowerCase().includes(searchQuery.toLowerCase())
      : true;
    return matchesSearch;
  });

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

  useEffect(() => {
    if (projectFilter === "all") return;
    if (!projects.some((project) => project.path === projectFilter)) {
      setProjectFilter("all");
    }
  }, [projectFilter, projects]);

  const handleNodeClick = useCallback(async (commitId: string, isHead: boolean) => {
    if (isHead) return;
    await navigateToSnapshot(commitId);
    await loadGraphData();
    await loadTimelines();
  }, [navigateToSnapshot, loadGraphData, loadTimelines]);

  const handleDiscard = useCallback(async () => {
    const confirmed = await confirm({
      title: "Discard all workspace changes?",
      message: "This restores the workspace to the last saved snapshot. Unsaved edits in sketches, notes, storyboards, and visuals will be lost.",
      confirmLabel: "Discard changes",
      variant: "error",
    });
    if (!confirmed) return;
    const branchToDelete = emptyStartedBranch;
    await discardChanges();
    await loadGraphData();
    await loadTimelines();
    if (branchToDelete) {
      const shouldDelete = await confirm({
        title: "Delete the empty branch too?",
        message: `You discarded the unsaved work on ${branchToDelete.branchName}. This branch has no new saved snapshots beyond where it started. Delete it as well?`,
        confirmLabel: "Delete branch",
        cancelLabel: "Keep branch",
        variant: "warning",
      });
      if (shouldDelete) {
        const fallback = timelines.find((timeline) => timeline.name !== branchToDelete.branchName);
        if (fallback) await switchTimeline(fallback.name);
        await deleteTimeline(branchToDelete.branchName);
      }
    }
  }, [confirm, deleteTimeline, discardChanges, emptyStartedBranch, loadGraphData, loadTimelines, switchTimeline, timelines]);

  const handleRenameMaster = useCallback(async () => {
    if (!confirmRenameMaster) {
      setConfirmRenameMaster(true);
      return;
    }
    setRenamingMaster(true);
    try {
      await renameLegacyMasterTimeline();
      setConfirmRenameMaster(false);
    } finally {
      setRenamingMaster(false);
    }
  }, [confirmRenameMaster, renameLegacyMasterTimeline]);

  const openFullHistoryGraph = useCallback(() => {
    openTab({ type: "history", path: "__history__", title: "History Graph" });
  }, [openTab]);

  const selectedProjectFilter = projectFilter === "all"
    ? null
    : projects.find((project) => project.path === projectFilter) ?? null;
  const filteredChangedFiles = selectedProjectFilter
    ? changedFiles.filter((file) => fileBelongsToProject(file.path, selectedProjectFilter.path))
    : changedFiles;
  const added = filteredChangedFiles.filter((f) => f.status === "added");
  const modified = filteredChangedFiles.filter((f) => f.status === "modified");
  const deleted = filteredChangedFiles.filter((f) => f.status === "deleted");
  const changesBodyClass = filteredChangedFiles.length === 0
    ? "max-h-24 shrink-0 overflow-hidden"
    : "max-h-[35%] shrink-0 overflow-y-auto";
  const historyBodyClass = "min-h-0 flex-1 overflow-y-auto";
  const workspaceName = currentProject ? getPathBasename(currentProject.repo_root) : "workspace";
  const ahead = syncStatus?.ahead ?? 0;
  const behind = syncStatus?.behind ?? 0;
  const projectScopeLabel = isMultiProject
    ? (selectedProjectFilter?.name ?? "All Projects")
    : "This project";
  const selectableProjects = projects.length > 0 ? projects : [];
  const otherChangeCount = changedFiles.length - filteredChangedFiles.length;
  const projectFilterMenu = showProjectFilterMenu && projectFilterMenuStyle ? createPortal(
    <div
      ref={projectFilterMenuRef}
      style={projectFilterMenuStyle}
      className="z-[var(--z-overlay)] overflow-hidden rounded-lg border border-[rgb(var(--color-border))] bg-[rgb(var(--color-surface))] shadow-lg"
    >
      <div className="py-1">
        <button
          onClick={() => {
            setProjectFilter("all");
            setShowProjectFilterMenu(false);
          }}
          className={`group relative flex w-full items-center gap-2 px-3 py-1.5 text-left text-[11px] transition-colors ${
            projectFilter === "all"
              ? "bg-[rgb(var(--color-accent))]/10 font-medium text-[rgb(var(--color-accent))]"
              : "text-[rgb(var(--color-text))] hover:bg-[rgb(var(--color-border))]/30"
          }`}
          title="Show changes from every project in this workspace"
        >
          <span className="flex w-[10px] shrink-0 items-center justify-center">
            {projectFilter === "all" ? (
              <Check className="h-2.5 w-2.5" />
            ) : (
              <span className="h-1.5 w-1.5 rounded-full bg-[rgb(var(--color-text-secondary))]/30" />
            )}
          </span>
          <span className="min-w-0 flex-1 truncate">All Projects</span>
          <span className="shrink-0 text-[9px] text-[rgb(var(--color-text-secondary))]/70">{changedFiles.length}</span>
        </button>
        {selectableProjects.map((project) => {
          const selected = projectFilter === project.path;
          const projectChangeCount = changedFiles.filter((file) => fileBelongsToProject(file.path, project.path)).length;
          return (
            <button
              key={project.path}
              onClick={() => {
                setProjectFilter(project.path);
                setShowProjectFilterMenu(false);
              }}
              className={`group relative flex w-full items-center gap-2 px-3 py-1.5 text-left text-[11px] transition-colors ${
                selected
                  ? "bg-[rgb(var(--color-accent))]/10 font-medium text-[rgb(var(--color-accent))]"
                  : "text-[rgb(var(--color-text))] hover:bg-[rgb(var(--color-border))]/30"
              }`}
              title={project.path}
            >
              <span className="flex w-[10px] shrink-0 items-center justify-center">
                {selected ? (
                  <Check className="h-2.5 w-2.5" />
                ) : (
                  <span className="h-1.5 w-1.5 rounded-full bg-[rgb(var(--color-text-secondary))]/30" />
                )}
              </span>
              <span className="min-w-0 flex-1 truncate">{project.name}</span>
              <span className="shrink-0 text-[9px] text-[rgb(var(--color-text-secondary))]/70">{projectChangeCount}</span>
            </button>
          );
        })}
      </div>
    </div>,
    document.body,
  ) : null;
  const outgoingPreview = showOutgoing && outgoingPreviewStyle ? createPortal(
    <OutgoingPreview count={ahead} style={outgoingPreviewStyle} />,
    document.body,
  ) : null;
  const incomingPreview = showIncoming && incomingPreviewStyle ? createPortal(
    <IncomingPreview commits={incomingCommits} style={incomingPreviewStyle} />,
    document.body,
  ) : null;

  return (
    <div className="flex h-full min-h-0 flex-col overflow-hidden bg-[rgb(var(--color-surface-inset))]">
      <SectionHeader
        title="Changes"
        count={filteredChangedFiles.length}
        expanded={changesExpanded}
        onToggle={() => setChangesExpanded(!changesExpanded)}
        actions={(
          <>
            {isDirty && (
              <button
                onClick={() => void handleDiscard()}
                className="grid h-6 w-6 shrink-0 place-items-center rounded-md text-[rgb(var(--color-text-secondary))] transition-colors hover:bg-error/10 hover:text-error"
                title="Discard workspace changes"
              >
                <Trash2 className="h-3 w-3" />
              </button>
            )}
          </>
        )}
      />
      {changesExpanded && (
        <div className="shrink-0 border-b border-[rgb(var(--color-border))] px-3 py-1.5">
          <div className="flex min-w-0 items-center gap-1.5">
            <div className="relative min-w-0 flex-1" ref={projectFilterTriggerRef}>
              <button
                onClick={() => {
                  if (isMultiProject && selectableProjects.length > 1) setShowProjectFilterMenu((open) => !open);
                }}
                className="flex h-6 min-w-0 max-w-full items-center gap-1.5 rounded-md px-1.5 text-[10px] text-[rgb(var(--color-text-secondary))] transition-colors hover:bg-[rgb(var(--color-surface-alt))] hover:text-[rgb(var(--color-text))]"
                title={isMultiProject ? "Filter visible changes by project. Save and discard still apply to the whole workspace." : "Showing changes for this project"}
              >
                <FileEdit className="h-3 w-3 shrink-0" />
                <span className="truncate">{projectScopeLabel}</span>
                {isMultiProject && selectableProjects.length > 1 && <ChevronDown className="h-2 w-2 shrink-0 opacity-50" />}
              </button>
              {projectFilterMenu}
            </div>
            <WorkspaceModeBadge remote={hasRemote} syncError={syncError} />
            <button
              onClick={() => promptSnapshot()}
              disabled={!isDirty || saving}
              className={`grid h-6 w-6 shrink-0 place-items-center rounded-md transition-colors hover:bg-[rgb(var(--color-accent))]/10 hover:text-[rgb(var(--color-accent))] disabled:pointer-events-none disabled:opacity-50 ${
                isDirty ? "text-[rgb(var(--color-accent))]" : "text-[rgb(var(--color-text-secondary))]"
              }`}
              title="Save snapshot (Ctrl+S)"
            >
              {saving ? (
                <svg className="h-3 w-3 shrink-0 animate-spin text-[rgb(var(--color-accent))]" viewBox="0 0 24 24" fill="none">
                  <circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="3" />
                  <path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4z" />
                </svg>
              ) : (
                <Save className="h-3 w-3 shrink-0" />
              )}
            </button>
          </div>

          {hasRemote && (
            <div className="mt-1 flex min-w-0 flex-wrap items-center gap-1.5 text-[9px] leading-tight text-[rgb(var(--color-text-secondary))]/60">
              <SyncBar variant="compact" />
              {(ahead > 0 || behind > 0) && (
                <div className="flex shrink-0 items-center gap-1">
                  {ahead > 0 && (
                    <div ref={outgoingTriggerRef} className="relative">
                      <button
                        type="button"
                        onClick={() => {
                          setShowOutgoing((value) => !value);
                          setShowIncoming(false);
                        }}
                        className="flex h-4 items-center gap-0.5 rounded-full bg-[rgb(var(--color-accent))]/10 px-1.5 text-[10px] font-semibold text-[rgb(var(--color-accent))] transition-colors hover:bg-[rgb(var(--color-accent))]/15"
                        title={`${ahead} outgoing snapshot${ahead !== 1 ? "s" : ""} ready to share`}
                      >
                        <ArrowUp className="h-2.5 w-2.5" />
                        {ahead}
                      </button>
                      {outgoingPreview}
                    </div>
                  )}
                  {behind > 0 && (
                    <div ref={incomingTriggerRef} className="relative">
                      <button
                        type="button"
                        onClick={() => {
                          setShowIncoming((value) => !value);
                          setShowOutgoing(false);
                        }}
                        className="flex h-4 items-center gap-0.5 rounded-full bg-warning/10 px-1.5 text-[10px] font-semibold text-warning transition-colors hover:bg-warning/15"
                        title={`${behind} incoming collaborator snapshot${behind !== 1 ? "s" : ""}`}
                      >
                        <ArrowDown className="h-2.5 w-2.5" />
                        {behind}
                      </button>
                      {incomingPreview}
                    </div>
                  )}
                </div>
              )}
            </div>
          )}

          {hasLegacyMasterTimeline && (
            <div className="mt-1.5 rounded-lg border border-[rgb(var(--color-warning))]/30 bg-[rgb(var(--color-warning))]/10 p-2 text-[10px] leading-snug text-[rgb(var(--color-text))]">
              <div className="flex min-w-0 items-start gap-2">
                <GitBranch className="mt-0.5 h-3 w-3 shrink-0 text-[rgb(var(--color-warning))]" />
                <div className="min-w-0 flex-1">
                  <div className="font-medium">Legacy Draftline branch name detected</div>
                  <div className="mt-0.5 text-[rgb(var(--color-text-secondary))]">
                    The real branch is <code className="rounded bg-[rgb(var(--color-surface))]/80 px-1">master</code>.
                    Rename it to <code className="rounded bg-[rgb(var(--color-surface))]/80 px-1">main</code> at the source instead of hiding it.
                  </div>
                  <button
                    type="button"
                    onClick={handleRenameMaster}
                    disabled={renamingMaster}
                    className="mt-1.5 rounded-md border border-[rgb(var(--color-warning))]/30 bg-[rgb(var(--color-surface))] px-2 py-1 font-medium text-[rgb(var(--color-text))] transition-colors hover:border-[rgb(var(--color-warning))]/60 hover:bg-[rgb(var(--color-warning))]/10 disabled:pointer-events-none disabled:opacity-60"
                  >
                    {renamingMaster ? "Renaming..." : confirmRenameMaster ? "Confirm rename master to main" : "Rename master to main"}
                  </button>
                </div>
              </div>
            </div>
          )}
        </div>
      )}

      {changesExpanded && (
        <div className={`${changesBodyClass} px-1 py-1`}>
          {filteredChangedFiles.length === 0 ? (
            <div className="flex items-center gap-2 px-2 py-3 text-[10px] text-[rgb(var(--color-text-secondary))]">
              <Camera className="h-3.5 w-3.5 opacity-40" />
              <span>
                {selectedProjectFilter
                  ? `No changes in ${selectedProjectFilter.name}${otherChangeCount > 0 ? ` (${otherChangeCount} elsewhere)` : ""}`
                  : "No workspace changes since last snapshot"}
              </span>
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
      />

      {historyExpanded && (
        <div className="flex min-w-0 shrink-0 items-center gap-1 border-b border-[rgb(var(--color-border))] px-3 py-1">
          <div className="min-w-0 flex-1">
            <TimelineSelector />
          </div>
          <button
            onClick={openFullHistoryGraph}
            className="grid h-6 w-6 shrink-0 place-items-center rounded-md text-[rgb(var(--color-text-secondary))] transition-colors hover:bg-[rgb(var(--color-surface-alt))] hover:text-[rgb(var(--color-accent))]"
            title="Open full history graph"
          >
            <GitBranch className="h-3 w-3" />
          </button>
          <button
            onClick={() => {
              setShowSearch(!showSearch);
              if (showSearch) setSearchQuery("");
            }}
            className={`grid h-6 w-6 shrink-0 place-items-center rounded-md transition-colors ${showSearch ? "text-[rgb(var(--color-accent))] bg-[rgb(var(--color-accent))]/10" : "text-[rgb(var(--color-text-secondary))] hover:bg-[rgb(var(--color-surface-alt))] hover:text-[rgb(var(--color-text))]"}`}
            title="Search snapshots"
          >
            <Search className="h-3 w-3" />
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
        <div className={historyBodyClass}>
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
      {confirmationDialog}
    </div>
  );
}

function useAnchoredPopover(
  open: boolean,
  triggerRef: RefObject<HTMLElement | null>,
  width: number,
  align: "left" | "right",
): CSSProperties | null {
  const [style, setStyle] = useState<CSSProperties | null>(null);

  useLayoutEffect(() => {
    if (!open) return;
    const updatePosition = () => {
      const trigger = triggerRef.current;
      if (!trigger) return;
      const rect = trigger.getBoundingClientRect();
      const preferredLeft = align === "right" ? rect.right - width : rect.left;
      const left = Math.min(preferredLeft, window.innerWidth - width - 8);
      setStyle({
        position: "fixed",
        left: Math.max(8, left),
        top: rect.bottom + 4,
        width,
      });
    };

    updatePosition();
    window.addEventListener("resize", updatePosition);
    window.addEventListener("scroll", updatePosition, true);
    return () => {
      window.removeEventListener("resize", updatePosition);
      window.removeEventListener("scroll", updatePosition, true);
    };
  }, [align, open, triggerRef, width]);

  return open ? style : null;
}

function WorkspaceModeBadge({ remote, syncError }: { remote: boolean; syncError: string | null }) {
  const degraded = remote && !!syncError;
  const label = remote ? (degraded ? "Remote issue" : "Remote") : "Local";
  const toneClass = degraded
    ? "border-warning/20 bg-warning/10 text-warning"
    : remote
      ? "border-success/20 bg-success/10 text-success"
      : "border-[rgb(var(--color-border))] bg-[rgb(var(--color-surface-alt))] text-[rgb(var(--color-text-secondary))]";
  const dotClass = degraded
    ? "bg-warning"
    : remote
      ? "bg-success"
      : "bg-[rgb(var(--color-text-secondary))]/50";
  const title = degraded
    ? `Remote project, but sync needs attention: ${syncError}`
    : remote
      ? "Remote project: collaboration controls are available"
      : "Local project: changes are saved locally. Add a remote in Settings to collaborate.";

  return (
    <span
      className={`flex h-5 shrink-0 items-center gap-1 rounded-full border px-1.5 text-[9px] font-medium ${toneClass}`}
      title={title}
    >
      <span className={`h-1.5 w-1.5 rounded-full ${dotClass}`} />
      <span className="hidden min-[250px]:inline">{label}</span>
    </span>
  );
}

function OutgoingPreview({ count, style }: { count: number; style?: CSSProperties }) {
  return (
    <div
      style={style}
      className={`${style ? "z-[var(--z-overlay)]" : "absolute left-0 top-full z-dropdown mt-1 w-64"} rounded-lg border border-[rgb(var(--color-border))] bg-[rgb(var(--color-surface))] shadow-lg`}
    >
      <div className="py-1">
        <div className="px-2 pb-1 text-[10px] font-semibold uppercase tracking-wider text-[rgb(var(--color-text-secondary))]">
          Outgoing work
        </div>
        <div className="border-t border-[rgb(var(--color-border))]/60 px-2 py-1.5">
          <div className="text-[11px] font-medium text-[rgb(var(--color-text))]">
            {count} snapshot{count === 1 ? "" : "s"} ready to share
          </div>
          <div className="mt-0.5 text-[9px] leading-relaxed text-[rgb(var(--color-text-secondary))]">
            Use Sync to publish this project's updates.
          </div>
        </div>
      </div>
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
        <span className="shrink-0 truncate">{title}</span>
        {scope && (
          <span
            className="min-w-0 max-w-full shrink truncate rounded-full border border-[rgb(var(--color-border))] px-1.5 py-0 text-left text-[9px] font-medium normal-case tracking-normal text-[rgb(var(--color-text-secondary))]/80"
            title={scopeTitle}
          >
            {scope}
          </span>
        )}
        {count !== undefined && count > 0 && (
          <span className="ml-1 shrink-0 rounded-full bg-[rgb(var(--color-accent))]/15 px-1 py-0 text-[9px] font-medium text-[rgb(var(--color-accent))]">
            {count}
          </span>
        )}
      </button>
      <div className="flex min-w-0 max-w-[58%] shrink items-center justify-end gap-1 overflow-hidden">{actions}</div>
    </div>
  );
}

function getPathBasename(path: string): string {
  return path.split(/[\\/]/).filter(Boolean).pop() ?? path;
}

function normalizeProjectPath(path: string | undefined): string {
  return (path ?? "").replace(/\\/g, "/").replace(/\/+$/, "").toLowerCase();
}

function fileBelongsToProject(filePath: string, projectPath: string): boolean {
  const normalizedProjectPath = normalizeProjectPath(projectPath).replace(/^\.\//, "");
  if (!normalizedProjectPath || normalizedProjectPath === ".") return true;
  const normalizedFilePath = normalizeProjectPath(filePath).replace(/^\.\//, "");
  return normalizedFilePath === normalizedProjectPath || normalizedFilePath.startsWith(`${normalizedProjectPath}/`);
}

function isDatabasePath(path: string): boolean {
  return /\.(db|sqlite|sqlite3)$/i.test(path);
}

function FileGroup({ label, files, icon }: { label: string; files: DiffEntry[]; icon: ReactNode }) {
  const openTab = useAppStore((s) => s.openTab);
  const openDatabase = useAppStore((s) => s.openDatabase);
  const discardFile = useAppStore((s) => s.discardFile);
  const { confirm, confirmationDialog } = useConfirmDialog();

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
                onClick={() => {
                  if (isDatabasePath(file.path) && file.status !== "deleted") {
                    openDatabase(file.path);
                  } else {
                    openTab({ type: "diff", path: file.path, title: `${filename} (diff)` });
                  }
                }}
                className="flex min-w-0 flex-1 cursor-pointer items-center gap-2 px-3 py-1.5 text-left"
                title={isDatabasePath(file.path) && file.status !== "deleted" ? `View database: ${file.path}` : `View diff: ${file.path}`}
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
                onClick={async () => {
                  const confirmed = await confirm({
                    title: "Discard file changes?",
                    message: `Restore ${file.path} to the last saved snapshot? Unsaved edits to this file will be lost.`,
                    confirmLabel: "Discard file",
                    variant: "error",
                  });
                  if (confirmed) await discardFile(file.path);
                }}
                className="shrink-0 rounded p-0.5 text-[rgb(var(--color-text-secondary))] opacity-0 transition-colors hover:text-error group-hover:opacity-100"
                title={`Discard changes to ${file.path}`}
              >
                <X className="h-3 w-3" />
              </button>
            </div>
          );
        })}
      </div>
      {confirmationDialog}
    </div>
  );
}
