import { describe, expect, it } from "vitest";
import {
  buildReadinessAiPrompt,
  computeStoryboardReadiness,
  storyboardSketchPaths,
} from "../utils/storyboardReadiness";
import type { Sketch, Storyboard } from "../types/sketch";

function sketch(rows: Sketch["rows"], locked = false): Sketch {
  return {
    title: "Setup",
    locked,
    description: "",
    rows,
    state: "draft",
    created_at: "2026-01-01T00:00:00Z",
    updated_at: "2026-01-01T00:00:00Z",
  };
}

describe("storyboard readiness", () => {
  it("counts gaps across sketch rows", () => {
    const readiness = computeStoryboardReadiness([
      {
        path: "setup.sk",
        title: "Setup",
        sketch: sketch([
          {
            time: "0:10",
            narrative: "Open with the setup.",
            demo_actions: "Open the dashboard.",
            screenshot: "screenshots/setup.png",
          },
          {
            locked: true,
            time: "",
            narrative: "",
            demo_actions: "Click Create.",
            screenshot: null,
            visual: null,
          },
        ]),
      },
    ]);

    expect(readiness.status).toBe("Needs Work");
    expect(readiness.totalRows).toBe(2);
    expect(readiness.incompleteRows).toBe(1);
    expect(readiness.lockedRows).toBe(1);
    expect(readiness.missingTiming).toBe(1);
    expect(readiness.missingNarration).toBe(1);
    expect(readiness.missingDemoActions).toBe(0);
    expect(readiness.missingVisuals).toBe(1);
    expect(readiness.incompleteSketches[0]?.issues).toContain("1 incomplete row");
  });

  it("marks complete storyboards as ready", () => {
    const readiness = computeStoryboardReadiness([
      {
        path: "demo.sk",
        title: "Demo",
        sketch: sketch([
          {
            time: "0:20",
            narrative: "Show the key workflow.",
            demo_actions: "Run the demo.",
            screenshot: null,
            visual: ".cutready/visuals/demo.json",
          },
        ]),
      },
    ]);

    expect(readiness.ready).toBe(true);
    expect(readiness.status).toBe("Ready");
    expect(readiness.nextSteps[0]).toContain("Start recording");
  });

  it("deduplicates sketch paths from legacy sections", () => {
    expect(storyboardSketchPaths([
      { type: "sketch_ref", path: "intro.sk" },
      { type: "section", title: "Part 1", sketches: ["intro.sk", "demo.sk"] },
    ])).toEqual(["intro.sk", "demo.sk"]);
  });

  it("builds an AI fix prompt that protects locked rows", () => {
    const storyboard: Storyboard = {
      title: "Launch Demo",
      description: "",
      items: [{ type: "sketch_ref", path: "setup.sk" }],
      created_at: "2026-01-01T00:00:00Z",
      updated_at: "2026-01-01T00:00:00Z",
    };
    const readiness = computeStoryboardReadiness([
      {
        path: "setup.sk",
        title: "Setup",
        sketch: sketch([
          {
            time: "",
            narrative: "",
            demo_actions: "",
            screenshot: null,
          },
        ]),
      },
    ]);

    const prompt = buildReadinessAiPrompt(storyboard, "launch.sb", readiness);

    expect(prompt).toContain("Launch Demo");
    expect(prompt).toContain("Do not touch any locked sketch, locked row, or locked cell");
    expect(prompt).toContain("missing time");
    expect(prompt).toContain("setup.sk");
  });

  it("surfaces all next steps and failed sketch loads", () => {
    const readiness = computeStoryboardReadiness([
      { path: "missing.sk", title: "Missing", loadError: "not found" },
      { path: "empty.sk", title: "Empty", sketch: sketch([]) },
      {
        path: "gaps.sk",
        title: "Gaps",
        sketch: sketch([
          {
            time: "",
            narrative: "",
            demo_actions: "",
            screenshot: null,
          },
        ]),
      },
    ]);

    expect(readiness.failedSketches).toBe(1);
    expect(readiness.incompleteSketches[0]?.issues[0]).toContain("Sketch could not be loaded");
    expect(readiness.nextSteps).toEqual([
      "Fix missing or unreadable sketch references.",
      "Add planning rows to empty sketches.",
      "Add time estimates to rows without timing.",
      "Write narration for rows without voiceover.",
      "Clarify demo actions for rows that are vague or empty.",
      "Attach screenshots or create visuals for rows with no visual reference.",
    ]);
  });
});
