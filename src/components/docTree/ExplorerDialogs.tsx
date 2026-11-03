import { useEffect, useRef, useState } from "react";
import type { ProjectEntry } from "../../types/project";
import { Dialog } from "../Dialog";

export type ExplorerAssetType = "storyboard" | "sketch" | "note" | "chat-artifact";
export type TransferType = "sketch" | "note" | "storyboard";

export interface PendingDelete {
  type: ExplorerAssetType;
  path: string;
  title: string;
  usedBy?: string[];
}

interface TransferRequest {
  action: "move" | "copy";
  type: TransferType;
  sourcePath: string;
  sourceTitle: string;
  destProject: ProjectEntry;
}

export interface TransferWarning extends TransferRequest {
  usedBy: string[];
}

export interface TransferConflict extends TransferRequest {
  ext: string;
  /** Suggested file name without its extension. */
  stem: string;
}

/** Moves focus into the dialog when it opens and back to the opener when it closes. */
function useDialogFocus(open: boolean, focusTarget: () => void) {
  const openerRef = useRef<HTMLElement | null>(null);
  useEffect(() => {
    if (!open) return;
    openerRef.current = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    requestAnimationFrame(focusTarget);
    return () => {
      const opener = openerRef.current;
      if (opener?.isConnected) opener.focus();
    };
    // Focus once per open; focusTarget only reads refs.
  }, [open]);
}

const cancelClass =
  "px-3 py-1.5 text-xs rounded-lg border border-[rgb(var(--color-border))] text-[rgb(var(--color-text-secondary))] hover:text-[rgb(var(--color-text))] transition-colors";

function UsedByNotice({ id, usedBy, consequence, testId }: { id?: string; usedBy: string[]; consequence: string; testId?: string }) {
  return (
    <div id={id} className="mb-3 px-3 py-2 rounded-lg bg-warning/10 border border-warning/30" data-testid={testId}>
      <p className="text-xs text-warning font-medium mb-1">
        ⚠ Used in {usedBy.length === 1 ? "a storyboard" : `${usedBy.length} storyboards`}:
      </p>
      <ul className="text-xs text-warning/80 list-disc list-inside">
        {usedBy.map((t) => <li key={t}>{t}</li>)}
      </ul>
      <p className="text-xs text-warning/80 mt-1">{consequence}</p>
    </div>
  );
}

/** Confirms deleting a document, warning when storyboards still reference it. */
export function DeleteAssetDialog({ pending, onCancel, onConfirm }: { pending: PendingDelete | null; onCancel: () => void; onConfirm: (pending: PendingDelete) => void }) {
  const cancelRef = useRef<HTMLButtonElement>(null);
  useDialogFocus(!!pending, () => cancelRef.current?.focus());
  return (
    <Dialog isOpen={!!pending} onClose={onCancel} labelledBy="delete-asset-title" describedBy={`delete-asset-desc${pending?.usedBy?.length ? " delete-asset-refs" : ""}`} role="alertdialog" width="max-w-sm mx-4">
      {pending && (
        <div className="cr-modal-surface p-5" data-testid="delete-asset-dialog">
          <p id="delete-asset-title" className="text-sm text-[rgb(var(--color-text))] mb-1 font-medium">
            Delete {pending.type === "chat-artifact" ? "chat" : pending.type}?
          </p>
          <p id="delete-asset-desc" className="text-xs text-[rgb(var(--color-text-secondary))] mb-2">"{pending.title}" will be permanently deleted.</p>
          {pending.usedBy && pending.usedBy.length > 0 && (
            <UsedByNotice id="delete-asset-refs" usedBy={pending.usedBy} consequence="Deleting will leave broken references." testId="delete-asset-used-by" />
          )}
          <div className="flex gap-2 justify-end">
            <button ref={cancelRef} type="button" onClick={onCancel} className={cancelClass}>Cancel</button>
            <button
              type="button"
              data-testid="delete-asset-confirm"
              onClick={() => onConfirm(pending)}
              className="px-3 py-1.5 text-xs rounded-lg bg-error text-accent-fg hover:bg-error/80 transition-colors"
            >
              Delete
            </button>
          </div>
        </div>
      )}
    </Dialog>
  );
}

