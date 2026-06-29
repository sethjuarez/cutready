import { useCallback, useEffect, useLayoutEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { useAppStore } from "../stores/appStore";
import { ArrowLeftRight, ChevronDown, Check, Cloud, Plus, RefreshCw } from "lucide-react";
import { UnsavedWorkspaceDialog } from "./UnsavedWorkspaceDialog";
import { useConfirmDialog } from "./ConfirmDialog";
import {
  isDraftlineVariationCreateConflictError,
  type DraftlineVariationCreatePreflight,
} from "../services/draftlineVersioning";

/**
 * TimelineSelector — dropdown for switching timelines (branches).
 * Borrowed from GitHub Desktop's branch switcher pattern.
 * Shows active timeline with sync badge, dropdown for all timelines.
 */
export function TimelineSelector() {
  const timelines = useAppStore((s) => s.timelines);
  const switchTimeline = useAppStore((s) => s.switchTimeline);
  const createTimeline = useAppStore((s) => s.createTimeline);
  const graphNodes = useAppStore((s) => s.graphNodes);
  const isDirty = useAppStore((s) => s.isDirty);
  const discardChanges = useAppStore((s) => s.discardChanges);
  const deleteTimeline = useAppStore((s) => s.deleteTimeline);
  const startedBranchFromSnapshot = useAppStore((s) => s.startedBranchFromSnapshot);
  const currentRemote = useAppStore((s) => s.currentRemote);
  const remoteBranches = useAppStore((s) => s.remoteBranches);
  const remoteBranchesLoading = useAppStore((s) => s.remoteBranchesLoading);
  const loadRemoteBranches = useAppStore((s) => s.loadRemoteBranches);
  const checkoutRemoteTimeline = useAppStore((s) => s.checkoutRemoteTimeline);

  const [open, setOpen] = useState(false);
  const [pendingSwitch, setPendingSwitch] = useState<string | null>(null);
  const [filter, setFilter] = useState("");
  const [newName, setNewName] = useState("");
  const [showNew, setShowNew] = useState(false);
  const [createConflict, setCreateConflict] = useState<DraftlineVariationCreatePreflight | null>(null);
  const triggerRef = useRef<HTMLDivElement>(null);
  const dropdownRef = useRef<HTMLDivElement>(null);
  const filterRef = useRef<HTMLInputElement>(null);
  const [dropdownStyle, setDropdownStyle] = useState<React.CSSProperties | null>(null);
  const { confirm, confirmationDialog } = useConfirmDialog();

  const active = timelines.find((t) => t.is_active);
  const head = graphNodes.find((node) => node.is_head);
  const emptyStartedBranch = startedBranchFromSnapshot
    && active?.name === startedBranchFromSnapshot.branchName
    && head?.id === startedBranchFromSnapshot.snapshotId
    ? startedBranchFromSnapshot
    : null;

  // Close on outside click
  useEffect(() => {
    if (!open) return;
    const handle = (e: MouseEvent) => {
      const target = e.target as Node;
      if (
        triggerRef.current?.contains(target) ||
        dropdownRef.current?.contains(target)
      ) {
        return;
      }
      {
        setOpen(false);
        setFilter("");
        setShowNew(false);
      }
    };
    window.addEventListener("mousedown", handle);
    return () => window.removeEventListener("mousedown", handle);
  }, [open]);

  useLayoutEffect(() => {
    if (!open) return;

    const updatePosition = () => {
      const trigger = triggerRef.current;
      if (!trigger) return;
      const rect = trigger.getBoundingClientRect();
      const width = 224;
      const left = Math.min(rect.left, window.innerWidth - width - 8);
      setDropdownStyle({
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
  }, [open]);

  // Focus filter when opening
  useEffect(() => {
    if (open) filterRef.current?.focus();
  }, [open]);

  useEffect(() => {
    if (open && currentRemote) void loadRemoteBranches();
  }, [currentRemote, loadRemoteBranches, open]);

  const handleSwitch = useCallback(async (name: string) => {
    if (isDirty) {
      setPendingSwitch(name);
      setOpen(false);
      return;
    }
    await switchTimeline(name);
    setOpen(false);
    setFilter("");
  }, [isDirty, switchTimeline]);

  const pendingTimeline = pendingSwitch ? timelines.find((timeline) => timeline.name === pendingSwitch) : null;

  const handleCreate = useCallback(async () => {
    if (!newName.trim()) return;
    // Find HEAD commit
    const head = graphNodes.find((n) => n.is_head);
    if (!head) return;
    try {
      await createTimeline(head.id, newName.trim());
      setNewName("");
      setCreateConflict(null);
      setShowNew(false);
      setOpen(false);
    } catch (error) {
      if (isDraftlineVariationCreateConflictError(error)) {
        setCreateConflict(error.preflight);
        return;
      }
      throw error;
    }
  }, [newName, graphNodes, createTimeline]);

  // Only show if we have more than 1 timeline (or always show for discoverability)
  if (timelines.length <= 1 && !active) return null;

  const filtered = timelines.filter((t) =>
    t.label.toLowerCase().includes(filter.toLowerCase())
  );
  const filteredRemoteBranches = remoteBranches.filter((branch) =>
    branch.name.toLowerCase().includes(filter.toLowerCase())
  );

  const handleRemoteBranchClick = useCallback(async (branchName: string) => {
    const ok = await confirm({
      title: "Adopt remote branch?",
      message: `This creates a local branch from ${currentRemote?.name ?? "origin"}/${branchName} and switches to it. Your current branch is left unchanged.`,
      confirmLabel: "Adopt and switch",
      cancelLabel: "Cancel",
      variant: "default",
    });
    if (!ok) return;
    await checkoutRemoteTimeline(branchName);
    setOpen(false);
    setFilter("");
  }, [checkoutRemoteTimeline, confirm, currentRemote?.name]);

  const handleAdoptCreateConflict = useCallback(async () => {
    if (!createConflict) return;
    await checkoutRemoteTimeline(createConflict.variation);
    setCreateConflict(null);
    setNewName("");
    setShowNew(false);
    setOpen(false);
    setFilter("");
  }, [checkoutRemoteTimeline, createConflict]);

  const dropdown = open && dropdownStyle ? createPortal(
    <div
      ref={dropdownRef}
      style={dropdownStyle}
      className="rounded-lg border border-[rgb(var(--color-border))] bg-[rgb(var(--color-surface))] shadow-lg z-dropdown overflow-hidden"
    >
      {/* Search filter */}
      {timelines.length > 3 && (
        <div className="px-2 pt-2">
          <input
            ref={filterRef}
            value={filter}
            onChange={(e) => setFilter(e.target.value)}
            placeholder="Filter branches…"
            className="w-full px-2 py-1 rounded text-[10px] bg-[rgb(var(--color-surface-alt))] border border-[rgb(var(--color-border))] text-[rgb(var(--color-text))] placeholder:text-[rgb(var(--color-text-secondary))]/50 outline-none focus:border-[rgb(var(--color-accent))]"
          />
        </div>
      )}

      {/* Timeline list */}
      <div className="max-h-48 overflow-y-auto py-1">
        {filtered.map((t) => (
          <button
            key={t.name}
            onClick={() => t.is_active ? setOpen(false) : handleSwitch(t.name)}
            className={`group w-full flex items-center gap-2 px-3 py-1.5 text-left text-[11px] transition-colors relative ${
              t.is_active
                ? "bg-[rgb(var(--color-accent))]/10 text-[rgb(var(--color-accent))] font-medium"
                : "text-[rgb(var(--color-text))] hover:bg-[rgb(var(--color-border))]/30"
            }`}
          >
            {/* Consistent icon area */}
            <span className="w-[10px] shrink-0 flex items-center justify-center">
              {t.is_active ? (
                <Check className="w-2.5 h-2.5" />
              ) : (
                <span className="w-1.5 h-1.5 rounded-full bg-[rgb(var(--color-text-secondary))]/30" />
              )}
            </span>
            <span className="truncate flex-1">{t.label}</span>
            <span className="text-[9px] text-[rgb(var(--color-text-secondary))] tabular-nums ml-auto">
              {t.snapshot_count} {t.snapshot_count === 1 ? "snap" : "snaps"}
            </span>
          </button>
        ))}
        {filtered.length === 0 && (
          <div className="px-3 py-2 text-[10px] text-[rgb(var(--color-text-secondary))]">
            No branches match "{filter}"
          </div>
        )}
      </div>

      {currentRemote && (
        <div className="border-t border-[rgb(var(--color-border))] bg-[rgb(var(--color-surface))]">
          <div className="flex items-center gap-2 px-3 py-1.5">
            <Cloud className="h-2.5 w-2.5 text-[rgb(var(--color-text-secondary))]" />
            <span className="min-w-0 flex-1 truncate text-[9px] font-semibold uppercase tracking-wider text-[rgb(var(--color-text-secondary))]">
              {currentRemote.name}
            </span>
            <button
              type="button"
              onClick={(event) => {
                event.stopPropagation();
                void loadRemoteBranches();
              }}
              disabled={remoteBranchesLoading}
              className="grid h-4 w-4 place-items-center rounded text-[rgb(var(--color-text-secondary))] transition-colors hover:bg-[rgb(var(--color-surface-alt))] hover:text-[rgb(var(--color-text))] disabled:opacity-40"
              title="Refresh remote branches"
              aria-label="Refresh remote branches"
            >
              <RefreshCw className={`h-2.5 w-2.5 ${remoteBranchesLoading ? "animate-spin" : ""}`} />
            </button>
          </div>
          <div className="max-h-36 overflow-y-auto pb-1">
            {remoteBranchesLoading && remoteBranches.length === 0 ? (
              <div className="px-3 py-2 text-[10px] text-[rgb(var(--color-text-secondary))]">
                Fetching remote branches…
              </div>
            ) : filteredRemoteBranches.length > 0 ? (
              filteredRemoteBranches.map((branch) => (
                <button
                  key={`${branch.remote}/${branch.id}`}
                  type="button"
                  onClick={() => handleRemoteBranchClick(branch.id)}
                  className="group flex w-full items-center gap-2 px-3 py-1.5 text-left text-[11px] text-[rgb(var(--color-text-secondary))] transition-colors hover:bg-[rgb(var(--color-accent))]/5 hover:text-[rgb(var(--color-text))]"
                  title={`Adopt ${branch.remote}/${branch.name}`}
                >
                  <span className="w-[10px] shrink-0">
                    <span className="block h-1.5 w-1.5 rounded-full border border-[rgb(var(--color-accent))]/50" />
                  </span>
                  <span className="min-w-0 flex-1 truncate">{branch.name}</span>
                  <span className="shrink-0 rounded border border-[rgb(var(--color-border))] px-1 py-px font-mono text-[8px] uppercase tracking-wide text-[rgb(var(--color-text-secondary))]/70">
                    remote
                  </span>
                </button>
              ))
            ) : (
              <div className="px-3 py-2 text-[10px] text-[rgb(var(--color-text-secondary))]/70">
                {filter ? `No remote branches match "${filter}"` : "No remote-only branches"}
              </div>
            )}
          </div>
        </div>
      )}

      {/* New timeline */}
      <div className="border-t border-[rgb(var(--color-border))]">
        {showNew ? (
          <div className="px-2 py-2">
            <div className="flex items-center gap-1.5">
              <input
                value={newName}
                onChange={(e) => {
                  setCreateConflict(null);
                  setNewName(e.target.value);
                }}
                onKeyDown={(e) => e.key === "Enter" && handleCreate()}
                placeholder="Branch name…"
                className="flex-1 px-2 py-1 rounded text-[10px] bg-[rgb(var(--color-surface-alt))] border border-[rgb(var(--color-border))] text-[rgb(var(--color-text))] placeholder:text-[rgb(var(--color-text-secondary))]/50 outline-none focus:border-[rgb(var(--color-accent))]"
                autoFocus
              />
              <button
                onClick={handleCreate}
                className="px-2 py-1 rounded text-[10px] font-medium bg-[rgb(var(--color-accent))] text-[rgb(var(--color-accent-fg))] hover:opacity-90 transition-opacity"
              >
                Create
              </button>
            </div>
            {createConflict && (
              <BranchCreateConflictPanel
                preflight={createConflict}
                onUseSuggestion={(name) => {
                  setCreateConflict(null);
                  setNewName(name);
                }}
                onAdopt={handleAdoptCreateConflict}
                onCancel={() => {
                  setCreateConflict(null);
                  setNewName("");
                  setShowNew(false);
                }}
              />
            )}
          </div>
        ) : (
          <button
            onClick={() => setShowNew(true)}
            className="w-full flex items-center gap-2 px-3 py-2 text-[11px] text-[rgb(var(--color-accent))] hover:bg-[rgb(var(--color-accent))]/5 transition-colors"
          >
            <Plus className="w-2.5 h-2.5" />
            New Branch
          </button>
        )}
      </div>
    </div>,
    document.body,
  ) : null;

  return (
    <div className="relative min-w-0" ref={triggerRef}>
      {/* Trigger button */}
      <button
        onClick={() => setOpen(!open)}
        className="flex h-6 min-w-0 max-w-full items-center gap-1.5 rounded-md px-1.5 text-[10px] text-[rgb(var(--color-text-secondary))] transition-colors hover:bg-[rgb(var(--color-surface-alt))] hover:text-[rgb(var(--color-text))]"
        title={`Branch: ${active?.label ?? "main"}`}
      >
        <ArrowLeftRight className="shrink-0 w-3 h-3" />
        <span className="truncate">{active?.label ?? "main"}</span>
        <ChevronDown className="shrink-0 opacity-50 w-2 h-2" />
      </button>

      {dropdown}
      <UnsavedWorkspaceDialog
        open={!!pendingSwitch}
        targetLabel={pendingTimeline?.label ?? pendingSwitch ?? "that branch"}
        onCancel={() => setPendingSwitch(null)}
        onSaveFirst={() => {
          if (!pendingSwitch) return;
          useAppStore.setState({ pendingTimelineAfterSave: pendingSwitch, snapshotPromptOpen: true });
          setPendingSwitch(null);
        }}
        onDiscardAndContinue={async () => {
          if (!pendingSwitch) return;
          const target = pendingSwitch;
          const branchToDelete = emptyStartedBranch;
          setPendingSwitch(null);
          await discardChanges();
          await switchTimeline(target);
          if (branchToDelete) {
            const shouldDelete = await confirm({
              title: "Delete the empty branch too?",
              message: `You discarded the unsaved work on ${branchToDelete.branchName}. This branch has no new saved snapshots beyond where it started. Delete it as well?`,
              confirmLabel: "Delete branch",
              cancelLabel: "Keep branch",
              variant: "warning",
            });
            if (shouldDelete) await deleteTimeline(branchToDelete.branchName);
          }
        }}
      />
      {confirmationDialog}
    </div>
  );
}

function BranchCreateConflictPanel({
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
    <div className="mt-2 rounded-lg border border-warning/25 bg-warning/5 px-2 py-2 text-[10px] leading-relaxed text-[rgb(var(--color-text-secondary))]">
      <div className="font-medium text-warning">{message}</div>
      <div className="mt-1">Choose another name, adopt the remote branch, or cancel branch creation.</div>
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
