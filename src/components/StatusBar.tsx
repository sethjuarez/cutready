import { useEffect, useState } from "react";
import { useAppStore } from "../stores/appStore";

export function StatusBar() {
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
      {version && <span className="opacity-60">v{version}</span>}
    </div>
  );
}
