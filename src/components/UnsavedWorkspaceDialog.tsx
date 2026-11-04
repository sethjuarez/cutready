import { DecisionDialog } from "./DecisionDialog";
import type { DecisionDialogAction } from "./DecisionDialog";
import { WorkspaceChangesList } from "./WorkspaceChangesList";

interface UnsavedWorkspaceDialogProps {
  open: boolean;
  targetLabel: string;
  onSaveFirst: () => void | Promise<void>;
  /** Shelve the changes so they can be restored later; omitted when a shelf already exists. */
  onSetAside?: () => void | Promise<void>;
  onCancel: () => void;
}

/** Shown before switching timelines with unsaved changes. Nothing is lost without a choice. */
export function UnsavedWorkspaceDialog({
  open,
  targetLabel,
  onSaveFirst,
  onSetAside,
  onCancel,
}: UnsavedWorkspaceDialogProps) {
  const actions: DecisionDialogAction[] = [{ id: "cancel", label: "Cancel", onSelect: onCancel }];
  if (onSetAside) actions.push({ id: "set-aside", label: "Set aside & switch", onSelect: onSetAside });
  actions.push({ id: "save", label: "Save version & continue", variant: "primary", onSelect: onSaveFirst });

  return (
    <DecisionDialog
      open={open}
      title="Save your changes first?"
      message={(
        <>
          You have unsaved changes. Before switching to{" "}
          <span className="font-medium text-[rgb(var(--color-text))]">{targetLabel}</span>, save them as a version
          {onSetAside ? ", or set them aside to restore later" : ""}.
          <WorkspaceChangesList />
        </>
      )}
      actions={actions}
      onClose={onCancel}
    />
  );
}
