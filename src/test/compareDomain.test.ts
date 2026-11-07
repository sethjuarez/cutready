import { describe, expect, it } from "vitest";
import { diffSequence } from "../domain/compare/sequenceDiff";
import { compareNote, diffWords, noteWordCounts } from "../domain/compare/noteCompare";
import { compareSketch } from "../domain/compare/sketchCompare";
import { compareStoryboard, storyboardSketches } from "../domain/compare/storyboardCompare";

const sketch = (rows: Array<Record<string, unknown>>, extra: Record<string, unknown> = {}) =>
  JSON.stringify({ title: "Demo", rows, ...extra });
const row = (id: string, narrative = id) => ({ id, time: "~10s", narrative, demo_actions: "" });

describe("diffSequence", () => {
  it("keeps common items and groups deletes before inserts", () => {
    const ops = diffSequence(["a", "b", "c"], ["a", "x", "c"]);
    expect(ops.map((op) => op.op)).toEqual(["equal", "delete", "insert", "equal"]);
  });

  it("handles empty sides", () => {
    expect(diffSequence([], ["a"])).toEqual([{ op: "insert", b: 0 }]);
    expect(diffSequence(["a"], [])).toEqual([{ op: "delete", a: 0 }]);
  });
});

describe("compareNote", () => {
  it("pairs edited paragraphs with a word diff", () => {
    const result = compareNote("Intro\n\nThe old line here", "Intro\n\nThe new line here\n\nOutro");
    expect(result.blocks.map((block) => block.status)).toEqual(["equal", "changed", "added"]);
    const changed = result.blocks[1];
    expect(changed.status === "changed" && changed.words).toEqual([
      { op: "equal", text: "The " },
      { op: "delete", text: "old" },
      { op: "insert", text: "new" },
      { op: "equal", text: " line here" },
    ]);
    expect(noteWordCounts(result)).toEqual({ added: 2, removed: 1 });
  });

  it("shows a reordered paragraph once, as moved", () => {
    const result = compareNote("A\n\nB\n\nC", "B\n\nC\n\nA");
    expect(result.blocks).toEqual([
      { status: "equal", text: "B" },
      { status: "equal", text: "C" },
      { status: "moved", text: "A" },
    ]);
    expect(noteWordCounts(result)).toEqual({ added: 0, removed: 0 });
  });

  it("treats a missing side as empty", () => {
    expect(compareNote(null, "Hello").blocks).toEqual([{ status: "added", text: "Hello" }]);
  });

  it("ignores reflowed whitespace inside words", () => {
    expect(diffWords("a  b", "a b")).toEqual([{ op: "equal", text: "a b" }]);
  });
});

describe("compareSketch", () => {
  it("lists added, removed, changed and moved rows in display order", () => {
    const before = sketch([row("r1"), row("r2"), row("r3"), row("r4")]);
    const after = sketch([row("r2"), row("r1", "edited"), row("r5"), row("r4")], { title: "Renamed" });
    const result = compareSketch(before, after)!;
    expect(result.rows.map((r) => [r.key, r.status, r.moved])).toEqual([
      ["r2", "unchanged", true],
      ["r1", "changed", false],
      ["r3", "removed", false],
      ["r5", "added", false],
      ["r4", "unchanged", false],
    ]);
    expect(result.rows[1].fields).toEqual(["narrative"]);
    expect(result.fields).toEqual(["title"]);
  });

  it("reads a missing side as an empty sketch", () => {
    const result = compareSketch(null, sketch([row("r1")]))!;
    expect(result.rows.map((r) => r.status)).toEqual(["added"]);
  });

  it("returns null for malformed text or repeated ids", () => {
    expect(compareSketch("{oops", sketch([]))).toBeNull();
    expect(compareSketch(sketch([row("a"), row("a")]), sketch([]))).toBeNull();
  });
});

describe("compareStoryboard", () => {
  const board = (items: unknown[]) => JSON.stringify({ title: "Board", items });

  it("shows a sketch moved between sections once, where it landed", () => {
    const before = board([
      { type: "sketch_ref", path: "intro.sk" },
      { type: "section", title: "Act 1", description: "", sketches: ["a.sk", "b.sk"] },
      { type: "section", title: "Old", description: "", sketches: ["gone.sk"] },
    ]);
    const after = board([
      { type: "sketch_ref", path: "intro.sk" },
      { type: "section", title: "Act 1", description: "changed", sketches: ["a.sk"] },
      { type: "section", title: "Act 2", description: "", sketches: ["b.sk", "new.sk"] },
    ]);
    const result = compareStoryboard(before, after)!;
    expect(result.entries.map((entry) => [entry.kind, entry.kind === "section" ? entry.title : entry.path, entry.status])).toEqual([
      ["sketch", "intro.sk", "unchanged"],
      ["section", "Act 1", "unchanged"],
      ["section", "Old", "removed"],
      ["section", "Act 2", "added"],
    ]);
    const act1 = result.entries[1];
    expect(act1.kind === "section" && act1.edited).toBe(true);
    const sketches = storyboardSketches(result).map((s) => [s.path, s.status, s.moved]);
    expect(sketches).toEqual([
      ["intro.sk", "unchanged", false],
      ["a.sk", "unchanged", false],
      ["gone.sk", "removed", false],
      ["b.sk", "unchanged", true],
      ["new.sk", "added", false],
    ]);
  });

  it("reads a missing side as empty and rejects malformed text", () => {
    expect(compareStoryboard(null, board([{ type: "sketch_ref", path: "a.sk" }]))!.entries[0].status).toBe("added");
    expect(compareStoryboard("[", board([]))).toBeNull();
  });
});
