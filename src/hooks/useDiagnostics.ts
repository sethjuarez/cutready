import { invoke } from "../services/tauri";
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
      dump: (options?: { sketchPath?: string; rowNumber?: number; rowIndex?: number }) => Promise<DiagnosticsDump>;
      dumpActiveVisual: (rowNumber: number) => Promise<DiagnosticsDump>;
    };
  }
}

function parseDiagnosticsRowTarget(options: { rowNumber?: number; rowIndex?: number }) {
  const { rowNumber, rowIndex } = options;
  if (rowNumber !== undefined) {
    if (!Number.isInteger(rowNumber) || rowNumber < 1) {
      throw new Error("rowNumber must be a positive 1-based row number");
    }

    const normalizedRowIndex = rowNumber - 1;
    if (rowIndex !== undefined && rowIndex !== normalizedRowIndex) {
      throw new Error(
        `Conflicting row targets: rowNumber ${rowNumber} refers to rowIndex ${normalizedRowIndex}, but rowIndex ${rowIndex} was also provided`,
      );
    }

    return { rowNumber, rowIndex: normalizedRowIndex };
  }

  if (rowIndex !== undefined && (!Number.isInteger(rowIndex) || rowIndex < 0)) {
    throw new Error("rowIndex must be a non-negative integer");
  }

  return { rowNumber: null, rowIndex: rowIndex ?? null };
}

export function useDiagnostics() {
  useEffect(() => {
    let cancelled = false;
    invoke<{ enabled: boolean }>("get_diagnostics_policy")
      .then((policy) => {
        if (cancelled) return;
        if (!policy.enabled) {
          delete window.cutReadyDiagnostics;
          return;
        }

        window.cutReadyDiagnostics = {
          enabled: true,
          help: () => [
            "cutReadyDiagnostics.snapshot()",
            "cutReadyDiagnostics.dump()",
            "cutReadyDiagnostics.dump({ sketchPath: 'intro.sk', rowNumber: 1 })",
            "cutReadyDiagnostics.dumpActiveVisual(1)",
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
          dump: (options = {}) => {
            const rowTarget = parseDiagnosticsRowTarget(options);
            return invoke<DiagnosticsDump>("dump_diagnostics", {
              sketchPath: options.sketchPath ?? null,
              rowNumber: rowTarget.rowNumber,
              rowIndex: rowTarget.rowIndex,
            });
          },
          dumpActiveVisual: (rowNumber) => {
            let rowTarget: ReturnType<typeof parseDiagnosticsRowTarget>;
            try {
              rowTarget = parseDiagnosticsRowTarget({ rowNumber });
            } catch (error) {
              return Promise.reject(error);
            }

            const { activeSketchPath } = useAppStore.getState();
            if (!activeSketchPath) {
              return Promise.reject(new Error("No active sketch is loaded"));
            }

            return invoke<DiagnosticsDump>("dump_diagnostics", {
              sketchPath: activeSketchPath,
              rowNumber: rowTarget.rowNumber,
              rowIndex: rowTarget.rowIndex,
            });
          },
        };
      })
      .catch(() => {
        delete window.cutReadyDiagnostics;
      });

    return () => {
      cancelled = true;
      delete window.cutReadyDiagnostics;
    };
  }, []);
}
