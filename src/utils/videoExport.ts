import type { PlanningRow } from "../types/sketch";

export type VideoExportIssue = { rowNumber: number; missing: string[] };

export type VideoExportOptions = {
  resolvedDemoPath: string | null;
  visualFrameManifestPaths: Array<string | null>;
};

export function emptyVideoExportOptions(rowCount: number): VideoExportOptions {
  return {
    resolvedDemoPath: null,
    visualFrameManifestPaths: Array.from({ length: rowCount }, () => null),
  };
}

export function normalizeVideoExportOptions(options: VideoExportOptions, rowCount: number): VideoExportOptions {
  return {
    resolvedDemoPath: options.resolvedDemoPath?.trim() || null,
    visualFrameManifestPaths: Array.from({ length: rowCount }, (_, index) => (
      options.visualFrameManifestPaths[index]?.trim() || null
    )),
  };
}

export function getVideoExportIssues(rows: PlanningRow[], options?: VideoExportOptions): VideoExportIssue[] {
  const normalizedOptions = normalizeVideoExportOptions(options ?? emptyVideoExportOptions(rows.length), rows.length);
  const exportIssues: VideoExportIssue[] = [];

  if (normalizedOptions.resolvedDemoPath && !isSafeProjectRelativePath(normalizedOptions.resolvedDemoPath)) {
    exportIssues.push({ rowNumber: 0, missing: ["project-relative Scenecast resolved demo path"] });
  }

  if (rows.length === 0) {
    return [...exportIssues, { rowNumber: 0, missing: ["at least one row"] }];
  }

  const rowIssues = rows.flatMap((row, index) => {
    const missing: string[] = [];
    const visualFrameManifestPath = normalizedOptions.visualFrameManifestPaths[index];
    if (visualFrameManifestPath && !isSafeProjectRelativePath(visualFrameManifestPath)) {
      missing.push("project-relative visual frame manifest path");
    }
    if (
      visualFrameManifestPath
      && (row.typing_spots?.length || row.motion_plan)
    ) {
      missing.push("row without typing spots or motion plan when using a visual frame manifest");
    }
    if (!row.screenshot?.trim() && !visualFrameManifestPath) {
      missing.push("screenshot or visual frame manifest");
    }
    if (!row.narration?.path?.trim()) missing.push("narration");
    return missing.length > 0 ? [{ rowNumber: index + 1, missing }] : [];
  });

  return [...exportIssues, ...rowIssues];
}

export function isSafeProjectRelativePath(path: string): boolean {
  const value = path.trim();
  if (!value) return true;
  if (/^[a-zA-Z]:[\\/]/.test(value) || value.startsWith("/") || value.startsWith("\\")) return false;

  return !value
    .replace(/[\\/]+/g, "/")
    .split("/")
    .some((segment) => segment === "..");
}

export function selectedFileToProjectRelativePath(projectRoot: string, selectedPath: string): string | null {
  const trimmedRoot = projectRoot.trim().replace(/[\\/]+$/, "");
  const trimmedSelected = selectedPath.trim();
  if (!trimmedRoot || !trimmedSelected) return null;

  const normalizedRoot = normalizeAbsolutePathForComparison(trimmedRoot);
  const normalizedSelected = normalizeAbsolutePathForComparison(trimmedSelected);
  if (!normalizedSelected.startsWith(`${normalizedRoot}/`)) return null;

  return normalizedSelected.slice(normalizedRoot.length + 1);
}

function normalizeAbsolutePathForComparison(path: string): string {
  const normalized = path.replace(/[\\/]+/g, "/").replace(/\/+$/, "");
  return /^[a-zA-Z]:\//.test(normalized) ? normalized.toLowerCase() : normalized;
}
