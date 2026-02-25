import { useAppStore } from "../stores/appStore";
import { DocumentList } from "./DocumentList";
import { SketchEditor } from "./SketchEditor";
import { VersionHistory } from "./VersionHistory";

export function SketchPanel() {
  const activeDocument = useAppStore((s) => s.activeDocument);
  const showVersionHistory = useAppStore((s) => s.showVersionHistory);
  const toggleVersionHistory = useAppStore((s) => s.toggleVersionHistory);

  return (
    <div className="flex h-full">
      {/* Left: Document list */}
      <DocumentList />

      {/* Center: Editor or empty state */}
      <div className="flex-1 flex flex-col min-w-0">
        {/* Toolbar */}
        <div className="flex items-center justify-between px-4 py-2 border-b border-[var(--color-border)]">
          <div className="text-sm font-medium truncate">
            {activeDocument?.title ?? "Select a document"}
          </div>
          <div className="flex items-center gap-2">
            <button
              onClick={toggleVersionHistory}
              className={`p-1.5 rounded-md transition-colors ${
                showVersionHistory
                  ? "text-[var(--color-accent)] bg-[var(--color-accent)]/10"
                  : "text-[var(--color-text-secondary)] hover:text-[var(--color-text)] hover:bg-[var(--color-surface)]"
              }`}
              title="Toggle version history"
            >
              <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                <circle cx="12" cy="12" r="10" />
                <polyline points="12 6 12 12 16 14" />
              </svg>
            </button>
          </div>
        </div>

        {/* Editor area */}
        {activeDocument ? (
          <SketchEditor />
        ) : (
          <div className="flex-1 flex items-center justify-center">
            <div className="text-center">
              <div className="text-4xl mb-4">📝</div>
              <p className="text-sm text-[var(--color-text-secondary)]">
                Select a document or create a new one
              </p>
            </div>
          </div>
        )}
      </div>

      {/* Right: Version history */}
      {showVersionHistory && <VersionHistory />}
    </div>
  );
}
