import { invoke } from "../services/tauri";
import { useCallback, useEffect, useRef, useState } from "react";
import { useAppStore } from "../stores/appStore";
import type { ProjectEntry } from "../types/project";
import { Folder, ChevronDown, Pencil, Check, Plus, RefreshCw, Trash2, X } from "lucide-react";
import { DecisionDialog } from "./DecisionDialog";

/** Compact project switcher dropdown for the title breadcrumb or sidebar. */
interface ProjectSwitcherProps {
  variant?: "sidebar" | "title";
}

export function ProjectSwitcher({ variant = "sidebar" }: ProjectSwitcherProps) {
  const currentProject = useAppStore((s) => s.currentProject);
  const projects = useAppStore((s) => s.projects);
  const isMultiProject = useAppStore((s) => s.isMultiProject);
  const switchProject = useAppStore((s) => s.switchProject);
  const createProjectInRepo = useAppStore((s) => s.createProjectInRepo);
  const deleteProjectFromRepo = useAppStore((s) => s.deleteProjectFromRepo);
  const loadProjects = useAppStore((s) => s.loadProjects);
  const isMerging = useAppStore((s) => s.isMerging);
  const cancelMerge = useAppStore((s) => s.cancelMerge);

  const [isOpen, setIsOpen] = useState(false);
  const [isCreating, setIsCreating] = useState(false);
  const [isMigrating, setIsMigrating] = useState(false);
  const [newName, setNewName] = useState("");
  const [migrateName, setMigrateName] = useState("");
  const [renamingPath, setRenamingPath] = useState<string | null>(null);
  const [renameValue, setRenameValue] = useState("");
  const [deletingPath, setDeletingPath] = useState<string | null>(null);
  const [mergeSwitchPath, setMergeSwitchPath] = useState<string | null>(null);
  const [deleting, setDeleting] = useState(false);
  const dropdownRef = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLInputElement>(null);
  const migrateInputRef = useRef<HTMLInputElement>(null);
  const renameInputRef = useRef<HTMLInputElement>(null);

  // Close dropdown on outside click
  useEffect(() => {
    if (!isOpen) return;
    const handleClick = (e: MouseEvent) => {
      if (dropdownRef.current && !dropdownRef.current.contains(e.target as Node)) {
        setIsOpen(false);
        setIsCreating(false);
        setIsMigrating(false);
        setRenamingPath(null);
        setDeletingPath(null);
      }
    };
    window.addEventListener("mousedown", handleClick);
    return () => window.removeEventListener("mousedown", handleClick);
  }, [isOpen]);

  // Global Escape to cancel any active input state
  useEffect(() => {
    const anyActive = isCreating || isMigrating || renamingPath || deletingPath;
    if (!anyActive) return;
    const handleEsc = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        setIsCreating(false); setNewName("");
        setIsMigrating(false); setMigrateName("");
        setRenamingPath(null); setRenameValue("");
        setDeletingPath(null);
      }
    };
    window.addEventListener("keydown", handleEsc);
    return () => window.removeEventListener("keydown", handleEsc);
  }, [deletingPath, isCreating, isMigrating, renamingPath]);

  // Focus input when creating, migrating, or renaming
  useEffect(() => {
    if (isCreating) inputRef.current?.focus();
    if (isMigrating) migrateInputRef.current?.focus();
    if (renamingPath) renameInputRef.current?.focus();
  }, [isCreating, isMigrating, renamingPath]);

  const handleToggleOpen = useCallback(() => {
    const nextOpen = !isOpen;
    setIsOpen(nextOpen);
    if (nextOpen) void loadProjects();
  }, [isOpen, loadProjects]);

  const handleSwitch = useCallback(
    (path: string) => {
      if (isMerging) {
        setMergeSwitchPath(path);
        setIsOpen(false);
        return;
      }
      void switchProject(path);
      setIsOpen(false);
    },
    [isMerging, switchProject],
  );

  const handleCreate = useCallback(async () => {
    const name = newName.trim();
    if (!name) return;
    await createProjectInRepo(name);
    setNewName("");
    setIsCreating(false);
    await loadProjects();
    const updatedProjects = useAppStore.getState().projects;
    const created = updatedProjects.find(
      (p) => p.name === name || p.path === name.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, ""),
    );
    if (created) switchProject(created.path);
    setIsOpen(false);
  }, [newName, createProjectInRepo, loadProjects, switchProject]);

  const handleMigrate = useCallback(async () => {
    const name = migrateName.trim();
    if (!name) return;
    try {
      const migrated = await invoke<ProjectEntry>("migrate_to_multi_project", { existingName: name });
      setMigrateName("");
      setIsMigrating(false);
      await loadProjects();
      await switchProject(migrated.path);
      // Now show the "new project" flow
      setIsCreating(true);
    } catch (err) {
      console.error("Migration failed:", err);
    }
  }, [migrateName, loadProjects, switchProject]);

  const handleRename = useCallback(async () => {
    const name = renameValue.trim();
    if (!name || !renamingPath) return;
    try {
      const newPath = await invoke<string>("rename_project", { projectPath: renamingPath, newName: name });
      setRenamingPath(null);
      setRenameValue("");
      await loadProjects();
      // Re-switch to the (possibly moved) project so currentProject updates
      await switchProject(newPath);
    } catch (err) {
      console.error("Rename failed:", err);
    }
  }, [renameValue, renamingPath, loadProjects, switchProject]);

  const handleDelete = useCallback(async (project: ProjectEntry, isActive: boolean, deleteFiles: boolean) => {
    setDeleting(true);
    try {
      const remaining = useAppStore.getState().projects.filter((p) => p.path !== project.path);
      if (isActive && remaining.length > 0) {
        await switchProject(remaining[0].path);
      }
      await deleteProjectFromRepo(project.path, deleteFiles);
      if (isActive && remaining.length === 0) {
        useAppStore.getState().closeProject();
      }
      setDeletingPath(null);
    } finally {
      setDeleting(false);
    }
  }, [deleteProjectFromRepo, switchProject]);

  const handleNewProjectClick = useCallback(() => {
    if (!isMultiProject) {
      // Single-project workspace: need to migrate first
      setMigrateName(currentProject?.name ?? "");
      setIsMigrating(true);
    } else {
      setIsCreating(true);
    }
  }, [isMultiProject, currentProject]);

  // Find the active project entry
  const activeEntry = projects.find((p) => {
    if (!currentProject) return false;
    if (p.path === ".") return currentProject.root === currentProject.repo_root;
    return currentProject.root.endsWith(p.path.replace(/\//g, "\\")) || currentProject.root.endsWith(p.path);
  });

  const workspaceName = currentProject
    ? currentProject.repo_root.replace(/[/\\]+$/, "").split(/[/\\]/).pop()
    : null;
  const isTitle = variant === "title";
  const mergeProject = mergeSwitchPath
    ? projects.find((project) => project.path === mergeSwitchPath)
    : null;

  return (
    <div
      ref={dropdownRef}
      className={
        isTitle
          ? "relative min-w-0 shrink"
          : "relative shrink-0 border-b border-[rgb(var(--color-border))]"
      }
    >
      {/* Trigger */}
      <button
        onClick={handleToggleOpen}
        className={
          isTitle
            ? "flex h-[22px] max-w-[320px] min-w-0 items-center gap-1.5 rounded px-1.5 text-left text-sm leading-none text-[rgb(var(--color-text-secondary))] transition-colors hover:bg-[rgb(var(--color-surface-alt))] hover:text-[rgb(var(--color-text))]"
            : "flex items-center gap-2 w-full px-3 py-1.5 text-left hover:bg-[rgb(var(--color-surface))] transition-colors"
        }
        title={isTitle ? "Switch project" : undefined}
      >
        {!isTitle && <Folder className="text-[rgb(var(--color-accent))] shrink-0 w-3.5 h-3.5" />}
        {isTitle ? (
          <>
            {workspaceName && <span className="truncate">{workspaceName}</span>}
            {isMultiProject && (
              <>
                <span className="text-[rgb(var(--color-text-secondary))]/50">/</span>
                <span className="truncate text-[rgb(var(--color-text))]">
                  {activeEntry?.name ?? currentProject?.name ?? "Select project"}
                </span>
              </>
            )}
          </>
        ) : (
          <span className="text-[12px] font-medium text-[rgb(var(--color-text))] truncate flex-1">
            {activeEntry?.name ?? currentProject?.name ?? "Select project"}
          </span>
        )}
        <ChevronDown
          className={`text-[rgb(var(--color-text-secondary))] shrink-0 transition-transform w-2.5 h-2.5 ${isOpen ? "rotate-180" : ""}`}
        />
      </button>

      {/* Dropdown */}
      {isOpen && (
        <div
          className={
            isTitle
              ? "absolute left-0 top-full z-[var(--z-modal)] mt-1 w-[260px] overflow-hidden rounded-lg border border-[rgb(var(--color-border))] bg-[rgb(var(--color-surface))] shadow-lg"
              : "absolute left-0 right-0 top-full z-dropdown bg-[rgb(var(--color-surface))] border border-[rgb(var(--color-border))] rounded-b-lg shadow-lg overflow-hidden"
          }
        >
          {isTitle && (
            <div className="border-b border-[rgb(var(--color-border))] px-3 py-2">
              <div className="text-[10px] font-medium uppercase tracking-wider text-[rgb(var(--color-text-secondary))]">
                Workspace
              </div>
              <div className="truncate text-[12px] text-[rgb(var(--color-text))]">
                {workspaceName ?? "Current workspace"}
              </div>
            </div>
          )}
          <div className="flex items-center justify-between border-b border-[rgb(var(--color-border))] px-3 py-1.5">
            <span className="text-[10px] font-medium uppercase tracking-wider text-[rgb(var(--color-text-secondary))]">
              Projects
            </span>
            <button
              type="button"
              onClick={() => loadProjects()}
              className="grid h-5 w-5 place-items-center rounded text-[rgb(var(--color-text-secondary))] transition-colors hover:bg-[rgb(var(--color-surface-alt))] hover:text-[rgb(var(--color-text))]"
              title="Refresh projects"
              aria-label="Refresh projects"
            >
              <RefreshCw className="h-3 w-3" />
            </button>
          </div>
          {projects.map((p) => {
            const isActive = activeEntry?.path === p.path;
            const isRenaming = renamingPath === p.path;
            const isDeleting = deletingPath === p.path;

            if (isRenaming) {
              return (
                <div key={p.path} className="flex items-center gap-1 px-2 py-1">
                  <input
                    ref={renameInputRef}
                    value={renameValue}
                    onChange={(e) => setRenameValue(e.target.value)}
                    onKeyDown={(e) => {
                      if (e.key === "Enter") handleRename();
                      if (e.key === "Escape") { setRenamingPath(null); setRenameValue(""); }
                    }}
                    className="flex-1 text-[12px] px-2 py-0.5 bg-[rgb(var(--color-surface-alt))] border border-[rgb(var(--color-accent))] rounded text-[rgb(var(--color-text))] outline-none"
                  />
                  <button
                    onClick={handleRename}
                    disabled={!renameValue.trim()}
                    className="text-[11px] px-1.5 py-0.5 rounded bg-[rgb(var(--color-accent))] text-[rgb(var(--color-accent-fg))] disabled:opacity-40"
                  >
                    ✓
                  </button>
                </div>
              );
            }

            if (isDeleting) {
              return (
                <div
                  key={p.path}
                  className="border-y border-error/20 bg-error/5 px-3 py-2"
                >
                  <div className="mb-2 flex items-start gap-2">
                    <span className="mt-0.5 grid h-5 w-5 shrink-0 place-items-center rounded-full bg-error/10 text-error">
                      <Trash2 className="h-3 w-3" />
                    </span>
                    <div className="min-w-0 flex-1">
                      <div className="text-[11px] font-medium text-[rgb(var(--color-text))]">
                        Remove {p.name}?
                      </div>
                      <div className="mt-0.5 text-[10px] leading-relaxed text-[rgb(var(--color-text-secondary))]">
                        Removing from the list keeps files on disk. Deleting files will show them as pending deletions in Changes.
                      </div>
                    </div>
                    <button
                      type="button"
                      onClick={() => setDeletingPath(null)}
                      disabled={deleting}
                      className="rounded p-0.5 text-[rgb(var(--color-text-secondary))] transition-colors hover:text-[rgb(var(--color-text))] disabled:opacity-40"
                      title="Cancel"
                      aria-label="Cancel remove project"
                    >
                      <X className="h-3 w-3" />
                    </button>
                  </div>
                  <div className="flex gap-1.5">
                    <button
                      type="button"
                      onClick={() => handleDelete(p, isActive, false)}
                      disabled={deleting}
                      className="flex-1 rounded-md border border-[rgb(var(--color-border))] px-2 py-1 text-[10px] font-medium text-[rgb(var(--color-text-secondary))] transition-colors hover:border-[rgb(var(--color-accent))]/40 hover:text-[rgb(var(--color-accent))] disabled:pointer-events-none disabled:opacity-40"
                    >
                      Remove from list
                    </button>
                    <button
                      type="button"
                      onClick={() => handleDelete(p, isActive, true)}
                      disabled={deleting}
                      className="flex-1 rounded-md bg-error px-2 py-1 text-[10px] font-medium text-accent-fg transition-colors hover:bg-error/80 disabled:pointer-events-none disabled:opacity-40"
                    >
                      {deleting ? "Deleting..." : "Delete files"}
                    </button>
                  </div>
                </div>
              );
            }

            return (
              <div
                key={p.path}
                className={`group flex items-center gap-2 w-full px-3 py-1.5 text-left transition-colors text-[12px] ${
                  isActive
                    ? "bg-[rgb(var(--color-accent))]/10 text-[rgb(var(--color-accent))]"
                    : "text-[rgb(var(--color-text))] hover:bg-[rgb(var(--color-surface-alt))]"
                }`}
              >
                <button
                  onClick={() => handleSwitch(p.path)}
                  className="truncate flex-1 text-left"
                >
                  {p.name}
                </button>
                <button
                  onClick={(e) => {
                    e.stopPropagation();
                    setRenamingPath(p.path);
                    setRenameValue(p.name);
                  }}
                  className="opacity-0 group-hover:opacity-100 p-0.5 rounded hover:bg-[rgb(var(--color-surface))] transition-opacity"
                  title="Rename project"
                >
                  <Pencil className="w-2.5 h-2.5" />
                </button>
                {p.path !== "." && (
                  <button
                    onClick={(e) => {
                      e.stopPropagation();
                      setRenamingPath(null);
                      setDeletingPath(p.path);
                    }}
                    className="opacity-0 group-hover:opacity-100 p-0.5 rounded text-[rgb(var(--color-text-secondary))] hover:bg-error/10 hover:text-error transition-opacity"
                    title="Delete project"
                    aria-label={`Delete ${p.name}`}
                  >
                    <Trash2 className="w-2.5 h-2.5" />
                  </button>
                )}
                {isActive && (
                  <Check className="shrink-0 w-3 h-3" />
                )}
              </div>
            );
          })}

          {/* Divider + New Project / Migration */}
          <div className="border-t border-[rgb(var(--color-border))]">
            {isMigrating ? (
              <div className="px-2 py-2">
                <p className="text-[11px] text-[rgb(var(--color-text-secondary))] mb-1.5 leading-relaxed">
                  <strong className="text-[rgb(var(--color-text))]">Reorganizing workspace.</strong>{" "}
                  Your current files will move into their own project folder.
                  Give this existing project a name:
                </p>
                <div className="flex items-center gap-1">
                  <input
                    ref={migrateInputRef}
                    value={migrateName}
                    onChange={(e) => setMigrateName(e.target.value)}
                    onKeyDown={(e) => {
                      if (e.key === "Enter") handleMigrate();
                      if (e.key === "Escape") {
                        setIsMigrating(false);
                        setMigrateName("");
                      }
                    }}
                    placeholder="e.g. My Demo"
                    className="flex-1 text-[12px] px-2 py-1 bg-[rgb(var(--color-surface-alt))] border border-[rgb(var(--color-border))] rounded text-[rgb(var(--color-text))] placeholder:text-[rgb(var(--color-text-secondary))]/50 outline-none focus:border-[rgb(var(--color-accent))]"
                  />
                  <button
                    onClick={handleMigrate}
                    disabled={!migrateName.trim()}
                    className="text-[11px] px-2 py-1 rounded bg-[rgb(var(--color-accent))] text-[rgb(var(--color-accent-fg))] disabled:opacity-40 hover:bg-[rgb(var(--color-accent-hover))] transition-colors"
                  >
                    Next →
                  </button>
                </div>
              </div>
            ) : isCreating ? (
              <div className="flex items-center gap-1 px-2 py-1.5">
                <input
                  ref={inputRef}
                  value={newName}
                  onChange={(e) => setNewName(e.target.value)}
                  onKeyDown={(e) => {
                    if (e.key === "Enter") handleCreate();
                    if (e.key === "Escape") {
                      setIsCreating(false);
                      setNewName("");
                    }
                  }}
                  placeholder="New project name…"
                  className="flex-1 text-[12px] px-2 py-1 bg-[rgb(var(--color-surface-alt))] border border-[rgb(var(--color-border))] rounded text-[rgb(var(--color-text))] placeholder:text-[rgb(var(--color-text-secondary))]/50 outline-none focus:border-[rgb(var(--color-accent))]"
                />
                <button
                  onClick={handleCreate}
                  disabled={!newName.trim()}
                  className="text-[11px] px-2 py-1 rounded bg-[rgb(var(--color-accent))] text-[rgb(var(--color-accent-fg))] disabled:opacity-40 hover:bg-[rgb(var(--color-accent-hover))] transition-colors"
                >
                  Add
                </button>
              </div>
            ) : (
              <button
                onClick={handleNewProjectClick}
                className="flex items-center gap-2 w-full px-3 py-1.5 text-left text-[12px] text-[rgb(var(--color-text-secondary))] hover:text-[rgb(var(--color-accent))] hover:bg-[rgb(var(--color-surface-alt))] transition-colors"
              >
                <Plus className="w-3 h-3" />
                New Project
              </button>
            )}
          </div>
        </div>
      )}
      <DecisionDialog
        open={!!mergeSwitchPath}
        title="Finish merge before switching projects?"
        message={(
          <>
            Incoming saves are waiting for conflict resolution. Switching to{" "}
            <span className="font-medium text-[rgb(var(--color-text))]">
              {mergeProject?.name ?? mergeSwitchPath ?? "that project"}
            </span>{" "}
            cancels the in-progress resolution flow.
          </>
        )}
        actions={[
          { id: "stay", label: "Stay and resolve", onSelect: () => setMergeSwitchPath(null) },
          {
            id: "switch",
            label: "Cancel merge and switch",
            variant: "danger",
            onSelect: async () => {
              if (!mergeSwitchPath) return;
              const target = mergeSwitchPath;
              setMergeSwitchPath(null);
              cancelMerge();
              await switchProject(target);
            },
          },
        ]}
        onClose={() => setMergeSwitchPath(null)}
      />
    </div>
  );
}
