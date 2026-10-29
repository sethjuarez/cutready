import { useEffect, useState } from "react";
import { FolderInput } from "lucide-react";
import { Dialog } from "./Dialog";
import { useAppStore } from "../stores/appStore";
import { moveProjectFolderErrorMessage } from "../services/draftlineErrors";
import type { ProjectView } from "../types/project";

function normalize(path: string): string {
  return path.replace(/[\\/]+/g, "/").replace(/\/$/, "");
}

/** The project folder relative to its repository; empty when it is the repository root. */
export function projectFolderInRepository(project: Pick<ProjectView, "repo_root" | "git_root">): string {
  const folder = normalize(project.repo_root);
  const repository = normalize(project.git_root ?? project.repo_root);
  if (folder.toLowerCase() === repository.toLowerCase()) return "";
  return folder.toLowerCase().startsWith(`${repository.toLowerCase()}/`)
    ? folder.slice(repository.length + 1)
    : "";
}

/** Moves the CutReady folder within its repository, keeping its history. */
export function MoveProjectFolderDialog() {
  const open = useAppStore((s) => s.moveFolderDialogOpen);
  const setOpen = useAppStore((s) => s.setMoveFolderDialogOpen);
  const project = useAppStore((s) => s.currentProject);
  const isDirty = useAppStore((s) => s.isDirty);
  const moveProjectFolder = useAppStore((s) => s.moveProjectFolder);
  const [to, setTo] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const current = project ? projectFolderInRepository(project) : "";
  useEffect(() => {
    if (!open) return;
    setTo(current || "cutready");
    setError(null);
    setBusy(false);
  }, [open, current]);

  if (!open || !project) return null;

  const destination = normalize(to.trim()).replace(/^\.\/?/, "");
  const unchanged = destination === current;
  const fromRoot = current === "";
  const toRoot = destination === "";
  const close = () => {
    if (!busy) setOpen(false);
  };
  const submit = async () => {
    if (busy || unchanged || isDirty) return;
    setBusy(true);
    setError(null);
    try {
      await moveProjectFolder(destination);
    } catch (err) {
      const friendly = moveProjectFolderErrorMessage(err);
      setError(friendly ?? (err instanceof Error ? err.message : String((err as { message?: unknown })?.message ?? err)));
      setBusy(false);
    }
  };

  return (
    <Dialog isOpen={open} onClose={close} align="top" topOffset="18vh" width="w-full max-w-lg mx-4">
      <form
        className="cr-modal-surface overflow-hidden rounded-2xl"
        data-testid="move-project-folder-dialog"
        onSubmit={(event) => {
          event.preventDefault();
          void submit();
        }}
      >
        <div className="flex items-start gap-3 border-b border-[rgb(var(--color-border))] px-5 py-4">
          <div className="mt-0.5 grid h-9 w-9 shrink-0 place-items-center rounded-xl bg-[rgb(var(--color-accent))]/10 text-[rgb(var(--color-accent))]">
            <FolderInput className="h-4.5 w-4.5" />
          </div>
          <div className="min-w-0 flex-1 space-y-3">
            <div>
              <h2 className="text-sm font-semibold text-[rgb(var(--color-text))]">Move project folder</h2>
              <p className="mt-1 text-xs leading-5 text-[rgb(var(--color-text-secondary))]">
                {fromRoot
                  ? "The project is at the root of its repository. Move it into a folder so code can live beside it."
                  : `The project is in "${current}/". Its history, settings, and chats move with it.`}
              </p>
            </div>
            <label className="block text-xs font-medium text-[rgb(var(--color-text))]">
              New folder, relative to the repository
              <input
                autoFocus
                value={to}
                onChange={(event) => setTo(event.target.value)}
                disabled={busy}
                placeholder="cutready"
                spellCheck={false}
                data-testid="move-project-folder-input"
                className="mt-1.5 w-full rounded-lg border border-[rgb(var(--color-border))] bg-[rgb(var(--color-surface))] px-2.5 py-1.5 font-mono text-xs text-[rgb(var(--color-text))] outline-none focus:border-[rgb(var(--color-accent))]"
              />
            </label>
            {fromRoot && !toRoot && (
              <p className="text-xs leading-5 text-[rgb(var(--color-text-secondary))]">
                Afterwards the repository can hold code too. CutReady keeps its branches under <code>cutready/</code>, and
                Send opens a pull request instead of publishing directly.
              </p>
            )}
            {toRoot && !fromRoot && (
              <p className="text-xs leading-5 text-[rgb(var(--color-text-secondary))]">
                The project can only move to the repository root when the repository holds nothing else.
              </p>
            )}
            {isDirty && (
              <p className="text-xs leading-5 text-[rgb(var(--color-warning))]" data-testid="move-project-folder-dirty">
                Save your changes first. Moving the folder records a save.
              </p>
            )}
            {error && (
              <p className="text-xs leading-5 text-[rgb(var(--color-error))]" role="alert" data-testid="move-project-folder-error">
                {error}
              </p>
            )}
          </div>
        </div>
        <div className="flex items-center justify-end gap-2 px-5 py-4">
          <button
            type="button"
            onClick={close}
            disabled={busy}
            className="rounded-lg border border-[rgb(var(--color-border))] px-3 py-1.5 text-xs font-semibold text-[rgb(var(--color-text-secondary))] transition-colors hover:bg-[rgb(var(--color-surface-alt))] hover:text-[rgb(var(--color-text))] disabled:opacity-45"
          >
            Cancel
          </button>
          <button
            type="submit"
            disabled={busy || unchanged || isDirty}
            data-testid="move-project-folder-submit"
            className="rounded-lg bg-[rgb(var(--color-accent))] px-3 py-1.5 text-xs font-semibold text-[rgb(var(--color-accent-fg))] transition-colors hover:bg-[rgb(var(--color-accent-hover))] disabled:pointer-events-none disabled:opacity-45"
          >
            {busy ? "Moving…" : "Move"}
          </button>
        </div>
      </form>
    </Dialog>
  );
}
