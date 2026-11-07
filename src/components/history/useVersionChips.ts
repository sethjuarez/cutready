import { useEffect, useState, type RefObject } from "react";
import { summaryChips, type SummaryChip } from "../../domain/changes";
import { loadVersionChangeSummary } from "../../services/versionChangeSummary";
import { observeOnce } from "./sharedVisibility";

/**
 * Change chips for one version against its first parent, loaded once the row scrolls into view.
 * Returns null while loading or when the chips can't be computed.
 */
export function useVersionChips(
  ref: RefObject<Element | null>,
  versionId: string,
  parentId: string | null,
  /** Limits the chips to this Draftline path, for a per-document history. */
  path: string | null = null,
): SummaryChip[] | null {
  const [visible, setVisible] = useState(false);
  const [chips, setChips] = useState<SummaryChip[] | null>(null);

  useEffect(() => {
    const element = ref.current;
    if (visible || !element) return;
    return observeOnce(element, () => setVisible(true));
  }, [ref, visible]);

  useEffect(() => {
    setChips(null);
    if (!visible || !parentId) return;
    let cancelled = false;
    loadVersionChangeSummary(parentId, versionId, path)
      .then((summary) => { if (!cancelled) setChips(summaryChips(summary.totals)); })
      .catch(() => { if (!cancelled) setChips(null); });
    return () => { cancelled = true; };
  }, [visible, parentId, versionId, path]);

  return chips;
}
