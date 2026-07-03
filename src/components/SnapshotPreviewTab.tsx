import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  AudioLines,
  Camera,
  ChevronDown,
  FileDiff,
  FileText,
  FolderOpen,
  GitBranch,
  Image,
  NotebookPen,
  RotateCcw,
  Sparkles,
  SquarePen,
} from "lucide-react";
import { snapshotDiffTabPath } from "./DiffViewer";
import {
  previewDraftlineVersion,
  previewDraftlineVersionFile,
  previewDraftlineWorkspaceFile,
  isDraftlineVariationCreateConflictError,
  type DraftlinePreviewFile,
  type DraftlineVariationCreatePreflight,
} from "../services/draftlineVersioning";
import { useAppStore } from "../stores/appStore";
import type { DiffEntry } from "../types/sketch";
import type { ProjectEntry, ProjectView } from "../types/project";

interface SnapshotPreviewTabProps {
  snapshotId: string;
}

type ChangeKind = "sketch" | "storyboard" | "note" | "visual" | "narration" | "asset" | "other";
type FileDetailState =
  | { status: "loading" }
  | { status: "ready"; bullets: string[]; context: string }
  | { status: "error"; message: string };

function fileDetailKey(snapshotId: string, path: string) {
  return `${snapshotId}\u0000${path}`;
}

function detailPanelId(snapshotId: string, path: string) {
  return `snapshot-detail-${snapshotId}-${path}`.replace(/[^A-Za-z0-9_-]/g, "-");
}

const KIND_LABELS: Record<ChangeKind, string> = {
  sketch: "Sketches",
  storyboard: "Storyboards",
  note: "Notes",
  visual: "Visuals",
  narration: "Narrations",
  asset: "Assets",
  other: "Other files",
};

const KIND_ICONS: Record<ChangeKind, typeof SquarePen> = {
  sketch: SquarePen,
  storyboard: Camera,
  note: NotebookPen,
  visual: Sparkles,
  narration: AudioLines,
  asset: Image,
  other: FileText,
};

