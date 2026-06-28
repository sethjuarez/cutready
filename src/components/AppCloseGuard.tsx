import { useCallback, useEffect, useRef, useState } from "react";
import { getCurrentWindow } from "@tauri-apps/api/window";
import { DecisionDialog } from "./DecisionDialog";
import { useAppStore } from "../stores/appStore";

type CloseReason = "dirty" | "merge";

export function AppCloseGuard() {
  const currentProject = useAppStore((state) => state.currentProject);
  const isDirty = useAppStore((state) => state.isDirty);
  const isMerging = useAppStore((state) => state.isMerging);
  const cancelMerge = useAppStore((state) => state.cancelMerge);
  const appWindowRef = useRef<ReturnType<typeof getCurrentWindow> | null>(null);
  const allowCloseRef = useRef(false);
  const [closeReason, setCloseReason] = useState<CloseReason | null>(null);

  useEffect(() => {
    const appWindow = getCurrentWindow();
    appWindowRef.current = appWindow;
    let disposed = false;
    let unlisten: (() => void) | undefined;

    appWindow.onCloseRequested((event) => {
      if (allowCloseRef.current || !currentProject) return;
      if (isMerging) {
        event.preventDefault();
        setCloseReason("merge");
        return;
      }
      if (isDirty) {
        event.preventDefault();
        setCloseReason("dirty");
      }
    }).then((off) => {
      if (disposed) {
        off();
      } else {
        unlisten = off;
      }
    }).catch(() => {
      appWindowRef.current = null;
    });

    return () => {
      disposed = true;
      unlisten?.();
    };
  }, [currentProject, isDirty, isMerging]);

  const closeNow = useCallback(async () => {
    allowCloseRef.current = true;
    setCloseReason(null);
    await appWindowRef.current?.close();
  }, []);

  if (!closeReason) return null;

  if (closeReason === "merge") {
    return (
      <DecisionDialog
        open
        title="Finish merge before closing?"
        message="Incoming saves are waiting for conflict resolution. Closing now abandons the in-progress resolution flow, though your files remain on disk."
        actions={[
          { id: "stay", label: "Stay and resolve", onSelect: () => setCloseReason(null) },
          {
            id: "quit",
            label: "Cancel merge and quit",
            variant: "danger",
            onSelect: async () => {
              cancelMerge();
              if (useAppStore.getState().isDirty) {
                setCloseReason("dirty");
                return;
              }
              await closeNow();
            },
          },
        ]}
        onClose={() => setCloseReason(null)}
      />
    );
  }

  return (
    <DecisionDialog
      open
      title="Quit with unsaved snapshot?"
      message="Your edits are saved on disk, but they are not captured in a snapshot yet. Save a snapshot before quitting if you want a restorable checkpoint."
      actions={[
        { id: "cancel", label: "Keep working", onSelect: () => setCloseReason(null) },
        {
          id: "save",
          label: "Save snapshot first",
          variant: "primary",
          onSelect: () => {
            useAppStore.setState({ snapshotPromptOpen: true });
            setCloseReason(null);
          },
        },
        { id: "quit", label: "Quit anyway", variant: "danger", onSelect: closeNow },
      ]}
      onClose={() => setCloseReason(null)}
    />
  );
}
