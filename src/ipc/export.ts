// Typed reads for video export preflight.
import { invoke } from "../services/tauri";

export type ResolvedDemoInspection = {
  schemaVersion: string;
  title: string;
  canExport: boolean;
  blockingError?: string | null;
  diagnosticCount: number;
  rowCount: number;
  rows: ResolvedDemoRowInspection[];
  diagnostics: ResolvedDemoDiagnostic[];
};
export type ResolvedDemoRowInspection = {
  rowNumber: number;
  stepCount: number;
  segmentCount: number;
  durationSeconds?: number | null;
  mediaAssetCount: number;
  missingAssetCount: number;
  invalidAssetCount: number;
  steps: ResolvedDemoStepInspection[];
};
export type ResolvedDemoStepInspection = {
  id: string;
  title: string;
  description?: string | null;
  targetLabels: string[];
  guideMarkLabels: string[];
  segmentKinds: string[];
};
export type ResolvedDemoDiagnostic = {
  severity: string;
  code: string;
  message: string;
};

export const exportIpc = {
  inspectResolvedDemo: (relativePath: string, rowCount: number, sourceRowIds: string[]) =>
    invoke<ResolvedDemoInspection>("inspect_resolved_demo", { relativePath, rowCount, sourceRowIds }),
};
