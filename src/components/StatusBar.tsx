import { useEffect, useState } from "react";
import { MessageSquare } from "lucide-react";
import { useAppStore } from "../stores/appStore";

interface StatusBarProps {
  onFeedback?: () => void;
}

export function StatusBar({ onFeedback }: StatusBarProps) {
  const [version, setVersion] = useState("");
  const currentProject = useAppStore((s) => s.currentProject);
  const changedFilesCount = useAppStore((s) => s.changedFiles.length);

  useEffect(() => {
    import("@tauri-apps/api/app")
      .then(({ getVersion }) => getVersion())
      .then((v) => setVersion(import.meta.env.DEV ? `${v}-dev` : v))
      .catch(() => setVersion("dev"));
  }, []);

  return (
    <div
      className="no-select fixed bottom-0 left-0 right-0 z-chrome flex items-center border-t border-[rgb(var(--color-border-subtle))] bg-[rgb(var(--color-surface))] px-3 text-xs text-[rgb(var(--color-text-secondary))]"
      style={{ height: "var(--statusbar-height)" }}
    >
      <div className="flex min-w-0 flex-1 items-center gap-2">
        <span className="truncate">
          {currentProject ? currentProject.name : "No project open"}
        </span>
        {currentProject && changedFilesCount > 0 && (
          <span className="rounded bg-[rgb(var(--color-accent))]/10 px-2 py-0.5 text-[10px] font-medium text-[rgb(var(--color-accent))]">
            {changedFilesCount} changed
          </span>
        )}
      </div>
      {onFeedback && (
        <button
          type="button"
          onClick={onFeedback}
          className="mr-2 inline-flex h-6 items-center gap-1.5 rounded-md px-2 text-[11px] text-[rgb(var(--color-text-secondary))] transition-colors hover:bg-[rgb(var(--color-surface-alt))] hover:text-[rgb(var(--color-text))]"
          title="Send Feedback"
          aria-label="Send feedback"
          data-testid="status-feedback"
        >
          <MessageSquare className="h-3.5 w-3.5" />
          Feedback
        </button>
      )}
      {version && <span className="opacity-60">v{version}</span>}
    </div>
  );
}