export function SnapshotPreviewTab({ snapshotId }: SnapshotPreviewTabProps) {
  const projects = useAppStore((s) => s.projects);
  const currentProject = useAppStore((s) => s.currentProject);
  const isMultiProject = useAppStore((s) => s.isMultiProject);
  const graphNodes = useAppStore((s) => s.graphNodes);
  const timelines = useAppStore((s) => s.timelines);
  const isDirty = useAppStore((s) => s.isDirty);
  const changedFiles = useAppStore((s) => s.changedFiles);
  const startTimelineFromSnapshot = useAppStore((s) => s.startTimelineFromSnapshot);
  const checkoutRemoteTimeline = useAppStore((s) => s.checkoutRemoteTimeline);
  const openTab = useAppStore((s) => s.openTab);

  const [entries, setEntries] = useState<DiffEntry[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [projectFilter, setProjectFilter] = useState("all");
  const [newTimelineName, setNewTimelineName] = useState("");
  const [restoreError, setRestoreError] = useState<string | null>(null);
  const [restoreConflict, setRestoreConflict] = useState<DraftlineVariationCreatePreflight | null>(null);
  const [restoring, setRestoring] = useState(false);
  const [restoreMenuOpen, setRestoreMenuOpen] = useState(false);
  const [expandedPath, setExpandedPath] = useState<string | null>(null);
  const [fileDetails, setFileDetails] = useState<Record<string, FileDetailState>>({});
  const snapshot = graphNodes.find((node) => node.id === snapshotId);
  const activeTimeline = timelines.find((timeline) => timeline.is_active);
  const selectedProject = projectFilter === "all"
    ? null
    : projects.find((project) => project.path === projectFilter) ?? null;
  const activeProjectPath = useMemo(() => activeProjectScope(currentProject), [currentProject]);
  const workspaceChangeSignature = useMemo(
    () => changedFiles
      .map((entry) => `${entry.path}:${entry.status}:${entry.additions}:${entry.deletions}`)
      .sort()
      .join("|"),
    [changedFiles],
  );

  useEffect(() => {
    let cancelled = false;
    setEntries(null);
    setError(null);
    setExpandedPath(null);
    setFileDetails({});
    previewDraftlineVersion(snapshotId)
      .then((result) => {
        if (!cancelled) setEntries(result);
      })
      .catch((err) => {
        if (!cancelled) setError(String(err));
      });
    return () => {
      cancelled = true;
    };
  }, [snapshotId, workspaceChangeSignature]);

  useEffect(() => {
    if (projectFilter === "all") return;
    if (!projects.some((project) => project.path === projectFilter)) {
      setProjectFilter("all");
    }
  }, [projectFilter, projects]);

  useEffect(() => {
    const base = snapshot?.message?.trim() || snapshotId.slice(0, 7);
    setNewTimelineName(branchNameFromSnapshot(base, snapshotId));
  }, [snapshot?.message, snapshotId]);

  const filteredEntries = useMemo(() => {
    if (!entries) return [];
    if (!selectedProject) return entries;
    return entries.filter((entry) => fileBelongsToProject(entry.path, selectedProject.path, activeProjectPath, projects));
  }, [activeProjectPath, entries, projects, selectedProject]);

  const groups = useMemo(() => groupEntries(filteredEntries), [filteredEntries]);
  const projectCounts = useMemo(
    () => projects.map((project) => ({
      project,
      count: entries?.filter((entry) => fileBelongsToProject(entry.path, project.path, activeProjectPath, projects)).length ?? 0,
    })),
    [activeProjectPath, entries, projects],
  );

  const totalAdded = filteredEntries.reduce((sum, entry) => sum + entry.additions, 0);
  const totalRemoved = filteredEntries.reduce((sum, entry) => sum + entry.deletions, 0);
  const restoreDisabled = restoring || isDirty || !newTimelineName.trim();

  const handleRestore = useCallback(async () => {
    if (restoreDisabled) return;
    setRestoring(true);
    setRestoreError(null);
    try {
      const name = newTimelineName.trim();
      const collides = timelines.some((timeline) => timeline.name === name || timeline.label === name);
      if (collides) {
        setRestoreError(`Branch "${name}" already exists. Choose a different branch name.`);
        return;
      }
      await startTimelineFromSnapshot(snapshotId, name);
      setRestoreConflict(null);
      setEntries(await previewDraftlineVersion(snapshotId));
      setExpandedPath(null);
      setFileDetails({});
      setRestoreMenuOpen(false);
    } catch (err) {
      if (isDraftlineVariationCreateConflictError(err)) {
        setRestoreConflict(err.preflight);
        setRestoreMenuOpen(true);
        return;
      }
      setRestoreError(`Restore failed: ${err}`);
    } finally {
      setRestoring(false);
    }
  }, [
    newTimelineName,
    restoreDisabled,
    startTimelineFromSnapshot,
    snapshotId,
    timelines,
  ]);

  const handleAdoptRestoreConflict = useCallback(async () => {
    if (!restoreConflict) return;
    setRestoring(true);
    setRestoreError(null);
    try {
      await checkoutRemoteTimeline(restoreConflict.variation);
      setRestoreConflict(null);
      setRestoreMenuOpen(false);
    } catch (err) {
      setRestoreError(`Adopt failed: ${err}`);
    } finally {
      setRestoring(false);
    }
  }, [checkoutRemoteTimeline, restoreConflict]);

  const handleOpenFileDiff = useCallback((entry: DiffEntry) => {
    openTab({
      type: "diff",
      path: snapshotDiffTabPath(snapshotId, entry.path),
      title: `${displayName(entry.path)} diff`,
    });
  }, [openTab, snapshotId]);

  const handleToggleFile = useCallback((entry: DiffEntry) => {
    const nextPath = expandedPath === entry.path ? null : entry.path;
    setExpandedPath(nextPath);
    if (!nextPath) return;

    const key = fileDetailKey(snapshotId, entry.path);
    if (fileDetails[key]) return;

    setFileDetails((details) => details[key] ? details : { ...details, [key]: { status: "loading" } });
    Promise.all([
      previewDraftlineVersionFile(snapshotId, entry.path),
      previewDraftlineWorkspaceFile(entry.path),
    ])
      .then(([snapshotFile, workspaceFile]) => {
        setFileDetails((details) => ({
          ...details,
          [key]: summarizePreviewFile(entry, snapshotFile, workspaceFile),
        }));
      })
      .catch((error: unknown) => {
        setFileDetails((details) => ({
          ...details,
          [key]: {
            status: "error",
            message: error instanceof Error ? error.message : "Unable to load file preview details.",
          },
        }));
      });
  }, [expandedPath, fileDetails, snapshotId]);

  return (
    <div className="flex h-full min-h-0 flex-col bg-[rgb(var(--color-surface))]">
      <div className="document-header shrink-0 border-b border-[rgb(var(--color-border))] bg-[rgb(var(--color-surface))] px-4 py-2">
        <div className="flex min-w-0 flex-wrap items-start gap-3">
          <div className="mt-1 flex h-6 w-6 shrink-0 items-center justify-center text-[rgb(var(--color-text-secondary))]">
            <RotateCcw className="h-4 w-4" />
          </div>
          <div className="min-w-[14rem] flex-1">
            <div className="flex min-w-0 items-center gap-2">
              <h1 className="truncate text-sm font-semibold text-[rgb(var(--color-text))]">
                {snapshot?.message ?? snapshotId.slice(0, 7)}
              </h1>
              <span className="shrink-0 rounded px-1.5 py-0.5 text-[10px] font-medium uppercase tracking-wider text-[rgb(var(--color-accent))]">
                Snapshot Preview
              </span>
            </div>
            <div className="mt-0.5 flex min-w-0 flex-wrap items-center gap-2 text-[11px] text-[rgb(var(--color-text-secondary))]">
              <span className="font-mono">{snapshotId.slice(0, 10)}</span>
              {snapshot?.author && <span>by {snapshot.author}</span>}
              {snapshot?.timestamp && <span>{formatDate(snapshot.timestamp)}</span>}
              {activeTimeline && <span>Current branch: {activeTimeline.label}</span>}
            </div>
          </div>
          <div className="ml-auto flex max-w-full shrink-0 flex-wrap justify-end gap-1 rounded-lg border border-[rgb(var(--color-border))] bg-[rgb(var(--color-surface))]/80 p-1">
            <label className="min-w-[150px] max-w-[220px] flex-1 sm:flex-none">
              <span className="sr-only">Project filter</span>
              <select
                value={projectFilter}
                onChange={(event) => setProjectFilter(event.target.value)}
                className="h-7 w-full rounded-md border border-transparent bg-[rgb(var(--color-surface-alt))] px-2 text-[11px] text-[rgb(var(--color-text))] outline-none transition-colors hover:border-[rgb(var(--color-border))] focus:border-[rgb(var(--color-accent))]"
                title="Filter preview changes by project"
              >
                <option value="all">All Projects ({entries?.length ?? 0})</option>
                {isMultiProject && projectCounts.map(({ project, count }) => (
                  <option key={project.path} value={project.path}>{project.name} ({count})</option>
                ))}
              </select>
            </label>
            <div className="inline-flex h-7 shrink-0 items-center gap-1.5 rounded-md bg-[rgb(var(--color-surface-alt))] px-2 text-[11px]">
              <span className="font-medium text-[rgb(var(--color-text))]">{filteredEntries.length}</span>
              <span className="hidden text-[rgb(var(--color-text-secondary))] sm:inline">files</span>
              <span className="text-success">+{totalAdded}</span>
              <span className="text-error">-{totalRemoved}</span>
            </div>
            <RestoreControls
              activeTimelineLabel={activeTimeline?.label ?? "current branch"}
              isDirty={isDirty}
              menuOpen={restoreMenuOpen}
              newTimelineName={newTimelineName}
              onMenuOpenChange={setRestoreMenuOpen}
              onNewTimelineNameChange={(value) => {
                setRestoreConflict(null);
                setNewTimelineName(value);
              }}
              onRestore={handleRestore}
              onAdoptConflict={handleAdoptRestoreConflict}
              onCancelConflict={() => {
                setRestoreConflict(null);
                setRestoreMenuOpen(false);
              }}
              onUseConflictSuggestion={(name) => {
                setRestoreConflict(null);
                setNewTimelineName(name);
              }}
              restoreConflict={restoreConflict}
              restoreDisabled={restoreDisabled}
              restoring={restoring}
              snapshotLabel={snapshot?.message ?? snapshotId.slice(0, 7)}
            />
          </div>
        </div>
        {restoreError && (
          <div className="mt-2 rounded-lg border border-error/20 bg-error/5 px-2 py-1.5 text-[11px] text-error">
            {restoreError}
          </div>
        )}
      </div>

      <div className="min-h-0 flex-1 overflow-y-auto px-5 py-4">
        {error ? (
          <div className="rounded-xl border border-error/20 bg-error/5 px-4 py-3 text-sm text-error">
            Snapshot preview failed: {error}
          </div>
        ) : !entries ? (
          <div className="rounded-xl border border-[rgb(var(--color-border))] bg-[rgb(var(--color-surface-alt))] px-4 py-6 text-center text-sm text-[rgb(var(--color-text-secondary))]">
            Loading snapshot preview...
          </div>
        ) : filteredEntries.length === 0 ? (
          <div className="rounded-xl border border-[rgb(var(--color-border))] bg-[rgb(var(--color-surface-alt))] px-4 py-6 text-center text-sm text-[rgb(var(--color-text-secondary))]">
            <div className="font-medium text-[rgb(var(--color-text))]">
              {selectedProject ? "No changes match this project filter." : "This snapshot matches the current workspace."}
            </div>
            <div className="mx-auto mt-1 max-w-lg text-xs leading-relaxed">
              {selectedProject
                ? "Switch back to All Projects, or open a snapshot that differs from the current workspace."
                : "To test the changed-items list, open an older snapshot after saving newer work, or make a small workspace change and preview the previous snapshot."}
            </div>
          </div>
        ) : (
          <div className="space-y-3">
            {(Object.entries(groups) as [ChangeKind, DiffEntry[]][]).map(([kind, items]) => (
              items.length > 0 && (
                <SemanticGroup
                  key={kind}
                  kind={kind}
                  entries={items}
                  expandedPath={expandedPath}
                  fileDetails={fileDetails}
                  onOpenFileDiff={handleOpenFileDiff}
                  onToggleFile={handleToggleFile}
                  activeProjectPath={activeProjectPath}
                  projects={projects}
                  snapshotId={snapshotId}
                />
              )
            ))}
          </div>
        )}
      </div>
    </div>
  );
}

function RestoreControls({
  activeTimelineLabel,
  isDirty,
  menuOpen,
  newTimelineName,
  onMenuOpenChange,
  onNewTimelineNameChange,
  onAdoptConflict,
  onCancelConflict,
  onRestore,
  onUseConflictSuggestion,
  restoreConflict,
  restoreDisabled,
  restoring,
  snapshotLabel,
}: {
  activeTimelineLabel: string;
  isDirty: boolean;
  menuOpen: boolean;
  newTimelineName: string;
  onMenuOpenChange: (open: boolean) => void;
  onNewTimelineNameChange: (value: string) => void;
  onAdoptConflict: () => void;
  onCancelConflict: () => void;
  onRestore: () => void;
  onUseConflictSuggestion: (name: string) => void;
  restoreConflict: DraftlineVariationCreatePreflight | null;
  restoreDisabled: boolean;
  restoring: boolean;
  snapshotLabel: string;
}) {
  const ref = useRef<HTMLDivElement>(null);
  const [confirming, setConfirming] = useState(false);
  const targetLabel = newTimelineName.trim() || "new branch";

  useEffect(() => {
    if (!menuOpen) {
      setConfirming(false);
      return;
    }
    const onPointerDown = (event: MouseEvent) => {
      if (ref.current && !ref.current.contains(event.target as Node)) {
        onMenuOpenChange(false);
      }
    };
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") onMenuOpenChange(false);
    };
    document.addEventListener("mousedown", onPointerDown);
    document.addEventListener("keydown", onKeyDown);
    return () => {
      document.removeEventListener("mousedown", onPointerDown);
      document.removeEventListener("keydown", onKeyDown);
    };
  }, [menuOpen, onMenuOpenChange]);

  return (
    <div ref={ref} className="relative shrink-0">
      <button
        type="button"
        onClick={() => onMenuOpenChange(!menuOpen)}
        disabled={isDirty || restoring}
        className="inline-flex h-8 items-center justify-center gap-1.5 rounded-lg bg-[rgb(var(--color-accent))] px-3 text-[11px] font-semibold text-[rgb(var(--color-accent-fg))] transition-colors hover:bg-[rgb(var(--color-accent-hover))] disabled:cursor-not-allowed disabled:opacity-45"
        title={isDirty ? "Save or discard workspace changes before starting a branch from this snapshot" : "Create a branch from this preview and switch to it"}
        aria-haspopup="dialog"
        aria-expanded={menuOpen}
      >
        <RotateCcw className="h-3.5 w-3.5" />
        {restoring ? "Starting..." : "Start Branch from Here"}
        <ChevronDown className={`h-3 w-3 transition-transform ${menuOpen ? "rotate-180" : ""}`} />
      </button>

      {menuOpen && (
        <div
          role="dialog"
          aria-label="Restore snapshot"
          className="absolute right-0 top-full z-dropdown mt-1 w-[360px] max-w-[calc(100vw-2rem)] overflow-hidden rounded-xl border border-[rgb(var(--color-border))] bg-[rgb(var(--color-surface))] p-2 shadow-xl"
        >
          <div className="mb-2 rounded-lg bg-[rgb(var(--color-surface-alt))] px-3 py-2 text-[11px] text-[rgb(var(--color-text-secondary))]">
            <GitBranch className="mr-1.5 inline h-3.5 w-3.5 align-[-2px]" />
            You are previewing <span className="font-medium text-[rgb(var(--color-text))]">{snapshotLabel}</span>. To write from it,
            CutReady creates branch <span className="font-medium text-[rgb(var(--color-text))]">{targetLabel}</span> and switches there. Your first edit will be dirty until you save a named snapshot.
          </div>
          <label>
            <span className="mb-1 block text-[10px] font-medium uppercase tracking-wider text-[rgb(var(--color-text-secondary))]">
              New branch name
            </span>
            <input
              value={newTimelineName}
              onChange={(event) => {
                setConfirming(false);
                onNewTimelineNameChange(event.target.value);
              }}
              placeholder="branch-name"
              className="h-8 w-full rounded-lg border border-[rgb(var(--color-border))] bg-[rgb(var(--color-surface-alt))] px-2 text-[12px] text-[rgb(var(--color-text))] outline-none placeholder:text-[rgb(var(--color-text-secondary))]/50 focus:border-[rgb(var(--color-accent))]"
            />
          </label>
          <div className="mt-2 rounded-lg border border-[rgb(var(--color-border))] bg-[rgb(var(--color-surface-alt))]/60 px-3 py-2 text-[10px] leading-relaxed text-[rgb(var(--color-text-secondary))]">
            Current branch <span className="font-medium text-[rgb(var(--color-text))]">{activeTimelineLabel}</span> stays untouched. Save later asks for the snapshot name.
          </div>
          {restoreConflict && (
            <SnapshotBranchConflictPanel
              preflight={restoreConflict}
              onUseSuggestion={onUseConflictSuggestion}
              onAdopt={onAdoptConflict}
              onCancel={onCancelConflict}
            />
          )}
          {isDirty && (
            <div className="mt-2 text-[10px] text-warning">
              Save or discard current workspace changes before starting from this preview.
            </div>
          )}
          <button
            onClick={() => {
              if (!confirming) {
                setConfirming(true);
                return;
              }
              onMenuOpenChange(false);
              void onRestore();
            }}
            disabled={restoreDisabled}
            className="mt-3 inline-flex h-8 w-full items-center justify-center gap-1.5 rounded-lg bg-[rgb(var(--color-accent))] px-3 text-[11px] font-semibold text-[rgb(var(--color-accent-fg))] transition-colors hover:bg-[rgb(var(--color-accent-hover))] disabled:pointer-events-none disabled:opacity-45"
            title={isDirty ? "Save or discard workspace changes before starting from this preview" : "Create a branch and switch to it"}
          >
            {restoring ? "Starting..." : confirming ? "Confirm Start Branch" : "Create Branch"}
          </button>
        </div>
      )}
    </div>
  );
}

