import { describe, expect, it } from "vitest";
import {
  describeChange,
  diffNote,
  diffSketch,
  diffStoryboard,
  documentKindOf,
  loadChangeSummary,
  mediaTypeOf,
  summarizeChanges,
  summaryChips,
} from "../domain/changes";

const sketch = (rows: Record<string, unknown>[], extra: Record<string, unknown> = {}) =>
  JSON.stringify({ title: "Intro", description: "", rows, ...extra });
const row = (id: string, narrative = "", extra: Record<string, unknown> = {}) => ({
  id,
  time: "0:10",
  narrative,
  demo_actions: "",
  screenshot: null,
  ...extra,
});
const storyboard = (items: unknown[], extra: Record<string, unknown> = {}) =>
  JSON.stringify({ title: "Talk", description: "", items, ...extra });

describe("classify", () => {
  it("classifies documents and media by path", () => {
    expect(documentKindOf("intro.sk")).toBe("sketch");
    expect(documentKindOf("cutready/talk.sb")).toBe("storyboard");
    expect(documentKindOf("notes/plan.md")).toBe("note");
    expect(documentKindOf(".cutready/screenshots/a.PNG")).toBe("media");
    expect(documentKindOf(".cutready/settings.json")).toBe("other");
    expect(mediaTypeOf("cutready/.cutready/visuals/v1.json")).toBe("visual");
    expect(mediaTypeOf("clip.mp4")).toBe("video");
    expect(mediaTypeOf(".cutready/narration/take.wav")).toBe("audio");
    expect(mediaTypeOf("readme.txt")).toBeNull();
  });
});

describe("diffSketch", () => {
  it("reports rows added, removed and edited by id with field names", () => {
    const before = sketch([row("a", "hello"), row("b", "keep"), row("c", "gone")]);
    const after = sketch([row("a", "hello world"), row("b", "keep"), row("d", "new")]);
    const changes = diffSketch(before, after)!;
    expect(changes.rowsAdded).toBe(1);
    expect(changes.rowsRemoved).toBe(1);
    expect(changes.rowsChanged).toEqual([{ id: "a", fields: ["narrative"] }]);
    expect(changes.rowsMoved).toBe(0);
    expect(changes.fields).toEqual([]);
  });

  it("counts reordered rows as moved, not edited", () => {
    const before = sketch([row("a"), row("b"), row("c")]);
    const after = sketch([row("c"), row("a"), row("b")]);
    const changes = diffSketch(before, after)!;
    expect(changes.rowsMoved).toBe(1);
    expect(changes.rowsChanged).toEqual([]);
  });

  it("notices screenshot, visual and title changes", () => {
    const before = sketch([row("a")]);
    const after = sketch([row("a", "", { screenshot: "s.png", visual: ".cutready/visuals/v.json" })], { title: "New" });
    const changes = diffSketch(before, after)!;
    expect(changes.rowsChanged[0].fields).toEqual(["screenshot", "visual"]);
    expect(changes.fields).toEqual(["title"]);
  });

  it("falls back to row index for legacy rows without ids", () => {
    const changes = diffSketch(sketch([{ narrative: "x" }]), sketch([{ narrative: "y" }]))!;
    expect(changes.rowsChanged).toEqual([{ id: "#0", fields: ["narrative"] }]);
  });

  it("returns null when a side does not parse", () => {
    expect(diffSketch("{oops", sketch([]))).toBeNull();
    expect(diffSketch(sketch([]), null)).toBeNull();
  });

  it("refuses to guess when row ids repeat", () => {
    expect(diffSketch(sketch([row("a"), row("a")]), sketch([row("a")]))).toBeNull();
  });

  it("does not confuse a real '#0' id with an index fallback", () => {
    const changes = diffSketch(sketch([{ narrative: "x" }]), sketch([{ narrative: "x" }, row("#0")]))!;
    expect(changes.rowsAdded).toBe(1);
    expect(changes.rowsChanged).toEqual([]);
  });
});

