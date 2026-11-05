import { beforeEach, describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen, within } from "@testing-library/react";

const diffVersions = vi.fn();
const diffVersionToWorkspace = vi.fn();
const previewVersionFile = vi.fn();
const previewWorkspaceFile = vi.fn();
vi.mock("../services/draftlineVersioning", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../services/draftlineVersioning")>()),
  facade: () => ({ diffVersions, diffVersionToWorkspace, previewVersionFile, previewWorkspaceFile }),
}));
const fetchProjectImageDataUrl = vi.fn();
vi.mock("../utils/projectImage", () => ({ fetchProjectImageDataUrl: (path: string) => fetchProjectImageDataUrl(path) }));

import { compareFile } from "../domain/compare/compareFile";
import { compareTabPath, compareTabTitle, parseCompareTabPath, WORKSPACE, type CompareTarget } from "../domain/compare/compareTarget";
import { compareNote } from "../domain/compare/noteCompare";
import { compareSketch } from "../domain/compare/sketchCompare";
import { compareStoryboard } from "../domain/compare/storyboardCompare";
import { listComparedFiles, loadFileComparison, type CompareImageReader } from "../services/versionCompare";
import { SketchCompareView } from "../components/compare/SketchCompareView";
import { NoteCompareView } from "../components/compare/NoteCompareView";
import { StoryboardCompareView } from "../components/compare/StoryboardCompareView";
import { MediaCompareView } from "../components/compare/MediaCompareView";
import { CompareTab } from "../components/compare/CompareTab";
import { openCompareTab } from "../components/compare/openCompareTab";
import { useAppStore } from "../stores/appStore";

const target: CompareTarget = { from: "v1", to: WORKSPACE, fromLabel: "Draft & notes", toLabel: "Now", path: null, documentTitle: null };
const sketch = (rows: object[]) => JSON.stringify({ title: "Intro", rows });
const noImages: CompareImageReader = { workspaceImage: async () => null };

describe("compare target", () => {
  it("round-trips through the tab path, including a document filter", () => {
    const withDoc = { ...target, path: "cutready/intro.sk", documentTitle: "Intro" };
    expect(parseCompareTabPath(compareTabPath(target))).toEqual(target);
    expect(parseCompareTabPath(compareTabPath(withDoc))).toEqual(withDoc);
    expect(compareTabTitle(withDoc)).toBe("Intro: Draft & notes ↔ Now");
    expect(parseCompareTabPath("cutready://snapshot/v1")).toBeNull();
    expect(parseCompareTabPath("cutready://compare?from=v1")).toBeNull();
  });
});

describe("compareFile", () => {
  it("picks the document-aware view by path", () => {
    expect(compareFile({ path: "a.sk", before: sketch([]), after: sketch([{ id: "r1" }]), isBinary: false }).view).toBe("sketch");
    expect(compareFile({ path: "a.sb", before: null, after: "{}", isBinary: false }).view).toBe("storyboard");
    expect(compareFile({ path: "a.md", before: "x", after: "y", isBinary: false }).view).toBe("note");
    expect(compareFile({ path: "screenshots/a.png", before: null, after: null, isBinary: true }).view).toBe("media");
    expect(compareFile({ path: "a.mp4", before: null, after: null, isBinary: true }).view).toBe("unavailable");
    expect(compareFile({ path: "a.bin", before: null, after: null, isBinary: true }).view).toBe("unavailable");
  });

  it("falls back to a line diff for malformed documents and plain text", () => {
    const broken = compareFile({ path: "a.sk", before: "{", after: "{}", isBinary: false });
    expect(broken.view).toBe("text");
    const text = compareFile({ path: "a.txt", before: "one\ntwo", after: "one\nthree", isBinary: false });
    expect(text.view === "text" && text.comparison.blocks.map((b) => b.status)).toEqual(["equal", "changed"]);
    const spacing = compareFile({ path: "a.txt", before: "a\n  b\n", after: "a\n\n    b\n", isBinary: false });
    expect(spacing.view === "text" && spacing.comparison.blocks.map((b) => b.status)).toEqual(["equal", "changed", "added"]);
  });
});

