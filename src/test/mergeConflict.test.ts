import { describe, it, expect } from "vitest";
import { buildMergedJson, setNestedValue } from "../components/MergeConflictPanel";
import type { ConflictFile } from "../types/sketch";

/** Helper to build a minimal ConflictFile for testing. */
function makeConflict(overrides: Partial<ConflictFile> = {}): ConflictFile {
  return {
    path: "test.sk",
    file_type: "sketch",
    ours: JSON.stringify({ title: "A", description: "desc-ours" }),
    theirs: JSON.stringify({ title: "B", description: "desc-theirs" }),
    ancestor: JSON.stringify({ title: "A", description: "desc-ancestor" }),
    field_conflicts: [],
    text_conflicts: [],
    ...overrides,
  };
}

describe("setNestedValue", () => {
  it("sets a top-level key", () => {
    const obj = { a: 1, b: 2 };
    setNestedValue(obj, "a", 99);
    expect(obj.a).toBe(99);
  });

  it("sets a nested key with dot path", () => {
    const obj = { meta: { author: "Alice" } };
    setNestedValue(obj, "meta.author", "Bob");
    expect(obj.meta.author).toBe("Bob");
  });

  it("sets an array element with bracket notation", () => {
    const obj = { items: ["x", "y", "z"] };
    setNestedValue(obj, "items[1]", "REPLACED");
    expect(obj.items[1]).toBe("REPLACED");
  });

  it("sets deeply nested path", () => {
    const obj = { a: { b: { c: { d: "old" } } } };
    setNestedValue(obj, "a.b.c.d", "new");
    expect(obj.a.b.c.d).toBe("new");
  });

  it("no-ops gracefully if intermediate path is missing", () => {
    const obj = { a: 1 };
    // "a.b.c" — a is not an object with key b, so should bail
    setNestedValue(obj, "x.y.z", "value");
    expect(obj).toEqual({ a: 1 });
  });
});

describe("buildMergedJson", () => {
  it("returns ours unchanged when no field conflicts exist", () => {
    const conflict = makeConflict();
    const result = buildMergedJson(conflict, {});
    expect(JSON.parse(result)).toEqual({ title: "A", description: "desc-ours" });
  });

  it("keeps ours value when choice is 'ours'", () => {
    const conflict = makeConflict({
      field_conflicts: [
        { field_path: "title", ours: "A", theirs: "B", ancestor: "A" },
      ],
    });
    const result = buildMergedJson(conflict, { title: "ours" });
    expect(JSON.parse(result).title).toBe("A");
  });

  it("applies theirs value when choice is 'theirs'", () => {
    const conflict = makeConflict({
      field_conflicts: [
        { field_path: "title", ours: "A", theirs: "B", ancestor: "A" },
      ],
    });
    const result = buildMergedJson(conflict, { title: "theirs" });
    expect(JSON.parse(result).title).toBe("B");
  });

  it("applies mixed ours/theirs across multiple fields", () => {
    const conflict = makeConflict({
      field_conflicts: [
        { field_path: "title", ours: "A", theirs: "B", ancestor: "A" },
        { field_path: "description", ours: "desc-ours", theirs: "desc-theirs", ancestor: "desc-ancestor" },
      ],
    });
    const result = buildMergedJson(conflict, {
      title: "theirs",
      description: "ours",
    });
    const parsed = JSON.parse(result);
    expect(parsed.title).toBe("B");
    expect(parsed.description).toBe("desc-ours");
  });

  it("handles nested field paths", () => {
    const ours = { meta: { author: "Alice", version: 1 }, rows: [] };
    const conflict = makeConflict({
      ours: JSON.stringify(ours),
      field_conflicts: [
        { field_path: "meta.author", ours: "Alice", theirs: "Bob", ancestor: "Alice" },
      ],
    });
    const result = buildMergedJson(conflict, { "meta.author": "theirs" });
    expect(JSON.parse(result).meta.author).toBe("Bob");
    expect(JSON.parse(result).meta.version).toBe(1);
  });

  it("handles array index field paths", () => {
    const ours = { items: ["row0", "row1", "row2"] };
    const conflict = makeConflict({
      ours: JSON.stringify(ours),
      field_conflicts: [
        { field_path: "items[1]", ours: "row1", theirs: "CHANGED", ancestor: "row1" },
      ],
    });
    const result = buildMergedJson(conflict, { "items[1]": "theirs" });
    expect(JSON.parse(result).items).toEqual(["row0", "CHANGED", "row2"]);
  });

  it("returns raw text when ours is invalid JSON", () => {
    const conflict = makeConflict({
      ours: "this is not json {{{",
    });
    const result = buildMergedJson(conflict, {});
    expect(result).toBe("this is not json {{{");
  });

  it("returns raw text when ours is empty string", () => {
    const conflict = makeConflict({ ours: "" });
    const result = buildMergedJson(conflict, {});
    expect(result).toBe("");
  });

  it("returns pretty-printed JSON", () => {
    const conflict = makeConflict();
    const result = buildMergedJson(conflict, {});
    // Should be indented with 2 spaces
    expect(result).toContain("\n");
    expect(result).toContain("  ");
  });

  it("does not crash when field conflict references missing nested path", () => {
    const conflict = makeConflict({
      field_conflicts: [
        { field_path: "nonexistent.deep.path", ours: "a", theirs: "b", ancestor: "a" },
      ],
    });
    // Should not throw — setNestedValue bails on missing intermediates
    const result = buildMergedJson(conflict, { "nonexistent.deep.path": "theirs" });
    expect(JSON.parse(result)).toEqual({ title: "A", description: "desc-ours" });
  });
});
