import { useCallback, useState } from "react";
import { emptyStartedTimeline } from "../../domain/versioning";
import { runVersionOperation } from "../../services/versionOperation";
import { useVersioningStore } from "../../stores/versioningStore";
import { UnsavedWorkspaceDialog } from "../UnsavedWorkspaceDialog";
import { useConfirmDialog } from "../ConfirmDialog";

interface PendingSwitch {
  label: string;
  run: () => Promise<void>;
}

/**
 * Runs a timeline change (switch or adopt) through the operation boundary,
 * so open edits are on disk before deciding. Asks first when there are
 * unsaved changes: save a version and continue, or set them aside. After
 * setting work aside on a timeline that never got a save of its own, offers
 * to delete it.
 */
export function useTimelineSwitch() {
  const hasStash = useVersioningStore((s) => s.hasStash);
  const [pending, setPending] = useState<PendingSwitch | null>(null);
  const { confirm, confirmationDialog } = useConfirmDialog();

  const request = useCallback((label: string, run: () => Promise<void>) =>
    runVersionOperation(`Switch to ${label}`, async (summary) => {
      if (summary.documents.length > 0 || useVersioningStore.getState().isDirty) {
        setPending({ label, run });
        return;
      }
      await run();
    }), []);

  const setAside = async () => {
    if (!pending) return;
    const { run } = pending;
    setPending(null);
    const state = useVersioningStore.getState();
    const leftBehind = emptyStartedTimeline(
      state.startedBranchFromSnapshot,
      state.timelines.find((timeline) => timeline.is_active),
      state.graphNodes,
    );
    if (!await runVersionOperation("Set aside", () => state.stashChanges())) return;
    await run();
    if (!leftBehind) return;
    const remove = await confirm({
      title: "Delete the empty timeline too?",
      message: `Your changes on ${leftBehind} were set aside. It has no saved versions beyond where it started. Delete it as well?`,
      confirmLabel: "Delete timeline",
      cancelLabel: "Keep timeline",
      variant: "warning",
    });
    if (remove) await useVersioningStore.getState().deleteTimeline(leftBehind);
  };

  const dialog = (
    <>
      <UnsavedWorkspaceDialog
        open={!!pending}
        targetLabel={pending?.label ?? "that timeline"}
        onCancel={() => setPending(null)}
        onSaveFirst={() => {
          if (!pending) return;
          useVersioningStore.setState({ pendingActionAfterSave: pending.run, snapshotPromptOpen: true });
          setPending(null);
        }}
        onSetAside={hasStash ? undefined : () => void setAside().catch((err) => console.error("Set aside failed:", err))}
      />
      {confirmationDialog}
    </>
  );

  return { request, dialog };
}
