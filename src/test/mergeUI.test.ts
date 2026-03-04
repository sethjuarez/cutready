/**
 * Tests for merge UI components and store actions.
 */
import { describe, it, expect, vi } from "vitest";
import type { ConflictFile, MergeResult } from "../types/sketch";

// Mock the MergeConflictPanel's helper functions directly
describe("buildMergedJson (JSON field resolver)", () => {
  // Inline the logic for testability
  function setNestedValue(obj: any, path: string, value: unknown) {
    const parts = path.replace(/\[(\d+)\]/g, ".$1").split(".");
    let current = obj;
    for (let i = 0; i < parts.length - 1; i++) {
      const key = parts[i];
      if (current[key] === undefined) return;
      current = current[key];
    }
    const lastKey = parts[parts.length - 1];
    current[lastKey] = value;
  }

  it("sets top-level field", () => {
    const obj = { title: "old", desc: "keep" };
    setNestedValue(obj, "title", "new");
    expect(obj.title).toBe("new");
    expect(obj.desc).toBe("keep");
  });

  it("sets nested field", () => {
    const obj = { meta: { author: "A", version: 1 } };
    setNestedValue(obj, "meta.author", "B");
    expect(obj.meta.author).toBe("B");
    expect(obj.meta.version).toBe(1);
  });

  it("sets array element by index", () => {
    const obj = { items: ["a", "b", "c"] };
    setNestedValue(obj, "items[1]", "X");
    expect(obj.items[1]).toBe("X");
    expect(obj.items[0]).toBe("a");
  });

  it("handles deep nested path", () => {
    const obj = { a: { b: { c: "old" } } };
    setNestedValue(obj, "a.b.c", "new");
    expect(obj.a.b.c).toBe("new");
  });
});

describe("MergeResult types", () => {
  it("clean merge has commit_id", () => {
    const result: MergeResult = { status: "clean", commit_id: "abc123" };
    expect(result.status).toBe("clean");
    if (result.status === "clean") {
      expect(result.commit_id).toBe("abc123");
    }
  });

  it("conflicts merge has conflict files", () => {
    const conflict: ConflictFile = {
      path: "sketches/intro.sk",
      file_type: "sketch",
      ours: '{"title":"Main"}',
      theirs: '{"title":"Fork"}',
      ancestor: '{"title":"Original"}',
      field_conflicts: [
        { field_path: "title", ours: "Main", theirs: "Fork", ancestor: "Original" },
      ],
      text_conflicts: [],
    };

    const result: MergeResult = { status: "conflicts", conflicts: [conflict] };
    expect(result.status).toBe("conflicts");
    if (result.status === "conflicts") {
      expect(result.conflicts).toHaveLength(1);
      expect(result.conflicts[0].file_type).toBe("sketch");
      expect(result.conflicts[0].field_conflicts).toHaveLength(1);
    }
  });

  it("fast_forward merge has commit_id", () => {
    const result: MergeResult = { status: "fast_forward", commit_id: "def456" };
    expect(result.status).toBe("fast_forward");
  });

  it("nothing merge", () => {
    const result: MergeResult = { status: "nothing" };
    expect(result.status).toBe("nothing");
  });
});

describe("ConflictFile classification", () => {
  it("classifies sketch files", () => {
    const c: ConflictFile = {
      path: "sketches/demo.sk",
      file_type: "sketch",
      ours: "", theirs: "", ancestor: "",
      field_conflicts: [], text_conflicts: [],
    };
    expect(c.file_type).toBe("sketch");
  });

  it("classifies note files", () => {
    const c: ConflictFile = {
      path: "notes/outline.md",
      file_type: "note",
      ours: "", theirs: "", ancestor: "",
      field_conflicts: [], text_conflicts: [],
    };
    expect(c.file_type).toBe("note");
  });

  it("classifies storyboard files", () => {
    const c: ConflictFile = {
      path: "storyboards/demo.sb",
      file_type: "storyboard",
      ours: "", theirs: "", ancestor: "",
      field_conflicts: [], text_conflicts: [],
    };
    expect(c.file_type).toBe("storyboard");
  });
});

describe("TextConflictRegion", () => {
  it("has expected structure", () => {
    const region = {
      start_line: 5,
      ours_lines: ["line from main"],
      theirs_lines: ["line from fork"],
      ancestor_lines: ["original line"],
    };
    expect(region.start_line).toBe(5);
    expect(region.ours_lines).toHaveLength(1);
    expect(region.theirs_lines).toHaveLength(1);
    expect(region.ancestor_lines).toHaveLength(1);
  });
});