describe("versionCompare service", () => {
  beforeEach(() => {
    for (const fn of [diffVersions, diffVersionToWorkspace, previewVersionFile, previewWorkspaceFile, fetchProjectImageDataUrl]) fn.mockReset();
  });

  it("diffs against the workspace or another version, filtered by path", async () => {
    const files = [{ path: "a.sk", kind: "Modified", is_binary: false }, { path: "b.png", kind: "Added", is_binary: true }];
    diffVersionToWorkspace.mockResolvedValue({ files });
    diffVersions.mockResolvedValue({ files });
    expect(await listComparedFiles("v1", WORKSPACE)).toEqual([
      { path: "a.sk", status: "modified", isBinary: false },
      { path: "b.png", status: "added", isBinary: true },
    ]);
    expect(diffVersionToWorkspace).toHaveBeenCalledWith("v1");
    expect(await listComparedFiles("v1", "v2", ["b.png"])).toEqual([{ path: "b.png", status: "added", isBinary: true }]);
    expect(await listComparedFiles("v1", "v2", ["new.sk", "a.sk"])).toEqual([{ path: "a.sk", status: "modified", isBinary: false }]);
    expect(diffVersions).toHaveBeenCalledWith("v1", "v2");
  });

  it("reads each side from its version or the workspace", async () => {
    previewVersionFile.mockResolvedValue({ path: "a.sk", content: sketch([{ id: "r1", narrative: "Hi" }]), is_binary: false });
    previewWorkspaceFile.mockResolvedValue({ path: "a.sk", content: sketch([{ id: "r1", narrative: "Hello" }]), is_binary: false });
    const result = await loadFileComparison("v1", WORKSPACE, { path: "a.sk", status: "modified", isBinary: false }, noImages);
    expect(previewVersionFile).toHaveBeenCalledWith("v1", "a.sk");
    expect(result.view === "sketch" && result.comparison.rows[0]).toMatchObject({ status: "changed", fields: ["narrative"] });
  });

  it("reads a renamed file's older side from its previous path, or says it can't", async () => {
    previewVersionFile.mockImplementation(async (version: string, path: string) =>
      version === "v1" && path === "old.md" ? { path, content: "Hi", is_binary: false }
        : version === "v2" && path === "new.md" ? { path, content: "Hi there", is_binary: false } : null);
    const renamed = { path: "new.md", status: "renamed", isBinary: false } as const;
    const result = await loadFileComparison("v1", "v2", renamed, noImages, ["new.md", "old.md"]);
    expect(result.view === "note" && result.comparison.blocks.map((b) => b.status)).toEqual(["changed"]);
    expect((await loadFileComparison("v1", "v2", renamed, noImages)).view).toBe("unavailable");
  });

  it("doesn't read the missing side of an added file", async () => {
    previewVersionFile.mockResolvedValue({ path: "a.md", content: "New", is_binary: false });
    const result = await loadFileComparison("v1", "v2", { path: "a.md", status: "added", isBinary: false }, noImages);
    expect(previewVersionFile).toHaveBeenCalledTimes(1);
    expect(previewVersionFile).toHaveBeenCalledWith("v2", "a.md");
    expect(result.view === "note" && result.comparison.blocks).toEqual([{ status: "added", text: "New" }]);
  });

  it("shows the workspace image and falls back for a version's image", async () => {
    previewVersionFile.mockResolvedValue({ path: "s.png", is_binary: true });
    previewWorkspaceFile.mockResolvedValue({ path: "s.png", is_binary: true });
    const reader: CompareImageReader = { workspaceImage: async (path) => `data:image/png;base64,${path}` };
    const result = await loadFileComparison("v1", WORKSPACE, { path: "s.png", status: "modified", isBinary: true }, reader);
    expect(result).toEqual({
      view: "media",
      before: { state: "unavailable", reason: "Preview not available for this version" },
      after: { state: "ready", src: "data:image/png;base64,s.png" },
    });
    const added = await loadFileComparison("v1", WORKSPACE, { path: "s.png", status: "added", isBinary: true }, reader);
    expect(added.view === "media" && added.before).toEqual({ state: "absent" });
  });
});