/** Warns before moving a sketch that storyboards in this project still reference. */
export function TransferWarningDialog({ warning, onCancel, onConfirm }: { warning: TransferWarning | null; onCancel: () => void; onConfirm: (warning: TransferWarning) => void }) {
  const cancelRef = useRef<HTMLButtonElement>(null);
  useDialogFocus(!!warning, () => cancelRef.current?.focus());
  return (
    <Dialog isOpen={!!warning} onClose={onCancel} labelledBy="transfer-warning-title" describedBy="transfer-warning-desc" role="alertdialog" width="max-w-sm mx-4">
      {warning && (
        <div className="cr-modal-surface p-5">
          <p id="transfer-warning-title" className="text-sm text-[rgb(var(--color-text))] mb-2 font-medium">Move "{warning.sourceTitle}"?</p>
          <UsedByNotice id="transfer-warning-desc" usedBy={warning.usedBy} consequence="Moving will leave broken references in this project." />
          <div className="flex gap-2 justify-end">
            <button ref={cancelRef} type="button" onClick={onCancel} className={cancelClass}>Cancel</button>
            <button
              type="button"
              onClick={() => onConfirm(warning)}
              className="px-3 py-1.5 text-xs rounded-lg bg-warning text-[rgb(var(--color-accent-fg))] hover:bg-warning/80 transition-colors"
            >
              Move anyway
            </button>
          </div>
        </div>
      )}
    </Dialog>
  );
}

/** Asks for a new name when the destination project already has a file with this one. */
export function TransferConflictDialog({ conflict, onCancel, onSubmit }: { conflict: TransferConflict | null; onCancel: () => void; onSubmit: (conflict: TransferConflict, destRel: string) => void }) {
  // Edits belong to one conflict, so a new one shows its own stem on the first render.
  const [edit, setEdit] = useState<{ conflict: TransferConflict; name: string } | null>(null);
  const name = edit && edit.conflict === conflict ? edit.name : conflict?.stem ?? "";
  const inputRef = useRef<HTMLInputElement>(null);
  useDialogFocus(!!conflict, () => {
    inputRef.current?.focus();
    inputRef.current?.select();
  });

  const submit = () => {
    const stem = name.trim();
    if (!conflict || !stem) return;
    const { sourcePath, ext } = conflict;
    const dir = sourcePath.includes("/") ? sourcePath.substring(0, sourcePath.lastIndexOf("/") + 1) : "";
    onSubmit(conflict, `${dir}${stem}${ext}`);
  };

  return (
    <Dialog isOpen={!!conflict} onClose={onCancel} labelledBy="transfer-conflict-title" describedBy="transfer-conflict-desc" width="max-w-sm mx-4">
      {conflict && (
        <div className="cr-modal-surface p-5">
          <p id="transfer-conflict-title" className="text-sm text-[rgb(var(--color-text))] mb-1 font-medium">File already exists</p>
          <p id="transfer-conflict-desc" className="text-xs text-[rgb(var(--color-text-secondary))] mb-3">
            A file with this name already exists in "{conflict.destProject.name}". Enter a new name:
          </p>
          <input
            ref={inputRef}
            value={name}
            onChange={(e) => conflict && setEdit({ conflict, name: e.target.value })}
            onKeyDown={(e) => {
              if (e.key === "Enter") submit();
            }}
            aria-label="New file name"
            placeholder="new-name"
            className="w-full px-3 py-2 text-xs rounded-lg bg-[rgb(var(--color-surface-alt))] border border-[rgb(var(--color-border))] text-[rgb(var(--color-text))] focus:outline-none focus:ring-1 focus:ring-[rgb(var(--color-accent))]/40 mb-3"
          />
          <div className="flex gap-2 justify-end">
            <button type="button" onClick={onCancel} className={cancelClass}>Cancel</button>
            <button
              type="button"
              onClick={submit}
              className="px-3 py-1.5 text-xs rounded-lg bg-[rgb(var(--color-accent))] text-[rgb(var(--color-accent-fg))] hover:bg-[rgb(var(--color-accent-hover))] transition-colors"
            >
              {conflict.action === "move" ? "Move As" : "Copy As"}
            </button>
          </div>
        </div>
      )}
    </Dialog>
  );
}
