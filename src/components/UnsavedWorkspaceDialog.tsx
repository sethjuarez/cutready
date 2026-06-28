import { DecisionDialog } from "./DecisionDialog";

interface UnsavedWorkspaceDialogProps {
  open: boolean;
  targetLabel: string;
  onSaveFirst: () => void | Promise<void>;
  onDiscardAndContinue: () => void | Promise<void>;
  onCancel: () => void;
}

export function UnsavedWorkspaceDialog({
  open,
  targetLabel,
  onSaveFirst,
  onDiscardAndContinue,
  onCancel,
}: UnsavedWorkspaceDialogProps) {
  return (
    <DecisionDialog
      open={open}
      title="Save changes before continuing?"
      message={(
        <>
          You have workspace changes that are not in a snapshot. Before switching to{" "}
          <span className="font-medium text-[rgb(var(--color-text))]">{targetLabel}</span>, save a snapshot or discard the local changes.
        </>
      )}
      actions={[
        { id: "cancel", label: "Cancel", onSelect: onCancel },
        { id: "discard", label: "Discard and continue", variant: "danger", onSelect: onDiscardAndContinue },
        { id: "save", label: "Save snapshot first", variant: "primary", onSelect: onSaveFirst },
      ]}
      onClose={onCancel}
    />
  );
}