describe("compare views", () => {
  it("marks sketch rows added, removed, moved and changed per field", () => {
    const comparison = compareSketch(
      sketch([{ id: "a", narrative: "Keep" }, { id: "b", narrative: "Old" }, { id: "c", narrative: "Gone" }, { id: "d", time: "0:10" }]),
      sketch([{ id: "d", time: "0:10" }, { id: "a", narrative: "Keep" }, { id: "b", narrative: "New" }, { id: "e", narrative: "Fresh" }]),
    )!;
    const { container } = render(<SketchCompareView comparison={comparison} />);
    const status = (id: string) => container.querySelector(`[data-row-id="${id}"]`)!;
    expect(status("b").getAttribute("data-row-status")).toBe("changed");
    expect(within(status("b") as HTMLElement).getByText("Old")).toHaveClass("line-through");
    expect(status("b").querySelector('[data-changed-field="narrative"]')).not.toBeNull();
    expect(status("c").getAttribute("data-row-status")).toBe("removed");
    expect(within(status("c") as HTMLElement).getByText("Gone")).toHaveClass("line-through");
    expect(within(status("e") as HTMLElement).getByText("Added")).toBeInTheDocument();
    expect(within(status("d") as HTMLElement).getByText("Moved")).toBeInTheDocument();
  });

  it("shows prose changes inline or side by side", () => {
    const comparison = compareNote("Hello world\n\nGone\n\nEnd", "Hello there world\n\nEnd\n\nNew");
    render(<NoteCompareView comparison={comparison} beforeLabel="Draft" afterLabel="Now" />);
    expect(screen.getByText("there")).toHaveClass("bg-diff-ins-bg");
    expect(screen.getByText("Gone").closest("[data-block-status]")).toHaveAttribute("data-block-status", "removed");
    fireEvent.click(screen.getByRole("button", { name: "Side by side" }));
    expect(screen.getByRole("button", { name: "Side by side" })).toHaveAttribute("aria-pressed", "true");
    expect(screen.getByText("Draft")).toBeInTheDocument();
    expect(screen.getByText("New")).toHaveAttribute("data-block-status", "added");
  });

  it("lists storyboard sections and sketches added, removed or moved", () => {
    const comparison = compareStoryboard(
      JSON.stringify({ items: [{ type: "sketch_ref", path: "a.sk" }, { type: "sketch_ref", path: "b.sk" }, { type: "sketch_ref", path: "gone.sk" }] }),
      JSON.stringify({ items: [{ type: "sketch_ref", path: "b.sk" }, { type: "sketch_ref", path: "a.sk" }, { type: "section", title: "Act 2", sketches: ["new.sk"] }] }),
    )!;
    const { container } = render(<StoryboardCompareView comparison={comparison} />);
    expect(screen.getByText("gone").closest("li")).toHaveAttribute("data-entry-status", "removed");
    expect(screen.getByText("Act 2").closest("li")).toHaveAttribute("data-entry-status", "added");
    expect(screen.getByText("new").closest("li")).toHaveAttribute("data-entry-status", "added");
    expect(container.querySelectorAll("[data-moved]").length).toBeGreaterThan(0);
  });

  it("puts images side by side with a fallback for an unavailable side", () => {
    render(
      <MediaCompareView
        before={{ state: "unavailable", reason: "Preview not available for this version" }}
        after={{ state: "ready", src: "data:image/png;base64,x" }}
        beforeLabel="Draft"
        afterLabel="Now"
      />,
    );
    expect(screen.getByText("Preview not available for this version")).toBeInTheDocument();
    expect(screen.getByRole("img", { name: "Now" })).toHaveAttribute("src", "data:image/png;base64,x");
  });
});

describe("CompareTab", () => {
  beforeEach(() => {
    for (const fn of [diffVersions, diffVersionToWorkspace, previewVersionFile, previewWorkspaceFile]) fn.mockReset();
  });

  it("lists changed documents and shows the selected one", async () => {
    diffVersionToWorkspace.mockResolvedValue({ files: [{ path: "a.md", kind: "Modified", is_binary: false }, { path: "b.md", kind: "Added", is_binary: false }] });
    previewVersionFile.mockResolvedValue({ path: "a.md", content: "Old line", is_binary: false });
    previewWorkspaceFile.mockImplementation(async (path: string) => ({ path, content: path === "a.md" ? "New line" : "Brand new", is_binary: false }));
    render(<CompareTab target={target} />);
    expect(screen.getByTestId("compare-sides")).toHaveTextContent("Draft & notes");
    const nav = await screen.findByRole("navigation", { name: "Changed documents" });
    expect(await screen.findByText("Old")).toBeInTheDocument();
    fireEvent.click(within(nav).getByRole("button", { name: /b\.md/ }));
    expect(await screen.findByText("Brand new")).toBeInTheDocument();
    expect(within(nav).getByRole("button", { name: /b\.md/ })).toHaveAttribute("aria-current", "true");
  });

  it("says when a filtered document didn't change", async () => {
    diffVersions.mockResolvedValue({ files: [{ path: "other.md", kind: "Modified", is_binary: false }] });
    render(<CompareTab target={{ ...target, to: "v2", path: "a.md", documentTitle: "Intro" }} />);
    expect(await screen.findByText("Intro didn't change.")).toBeInTheDocument();
    expect(screen.queryByRole("navigation")).toBeNull();
  });

  it("reports a failed diff", async () => {
    diffVersionToWorkspace.mockRejectedValue(new Error("boom"));
    render(<CompareTab target={target} />);
    expect(await screen.findByText("Couldn't load changes: boom")).toBeInTheDocument();
  });

  it("opens one compare tab per pair of versions", () => {
    useAppStore.setState({ openTabs: [], activeTabId: null } as never);
    openCompareTab(target);
    openCompareTab(target);
    const tabs = useAppStore.getState().openTabs;
    expect(tabs).toHaveLength(1);
    expect(tabs[0]).toMatchObject({ type: "compare", title: "Draft & notes ↔ Now" });
    expect(parseCompareTabPath(tabs[0].path)).toEqual(target);
  });
});
