import type { MergeConflictResolution, MergeIncomingToken } from "@draftline/client";
import {
  DraftlineErrorCode,
  draftlineErrorCode,
  friendlyDraftlineErrorMessage,
  VARIATION_OUTSIDE_NAMESPACE_MESSAGE,
} from "./draftlineErrors";
import { facade, mergeIncomingReportToDto, type DraftlineMergeIncomingReport } from "./draftlineVersioning";
import { askMergeName } from "./mergeName";

/** Previews merging another local timeline into the current one. */
export async function preflightVariationMerge(sourceVariationId: string): Promise<DraftlineMergeIncomingReport> {
  return mergeIncomingReportToDto(await facade().preflightMergeVariation(sourceVariationId));
}

/**
 * Writes the two-parent merge pinned to the previewed token: clean with no
 * resolutions, or with the user's. Refuses if either timeline moved since.
 */
export async function mergeVariation(
  token: MergeIncomingToken,
  label: string,
  resolutions: MergeConflictResolution[] = [],
): Promise<string> {
  const result = await facade().mergeVariationWithResolutions(label, token, resolutions);
  return result.merge.version.id;
}

/** A plain-language reason a timeline merge didn't happen. Nothing is merged in any of these cases. */
export function variationMergeErrorMessage(error: unknown, source: string, target: string): string {
  switch (draftlineErrorCode(error)) {
    case DraftlineErrorCode.NothingToMerge:
      return `${target} already has everything from ${source}.`;
    case DraftlineErrorCode.InvalidMergeToken:
      return "That merge preview can't be used anymore. Nothing was merged — try again.";
    case DraftlineErrorCode.RemoteRace:
    case DraftlineErrorCode.LocalStateChanged:
      return `${source} or ${target} changed while you were naming the merge. Nothing was merged — try again.`;
    case DraftlineErrorCode.VariationOutsideNamespace:
      return VARIATION_OUTSIDE_NAMESPACE_MESSAGE;
    default:
      return friendlyDraftlineErrorMessage(error) ?? `Couldn't merge ${source}: ${error instanceof Error ? error.message : String(error)}`;
  }
}

export type VariationMergeOutcome =
  | { kind: "merged"; commitId: string }
  | { kind: "conflicts"; report: DraftlineMergeIncomingReport & { token: MergeIncomingToken } }
  | { kind: "cancelled" }
  | { kind: "failed"; message: string };

/**
 * Merges `source` into the current timeline after the user approves the
 * merge's name. Conflicts come back for the conflict panel, unmerged.
 */
export async function runVariationMerge(
  source: { id: string; label: string },
  target: string,
): Promise<VariationMergeOutcome> {
  try {
    const report = await preflightVariationMerge(source.id);
    if (report.dirtyFiles.length > 0) {
      return { kind: "failed", message: `Save or set aside your changes before merging ${source.label}.` };
    }
    if (!report.token) return { kind: "failed", message: `${source.label} can't be merged into ${target} safely right now.` };
    if (!report.canMergeCleanly) {
      if (report.conflicts.length === 0) {
        return { kind: "failed", message: `${source.label} can't be merged into ${target} safely right now.` };
      }
      return { kind: "conflicts", report: { ...report, token: report.token } };
    }
    const label = await askMergeName(source.label, report.incoming);
    if (!label) return { kind: "cancelled" };
    return { kind: "merged", commitId: await mergeVariation(report.token, label) };
  } catch (error) {
    return { kind: "failed", message: variationMergeErrorMessage(error, source.label, target) };
  }
}