function SnapshotBranchConflictPanel({
  preflight,
  onUseSuggestion,
  onAdopt,
  onCancel,
}: {
  preflight: DraftlineVariationCreatePreflight;
  onUseSuggestion: (name: string) => void;
  onAdopt: () => void;
  onCancel: () => void;
}) {
  const remote = preflight.remote ?? "remote";
  const canAdopt = preflight.remote_collision || preflight.remote_only_collision;
  const message = canAdopt
    ? `${remote}/${preflight.variation} already exists${preflight.existing_remote_head?.label ? ` at "${preflight.existing_remote_head.label}"` : ""}.`
    : `Branch "${preflight.variation}" already exists locally.`;

  return (
    <div className="mt-2 rounded-lg border border-warning/25 bg-warning/5 px-3 py-2 text-[10px] leading-relaxed text-[rgb(var(--color-text-secondary))]">
      <div className="font-medium text-warning">{message}</div>
      <div className="mt-1">Rename this branch, adopt the remote branch, or cancel starting from this snapshot.</div>
      <div className="mt-2 flex flex-wrap items-center gap-1.5">
        {preflight.suggested_alternative && (
          <button
            type="button"
            onClick={() => onUseSuggestion(preflight.suggested_alternative!)}
            className="rounded-md border border-[rgb(var(--color-border))] bg-[rgb(var(--color-surface))] px-2 py-1 font-medium text-[rgb(var(--color-text))] hover:bg-[rgb(var(--color-surface-alt))]"
          >
            Use {preflight.suggested_alternative}
          </button>
        )}
        {canAdopt && (
          <button
            type="button"
            onClick={onAdopt}
            className="rounded-md bg-[rgb(var(--color-accent))] px-2 py-1 font-medium text-[rgb(var(--color-accent-fg))] hover:bg-[rgb(var(--color-accent-hover))]"
          >
            Adopt and switch
          </button>
        )}
        <button
          type="button"
          onClick={onCancel}
          className="rounded-md px-2 py-1 font-medium text-[rgb(var(--color-text-secondary))] hover:text-[rgb(var(--color-text))]"
        >
          Cancel
        </button>
      </div>
    </div>
  );
}

