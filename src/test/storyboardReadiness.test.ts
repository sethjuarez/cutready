import { describe, expect, it } from "vitest";
import {
  buildStoryboardReadiness,
  formatReadinessPrompt,
  getStoryboardSketchPaths,
} from "../utils/storyboardReadiness";
import type { Sketch, Storyboard } from "../types/sketch";

function storyboard(items: Storyboard["items"]): Storyboard {
  return {
    title: "Launch Demo",
    description: "",
    items,
    created_at: "2026-01-01T00:00:00Z",
    updated_at: "2026-01-01T00:00:00Z",
  };
}

function sketch(title: string, rows: Sketch["rows"], locked = false): Sketch {
  return {
    title,
    locked,
    description: "",
    rows,
    state: "draft",
    created_at: "2026-01-01T00:00:00Z",
    updated_at: "2026-01-01T00:00:00Z",
  };
}

describe("storyboard readiness", () => {
  it("reports ready when every row has timing, narration, actions, and a visual cue", () => {
    const sb = storyboard([{ type: "sketch_ref", path: "intro.sk" }]);
    const sketches = new Map([
      ["intro.sk", sketch("Intro", [
        {
          time: "0:00-0:15",
          narrative: "Introduce the problem.",
          demo_actions: "Open the dashboard and point to the project list.",
          screenshot: "screenshots/dashboard.png",
        },
      ])],
    ]);

    const readiness = buildStoryboardReadiness(sb, sketches);

    expect(readiness.status).toBe("ready");
    expect(readiness.totalRows).toBe(1);
    expect(readiness.nextSteps).toEqual(["Ready to record."]);
  });

  it("counts missing fields, vague actions, and missing screenshot or visual coverage", () => {
    const sb = storyboard([{ type: "sketch_ref", path: "setup.sk" }]);
    const sketches = new Map([
      ["setup.sk", sketch("Setup", [
        {
          time: "",
          narrative: "",
          demo_actions: "",
          screenshot: null,
        },
        {
          time: "0:15-0:30",
          narrative: "Show the configured workflow.",
          demo_actions: "walk through",
          screenshot: null,
          visual: null,
        },
      ])],
    ]);

    const readiness = buildStoryboardReadiness(sb, sketches);

    expect(readiness.status).toBe("needs-work");
    expect(readiness.missingTiming).toBe(1);
    expect(readiness.missingNarration).toBe(1);
    expect(readiness.missingDemoActions).toBe(1);
    expect(readiness.vagueDemoActions).toBe(1);
    expect(readiness.missingVisuals).toBe(2);
    expect(readiness.incompleteSketches).toHaveLength(1);
  });

  it("includes sketches nested in legacy storyboard sections", () => {
    const sb = storyboard([
      { type: "section", title: "Main flow", sketches: ["intro.sk", "outro.sk"] },
    ]);

    expect(getStoryboardSketchPaths(sb)).toEqual(["intro.sk", "outro.sk"]);
  });

  it("tells the AI prompt not to touch locked rows", () => {
    const sb = storyboard([{ type: "sketch_ref", path: "locked.sk" }]);
    const sketches = new Map([
      ["locked.sk", sketch("Locked", [
        {
          locked: true,
          time: "",
          narrative: "",
          demo_actions: "",
          screenshot: null,
        },
      ])],
    ]);
    const readiness = buildStoryboardReadiness(sb, sketches);

    const prompt = formatReadinessPrompt(sb, readiness);

    expect(readiness.lockedIssueRows).toBe(1);
    expect(prompt).toContain("do not edit this row");
    expect(prompt).toContain("Do not modify locked rows or locked cells");
  });

  it("treats rows in locked sketches as non-editable for AI fixes", () => {
    const sb = storyboard([{ type: "sketch_ref", path: "locked-sketch.sk" }]);
    const sketches = new Map([
      ["locked-sketch.sk", sketch("Locked Sketch", [
        {
          time: "",
          narrative: "",
          demo_actions: "",
          screenshot: null,
        },
      ], true)],
    ]);

    const readiness = buildStoryboardReadiness(sb, sketches);
    const prompt = formatReadinessPrompt(sb, readiness);

    expect(readiness.lockedIssueRows).toBe(1);
    expect(prompt).toContain("locked - do not edit this row");
  });

  it("names empty sketches as AI targets for planning-row creation", () => {
    const sb = storyboard([{ type: "sketch_ref", path: "empty.sk" }]);
    const sketches = new Map([
      ["empty.sk", sketch("Empty Sketch", [])],
    ]);

    const readiness = buildStoryboardReadiness(sb, sketches);
    const prompt = formatReadinessPrompt(sb, readiness);

    expect(readiness.status).toBe("needs-work");
    expect(readiness.incompleteSketches).toHaveLength(1);
    expect(prompt).toContain("Sketches with no planning rows");
    expect(prompt).toContain("Empty Sketch (empty.sk)");
  });

  it("reports unloaded sketches with a fallback title", () => {
    const sb = storyboard([{ type: "sketch_ref", path: "missing.sk" }]);

    const readiness = buildStoryboardReadiness(sb, new Map());

    expect(readiness.status).toBe("needs-work");
    expect(readiness.unloadedSketches).toEqual([
      {
        path: "missing.sk",
        title: "missing.sk",
        locked: false,
        loaded: false,
        rowCount: 0,
        issueCount: 1,
      },
    ]);
    expect(readiness.incompleteSketches).toEqual([]);
  });
});
