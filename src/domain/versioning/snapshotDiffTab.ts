// A diff tab opened from a version preview: one file's changes in that version.

export interface SnapshotDiffTarget {
  snapshotId: string;
  filePath: string;
}

const PREFIX = "cutready://snapshot-diff?";

export function snapshotDiffTabPath(snapshotId: string, filePath: string): string {
  return `${PREFIX}version=${encodeURIComponent(snapshotId)}&path=${encodeURIComponent(filePath)}`;
}

export function parseSnapshotDiffTarget(path: string): SnapshotDiffTarget | null {
  if (!path.startsWith(PREFIX)) return null;
  try {
    const url = new URL(path);
    const snapshotId = url.searchParams.get("version");
    const filePath = url.searchParams.get("path");
    return snapshotId && filePath ? { snapshotId, filePath } : null;
  } catch {
    return null;
  }
}