function SemanticGroup({
  kind,
  entries,
  expandedPath,
  fileDetails,
  onOpenFileDiff,
  onToggleFile,
  activeProjectPath,
  projects,
  snapshotId,
}: {
  kind: ChangeKind;
  entries: DiffEntry[];
  expandedPath: string | null;
  fileDetails: Record<string, FileDetailState>;
  onOpenFileDiff: (entry: DiffEntry) => void;
  onToggleFile: (entry: DiffEntry) => void;
  activeProjectPath: string | null;
  projects: ProjectEntry[];
  snapshotId: string;
}) {
  const Icon = KIND_ICONS[kind];
  return (
    <section className="overflow-hidden rounded-xl border border-[rgb(var(--color-border))] bg-[rgb(var(--color-surface-alt))]">
      <div className="flex items-center justify-between border-b border-[rgb(var(--color-border))] px-3 py-2">
        <div className="flex items-center gap-2 text-sm font-semibold text-[rgb(var(--color-text))]">
          <Icon className="h-4 w-4 text-[rgb(var(--color-accent))]" />
          {KIND_LABELS[kind]}
        </div>
        <span className="rounded-full bg-[rgb(var(--color-accent))]/10 px-2 py-0.5 text-[10px] font-medium text-[rgb(var(--color-accent))]">
          {entries.length}
        </span>
      </div>
      <div className="divide-y divide-[rgb(var(--color-border))] bg-[rgb(var(--color-surface))]">
        {entries.map((entry) => {
          const project = projectForPath(entry.path, projects, activeProjectPath);
          const expanded = expandedPath === entry.path;
          const detail = fileDetails[fileDetailKey(snapshotId, entry.path)];
          const detailsId = detailPanelId(snapshotId, entry.path);
          return (
            <div key={entry.path} className="group">
              <button
                type="button"
                onClick={() => onToggleFile(entry)}
                className="flex w-full min-w-0 items-center gap-3 px-3 py-2.5 text-left transition-colors hover:bg-[rgb(var(--color-surface-alt))]"
                title={expanded ? "Hide file change details" : "Show file change details"}
                aria-expanded={expanded}
                aria-controls={detailsId}
              >
                <ChevronDown className={`h-3.5 w-3.5 shrink-0 text-[rgb(var(--color-text-secondary))] transition-transform ${expanded ? "" : "-rotate-90"}`} />
                <StatusDot status={entry.status} />
                <div className="min-w-0 flex-1">
                  <div className="flex min-w-0 items-center gap-2">
                    <div className="truncate text-sm font-medium text-[rgb(var(--color-text))]">{displayName(entry.path)}</div>
                    <StatusBadge status={entry.status} />
                    {project && (
                      <span className="hidden shrink-0 items-center gap-1 rounded-full border border-[rgb(var(--color-border))] px-1.5 py-0.5 text-[9px] text-[rgb(var(--color-text-secondary))] sm:inline-flex">
                        <FolderOpen className="h-3 w-3" />
                        {project.name}
                      </span>
                    )}
                  </div>
                  <div className="mt-0.5 truncate text-[11px] text-[rgb(var(--color-text-secondary))]">
                    {businessSummary(entry.path, kind)}
                  </div>
                  <div className="mt-0.5 truncate font-mono text-[10px] text-[rgb(var(--color-text-secondary))]/70">{entry.path}</div>
                </div>
                <ChangeStats entry={entry} />
                <span className="hidden shrink-0 text-[10px] font-medium text-[rgb(var(--color-accent))] opacity-0 transition-opacity group-hover:opacity-100 md:inline">
                  Details
                </span>
              </button>
              {expanded && (
                <div id={detailsId} className="border-t border-[rgb(var(--color-border))]/70 bg-[rgb(var(--color-surface-alt))]/60 px-4 pb-3 pt-3 sm:pl-12">
                  <div className="grid gap-3 md:grid-cols-[minmax(0,1fr)_auto] md:items-start">
                    <div className="min-w-0">
                      <div className="text-xs font-medium text-[rgb(var(--color-text))]">
                        {businessSummary(entry.path, kind)}
                      </div>
                      <div className="mt-1 text-[11px] leading-relaxed text-[rgb(var(--color-text-secondary))]">
                        {detailContext(detail, entry, kind)}
                      </div>
                      <div className="mt-2 flex flex-wrap gap-1.5">
                        <StatusBadge status={entry.status} />
                        <span className="rounded-md border border-[rgb(var(--color-border))] bg-[rgb(var(--color-surface))] px-1.5 py-0.5 text-[10px] text-[rgb(var(--color-text-secondary))]">
                          {entry.additions} additions
                        </span>
                        <span className="rounded-md border border-[rgb(var(--color-border))] bg-[rgb(var(--color-surface))] px-1.5 py-0.5 text-[10px] text-[rgb(var(--color-text-secondary))]">
                          {entry.deletions} removals
                        </span>
                      </div>
                    </div>
                    <button
                      type="button"
                      onClick={() => onOpenFileDiff(entry)}
                      className="inline-flex h-8 shrink-0 items-center justify-center gap-1.5 rounded-lg border border-[rgb(var(--color-border))] bg-[rgb(var(--color-surface))] px-3 text-[11px] font-medium text-[rgb(var(--color-text))] transition-colors hover:border-[rgb(var(--color-accent))] hover:text-[rgb(var(--color-accent))]"
                    >
                      <FileDiff className="h-3.5 w-3.5" />
                      Open full diff
                    </button>
                  </div>
                  <div className="mt-2 rounded-lg border border-[rgb(var(--color-border))] bg-[rgb(var(--color-surface))] px-3 py-2">
                    <div className="mb-1 flex items-center justify-between gap-2">
                      <div className="text-[10px] font-semibold uppercase tracking-wider text-[rgb(var(--color-text-secondary))]">
                        Change summary
                      </div>
                      <div className="break-all text-right font-mono text-[10px] text-[rgb(var(--color-text-secondary))]/80">{entry.path}</div>
                    </div>
                    <DetailBullets detail={detail} />
                  </div>
                </div>
              )}
            </div>
          );
        })}
      </div>
    </section>
  );
}

