import { DecisionDialog } from "./DecisionDialog";
import type { DecisionDialogAction } from "./DecisionDialog";
import { WorkspaceChangesList } from "./WorkspaceChangesList";

interface UnsavedWorkspaceDialogProps {
  open: boolean;
  targetLabel: string;
  onSaveFirst: () => void | Promise<void>;
  onDiscardAndContinue: () => void | Promise<void>;
  /** Shelve the changes so they can be restored later; omitted when a shelf already exists. */
  onShelveAndContinue?: () => void | Promise<void>;
  onCancel: () => void;
}

export function UnsavedWorkspaceDialog({
  open,
  targetLabel,
  onSaveFirst,
  onDiscardAndContinue,
  onShelveAndContinue,
  onCancel,
}: UnsavedWorkspaceDialogProps) {
  const actions: DecisionDialogAction[] = [
    { id: "cancel", label: "Cancel", onSelect: onCancel },
    { id: "discard", label: "Discard and continue", variant: "danger", onSelect: onDiscardAndContinue },
  ];
  if (onShelveAndContinue) {
    actions.push({ id: "shelve", label: "Shelve and continue", onSelect: onShelveAndContinue });
  }
  actions.push({ id: "save", label: "Save snapshot first", variant: "primary", onSelect: onSaveFirst });

  return (
    <DecisionDialog
      open={open}
      title="Save changes before continuing?"
      message={(
        <>
          You have workspace changes that are not in a snapshot. Before switching to{" "}
          <span className="font-medium text-[rgb(var(--color-text))]">{targetLabel}</span>, save a snapshot,
          shelve the changes to restore later, or discard them.
          <WorkspaceChangesList />
        </>
      )}
      actions={actions}
      onClose={onCancel}
    />
  );
}

