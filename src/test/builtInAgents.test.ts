import { describe, expect, it } from "vitest";
import { BUILT_IN_AGENTS } from "../agents/builtInAgents";

describe("built-in Designer agent", () => {
  const designer = BUILT_IN_AGENTS.find((agent) => agent.id === "designer");

  it("requires an evaluative visual workflow", () => {
    expect(designer).toBeDefined();
    const prompt = designer?.prompt ?? "";

    expect(prompt).toContain("Required Evaluative Workflow");
    expect(prompt).toContain("design_plan");
    expect(prompt).toContain("set_row_visual");
    expect(prompt).toContain("review_row_visual");
    expect(prompt).toContain("apply_row_visual_nudge");
    expect(prompt).toContain("apply_row_visual_command");
  });

  it("documents the full Elucim bridge tool loop", () => {
    const prompt = designer?.prompt ?? "";

    for (const operation of [
      "catalog",
      "createComposite",
      "applyCommands",
      "validate",
      "repair",
      "evaluate",
      "inspect",
      "inspectPolishHeuristics",
      "suggestNudges",
      "applyNudge",
      "suggestSemanticLayoutNudges",
      "planMotionBeats",
      "createSemanticMotionTimeline",
      "createAutoStaggerTimeline",
      "createStateSnapshotMotion",
      "lintMotion",
      "previewBeatDiffs",
      "createReducedMotionDocument",
      "holdFinalFrame",
    ]) {
      expect(prompt).toContain(operation);
    }
  });
});