function DetailBullets({ detail }: { detail?: FileDetailState }) {
  if (!detail || detail.status === "loading") {
    return (
      <div className="text-[11px] text-[rgb(var(--color-text-secondary))]">
        Loading file-specific preview...
      </div>
    );
  }
  if (detail.status === "error") {
    return (
      <div className="text-[11px] text-error">
        {detail.message}
      </div>
    );
  }
  return (
    <ul className="space-y-1 text-[11px] text-[rgb(var(--color-text-secondary))]">
      {detail.bullets.map((bullet) => (
        <li key={bullet} className="flex gap-2">
          <span className="mt-1 h-1.5 w-1.5 shrink-0 rounded-full bg-[rgb(var(--color-accent))]/70" />
          <span>{bullet}</span>
        </li>
      ))}
    </ul>
  );
}

function detailContext(detail: FileDetailState | undefined, entry: DiffEntry, kind: ChangeKind) {
  if (detail?.status === "ready") return detail.context;
  const artifact = KIND_DETAIL_LABELS[kind];
  const action = entry.status === "added"
    ? "would add"
    : entry.status === "deleted"
      ? "would remove"
      : "would update";
  return `Restoring this snapshot ${action} this ${artifact}.`;
}

const KIND_DETAIL_LABELS: Record<ChangeKind, string> = {
  sketch: "sketch",
  storyboard: "storyboard",
  note: "note",
  visual: "visual",
  narration: "narration",
  asset: "media reference",
  other: "file",
};

