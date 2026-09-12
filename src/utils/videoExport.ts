import type { PlanningRow } from "../types/sketch";

export type VideoExportIssue = { rowNumber: number; missing: string[] };
export type VideoExportMediaSource = "frame-manifest" | "visual" | "resolved-demo" | "screenshot" | "missing";
export type VideoExportTimingSource = "resolved-demo" | "sketch";

export type VideoExportRowCoverage = {
  rowNumber: number;
  label: string;
  mediaSource: VideoExportMediaSource;
  timingSource: VideoExportTimingSource;
  usesResolvedDemoMedia: boolean;
  hasOverlay: boolean;
};

export type VideoExportOptions = {
  resolvedDemoPath: string | null;
  generateResolvedDemo: boolean;
  visualFrameManifestPaths: Array<string | null>;
};

export function emptyVideoExportOptions(rowCount: number): VideoExportOptions {
  return {
    resolvedDemoPath: null,
    generateResolvedDemo: false,
    visualFrameManifestPaths: Array.from({ length: rowCount }, () => null),
  };
}

export function normalizeVideoExportOptions(options: VideoExportOptions, rowCount: number): VideoExportOptions {
  return {
    resolvedDemoPath: options.resolvedDemoPath?.trim() || null,
    generateResolvedDemo: Boolean(options.generateResolvedDemo),
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
    const visualPath = row.visual?.trim() || null;
    const mayUseResolvedDemoMedia = Boolean(normalizedOptions.resolvedDemoPath)
      && !(row.typing_spots?.length)
      && !row.motion_plan;
    if (visualFrameManifestPath && !isSafeProjectRelativePath(visualFrameManifestPath)) {
      missing.push("project-relative visual frame manifest path");
    }
    if (visualPath && !isSafeProjectRelativePath(visualPath)) {
      missing.push("project-relative visual path");
    }
    if (
      visualFrameManifestPath
      && (row.typing_spots?.length || row.motion_plan)
    ) {
      missing.push("row without typing spots or motion plan when using a visual frame manifest");
    }
    if (visualPath && (row.typing_spots?.length || row.motion_plan) && !visualFrameManifestPath) {
      missing.push("visual row without typing spots or motion plan");
    }
    if (!row.screenshot?.trim() && !visualPath && !visualFrameManifestPath && !mayUseResolvedDemoMedia) {
      missing.push("screenshot, visual, visual frame manifest, or resolved demo media");
    }
    if (
      normalizedOptions.generateResolvedDemo
      && !normalizedOptions.resolvedDemoPath
      && !row.screenshot?.trim()
    ) {
      missing.push("screenshot for generated Scenecast resolved demo");
    }
    if (!row.narration?.path?.trim()) {
      missing.push("narration");
    } else if (row.narration.narrative_text != null && row.narration.narrative_text !== row.narrative) {
      missing.push("fresh narration matching current narrative");
    }
    return missing.length > 0 ? [{ rowNumber: index + 1, missing }] : [];
  });

  return [...exportIssues, ...rowIssues];
}

export function getVideoExportCoverage(rows: PlanningRow[], options?: VideoExportOptions): VideoExportRowCoverage[] {
  const normalizedOptions = normalizeVideoExportOptions(options ?? emptyVideoExportOptions(rows.length), rows.length);
  return rows.map((row, index) => {
    const visualFrameManifestPath = normalizedOptions.visualFrameManifestPaths[index];
    const visualPath = row.visual?.trim() || null;
    const hasOverlay = Boolean(row.typing_spots?.length || row.motion_plan);
    const usesResolvedDemoMedia = Boolean(normalizedOptions.resolvedDemoPath) && !hasOverlay;
    const mediaSource: VideoExportMediaSource = visualFrameManifestPath
      ? "frame-manifest"
      : visualPath
        ? "visual"
        : usesResolvedDemoMedia
          ? "resolved-demo"
          : row.screenshot?.trim()
            ? "screenshot"
            : "missing";

    return {
      rowNumber: index + 1,
      label: row.time || row.narrative || "Untitled beat",
      mediaSource,
      timingSource: (normalizedOptions.resolvedDemoPath || normalizedOptions.generateResolvedDemo) ? "resolved-demo" : "sketch",
      usesResolvedDemoMedia: mediaSource === "resolved-demo",
      hasOverlay,
    };
  });
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
