import { useAppStore } from "../stores/appStore";

export function ScriptEditorPanel() {
  const project = useAppStore((s) => s.currentProject);
  const closeProject = useAppStore((s) => s.closeProject);

  if (!project) {
    return (
      <div className="flex items-center justify-center h-full text-[rgb(var(--color-text-secondary))]">
        No workspace open. Go to Home to select one.
      </div>
    );
  }

  return (
    <div className="px-6 py-6">
      {/* Project header */}
      <div className="flex items-center justify-between mb-6">
        <div>
          <h2 className="text-xl font-semibold tracking-tight">
            {project.name}
          </h2>
          <p className="text-xs text-[rgb(var(--color-text-secondary))] mt-0.5">
            Script Editor
          </p>
        </div>
        <button
          onClick={closeProject}
          className="px-3 py-1.5 rounded-lg text-sm text-[rgb(var(--color-text-secondary))] hover:bg-[rgb(var(--color-surface-alt))] transition-colors"
        >
          Close
        </button>
      </div>

      {/* Empty state */}
      <div className="text-center py-20">
        <div className="text-4xl mb-4">🎬</div>
        <h3 className="text-lg font-medium mb-2">No script yet</h3>
        <p className="text-sm text-[rgb(var(--color-text-secondary))] max-w-sm mx-auto">
          Record a demo walkthrough to generate your first script, or add
          segments manually.
        </p>
        <div className="flex justify-center gap-3 mt-6">
          <button
            disabled
            className="px-4 py-2 rounded-lg bg-[rgb(var(--color-accent))] text-[rgb(var(--color-accent-fg))] text-sm font-medium opacity-50 cursor-not-allowed"
            title="Recording not yet implemented"
          >
            Record Demo
          </button>
        </div>
      </div>
    </div>
  );
}