function summarizePreviewFile(
  entry: DiffEntry,
  snapshotFile: DraftlinePreviewFile | null,
  workspaceFile: DraftlinePreviewFile | null,
): FileDetailState {
  const kind = classifyPath(entry.path);
  const snapshotLabel = filePresenceLabel(snapshotFile);
  const workspaceLabel = filePresenceLabel(workspaceFile);
  const context = `Snapshot version: ${snapshotLabel}. Current workspace: ${workspaceLabel}.`;

  if (snapshotFile?.isBinary || workspaceFile?.isBinary) {
    return {
      status: "ready",
      context,
      bullets: [
        "Binary or media content cannot be summarized inline.",
        "Open the full diff to review the restore impact for this artifact.",
      ],
    };
  }

  const snapshotContent = snapshotFile?.content ?? null;
  const workspaceContent = workspaceFile?.content ?? null;
  const bullets = detailBulletsForKind(kind, snapshotContent, workspaceContent);

  return {
    status: "ready",
    context,
    bullets: bullets.length > 0 ? bullets : [
      "Content differs, but no CutReady-specific fields could be summarized.",
      textMetricSummary("Snapshot", snapshotContent),
      textMetricSummary("Workspace", workspaceContent),
    ],
  };
}

function filePresenceLabel(file: DraftlinePreviewFile | null) {
  if (!file) return "missing";
  if (file.isBinary) return "binary file present";
  return file.content === null ? "empty file present" : "text file present";
}

function detailBulletsForKind(kind: ChangeKind, snapshotContent: string | null, workspaceContent: string | null) {
  if (!snapshotContent && !workspaceContent) return [];
  switch (kind) {
    case "sketch":
      return sketchDetailBullets(snapshotContent, workspaceContent);
    case "storyboard":
      return storyboardDetailBullets(snapshotContent, workspaceContent);
    case "note":
      return noteDetailBullets(snapshotContent, workspaceContent);
    case "visual":
      return jsonDetailBullets(snapshotContent, workspaceContent, "Visual DSL");
    default:
      return genericTextDetailBullets(snapshotContent, workspaceContent);
  }
}

function sketchDetailBullets(snapshotContent: string | null, workspaceContent: string | null) {
  const snapshot = parseJsonRecord(snapshotContent);
  const workspace = parseJsonRecord(workspaceContent);
  if (!snapshot && !workspace) return genericTextDetailBullets(snapshotContent, workspaceContent);

  const bullets: string[] = [];
  pushFieldChange(bullets, "Title", readString(snapshot, "title"), readString(workspace, "title"));
  pushFieldChange(bullets, "State", readString(snapshot, "state"), readString(workspace, "state"));

  const snapshotRows = readArray(snapshot, "rows");
  const workspaceRows = readArray(workspace, "rows");
  pushCountChange(bullets, "Planning rows", snapshotRows.length, workspaceRows.length);
  pushCountChange(bullets, "Rows with screenshots", countRowsWithField(snapshotRows, "screenshot"), countRowsWithField(workspaceRows, "screenshot"));
  pushCountChange(bullets, "Rows with visuals", countRowsWithField(snapshotRows, "visual"), countRowsWithField(workspaceRows, "visual"));

  const changedRows = countChangedRows(snapshotRows, workspaceRows);
  if (changedRows > 0) bullets.push(`${changedRows} planning ${changedRows === 1 ? "row differs" : "rows differ"} by time, narration, actions, screenshot, or visual.`);

  if (JSON.stringify(snapshot?.description ?? null) !== JSON.stringify(workspace?.description ?? null)) {
    bullets.push("Sketch description content differs.");
  }
  return bullets;
}

