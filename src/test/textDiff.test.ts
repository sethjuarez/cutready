import { describe, it, expect } from "vitest";
import { wordDiff, diffRow } from "../utils/textDiff";

describe("wordDiff", () => {
  it("returns equal for identical strings", () => {
    const result = wordDiff("hello world", "hello world");
    expect(result).toEqual([{ type: "equal", text: "hello world" }]);
  });

  it("returns added for empty old", () => {
    const result = wordDiff("", "hello");
    expect(result).toEqual([{ type: "added", text: "hello" }]);
  });

  it("returns removed for empty new", () => {
    const result = wordDiff("hello", "");
    expect(result).toEqual([{ type: "removed", text: "hello" }]);
  });

  it("detects word-level changes", () => {
    const result = wordDiff("Click the settings panel", "Click the preferences panel");
    // Should have: equal "Click the", removed "settings", added "preferences", equal "panel"
    const types = result.map((s) => s.type);
    expect(types).toContain("removed");
    expect(types).toContain("added");
    const removed = result.filter((s) => s.type === "removed").map((s) => s.text).join(" ");
    const added = result.filter((s) => s.type === "added").map((s) => s.text).join(" ");
    expect(removed).toContain("settings");
    expect(added).toContain("preferences");
  });

  it("handles complete replacement", () => {
    const result = wordDiff("old text", "new content");
    expect(result.some((s) => s.type === "removed")).toBe(true);
    expect(result.some((s) => s.type === "added")).toBe(true);
  });
});

describe("diffRow", () => {
  it("returns null for identical rows", () => {
    const row = { time: "~30s", narrative: "Hello", demo_actions: "Click" };
    expect(diffRow(row, row, 0)).toBeNull();
  });

  it("detects narrative change", () => {
    const old = { time: "~30s", narrative: "Click settings", demo_actions: "Click" };
    const nw = { time: "~30s", narrative: "Click preferences", demo_actions: "Click" };
    const result = diffRow(old, nw, 2);
    expect(result).not.toBeNull();
    expect(result!.rowIndex).toBe(2);
    expect(result!.fields).toHaveLength(1);
    expect(result!.fields[0].field).toBe("narrative");
  });

  it("detects visual change", () => {
    const old = { time: "", narrative: "", demo_actions: "", visual: null };
    const nw = { time: "", narrative: "", demo_actions: "", visual: "visuals/abc.json" };
    const result = diffRow(old, nw, 0);
    expect(result).not.toBeNull();
    expect(result!.fields[0].field).toBe("visual");
    expect(result!.fields[0].segments[0].text).toBe("Visual updated");
  });

  it("detects multiple field changes", () => {
    const old = { time: "~10s", narrative: "Old text", demo_actions: "Old action" };
    const nw = { time: "~30s", narrative: "New text", demo_actions: "New action" };
    const result = diffRow(old, nw, 1);
    expect(result).not.toBeNull();
    expect(result!.fields.length).toBe(3);
  });
});
