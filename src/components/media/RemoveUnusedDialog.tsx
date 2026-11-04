import { useEffect, useId, useRef } from "react";
import { Dialog } from "../Dialog";
import type { MediaItem } from "../../utils/media";
import { MediaKindIcon } from "./MediaKindIcon";

interface RemoveUnusedDialogProps {
  open: boolean;
  remove: MediaItem[];
  keep: MediaItem[];
  busy?: boolean;
  onConfirm: () => void;
  onCancel: () => void;
}

/** Confirms "Remove unused": lists every file that will go, and says how to get them back. */
export function RemoveUnusedDialog({ open, remove, keep, busy = false, onConfirm, onCancel }: RemoveUnusedDialogProps) {
  const titleId = useId();
  const descriptionId = useId();
  const cancelRef = useRef<HTMLButtonElement>(null);
  useEffect(() => {
    if (open) requestAnimationFrame(() => cancelRef.current?.focus());
  }, [open]);
  if (!open) return null;

  const count = remove.length;
  return (
    <Dialog isOpen={open} onClose={onCancel} align="top" topOffset="14vh" width="w-full max-w-md mx-4" labelledBy={titleId} describedBy={descriptionId} role="alertdialog">
      <div className="cr-modal-surface overflow-hidden" data-testid="media-remove-dialog">
        <div className="px-5 pt-5 pb-3">
          <h2 id={titleId} className="mb-2 text-[15px] font-semibold text-[rgb(var(--color-text))]">
            Remove {count} unused {count === 1 ? "file" : "files"}?
          </h2>
          <p id={descriptionId} className="text-sm text-[rgb(var(--color-text-secondary))]">
            No sketch or note uses these. Removed files stay in your project history, so you can bring them back by
            restoring an earlier version. Files added since your last save aren't in history yet.
          </p>
        </div>
        <ul className="mx-5 max-h-60 overflow-y-auto rounded-lg border border-[rgb(var(--color-border))] py-1" aria-label="Files to remove">
          {remove.map((item) => (
            <li key={item.path} className="flex min-w-0 items-center gap-2 px-3 py-1 text-sm text-[rgb(var(--color-text))]">
              <MediaKindIcon kind={item.kind} className="h-4 w-4 shrink-0 text-[rgb(var(--color-text-secondary))]" />
              <span className="truncate" title={item.path}>{item.name}</span>
            </li>
          ))}
        </ul>
        {keep.length > 0 && (
          <p className="mx-5 mt-2 text-xs text-[rgb(var(--color-text-secondary))]">
            {keep.length} unused {keep.length === 1 ? "file lives" : "files live"} elsewhere in your project folder and{" "}
            {keep.length === 1 ? "is" : "are"} kept.
          </p>
        )}
        <div className="flex items-center justify-end gap-2 px-5 pt-4 pb-4">
          <button ref={cancelRef} type="button" onClick={onCancel} className="cr-btn">Cancel</button>
          <button
            type="button"
            onClick={onConfirm}
            disabled={busy || count === 0}
            className="cr-btn cr-btn-danger"
            data-testid="media-remove-confirm"
          >
            Remove {count} {count === 1 ? "file" : "files"}
          </button>
        </div>
      </div>
    </Dialog>
  );
}