function storyboardDetailBullets(snapshotContent: string | null, workspaceContent: string | null) {
  const snapshot = parseJsonRecord(snapshotContent);
  const workspace = parseJsonRecord(workspaceContent);
  if (!snapshot && !workspace) return genericTextDetailBullets(snapshotContent, workspaceContent);

  const bullets: string[] = [];
  pushFieldChange(bullets, "Title", readString(snapshot, "title"), readString(workspace, "title"));
  pushFieldChange(bullets, "Description", readString(snapshot, "description"), readString(workspace, "description"));

  const snapshotItems = readArray(snapshot, "items");
  const workspaceItems = readArray(workspace, "items");
  pushCountChange(bullets, "Storyboard items", snapshotItems.length, workspaceItems.length);
  pushCountChange(bullets, "Sections", countItemsByType(snapshotItems, "section"), countItemsByType(workspaceItems, "section"));
  pushCountChange(bullets, "Sketch references", countItemsByType(snapshotItems, "sketch_ref"), countItemsByType(workspaceItems, "sketch_ref"));
  if (JSON.stringify(snapshotItems) !== JSON.stringify(workspaceItems)) bullets.push("Storyboard ordering or section membership differs.");
  return bullets;
}

function noteDetailBullets(snapshotContent: string | null, workspaceContent: string | null) {
  const bullets = genericTextDetailBullets(snapshotContent, workspaceContent);
  const snapshotHeading = firstMarkdownHeading(snapshotContent);
  const workspaceHeading = firstMarkdownHeading(workspaceContent);
  pushFieldChange(bullets, "Top heading", snapshotHeading, workspaceHeading);
  pushCountChange(bullets, "Headings", countMarkdownHeadings(snapshotContent), countMarkdownHeadings(workspaceContent));
  pushCountChange(bullets, "Words", countWords(snapshotContent), countWords(workspaceContent));
  return bullets;
}

function jsonDetailBullets(snapshotContent: string | null, workspaceContent: string | null, label: string) {
  const snapshot = parseJsonRecord(snapshotContent);
  const workspace = parseJsonRecord(workspaceContent);
  if (!snapshot && !workspace) return genericTextDetailBullets(snapshotContent, workspaceContent);

  const bullets: string[] = [];
  const snapshotKeys = Object.keys(snapshot ?? {});
  const workspaceKeys = Object.keys(workspace ?? {});
  pushCountChange(bullets, `${label} top-level fields`, snapshotKeys.length, workspaceKeys.length);
  const changedKeys = [...new Set([...snapshotKeys, ...workspaceKeys])]
    .filter((key) => JSON.stringify(snapshot?.[key] ?? null) !== JSON.stringify(workspace?.[key] ?? null));
  if (changedKeys.length > 0) bullets.push(`Changed fields: ${changedKeys.slice(0, 6).join(", ")}${changedKeys.length > 6 ? "..." : ""}.`);
  return bullets;
}

function genericTextDetailBullets(snapshotContent: string | null, workspaceContent: string | null) {
  return [
    textMetricSummary("Snapshot", snapshotContent),
    textMetricSummary("Workspace", workspaceContent),
  ];
}

function textMetricSummary(label: string, content: string | null) {
  if (content === null) return `${label}: file is missing.`;
  const lines = content.length === 0 ? 0 : content.split(/\r?\n/).length;
  return `${label}: ${lines} ${lines === 1 ? "line" : "lines"}, ${content.length} characters.`;
}

