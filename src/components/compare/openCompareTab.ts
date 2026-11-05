import { compareTabPath, compareTabTitle, type CompareTarget } from "../../domain/compare/compareTarget";
import { useAppStore } from "../../stores/appStore";

/** Opens (or focuses) the Compare tab for this pair of versions. */
export function openCompareTab(target: CompareTarget) {
  useAppStore.getState().openTab({ type: "compare", path: compareTabPath(target), title: compareTabTitle(target) });
}
