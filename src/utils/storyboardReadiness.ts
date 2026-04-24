import type { Sketch, Storyboard, StoryboardItem } from "../types/sketch";

export interface ReadinessSketchInput {
  path: string;
  title: string;
  sketch?: Sketch | null;
  loadError?: string | null;
}

export interface IncompleteSketchSummary {
  path: string;
  title: string;
  issues: string[];
}

export interface StoryboardReadiness {
  ready: boolean;
  status: "Ready" | "Needs Work";
  totalSketches: number;
  loadedSketches: number;
  totalRows: number;
  incompleteRows: number;
  lockedRows: number;
  missingTiming: number;
  missingNarration: number;
  missingDemoActions: number;
  missingVisuals: number;
  emptySketches: number;
  unloadedSketches: number;
  failedSketches: number;
  incompleteSketches: IncompleteSketchSummary[];
  nextSteps: string[];
}

const blank = (value: string | null | undefined) => !value || value.trim().length === 0;

export function storyboardSketchPaths(items: StoryboardItem[]): string[] {
  const paths: string[] = [];
  const seen = new Set<string>();
  const add = (path: string) => {
    if (seen.has(path)) return;
    seen.add(path);
    paths.push(path);
  };

  for (const item of items) {
    if (item.type === "sketch_ref") {
      add(item.path);
    } else {
      item.sketches.forEach(add);
    }
  }

  return paths;
}

export function buildReadinessAiPrompt(storyboard: Storyboard, storyboardPath: string | null, readiness: StoryboardReadiness): string {
  const incomplete = readiness.incompleteSketches
    .map((sketch) => `- ${sketch.title} (${sketch.path}): ${sketch.issues.join("; ")}`)
    .join("\n");

  return [
    `Run a Readiness Check fix pass for the storyboard "${storyboard.title}"${storyboardPath ? ` at "${storyboardPath}"` : ""}.`,
    "Use read_storyboard and read_sketch to inspect the current storyboard and every referenced sketch before editing.",
    "Fill gaps that block recording: missing time, missing narrative, missing demo actions, and rows missing both screenshot and visual.",
    "Do not touch any locked sketch, locked row, or locked cell. Preserve existing user content unless it is clearly a placeholder.",
    "For rows without screenshot or visual, prefer creating an appropriate visual/design plan; do not invent a screenshot path.",
    "Apply safe changes with update_planning_row or the visual tools only, then summarize what changed and what still needs human input.",
    "",
    `Current status: ${readiness.status}. Total rows: ${readiness.totalRows}. Incomplete rows: ${readiness.incompleteRows}. Locked rows: ${readiness.lockedRows}.`,
    incomplete ? `Known gaps:\n${incomplete}` : "Known gaps: none from the local check.",
  ].join("\n");
}

export function computeStoryboardReadiness(sketches: ReadinessSketchInput[]): StoryboardReadiness {
  const readiness: StoryboardReadiness = {
    ready: false,
    status: "Needs Work",
    totalSketches: sketches.length,
    loadedSketches: 0,
    totalRows: 0,
    incompleteRows: 0,
    lockedRows: 0,
    missingTiming: 0,
    missingNarration: 0,
    missingDemoActions: 0,
    missingVisuals: 0,
    emptySketches: 0,
    unloadedSketches: 0,
    failedSketches: 0,
    incompleteSketches: [],
    nextSteps: [],
  };

  for (const item of sketches) {
    const sketch = item.sketch;
    const issues: string[] = [];

    if (item.loadError) {
      readiness.failedSketches += 1;
      readiness.incompleteSketches.push({
        path: item.path,
        title: item.title,
        issues: [`Sketch could not be loaded: ${item.loadError}`],
      });
      continue;
    }

    if (!sketch) {
      readiness.unloadedSketches += 1;
      readiness.incompleteSketches.push({
        path: item.path,
        title: item.title,
        issues: ["Waiting for sketch data"],
      });
      continue;
    }

    readiness.loadedSketches += 1;
    if (sketch.rows.length === 0) {
      readiness.emptySketches += 1;
      issues.push("No planning rows");
    }

    let sketchIncompleteRows = 0;
    let sketchMissingTiming = 0;
    let sketchMissingNarration = 0;
    let sketchMissingActions = 0;
    let sketchMissingVisuals = 0;

    for (const row of sketch.rows) {
      readiness.totalRows += 1;
      if (row.locked || sketch.locked) readiness.lockedRows += 1;

      const missingTiming = blank(row.time);
      const missingNarration = blank(row.narrative);
      const missingActions = blank(row.demo_actions);
      const missingVisual = blank(row.screenshot) && blank(row.visual);

      if (missingTiming) {
        readiness.missingTiming += 1;
        sketchMissingTiming += 1;
      }
      if (missingNarration) {
        readiness.missingNarration += 1;
        sketchMissingNarration += 1;
      }
      if (missingActions) {
        readiness.missingDemoActions += 1;
        sketchMissingActions += 1;
      }
      if (missingVisual) {
        readiness.missingVisuals += 1;
        sketchMissingVisuals += 1;
      }
      if (missingTiming || missingNarration || missingActions || missingVisual) {
        readiness.incompleteRows += 1;
        sketchIncompleteRows += 1;
      }
    }

    if (sketchIncompleteRows > 0) issues.push(`${sketchIncompleteRows} incomplete ${sketchIncompleteRows === 1 ? "row" : "rows"}`);
    if (sketchMissingTiming > 0) issues.push(`${sketchMissingTiming} missing timing`);
    if (sketchMissingNarration > 0) issues.push(`${sketchMissingNarration} missing narration`);
    if (sketchMissingActions > 0) issues.push(`${sketchMissingActions} missing demo actions`);
    if (sketchMissingVisuals > 0) issues.push(`${sketchMissingVisuals} missing screenshot or visual`);

    if (issues.length > 0) {
      readiness.incompleteSketches.push({
        path: item.path,
        title: sketch.title || item.title,
        issues,
      });
    }
  }

  readiness.ready = readiness.totalSketches > 0
    && readiness.loadedSketches === readiness.totalSketches
    && readiness.totalRows > 0
    && readiness.emptySketches === 0
    && readiness.failedSketches === 0
    && readiness.incompleteRows === 0;
  readiness.status = readiness.ready ? "Ready" : "Needs Work";
  readiness.nextSteps = buildNextSteps(readiness);

  return readiness;
}

function buildNextSteps(readiness: StoryboardReadiness): string[] {
  if (readiness.ready) {
    return ["Start recording. Every row has timing, narration, demo actions, and a screenshot or visual."];
  }

  const steps: string[] = [];
  if (readiness.failedSketches > 0) steps.push("Fix missing or unreadable sketch references.");
  if (readiness.unloadedSketches > 0) steps.push("Wait for all sketches to load, then re-run the check.");
  if (readiness.emptySketches > 0) steps.push("Add planning rows to empty sketches.");
  if (readiness.missingTiming > 0) steps.push("Add time estimates to rows without timing.");
  if (readiness.missingNarration > 0) steps.push("Write narration for rows without voiceover.");
  if (readiness.missingDemoActions > 0) steps.push("Clarify demo actions for rows that are vague or empty.");
  if (readiness.missingVisuals > 0) steps.push("Attach screenshots or create visuals for rows with no visual reference.");
  return steps;
}