function parseJsonRecord(content: string | null): Record<string, unknown> | null {
  if (!content) return null;
  try {
    const value: unknown = JSON.parse(content);
    return isRecord(value) ? value : null;
  } catch {
    return null;
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function readString(record: Record<string, unknown> | null, key: string) {
  const value = record?.[key];
  return typeof value === "string" ? value : null;
}

function readArray(record: Record<string, unknown> | null, key: string) {
  const value = record?.[key];
  return Array.isArray(value) ? value : [];
}

function pushFieldChange(bullets: string[], label: string, snapshotValue: string | null, workspaceValue: string | null) {
  if (snapshotValue === workspaceValue) return;
  bullets.push(`${label}: ${formatValue(workspaceValue)} -> ${formatValue(snapshotValue)} when restored.`);
}

function pushCountChange(bullets: string[], label: string, snapshotCount: number, workspaceCount: number) {
  if (snapshotCount === workspaceCount) return;
  bullets.push(`${label}: ${workspaceCount} -> ${snapshotCount} when restored.`);
}

function formatValue(value: string | null) {
  if (!value) return "none";
  return `"${value.length > 60 ? `${value.slice(0, 57)}...` : value}"`;
}

function countRowsWithField(rows: unknown[], field: string) {
  return rows.filter((row) => isRecord(row) && typeof row[field] === "string" && row[field].trim().length > 0).length;
}

function countChangedRows(snapshotRows: unknown[], workspaceRows: unknown[]) {
  const max = Math.max(snapshotRows.length, workspaceRows.length);
  let changed = 0;
  for (let index = 0; index < max; index += 1) {
    if (JSON.stringify(snapshotRows[index] ?? null) !== JSON.stringify(workspaceRows[index] ?? null)) changed += 1;
  }
  return changed;
}

function countItemsByType(items: unknown[], type: string) {
  return items.filter((item) => isRecord(item) && item.type === type).length;
}

function firstMarkdownHeading(content: string | null) {
  return content?.split(/\r?\n/).find((line) => /^#{1,6}\s+\S/.test(line))?.replace(/^#{1,6}\s+/, "") ?? null;
}

function countMarkdownHeadings(content: string | null) {
  if (!content) return 0;
  return content.split(/\r?\n/).filter((line) => /^#{1,6}\s+\S/.test(line)).length;
}

function countWords(content: string | null) {
  if (!content) return 0;
  const matches = content.match(/\S+/g);
  return matches ? matches.length : 0;
}

function StatusDot({ status }: { status: string }) {
  return (
    <span
      className={`h-2 w-2 shrink-0 rounded-full ${
        status === "added" ? "bg-success" : status === "deleted" ? "bg-error" : "bg-warning"
      }`}
      title={status}
    />
  );
}

function StatusBadge({ status }: { status: string }) {
  const className = status === "added"
    ? "bg-success/15 text-success"
    : status === "deleted"
      ? "bg-error/15 text-error"
      : "bg-warning/15 text-warning";
  return (
    <span className={`shrink-0 rounded px-1.5 py-0.5 text-[9px] font-medium uppercase tracking-wider ${className}`}>
      {statusLabel(status)}
    </span>
  );
}

function ChangeStats({ entry }: { entry: DiffEntry }) {
  return (
    <div className="flex shrink-0 items-center gap-1 text-[10px] font-medium">
      {entry.additions > 0 && <span className="text-success">+{entry.additions}</span>}
      {entry.deletions > 0 && <span className="text-error">-{entry.deletions}</span>}
      {entry.additions === 0 && entry.deletions === 0 && (
        <span className="text-[rgb(var(--color-text-secondary))]">{statusLabel(entry.status)}</span>
      )}
    </div>
  );
}

function statusLabel(status: string) {
  return status === "added" ? "Added" : status === "deleted" ? "Deleted" : "Modified";
}

function groupEntries(entries: DiffEntry[]): Record<ChangeKind, DiffEntry[]> {
  return entries.reduce<Record<ChangeKind, DiffEntry[]>>(
    (groups, entry) => {
      groups[classifyPath(entry.path)].push(entry);
      return groups;
    },
    { sketch: [], storyboard: [], note: [], visual: [], narration: [], asset: [], other: [] },
  );
}

function classifyPath(path: string): ChangeKind {
  const lower = path.toLowerCase();
  if (lower.endsWith(".sk")) return "sketch";
  if (lower.endsWith(".sb")) return "storyboard";
  if (lower.endsWith(".md")) return "note";
  if (lower.includes(".cutready/visuals/") || lower.endsWith(".elucim.json")) return "visual";
  if (lower.includes(".cutready/narration/") || /\.(webm|ogg|oga|wav|mp3|m4a|flac)$/i.test(path)) return "narration";
  if (/\.(png|jpe?g|gif|webp|svg|mp4|mov|mkv)$/i.test(path)) return "asset";
  return "other";
}

function displayName(path: string): string {
  const basename = path.split(/[\\/]/).filter(Boolean).pop() ?? path;
  return basename
    .replace(/\.(sk|sb|md)$/i, "")
    .replace(/[-_]+/g, " ")
    .replace(/\b\w/g, (char) => char.toUpperCase());
}

function branchNameFromSnapshot(label: string, snapshotId: string) {
  const slug = label
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 36);
  return `from-${slug || snapshotId.slice(0, 7)}`;
}

function businessSummary(path: string, kind: ChangeKind): string {
  switch (kind) {
    case "sketch":
      return "Sketch plan changes: title, description, planning rows, screenshots, or visuals.";
    case "storyboard":
      return "Storyboard structure changes: sections, sketch order, or sequence metadata.";
    case "note":
      return "Note content changes: headings, planning text, or generated copy.";
    case "visual":
      return "Visual framing changes for generated graphics or Elucim assets.";
    case "narration":
      return "Narration audio changed for reusable row voiceover cuts.";
    case "asset":
      return "Referenced media asset changed in the project workspace.";
    default:
      return path.startsWith(".cutready/")
        ? "CutReady project metadata changed."
        : "Workspace file changed outside a recognized CutReady document type.";
  }
}

function projectForPath(path: string, projects: ProjectEntry[], activeProjectPath: string | null): ProjectEntry | null {
  return projects.find((project) => fileBelongsToProject(path, project.path, activeProjectPath, projects)) ?? null;
}

function fileBelongsToProject(
  filePath: string,
  projectPath: string,
  activeProjectPath: string | null,
  projects: ProjectEntry[],
): boolean {
  const normalizedProjectPath = normalizePath(projectPath).replace(/^\.\//, "");
  if (!normalizedProjectPath || normalizedProjectPath === ".") return true;
  const normalizedFilePath = normalizePath(filePath).replace(/^\.\//, "");
  if (normalizedFilePath === normalizedProjectPath || normalizedFilePath.startsWith(`${normalizedProjectPath}/`)) {
    return true;
  }

  const normalizedActiveProjectPath = activeProjectPath ? normalizePath(activeProjectPath).replace(/^\.\//, "") : null;
  if (normalizedActiveProjectPath !== normalizedProjectPath) return false;

  return !projects.some((project) => {
    const otherPath = normalizePath(project.path).replace(/^\.\//, "");
    return otherPath !== normalizedProjectPath
      && otherPath
      && otherPath !== "."
      && (normalizedFilePath === otherPath || normalizedFilePath.startsWith(`${otherPath}/`));
  });
}

function normalizePath(path: string): string {
  return path.replace(/\\/g, "/").replace(/\/+$/, "").toLowerCase();
}

function activeProjectScope(currentProject: ProjectView | null): string | null {
  if (!currentProject) return null;
  const root = normalizePath(currentProject.root);
  const repoRoot = normalizePath(currentProject.repo_root);
  if (root === repoRoot) return null;
  const repoPrefix = `${repoRoot}/`;
  return root.startsWith(repoPrefix) ? root.slice(repoPrefix.length) : null;
}

function formatDate(timestamp: string): string {
  const date = new Date(timestamp);
  if (Number.isNaN(date.getTime())) return timestamp;
  return date.toLocaleString([], { dateStyle: "medium", timeStyle: "short" });
}
