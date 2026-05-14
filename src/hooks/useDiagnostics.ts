import { invoke } from "@tauri-apps/api/core";
import { useEffect } from "react";
import { useAppStore } from "../stores/appStore";

type DiagnosticsDump = {
  app_version: string;
  project: { name: string; root: string } | null;
  environment: {
    diagnostics_enabled: boolean;
    diagnostics_value: string | null;
    elucim_bridge_enabled: boolean;
    elucim_bridge_value: string | null;
  };
  visual: unknown | null;
  checks: Array<{ id: string; status: "pass" | "warning" | "fail"; message: string }>;
};

declare global {
  interface Window {
    cutReadyDiagnostics?: {
      enabled: true;
      help: () => string[];
      snapshot: () => unknown;
      dump: (options?: { sketchPath?: string; rowIndex?: number }) => Promise<DiagnosticsDump>;
      dumpActiveVisual: (rowIndex: number) => Promise<DiagnosticsDump>;
    };
  }
}

export function useDiagnostics() {
  useEffect(() => {
    const diagnosticsEnabled =
      import.meta.env.DEV || import.meta.env.VITE_CUTREADY_DIAGNOSTICS === "1";

    if (!diagnosticsEnabled) {
      delete window.cutReadyDiagnostics;
      return;
    }

    window.cutReadyDiagnostics = {
      enabled: true,
      help: () => [
        "cutReadyDiagnostics.snapshot()",
        "cutReadyDiagnostics.dump()",
        "cutReadyDiagnostics.dump({ sketchPath: 'intro.sk', rowIndex: 0 })",
        "cutReadyDiagnostics.dumpActiveVisual(0)",
      ],
      snapshot: () => {
        const {
          currentProject,
          openTabs,
          activeTabId,
          splitTabs,
          splitActiveTabId,
          activeEditorGroup,
          activeSketchPath,
          activeSketch,
        } = useAppStore.getState();
        return {
          currentProject,
          openTabs,
          activeTabId,
          splitTabs,
          splitActiveTabId,
          activeEditorGroup,
          activeSketchPath,
          activeSketchSummary: activeSketch
            ? { title: activeSketch.title, rowCount: activeSketch.rows.length }
            : null,
        };
      },
      dump: (options = {}) =>
        invoke<DiagnosticsDump>("dump_diagnostics", {
          sketchPath: options.sketchPath ?? null,
          rowIndex: options.rowIndex ?? null,
        }),
      dumpActiveVisual: (rowIndex) => {
        if (!Number.isInteger(rowIndex) || rowIndex < 0) {
          return Promise.reject(new Error("rowIndex must be a non-negative integer"));
        }

        const { activeSketchPath } = useAppStore.getState();
        if (!activeSketchPath) {
          return Promise.reject(new Error("No active sketch is loaded"));
        }

        return invoke<DiagnosticsDump>("dump_diagnostics", {
          sketchPath: activeSketchPath,
          rowIndex,
        });
      },
    };

    return () => {
      delete window.cutReadyDiagnostics;
    };
  }, []);
}