describe("diffNote", () => {
  it("pairs edited paragraphs and counts words", () => {
    const before = "# Title\n\nOne two three.\n\nRemoved para.";
    const after = "# Title\n\nOne two four five.\n\nRemoved para.\n\nBrand new.";
    expect(diffNote(before, after)).toEqual({
      paragraphsAdded: 1,
      paragraphsRemoved: 0,
      paragraphsChanged: 1,
      wordsAdded: 4,
      wordsRemoved: 1,
    });
  });

  it("ignores whitespace-only and line-ending differences", () => {
    const changes = diffNote("a  b\r\n\r\nc", "a b\n\n\nc");
    expect(changes.paragraphsAdded + changes.paragraphsRemoved + changes.paragraphsChanged).toBe(0);
  });
});

describe("diffStoryboard", () => {
  it("reports sections and sketch references added, removed and moved", () => {
    const before = storyboard([
      { type: "sketch_ref", path: "a.sk" },
      { type: "section", title: "Act 1", sketches: ["b.sk", "c.sk"] },
    ]);
    const after = storyboard([
      { type: "section", title: "Act 1", sketches: ["c.sk", "b.sk"] },
      { type: "section", title: "Act 2", sketches: ["d.sk"] },
    ]);
    const changes = diffStoryboard(before, after)!;
    expect(changes.sectionsAdded).toEqual(["Act 2"]);
    expect(changes.sectionsRemoved).toEqual([]);
    expect(changes.sketchesAdded).toEqual(["d.sk"]);
    expect(changes.sketchesRemoved).toEqual(["a.sk"]);
    expect(changes.sketchesMoved).toBe(1);
    expect(changes.sectionsEdited).toEqual([]);
  });

  it("counts repeated references and duplicate section titles by occurrence", () => {
    const before = storyboard([{ type: "sketch_ref", path: "a.sk" }, { type: "section", title: "Act", sketches: [] }]);
    const after = storyboard([
      { type: "sketch_ref", path: "a.sk" },
      { type: "sketch_ref", path: "a.sk" },
      { type: "section", title: "Act", sketches: [] },
      { type: "section", title: "Act", sketches: [] },
    ]);
    const changes = diffStoryboard(before, after)!;
    expect(changes.sketchesAdded).toEqual(["a.sk"]);
    expect(changes.sectionsAdded).toEqual(["Act"]);
  });

  it("sees a sketch moving between sections and section description edits", () => {
    const before = storyboard([
      { type: "section", title: "One", description: "", sketches: ["a.sk"] },
      { type: "section", title: "Two", sketches: [] },
    ]);
    const after = storyboard([
      { type: "section", title: "One", description: "Opening", sketches: [] },
      { type: "section", title: "Two", sketches: ["a.sk"] },
    ]);
    const changes = diffStoryboard(before, after)!;
    expect(changes.sketchesMoved).toBe(1);
    expect(changes.sectionsEdited).toEqual(["One"]);
    expect(describeChange({ path: "s.sb", kind: "storyboard", status: "modified", detail: { kind: "storyboard", changes } })).toBe(
      "1 section edited, 1 sketch moved",
    );
  });
});

