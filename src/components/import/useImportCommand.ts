// Adds "Import…" to the command palette while a project is open.
import { createElement, useEffect } from "react";
import { Download } from "lucide-react";
import { commandRegistry } from "../../services/commandRegistry";
import { useAppStore } from "../../stores/appStore";
import { useImportStore } from "../../stores/importStore";

export function useImportCommand() {
  const root = useAppStore((s) => s.currentProject?.root ?? null);
  useEffect(() => {
    if (!root) return;
    return commandRegistry.register({
      id: "project.import",
      title: "Import…",
      category: "Project",
      icon: createElement(Download, { className: "w-4 h-4" }),
      handler: () => {
        useImportStore.getState().requestImport({ kind: "files" }, useAppStore.getState().currentProject?.root);
      },
    });
  }, [root]);
}
