import { useAppStore } from "../stores/appStore";

export function ScriptEditorPanel() {
  const project = useAppStore((s) => s.currentProject);
  const closeProject = useAppStore((s) => s.closeProject);

  if (!project) {
    return (
      <div className="flex items-center justify-center h-full text-[var(--color-text-secondary)]">
        No project open. Go to Home to select one.
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
          <p className="text-xs text-[var(--color-text-secondary)] mt-0.5">
            {project.script.rows.length} segments
          </p>
        </div>
        <button
          onClick={closeProject}
          className="px-3 py-1.5 rounded-lg text-sm text-[var(--color-text-secondary)] hover:bg-[var(--color-surface-alt)] transition-colors"
        >
          Close
        </button>
      </div>

      {/* Empty state */}
      {project.script.rows.length === 0 ? (
        <div className="text-center py-20">
          <div className="text-4xl mb-4">🎬</div>
          <h3 className="text-lg font-medium mb-2">No script yet</h3>
          <p className="text-sm text-[var(--color-text-secondary)] max-w-sm mx-auto">
            Record a demo walkthrough to generate your first script, or add
            segments manually.
          </p>
          <div className="flex justify-center gap-3 mt-6">
            <button
              disabled
              className="px-4 py-2 rounded-lg bg-[var(--color-accent)] text-white text-sm font-medium opacity-50 cursor-not-allowed"
              title="Recording not yet implemented"
            >
              Record Demo
            </button>
          </div>
        </div>
      ) : (
        <div className="text-[var(--color-text-secondary)] text-sm">
          Script table editor will be implemented in Phase 2.
        </div>
      )}
    </div>
  );
}

