// Runs import requests from the sidebar, palette and file drops, one at a time,
// and hosts the dialogs an import can need.
import { useEffect, useRef } from "react";
import { useFileDropImport } from "../../hooks/useFileDropImport";
import { useImportStore } from "../../stores/importStore";
import { ConfirmDialog } from "../ConfirmDialog";
import { useImportCommand } from "./useImportCommand";
import { useProjectImport } from "./useProjectImport";
import { VideoImportPlanningContextDialog, VideoImportProgressDialog } from "./VideoImportDialogs";

const PROTECTED_MESSAGE =
  "This document is protected. To import it:\n\n1. Open the file in Word\n2. Select all text (Ctrl+A)\n3. Copy it (Ctrl+C)\n4. Click Import below\n\nThe note will be created from your clipboard.";

export function ProjectImport() {
  useImportCommand();
  useFileDropImport();
  const importer = useProjectImport();
  const runRef = useRef(importer.run);
  runRef.current = importer.run;
  const pending = useImportStore((s) => s.pending);

  useEffect(() => {
    if (!pending) return;
    const request = useImportStore.getState().take();
    if (!request) return;
    void runRef.current(request).finally(() => useImportStore.getState().finish());
  }, [pending]);

  const { videoContext } = importer;
  return (
    <>
      <ConfirmDialog
        open={importer.drmConfirmOpen}
        title="Protected Document"
        message={PROTECTED_MESSAGE}
        confirmLabel="Import from Clipboard"
        cancelLabel="Cancel"
        variant="warning"
        onConfirm={() => importer.resolveDrmConfirm(true)}
        onCancel={() => importer.resolveDrmConfirm(false)}
      />
      <VideoImportProgressDialog progress={importer.progress} onClose={importer.closeProgress} />
      <VideoImportPlanningContextDialog
        open={videoContext.open}
        value={videoContext.text}
        references={videoContext.references}
        onChange={videoContext.setText}
        onInsertMention={videoContext.insertMention}
        onContinue={videoContext.proceed}
        onCancel={videoContext.cancel}
      />
    </>
  );
}
