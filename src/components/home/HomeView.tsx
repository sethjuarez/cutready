// The home screen: greeting, prompt composer, quick starts, continue card and recent workspaces.
import { useEffect, useState } from "react";
import { ChevronDown, Download, FolderGit2, Plus } from "lucide-react";
import { useAppStore } from "../../stores/appStore";
import { useVersioningStore } from "../../stores/versioningStore";
import { getContributorIdentity } from "../../services/identity";
import { resolveProjectSelection, timeOfDayGreeting } from "../../utils/home";
import { RecentWorkspaceList } from "../RecentWorkspaceList";
import { ContinueCard } from "./ContinueCard";
import { HomeComposer } from "./HomeComposer";
import { ContextMenu } from "../ContextMenu";
import { NewInRepoForm } from "./NewInRepoForm";
import { CloneWorkspaceForm, NewWorkspaceForm } from "./NewWorkspaceForms";
import { QuickStartCards } from "./QuickStartCards";
import { useHomeActions } from "./useHomeActions";

const linkButton =
  "show-underlines-target inline-flex items-center gap-1 rounded-control text-sm text-[rgb(var(--color-accent))] hover:underline focus:outline-none focus-visible:ring-2 focus-visible:ring-[rgb(var(--color-accent))]";

function useFirstName(): string | null {
  const [name, setName] = useState<string | null>(null);
  useEffect(() => {
    let cancelled = false;
    getContributorIdentity()
      .then((identity) => {
        if (!cancelled && !identity.needs_setup) setName(identity.name.trim().split(/\s+/)[0] || null);
      })
      .catch(() => {});
    return () => { cancelled = true; };
  }, []);
  return name;
}

export function HomeView() {
  const recentProjects = useAppStore((s) => s.recentProjects);
  const loading = useAppStore((s) => s.loading);
  const loadRecentProjects = useAppStore((s) => s.loadRecentProjects);
  const removeRecentProject = useAppStore((s) => s.removeRecentProject);
  const openProject = useAppStore((s) => s.openProject);
  const currentProject = useAppStore((s) => s.currentProject);
  const activeBranch = useVersioningStore((s) => s.timelines.find((t) => t.is_active)?.label ?? null);
  const actions = useHomeActions();
  const firstName = useFirstName();
  const [projectPath, setProjectPath] = useState<string | null>(null);
  const [form, setForm] = useState<"new" | "existing-repo" | "clone" | null>(null);
  const [newMenu, setNewMenu] = useState<{ x: number; y: number } | null>(null);

  useEffect(() => {
    void loadRecentProjects();
  }, [loadRecentProjects]);

  const target = resolveProjectSelection(projectPath, recentProjects);
  const greeting = timeOfDayGreeting(new Date());

  const pickFolder = async () => {
    const opened = await actions.openFolder(true);
    if (opened) setProjectPath(opened);
  };

  return (
    <div className="mx-auto w-full max-w-[900px] px-10 pb-20 pt-10">
      <div className="mb-1.5 inline-flex items-center gap-1.5 text-sm text-[rgb(var(--color-text-secondary))]">
        <img src="/cutready.svg" alt="" className="h-4 w-4" draggable={false} />
        {firstName ? `${greeting}, ${firstName}` : greeting}
      </div>
      <h1 className="text-[28px] font-semibold leading-9 tracking-tight">What are you presenting?</h1>
      <p className="mb-5 mt-1.5 text-sm text-[rgb(var(--color-text-secondary))]">
        Describe it in a sentence or bring what you have. Planner turns it into a storyboard of sketches you can edit.
      </p>

      <HomeComposer
        recents={recentProjects}
        projectPath={target}
        onProjectChange={setProjectPath}
        onOpenFolder={() => void pickFolder()}
        onSend={actions.sendPrompt}
        onAttach={actions.attachFile}
      />

      <QuickStartCards
        hasProject={!!target}
        onImportDeck={() => void actions.importAndDraft("deck", target)}
        onDraftFromDocument={() => void actions.importAndDraft("document", target)}
        onBlankSketch={() => void actions.startBlankSketch(target)}
        onOpenFolder={() => void actions.openFolder()}
      />

      <ContinueCard />

      <div className="mb-2.5 mt-8 flex items-baseline justify-between gap-3">
        <h2 className="text-sm font-semibold">Recent workspaces</h2>
        <div className="flex items-center gap-4">
          <button
            type="button"
            onClick={(e) => {
              const rect = e.currentTarget.getBoundingClientRect();
              setNewMenu(newMenu ? null : { x: rect.left, y: rect.bottom + 4 });
            }}
            // Keep the menu's outside-click handler from closing it before this toggles it.
            onMouseDown={(e) => { if (newMenu) e.nativeEvent.stopPropagation(); }}
            aria-haspopup="menu"
            aria-expanded={newMenu !== null}
            className={linkButton}
          >
            <Plus aria-hidden="true" className="h-3.5 w-3.5" />New<ChevronDown aria-hidden="true" className="h-3.5 w-3.5" />
          </button>
          {newMenu && (
            <ContextMenu
              position={newMenu}
              onClose={() => setNewMenu(null)}
              items={[
                { label: "New workspace", icon: <Plus className="h-3.5 w-3.5" />, action: () => setForm("new") },
                { label: "New in existing repo…", icon: <FolderGit2 className="h-3.5 w-3.5" />, action: () => setForm("existing-repo") },
              ]}
            />
          )}
          <button type="button" onClick={() => setForm(form === "clone" ? null : "clone")} aria-expanded={form === "clone"} className={linkButton}>
            <Download aria-hidden="true" className="h-3.5 w-3.5" />Clone
          </button>
          <button type="button" onClick={() => void actions.openFolder()} className={linkButton}>
            Open folder…
          </button>
        </div>
      </div>
      {form === "new" && <NewWorkspaceForm chooseFolder={actions.chooseFolder} onClose={() => setForm(null)} />}
      {form === "existing-repo" && <NewInRepoForm chooseFolder={actions.chooseFolder} onClose={() => setForm(null)} />}
      {form === "clone" && <CloneWorkspaceForm chooseFolder={actions.chooseFolder} onClose={() => setForm(null)} />}
      <div className={form ? "mt-3" : undefined}>
        {loading && recentProjects.length === 0 ? (
          <p className="py-6 text-sm text-[rgb(var(--color-text-secondary))]">Loading...</p>
        ) : recentProjects.length === 0 ? (
          <p className="rounded-card border border-dashed border-[rgb(var(--color-border))] px-4 py-6 text-center text-sm text-[rgb(var(--color-text-secondary))]">
            No recent workspaces yet.
          </p>
        ) : (
          <RecentWorkspaceList
            projects={recentProjects}
            onOpen={openProject}
            onRemove={removeRecentProject}
            currentPath={currentProject?.repo_root}
            currentBranch={activeBranch}
          />
        )}
      </div>
    </div>
  );
}
