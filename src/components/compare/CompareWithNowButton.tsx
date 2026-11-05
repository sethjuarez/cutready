import { GitCompare } from "lucide-react";
import { WORKSPACE } from "../../domain/compare/compareTarget";
import { openCompareTab } from "./openCompareTab";

/** Opens a Compare tab from a previewed version to the working copy. */
export function CompareWithNowButton({ versionId, versionName }: { versionId: string; versionName: string }) {
  return (
    <button
      type="button"
      onClick={() => openCompareTab({ from: versionId, to: WORKSPACE, fromLabel: versionName, toLabel: "Now", path: null, documentTitle: null })}
      className="inline-flex h-8 shrink-0 items-center justify-center gap-1.5 rounded-lg border border-border bg-surface px-3 text-xs font-medium text-text transition-colors hover:border-accent hover:text-accent focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent"
      title="See what changed between this version and now"
      data-testid="compare-with-now"
    >
      <GitCompare className="h-3.5 w-3.5" aria-hidden="true" />
      Compare with now
    </button>
  );
}
