import { describe, expect, it } from "vitest";
import type { StoryboardItem } from "../types/sketch";
import {
  appendSketchToSection,
  getStoryboardItemRenderKey,
  getStoryboardSketchCount,
  getStoryboardSketchPaths,
  getUniqueStoryboardSketchPaths,
  removeStoryboardItem,
  removeSketchFromSection,
  updateStoryboardSection,
} from "../utils/storyboard";

describe("storyboard helpers", () => {
  const items: StoryboardItem[] = [
    { type: "sketch_ref", path: "intro.sk" },
    {
      type: "section",
      title: "Build",
      description: "Prototype and deploy.",
      sketches: ["prototype.sk", "deploy.sk", "deploy.sk"],
    },
  ];

  it("centralizes storyboard sketch traversal", () => {
    const storyboard = {
      title: "Demo",
      description: "",
      items,
      created_at: "2026-01-01T00:00:00Z",
      updated_at: "2026-01-01T00:00:00Z",
    };

    expect(getStoryboardSketchPaths(storyboard)).toEqual(["intro.sk", "prototype.sk", "deploy.sk", "deploy.sk"]);
    expect(getUniqueStoryboardSketchPaths(storyboard)).toEqual(["intro.sk", "prototype.sk", "deploy.sk"]);
    expect(getStoryboardSketchCount(storyboard)).toBe(4);
    expect(getStoryboardItemRenderKey(storyboard.items[1], 1)).toContain("section:Build");
  });

  it("updates section metadata and sketches without mutating callers", () => {
    const renamed = updateStoryboardSection(items, 1, { title: "Observe" });
    expect(renamed[1]).toMatchObject({ type: "section", title: "Observe" });
    expect(items[1]).toMatchObject({ type: "section", title: "Build" });

    const appended = appendSketchToSection(items, 1, "governance.sk");
    expect(appended[1]).toMatchObject({
      type: "section",
      sketches: ["prototype.sk", "deploy.sk", "deploy.sk", "governance.sk"],
    });

    const removed = removeSketchFromSection(items, 1, 0);
    expect(removed[1]).toMatchObject({
      type: "section",
      sketches: ["deploy.sk", "deploy.sk"],
    });

    expect(removeStoryboardItem(items, 1)).toEqual([{ type: "sketch_ref", path: "intro.sk" }]);
  });
});
