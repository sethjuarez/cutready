import { useEffect } from "react";
import { useAppStore } from "../stores/appStore";

const MAX_LISTED = 8;

/** The unsaved files a discard or shelve would affect, refreshed when shown. */
export function WorkspaceChangesList() {
  const changedFiles = useAppStore((s) => s.changedFiles);
  const refreshChangedFiles = useAppStore((s) => s.refreshChangedFiles);

  useEffect(() => {
    void refreshChangedFiles();
  }, [refreshChangedFiles]);

  if (changedFiles.length === 0) return null;
  const listed = changedFiles.slice(0, MAX_LISTED);
  const remaining = changedFiles.length - listed.length;

  return (
    <ul data-testid="workspace-changes-list" className="mt-2 max-h-40 overflow-y-auto rounded-md border border-[rgb(var(--color-border))] bg-[rgb(var(--color-surface-alt))]/55 px-2 py-1.5 font-mono text-[11px] leading-5 text-[rgb(var(--color-text))]">
      {listed.map((file) => (
        <li key={file.path} className="truncate" title={file.path}>
          <span className="mr-1.5 text-[rgb(var(--color-text-secondary))]">{statusLetter(file.status)}</span>
          {file.path}
        </li>
      ))}
      {remaining > 0 && <li className="text-[rgb(var(--color-text-secondary))]">and {remaining} more</li>}
    </ul>
  );
}

function statusLetter(status: string): string {
  if (status === "added") return "A";
  if (status === "deleted") return "D";
  return "M";
}
