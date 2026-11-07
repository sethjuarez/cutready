// Files dropped on the sidebar import the same way as the Import… picker.
import { useEffect } from "react";
import { onFileDrop, type FileDropEvent } from "../ipc/fileDrop";
import { partitionImportable, skippedFilesMessage } from "../components/import/importRouting";
import { useAppStore } from "../stores/appStore";
import { useImportStore } from "../stores/importStore";
import { useToastStore } from "../stores/toastStore";

const SIDEBAR_ID = "app-sidebar";

function overSidebar(x: number, y: number) {
  const sidebar = document.getElementById(SIDEBAR_ID);
  if (!sidebar || sidebar.dataset.expanded === "false") return false;
  const rect = sidebar.getBoundingClientRect();
  return x >= rect.left && x <= rect.right && y >= rect.top && y <= rect.bottom;
}

/** Handles one drag event; exported for tests. */
export function handleFileDrop(event: FileDropEvent) {
  const imports = useImportStore.getState();
  const root = useAppStore.getState().currentProject?.root;
  const accepts = event.type !== "leave" && !!root && !imports.busy && overSidebar(event.x, event.y);
  imports.setDropActive(event.type === "over" && accepts);
  if (event.type !== "drop" || !accepts) return;
  const { supported, unsupported } = partitionImportable(event.paths);
  if (unsupported.length) useToastStore.getState().show(skippedFilesMessage(unsupported), 5000, "warning");
  if (supported.length) imports.requestImport({ kind: "paths", paths: supported }, root);
}

export function useFileDropImport() {
  useEffect(() => {
    let cancelled = false;
    let unlisten: (() => void) | undefined;
    void onFileDrop(handleFileDrop)
      .then((stop) => {
        if (cancelled) stop();
        else unlisten = stop;
      })
      .catch((err) => console.warn("[import] File drop listener unavailable:", err));
    return () => {
      cancelled = true;
      unlisten?.();
      useImportStore.getState().setDropActive(false);
    };
  }, []);
}
