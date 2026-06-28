import { describe, expect, it } from "vitest";
import type { Storyboard } from "../types/sketch";
import {
  formatDuration,
  formatDurationDisplay,
  formatDurationSummary,
  normalizeMetadata,
  parseDurationSeconds,
  parseNoteDocument,
  serializeNoteDocument,
  summarizeSketchPathsDuration,
  summarizeSketchDuration,
  summarizeStoryboardDuration,
} from "../utils/documentMetadata";

describe("document metadata helpers", () => {
  it("normalizes empty keys and values out of document metadata", () => {
    expect(normalizeMetadata({ fields: { owner: " Demo team ", "": "ignored", status: "" } })).toEqual({
      fields: { owner: "Demo team" },
    });
  });

  it("round-trips note metadata as portable frontmatter", () => {
    const content = serializeNoteDocument({ fields: { owner: "Demo: team", status: "draft" } }, "# Notes");
    expect(parseNoteDocument(content)).toEqual({
      metadata: { fields: { owner: "Demo: team", status: "draft" } },
      body: "# Notes",
    });
  });
});

describe("duration helpers", () => {
  it("parses common planning durations", () => {
    expect(parseDurationSeconds("~25s")).toBe(25);
    expect(parseDurationSeconds("1:30")).toBe(90);
    expect(parseDurationSeconds("2m 15s")).toBe(135);
    expect(parseDurationSeconds("not sure")).toBeNull();
  });

  it("formats duration totals", () => {
    expect(formatDuration(75)).toBe("1:15");
    expect(formatDurationDisplay(75, "seconds")).toBe("75s");
    expect(formatDurationDisplay(75, "minutes")).toBe("1:15m");
    expect(formatDuration(3671)).toBe("1:01:11");
  });

  it("summarizes sketch and storyboard durations with unspecified rows", () => {
    const rows = [
      { time: "~30s", duration_seconds: null, narrative: "", demo_actions: "", screenshot: null },
      { time: "1:00", duration_seconds: 45, narrative: "", demo_actions: "", screenshot: null },
      { time: "later", narrative: "", demo_actions: "", screenshot: null },
    ];
    expect(formatDurationSummary(summarizeSketchDuration(rows))).toBe("1:15m + 1 unspecified row");
    expect(formatDurationSummary(summarizeSketchDuration(rows), "seconds")).toBe("75s + 1 unspecified row");

    const storyboard: Storyboard = {
      title: "Demo",
      description: "",
      items: [{ type: "sketch_ref", path: "intro.sk" }, { type: "sketch_ref", path: "missing.sk" }],
      created_at: "",
      updated_at: "",
    };
    expect(formatDurationSummary(summarizeStoryboardDuration(storyboard, new Map([["intro.sk", { rows }]])))).toBe(
      "1:15m + 2 unspecified rows",
    );
    expect(formatDurationSummary(summarizeSketchPathsDuration(["intro.sk"], new Map([["intro.sk", { rows }]])))).toBe(
      "1:15m + 1 unspecified row",
    );
  });
});
