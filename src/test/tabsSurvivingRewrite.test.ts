import { describe, expect, it } from "vitest";
import type { EditorTab } from "../stores/appStore";
import { compareTabPath, WORKSPACE } from "../domain/compare/compareTarget";
import { editorGroupAfterFiltering, tabsSurvivingRewrite } from "../stores/workspaceHelpers";

const tab = (type: EditorTab["type"], path: string = type): EditorTab => ({ id: `${type}-${path}`, type, path, title: path });
const compare = (to: string) => tab("compare", compareTabPath({ from: "aaa", to, fromLabel: "A", toLabel: "B", path: null, documentTitle: null }));

describe("tabsSurvivingRewrite", () => {
  it("keeps History and version-to-version compares, and closes views of the working copy", () => {
    const tabs = [tab("note", "plan.md"), tab("history"), tab("sketch", "tour.sk"), compare("bbb"), compare(WORKSPACE), tab("asset", "a.png"), tab("diff"), tab("snapshot-preview")];
    const kept = tabsSurvivingRewrite(tabs, "history-history").tabs;
    expect(kept.map((t) => t.type)).toEqual(["history", "compare"]);
    expect(kept[1].path).toContain("to=bbb");
  });

  it("keeps the active History tab active", () => {
    const tabs = [tab("note", "plan.md"), tab("history")];
    expect(tabsSurvivingRewrite(tabs, "history-history").activeTabId).toBe("history-history");
  });

  it("moves focus to a surviving tab when the active document closes", () => {
    const tabs = [tab("history"), tab("note", "plan.md")];
    expect(tabsSurvivingRewrite(tabs, "note-plan.md").activeTabId).toBe("history-history");
  });

  it("leaves nothing active when only documents were open", () => {
    expect(tabsSurvivingRewrite([tab("note", "plan.md")], "note-plan.md")).toEqual({ tabs: [], activeTabId: null });
  });
});

describe("editorGroupAfterFiltering", () => {
  it("focuses the group that still has tabs", () => {
    expect(editorGroupAfterFiltering("split", 2, 0)).toBe("main");
    expect(editorGroupAfterFiltering("main", 0, 1)).toBe("split");
    expect(editorGroupAfterFiltering("split", 1, 1)).toBe("split");
    expect(editorGroupAfterFiltering("main", 0, 0)).toBe("main");
  });
});
