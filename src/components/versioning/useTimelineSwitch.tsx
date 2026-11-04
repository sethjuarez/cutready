import { useCallback } from "react";
import { emptyStartedTimeline } from "../../domain/versioning";
import { requestPreAction } from "../../services/preAction";
import { useVersioningStore } from "../../stores/versioningStore";
import { useConfirmDialog } from "../ConfirmDialog";

/**
 * Runs a timeline change (switch or adopt) through the shared pre-action
 * dialog. After setting work aside on a timeline that never got a save of
 * its own, offers to delete it.
 */
export function useTimelineSwitch() {
  const { confirm, confirmationDialog } = useConfirmDialog();

  const request = useCallback((label: string, run: () => Promise<void>) => {
    const onSetAside = () => {
      // Decided before shelving: afterwards the timeline looks clean either way.
      const state = useVersioningStore.getState();
      const leftBehind = emptyStartedTimeline(
        state.startedBranchFromSnapshot,
        state.timelines.find((timeline) => timeline.is_active),
        state.graphNodes,
      );
      if (!leftBehind) return;
      return async () => {
        const remove = await confirm({
          title: "Delete the empty timeline too?",
          message: `Your changes on ${leftBehind} were set aside. It has no saved versions beyond where it started. Delete it as well?`,
          confirmLabel: "Delete timeline",
          cancelLabel: "Keep timeline",
          variant: "warning",
        });
        if (remove) await useVersioningStore.getState().deleteTimeline(leftBehind);
      };
    };
    return requestPreAction({ operation: `Switch to ${label}`, target: `switching to ${label}`, run, onSetAside });
  }, [confirm]);

  return { request, dialog: confirmationDialog };
}
