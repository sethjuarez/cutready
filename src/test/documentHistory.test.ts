import { beforeEach, describe, expect, it, vi } from "vitest";
import { act, renderHook } from "@testing-library/react";

vi.mock("../hooks/useRemoteSync", () => ({ useRemoteSync: () => {} }));
vi.mock("../services/discardShelves", () => ({ pruneDiscardShelves: () => Promise.resolve(0) }));

import { openDocumentHistory, openHistoryTab, useVersioningLifecycle } from "../hooks/useVersioningLifecycle";
import { summarizeChanges, summaryForPath } from "../domain/changes";
import { useAppStore } from "../stores/appStore";
import { useHistoryFilterStore } from "../stores/historyFilterStore";

describe("openDocumentHistory", () => {
  beforeEach(() => {
    useHistoryFilterStore.setState({ document: null });
    useAppStore.setState({ openTabs: [], activeTabId: null } as never);
  });

  it("filters to the document's Draftline path in a hybrid project and opens History", () => {
    useAppStore.setState({ currentProject: { root: "C:/repo/talks/demo", repo_root: "C:/repo/talks/demo", git_root: "C:/repo" } } as never);
    openDocumentHistory("notes\\intro.md", "Intro");
    expect(useHistoryFilterStore.getState().document).toEqual({ path: "talks/demo/notes/intro.md", title: "Intro" });
    expect(useAppStore.getState().openTabs.some((tab) => tab.type === "history")).toBe(true);
  });

  it("keeps the project path in a standalone project, and Open history clears the filter", () => {
    useAppStore.setState({ currentProject: { root: "C:/p", repo_root: "C:/p", git_root: "C:/p" } } as never);
    openDocumentHistory("intro.sk", "Intro");
    expect(useHistoryFilterStore.getState().document?.path).toBe("intro.sk");
    openHistoryTab();
    expect(useHistoryFilterStore.getState().document).toBeNull();
  });
});

describe("useVersioningLifecycle", () => {
  it("clears the document filter when switching projects inside one repository", () => {
    useAppStore.setState({ currentProject: { root: "C:/repo/a", repo_root: "C:/repo", git_root: "C:/repo" } } as never);
    renderHook(() => useVersioningLifecycle());
    useHistoryFilterStore.setState({ document: { path: "a/intro.md", title: "Intro" } });
    act(() => { useAppStore.setState({ currentProject: { root: "C:/repo/b", repo_root: "C:/repo", git_root: "C:/repo" } } as never); });
    expect(useHistoryFilterStore.getState().document).toBeNull();
  });
});

describe("summaryForPath", () => {
  it("keeps only the document's changes and recounts the totals", () => {
    const summary = summarizeChanges([
      { path: "a.sk", status: "modified" },
      { path: "b.md", status: "added" },
      { path: "c.md", previousPath: "old.md", status: "renamed" },
    ]);
    expect(summaryForPath(summary, "b.md").totals).toMatchObject({ documents: 1, documentsAdded: 1, sketchesEdited: 0 });
    expect(summaryForPath(summary, "old.md").documents.map((d) => d.path)).toEqual(["c.md"]);
    expect(summaryForPath(summary, "none.md").documents).toEqual([]);
  });
});
