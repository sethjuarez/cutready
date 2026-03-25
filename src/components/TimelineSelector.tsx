import { useCallback, useEffect, useRef, useState } from "react";
import { useAppStore } from "../stores/appStore";
import { ArrowsRightLeftIcon, ChevronDownIcon, CheckIcon, PlusIcon } from "@heroicons/react/24/outline";

/**
 * TimelineSelector — dropdown for switching timelines (branches).
 * Borrowed from GitHub Desktop's branch switcher pattern.
 * Shows active timeline with sync badge, dropdown for all timelines.
 */
export function TimelineSelector() {
  const timelines = useAppStore((s) => s.timelines);
  const switchTimeline = useAppStore((s) => s.switchTimeline);
  const createTimeline = useAppStore((s) => s.createTimeline);
  const deleteTimeline = useAppStore((s) => s.deleteTimeline);
  const promoteTimeline = useAppStore((s) => s.promoteTimeline);
  const mergeTimelines = useAppStore((s) => s.mergeTimelines);
  const isDirty = useAppStore((s) => s.isDirty);
  const graphNodes = useAppStore((s) => s.graphNodes);

  const [open, setOpen] = useState(false);
  const [filter, setFilter] = useState("");
  const [newName, setNewName] = useState("");
  const [showNew, setShowNew] = useState(false);
  const dropdownRef = useRef<HTMLDivElement>(null);
  const filterRef = useRef<HTMLInputElement>(null);

  const active = timelines.find((t) => t.is_active);

  // Close on outside click
  useEffect(() => {
    if (!open) return;
    const handle = (e: MouseEvent) => {
      if (dropdownRef.current && !dropdownRef.current.contains(e.target as Node)) {
        setOpen(false);
        setFilter("");
        setShowNew(false);
      }
    };
    window.addEventListener("mousedown", handle);
    return () => window.removeEventListener("mousedown", handle);
  }, [open]);

  // Focus filter when opening
  useEffect(() => {
    if (open) filterRef.current?.focus();
  }, [open]);

  const handleSwitch = useCallback(async (name: string) => {
    if (isDirty) {
      // If dirty, let the store's switchTimeline handle it (it prompts)
      useAppStore.setState({ snapshotPromptOpen: true });
      return;
    }
    await switchTimeline(name);
    setOpen(false);
    setFilter("");
  }, [isDirty, switchTimeline]);

  const handleCreate = useCallback(async () => {
    if (!newName.trim()) return;
    // Find HEAD commit
    const head = graphNodes.find((n) => n.is_head);
    if (!head) return;
    await createTimeline(head.id, newName.trim());
    setNewName("");
    setShowNew(false);
    setOpen(false);
  }, [newName, graphNodes, createTimeline]);

  const handleDelete = useCallback(async (name: string, e: React.MouseEvent) => {
    e.stopPropagation();
    if (window.confirm(`Delete timeline "${name}"? This cannot be undone.`)) {
      await deleteTimeline(name);
    }
  }, [deleteTimeline]);

  const handlePromote = useCallback(async (name: string, label: string, e: React.MouseEvent) => {
    e.stopPropagation();
    if (window.confirm(`Promote "${label}" to Main? The current Main will be preserved as a separate timeline.`)) {
      await promoteTimeline(name);
      setOpen(false);
    }
  }, [promoteTimeline]);

  const handleMerge = useCallback(async (sourceName: string, sourceLabel: string, e: React.MouseEvent) => {
    e.stopPropagation();
    const targetLabel = active?.label ?? "Main";
    if (window.confirm(`Combine "${sourceLabel}" into "${targetLabel}"? This will merge all changes.`)) {
      try {
        const result = await mergeTimelines(sourceName, active?.name ?? "main");
        if (result.status === "clean" || result.status === "fast_forward") {
          setOpen(false);
        } else if (result.status === "conflicts") {
          setOpen(false);
          // UI will show MergeConflictPanel automatically via store state
        }
      } catch (err) {
        console.error("Merge failed:", err);
      }
    }
  }, [mergeTimelines, active]);

  // Only show if we have more than 1 timeline (or always show for discoverability)
  if (timelines.length <= 1 && !active) return null;

  const filtered = timelines.filter((t) =>
    t.label.toLowerCase().includes(filter.toLowerCase())
  );

  return (
    <div className="relative" ref={dropdownRef}>
      {/* Trigger button */}
      <button
        onClick={() => setOpen(!open)}
        className="flex items-center gap-1.5 px-2 py-1 rounded text-[10px] text-[rgb(var(--color-text-secondary))] hover:text-[rgb(var(--color-text))] hover:bg-[rgb(var(--color-border))]/50 transition-colors max-w-[140px]"
        title={`Branch: ${active?.label ?? "main"}`}
      >
        <ArrowsRightLeftIcon className="shrink-0 w-3 h-3" />
        <span className="truncate">{active?.label ?? "main"}</span>
        <ChevronDownIcon className="shrink-0 opacity-50 w-2 h-2" />
      </button>

      {/* Dropdown */}
      {open && (
        <div className="absolute top-full left-0 mt-1 w-56 rounded-lg border border-[rgb(var(--color-border))] bg-[rgb(var(--color-surface))] shadow-lg z-dropdown overflow-hidden">
          {/* Search filter */}
          {timelines.length > 3 && (
            <div className="px-2 pt-2">
              <input
                ref={filterRef}
                value={filter}
                onChange={(e) => setFilter(e.target.value)}
                placeholder="Filter branches…"
                className="w-full px-2 py-1 rounded text-[10px] bg-[rgb(var(--color-bg))] border border-[rgb(var(--color-border))] text-[rgb(var(--color-text))] placeholder:text-[rgb(var(--color-text-secondary))]/50 outline-none focus:border-[rgb(var(--color-accent))]"
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
                    <CheckIcon className="w-2.5 h-2.5" />
                  ) : (
                    <span className="w-1.5 h-1.5 rounded-full bg-[rgb(var(--color-text-secondary))]/30" />
                  )}
                </span>
                <span className="truncate flex-1">{t.label}</span>
                <span className="text-[9px] text-[rgb(var(--color-text-secondary))] tabular-nums ml-auto">
                  {t.snapshot_count} {t.snapshot_count === 1 ? "snap" : "snaps"}
                </span>
                {!t.is_active && t.name !== "main" && timelines.length > 1 && (
                  <span className="absolute right-2 flex items-center gap-1 opacity-0 group-hover:opacity-100 transition-opacity bg-[rgb(var(--color-surface))] pl-1 rounded">
                    <button
                      onClick={(e) => handleMerge(t.name, t.label, e)}
                      className="text-[9px] px-1.5 py-0.5 rounded hover:bg-success/15 hover:text-success transition-colors"
                    >
                      Merge
                    </button>
                    <button
                      onClick={(e) => handlePromote(t.name, t.label, e)}
                      className="text-[9px] px-1.5 py-0.5 rounded hover:bg-[rgb(var(--color-accent))]/15 hover:text-[rgb(var(--color-accent))] transition-colors"
                    >
                      Promote
                    </button>
                    <button
                      onClick={(e) => handleDelete(t.name, e)}
                      className="text-[9px] px-1.5 py-0.5 rounded hover:bg-error/15 hover:text-error transition-colors"
                    >
                      ✕
                    </button>
                  </span>
                )}
              </button>
            ))}
            {filtered.length === 0 && (
              <div className="px-3 py-2 text-[10px] text-[rgb(var(--color-text-secondary))]">
                No branches match "{filter}"
              </div>
            )}
          </div>

          {/* New timeline */}
          <div className="border-t border-[rgb(var(--color-border))]">
            {showNew ? (
              <div className="flex items-center gap-1.5 px-2 py-2">
                <input
                  value={newName}
                  onChange={(e) => setNewName(e.target.value)}
                  onKeyDown={(e) => e.key === "Enter" && handleCreate()}
                  placeholder="Branch name…"
                  className="flex-1 px-2 py-1 rounded text-[10px] bg-[rgb(var(--color-bg))] border border-[rgb(var(--color-border))] text-[rgb(var(--color-text))] placeholder:text-[rgb(var(--color-text-secondary))]/50 outline-none focus:border-[rgb(var(--color-accent))]"
                  autoFocus
                />
                <button
                  onClick={handleCreate}
                  className="px-2 py-1 rounded text-[10px] font-medium bg-[rgb(var(--color-accent))] text-white hover:opacity-90 transition-opacity"
                >
                  Create
                </button>
              </div>
            ) : (
              <button
                onClick={() => setShowNew(true)}
                className="w-full flex items-center gap-2 px-3 py-2 text-[11px] text-[rgb(var(--color-accent))] hover:bg-[rgb(var(--color-accent))]/5 transition-colors"
              >
                <PlusIcon className="w-2.5 h-2.5" />
                New Branch
              </button>
            )}
          </div>
        </div>
      )}
    </div>
  );
}
