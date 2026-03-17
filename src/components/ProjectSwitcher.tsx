import { invoke } from "@tauri-apps/api/core";
import { useCallback, useEffect, useRef, useState } from "react";
import { useAppStore } from "../stores/appStore";
import type { ProjectEntry } from "../types/project";

/**
 * Compact project switcher dropdown. Only visible when the workspace has multiple
 * projects (or when the user wants to add one). Sits at the top of the sidebar.
 */
export function ProjectSwitcher() {
  const currentProject = useAppStore((s) => s.currentProject);
  const projects = useAppStore((s) => s.projects);
  const isMultiProject = useAppStore((s) => s.isMultiProject);
  const switchProject = useAppStore((s) => s.switchProject);
  const createProjectInRepo = useAppStore((s) => s.createProjectInRepo);
  const loadProjects = useAppStore((s) => s.loadProjects);

  const [isOpen, setIsOpen] = useState(false);
  const [isCreating, setIsCreating] = useState(false);
  const [isMigrating, setIsMigrating] = useState(false);
  const [newName, setNewName] = useState("");
  const [migrateName, setMigrateName] = useState("");
  const [renamingPath, setRenamingPath] = useState<string | null>(null);
  const [renameValue, setRenameValue] = useState("");
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
      }
    };
    window.addEventListener("mousedown", handleClick);
    return () => window.removeEventListener("mousedown", handleClick);
  }, [isOpen]);

  // Focus input when creating, migrating, or renaming
  useEffect(() => {
    if (isCreating) inputRef.current?.focus();
    if (isMigrating) migrateInputRef.current?.focus();
    if (renamingPath) renameInputRef.current?.focus();
  }, [isCreating, isMigrating, renamingPath]);

  const handleSwitch = useCallback(
    (path: string) => {
      switchProject(path);
      setIsOpen(false);
    },
    [switchProject],
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
      await invoke<ProjectEntry>("migrate_to_multi_project", { existingName: name });
      setMigrateName("");
      setIsMigrating(false);
      await loadProjects();
      // Now show the "new project" flow
      setIsCreating(true);
    } catch (err) {
      console.error("Migration failed:", err);
    }
  }, [migrateName, loadProjects]);

  const handleRename = useCallback(async () => {
    const name = renameValue.trim();
    if (!name || !renamingPath) return;
    try {
      await invoke("rename_project", { projectPath: renamingPath, newName: name });
      setRenamingPath(null);
      setRenameValue("");
      await loadProjects();
    } catch (err) {
      console.error("Rename failed:", err);
    }
  }, [renameValue, renamingPath, loadProjects]);

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

  return (
    <div ref={dropdownRef} className="relative shrink-0 border-b border-[var(--color-border)]">
      {/* Trigger */}
      <button
        onClick={() => setIsOpen(!isOpen)}
        className="flex items-center gap-2 w-full px-3 py-1.5 text-left hover:bg-[var(--color-surface)] transition-colors"
      >
        {/* Project icon */}
        <svg
          width="14"
          height="14"
          viewBox="0 0 24 24"
          fill="none"
          stroke="currentColor"
          strokeWidth="2"
          strokeLinecap="round"
          strokeLinejoin="round"
          className="text-[var(--color-accent)] shrink-0"
        >
          <path d="M4 20h16a2 2 0 0 0 2-2V8a2 2 0 0 0-2-2h-7.93a2 2 0 0 1-1.66-.9l-.82-1.2A2 2 0 0 0 7.93 3H4a2 2 0 0 0-2 2v13c0 1.1.9 2 2 2Z" />
        </svg>
        <span className="text-[12px] font-medium text-[var(--color-text)] truncate flex-1">
          {activeEntry?.name ?? currentProject?.name ?? "Select project"}
        </span>
        {/* Chevron */}
        <svg
          width="10"
          height="10"
          viewBox="0 0 24 24"
          fill="none"
          stroke="currentColor"
          strokeWidth="2"
          strokeLinecap="round"
          strokeLinejoin="round"
          className={`text-[var(--color-text-secondary)] shrink-0 transition-transform ${isOpen ? "rotate-180" : ""}`}
        >
          <polyline points="6 9 12 15 18 9" />
        </svg>
      </button>

      {/* Dropdown */}
      {isOpen && (
        <div className="absolute left-0 right-0 top-full z-50 bg-[var(--color-surface)] border border-[var(--color-border)] rounded-b-lg shadow-lg overflow-hidden">
          {projects.map((p) => {
            const isActive = activeEntry?.path === p.path;
            const isRenaming = renamingPath === p.path;

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
                    className="flex-1 text-[12px] px-2 py-0.5 bg-[var(--color-surface-alt)] border border-[var(--color-accent)] rounded text-[var(--color-text)] outline-none"
                  />
                  <button
                    onClick={handleRename}
                    disabled={!renameValue.trim()}
                    className="text-[11px] px-1.5 py-0.5 rounded bg-[var(--color-accent)] text-white disabled:opacity-40"
                  >
                    ✓
                  </button>
                </div>
              );
            }

            return (
              <button
                key={p.path}
                onClick={() => handleSwitch(p.path)}
                onDoubleClick={(e) => {
                  e.preventDefault();
                  setRenamingPath(p.path);
                  setRenameValue(p.name);
                }}
                className={`flex items-center gap-2 w-full px-3 py-1.5 text-left transition-colors text-[12px] ${
                  isActive
                    ? "bg-[var(--color-accent)]/10 text-[var(--color-accent)]"
                    : "text-[var(--color-text)] hover:bg-[var(--color-surface-alt)]"
                }`}
                title="Click to switch · Double-click to rename"
              >
                <span className="truncate flex-1">{p.name}</span>
                {isActive && (
                  <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="3" strokeLinecap="round" strokeLinejoin="round">
                    <polyline points="20 6 9 17 4 12" />
                  </svg>
                )}
              </button>
            );
          })}

          {/* Divider + New Project / Migration */}
          <div className="border-t border-[var(--color-border)]">
            {isMigrating ? (
              <div className="px-2 py-2">
                <p className="text-[11px] text-[var(--color-text-secondary)] mb-1.5 leading-relaxed">
                  <strong className="text-[var(--color-text)]">Reorganizing workspace.</strong>{" "}
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
                    className="flex-1 text-[12px] px-2 py-1 bg-[var(--color-surface-alt)] border border-[var(--color-border)] rounded text-[var(--color-text)] placeholder:text-[var(--color-text-secondary)]/50 outline-none focus:border-[var(--color-accent)]"
                  />
                  <button
                    onClick={handleMigrate}
                    disabled={!migrateName.trim()}
                    className="text-[11px] px-2 py-1 rounded bg-[var(--color-accent)] text-white disabled:opacity-40 hover:bg-[var(--color-accent-hover)] transition-colors"
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
                  className="flex-1 text-[12px] px-2 py-1 bg-[var(--color-surface-alt)] border border-[var(--color-border)] rounded text-[var(--color-text)] placeholder:text-[var(--color-text-secondary)]/50 outline-none focus:border-[var(--color-accent)]"
                />
                <button
                  onClick={handleCreate}
                  disabled={!newName.trim()}
                  className="text-[11px] px-2 py-1 rounded bg-[var(--color-accent)] text-white disabled:opacity-40 hover:bg-[var(--color-accent-hover)] transition-colors"
                >
                  Add
                </button>
              </div>
            ) : (
              <button
                onClick={handleNewProjectClick}
                className="flex items-center gap-2 w-full px-3 py-1.5 text-left text-[12px] text-[var(--color-text-secondary)] hover:text-[var(--color-accent)] hover:bg-[var(--color-surface-alt)] transition-colors"
              >
                <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                  <line x1="12" y1="5" x2="12" y2="19" />
                  <line x1="5" y1="12" x2="19" y2="12" />
                </svg>
                New Project
              </button>
            )}
          </div>
        </div>
      )}
    </div>
  );
}