describe("summarizeChanges", () => {
  it("totals document-aware changes across kinds", () => {
    const summary = summarizeChanges([
      { path: "intro.sk", status: "modified", before: sketch([row("a")]), after: sketch([row("a", "x"), row("b")]) },
      { path: "plan.md", status: "modified", before: "a", after: "b" },
      { path: "new.sk", status: "added" },
      { path: "old.md", status: "deleted" },
      { path: "renamed.sb", previousPath: "talk.sb", status: "renamed" },
      { path: ".cutready/screenshots/s.png", status: "added", isBinary: true },
      { path: ".cutready/narration/t.wav", status: "deleted", isBinary: true },
      { path: "conflict.sk", status: "conflicted", before: sketch([]), after: sketch([]) },
    ]);
    expect(summary.totals).toMatchObject({
      documents: 8,
      rowsAdded: 1,
      rowsChanged: 1,
      sketchesEdited: 1,
      notesEdited: 1,
      documentsAdded: 1,
      documentsDeleted: 1,
      documentsRenamed: 1,
      mediaAdded: 1,
      mediaRemoved: 1,
      conflicts: 1,
    });
    const conflict = summary.documents.find((d) => d.path === "conflict.sk")!;
    expect(conflict).toMatchObject({ status: "conflicted", detail: null });
    expect(describeChange(conflict)).toBe("Conflicted");
    expect(summaryChips(summary.totals)[0]).toEqual({ id: "conflicts", label: "1 conflict" });
    expect(summary.documents.find((d) => d.path === ".cutready/screenshots/s.png")?.mediaType).toBe("image");
  });

  it("counts renamed documents as edited only when content changed", () => {
    const summary = summarizeChanges([
      { path: "b.sk", previousPath: "a.sk", status: "renamed", before: sketch([row("a")]), after: sketch([row("a", "x")]) },
      { path: "d.md", previousPath: "c.md", status: "renamed", before: "same", after: "same" },
      { path: "e.md", status: "modified", before: "same", after: "same" },
    ]);
    expect(summary.totals).toMatchObject({ sketchesEdited: 1, notesEdited: 0, documentsRenamed: 2, rowsChanged: 1 });
  });

  it("counts renamed and modified media as changed", () => {
    const summary = summarizeChanges([
      { path: ".cutready/visuals/v.json", status: "modified" },
      { path: "clip2.mp4", previousPath: "clip.mp4", status: "renamed", isBinary: true },
    ]);
    expect(summary.totals).toMatchObject({ mediaChanged: 2, documentsRenamed: 0 });
    expect(summaryChips(summary.totals).map((chip) => chip.label)).toEqual(["2 media files changed"]);
  });

  it("keeps file-level entries when content is unavailable", () => {
    const summary = summarizeChanges([{ path: "intro.sk", status: "modified" }]);
    expect(summary.documents[0].detail).toBeNull();
    expect(describeChange(summary.documents[0])).toBe("Edited");
  });
});

describe("loadChangeSummary", () => {
  it("loads content only for edited text documents and survives loader failures", async () => {
    const loaded: string[] = [];
    const summary = await loadChangeSummary(
      [
        { path: "a.sk", status: "modified" },
        { path: "b.md", status: "modified" },
        { path: "c.sk", status: "added" },
        { path: "s.png", status: "modified" },
      ],
      async (file) => {
        loaded.push(file.path);
        if (file.path === "b.md") throw new Error("boom");
        return { before: sketch([]), after: sketch([row("x")]), isBinary: false };
      },
    );
    expect(loaded).toEqual(["a.sk", "b.md"]);
    expect(summary.totals.rowsAdded).toBe(1);
    expect(summary.documents[1].detail).toBeNull();
  });
});

describe("format", () => {
  it("builds popover chips from totals", () => {
    const summary = summarizeChanges([
      { path: "intro.sk", status: "modified", before: sketch([row("a")]), after: sketch([row("b"), row("c")]) },
      { path: "s.png", status: "added" },
      { path: "n.md", status: "added" },
    ]);
    expect(summaryChips(summary.totals).map((chip) => chip.label)).toEqual([
      "+2 rows, −1 row",
      "1 sketch edited",
      "+1 media file",
      "Documents: 1 added",
    ]);
    expect(summaryChips(summarizeChanges([]).totals)).toEqual([]);
  });

  it("describes per-document changes", () => {
    const [sketchChange, renamed, note] = summarizeChanges([
      { path: "intro.sk", status: "modified", before: sketch([row("a")]), after: sketch([row("a", "x")], { title: "T" }) },
      { path: "b.sb", previousPath: "a.sb", status: "renamed", before: storyboard([]), after: storyboard([]) },
      { path: "n.md", status: "modified", before: "one", after: "one two" },
    ]).documents;
    expect(describeChange(sketchChange)).toBe("1 row edited, title");
    expect(describeChange(renamed)).toBe("Renamed from a");
    expect(describeChange(note)).toBe("1 paragraph edited, +1 word");
  });
});
