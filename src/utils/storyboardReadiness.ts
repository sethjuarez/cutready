import type { PlanningRow, Sketch, SketchSummary, Storyboard, StoryboardItem } from "../types/sketch";

export type StoryboardReadinessStatus = "ready" | "needs-work";

export interface RowReadinessIssue {
  sketchPath: string;
  sketchTitle: string;
  rowNumber: number;
  locked: boolean;
  missingTiming: boolean;
  missingNarration: boolean;
  missingDemoActions: boolean;
  vagueDemoActions: boolean;
  missingVisuals: boolean;
}

export interface SketchReadinessSummary {
  path: string;
  title: string;
  locked: boolean;
  loaded: boolean;
  rowCount: number;
  issueCount: number;
}

export interface StoryboardReadinessSummary {
  status: StoryboardReadinessStatus;
  totalSketches: number;
  loadedSketches: number;
  totalRows: number;
  missingTiming: number;
  missingNarration: number;
  missingDemoActions: number;
  vagueDemoActions: number;
  missingVisuals: number;
  lockedIssueRows: number;
  incompleteSketches: SketchReadinessSummary[];
  unloadedSketches: SketchReadinessSummary[];
  rowIssues: RowReadinessIssue[];
  nextSteps: string[];
}

const VAGUE_ACTION_PATTERNS = [
  /\btbd\b/i,
  /\btodo\b/i,
  /\bfix me\b/i,
  /\bclick around\b/i,
  /\bshow (the )?(feature|thing|stuff|page|screen)\b/i,
  /\bdemo (this|it|feature)\b/i,
  /\bwalk through\b/i,
  /\bgo through\b/i,
  /\badd actions?\b/i,
  /\bfill (this )?in\b/i,
];

export function getStoryboardSketchPaths(storyboard: Storyboard): string[] {
  return storyboard.items.flatMap((item) => getItemSketchPaths(item));
}

export function buildStoryboardReadiness(
  storyboard: Storyboard,
  sketchesByPath: Map<string, Sketch>,
  summariesByPath: Map<string, SketchSummary> = new Map(),
): StoryboardReadinessSummary {
  const sketchPaths = getStoryboardSketchPaths(storyboard);
  const rowIssues: RowReadinessIssue[] = [];
  const incompleteSketches: SketchReadinessSummary[] = [];
  const unloadedSketches: SketchReadinessSummary[] = [];

  let totalRows = 0;
  let missingTiming = 0;
  let missingNarration = 0;
  let missingDemoActions = 0;
  let vagueDemoActions = 0;
  let missingVisuals = 0;
  let lockedIssueRows = 0;

  for (const path of sketchPaths) {
    const sketch = sketchesByPath.get(path);
    const summary = summariesByPath.get(path);
    const title = sketch?.title ?? summary?.title ?? path;
    const locked = sketch?.locked ?? false;

    if (!sketch) {
      unloadedSketches.push({
        path,
        title,
        locked,
        loaded: false,
        rowCount: summary?.row_count ?? 0,
        issueCount: 1,
      });
      continue;
    }

    totalRows += sketch.rows.length;
    let sketchIssueCount = sketch.rows.length === 0 ? 1 : 0;

    sketch.rows.forEach((row, index) => {
      const issue = buildRowIssue(path, title, sketch.locked ?? false, row, index);
      if (!hasRowIssue(issue)) return;

      rowIssues.push(issue);
      sketchIssueCount += countRowIssue(issue);
      if (issue.missingTiming) missingTiming += 1;
      if (issue.missingNarration) missingNarration += 1;
      if (issue.missingDemoActions) missingDemoActions += 1;
      if (issue.vagueDemoActions) vagueDemoActions += 1;
      if (issue.missingVisuals) missingVisuals += 1;
      if (issue.locked) lockedIssueRows += 1;
    });

    if (sketchIssueCount > 0) {
      incompleteSketches.push({
        path,
        title,
        locked,
        loaded: true,
        rowCount: sketch.rows.length,
        issueCount: sketchIssueCount,
      });
    }
  }

  const nextSteps = buildNextSteps({
    totalSketches: sketchPaths.length,
    totalRows,
    missingTiming,
    missingNarration,
    missingDemoActions,
    vagueDemoActions,
    missingVisuals,
    unloadedSketches: unloadedSketches.length,
  });

  return {
    status: incompleteSketches.length === 0 && unloadedSketches.length === 0 && sketchPaths.length > 0
      ? "ready"
      : "needs-work",
    totalSketches: sketchPaths.length,
    loadedSketches: sketchPaths.length - unloadedSketches.length,
    totalRows,
    missingTiming,
    missingNarration,
    missingDemoActions,
    vagueDemoActions,
    missingVisuals,
    lockedIssueRows,
    incompleteSketches,
    unloadedSketches,
    rowIssues,
    nextSteps,
  };
}

export function formatReadinessPrompt(storyboard: Storyboard, summary: StoryboardReadinessSummary): string {
  const emptySketches = summary.incompleteSketches
    .filter((sketch) => sketch.loaded && sketch.rowCount === 0)
    .map((sketch) => {
      const lockNote = sketch.locked ? " (locked - do not edit this sketch)" : "";
      return `- ${sketch.title} (${sketch.path})${lockNote}`;
    })
    .join("\n");

  const issues = summary.rowIssues
    .map((issue) => {
      const parts = [
        issue.missingTiming ? "missing timing" : null,
        issue.missingNarration ? "missing narration" : null,
        issue.missingDemoActions ? "missing demo actions" : null,
        issue.vagueDemoActions ? "vague demo actions" : null,
        issue.missingVisuals ? "missing screenshot/visual" : null,
      ].filter(Boolean).join(", ");
      const lockNote = issue.locked ? " (locked - do not edit this row or its locked cells)" : "";
      return `- ${issue.sketchTitle} (${issue.sketchPath}) row ${issue.rowNumber}: ${parts}${lockNote}`;
    })
    .join("\n");

  const unloaded = summary.unloadedSketches
    .map((sketch) => `- ${sketch.title} (${sketch.path})`)
    .join("\n");

  return [
    `Fix readiness gaps for the storyboard "${storyboard.title}".`,
    "Use the storyboard and sketch tools to update only rows that are not locked. Do not modify locked rows or locked cells.",
    `Current readiness status: ${summary.status === "ready" ? "Ready" : "Needs Work"}.`,
    `Totals: ${summary.totalRows} rows, ${summary.missingTiming} missing timing, ${summary.missingNarration} missing narration, ${summary.missingDemoActions} missing demo actions, ${summary.vagueDemoActions} vague demo actions, ${summary.missingVisuals} missing screenshots/visuals.`,
    emptySketches ? `Sketches with no planning rows:\n${emptySketches}` : "",
    issues ? `Rows to fix:\n${issues}` : "No row-level gaps were detected.",
    unloaded ? `First load or inspect these sketches before editing:\n${unloaded}` : "",
    "Add concise timing, narration, concrete demo actions, and screenshot/visual guidance where appropriate. When finished, summarize what changed.",
  ].filter(Boolean).join("\n\n");
}

function getItemSketchPaths(item: StoryboardItem): string[] {
  if (item.type === "sketch_ref") return [item.path];
  return item.sketches;
}

function buildRowIssue(
  sketchPath: string,
  sketchTitle: string,
  sketchLocked: boolean,
  row: PlanningRow,
  rowIndex: number,
): RowReadinessIssue {
  const missingDemoActions = isBlank(row.demo_actions);
  const missingTiming = isBlank(row.time);
  const missingNarration = isBlank(row.narrative);
  const vagueDemoActions = !missingDemoActions && isVagueAction(row.demo_actions);
  const missingVisuals = isBlank(row.screenshot) && isBlank(row.visual);

  return {
    sketchPath,
    sketchTitle,
    rowNumber: rowIndex + 1,
    locked: isIssueLocked(row, sketchLocked, {
      missingTiming,
      missingNarration,
      missingDemoActions,
      vagueDemoActions,
      missingVisuals,
    }),
    missingTiming,
    missingNarration,
    missingDemoActions,
    vagueDemoActions,
    missingVisuals,
  };
}

function isBlank(value: string | null | undefined): boolean {
  return !value || value.trim().length === 0;
}

function isVagueAction(value: string): boolean {
  const normalized = value.trim();
  if (normalized.length < 4) return true;
  return VAGUE_ACTION_PATTERNS.some((pattern) => pattern.test(normalized));
}

function hasRowIssue(issue: RowReadinessIssue): boolean {
  return countRowIssue(issue) > 0;
}

function countRowIssue(issue: RowReadinessIssue): number {
  return [
    issue.missingTiming,
    issue.missingNarration,
    issue.missingDemoActions,
    issue.vagueDemoActions,
    issue.missingVisuals,
  ].filter(Boolean).length;
}

function isIssueLocked(
  row: PlanningRow,
  sketchLocked: boolean,
  issues: {
    missingTiming: boolean;
    missingNarration: boolean;
    missingDemoActions: boolean;
    vagueDemoActions: boolean;
    missingVisuals: boolean;
  },
): boolean {
  if (sketchLocked || row.locked) return true;
  const locks = row.locks ?? {};
  return Boolean(
    (issues.missingTiming && locks.time) ||
    (issues.missingNarration && locks.narrative) ||
    ((issues.missingDemoActions || issues.vagueDemoActions) && locks.demo_actions) ||
    (issues.missingVisuals && locks.screenshot && locks.visual),
  );
}

function buildNextSteps(input: {
  totalSketches: number;
  totalRows: number;
  missingTiming: number;
  missingNarration: number;
  missingDemoActions: number;
  vagueDemoActions: number;
  missingVisuals: number;
  unloadedSketches: number;
}): string[] {
  if (input.totalSketches === 0) return ["Add at least one sketch to the storyboard."];
  if (input.unloadedSketches > 0) return ["Finish loading referenced sketches, then run the readiness check again."];
  if (input.totalRows === 0) return ["Add planning rows to the storyboard sketches."];

  const steps: string[] = [];
  if (input.missingTiming > 0) steps.push("Fill in timing for rows that do not yet have pacing.");
  if (input.missingNarration > 0) steps.push("Add narration so the presenter knows what to say.");
  if (input.missingDemoActions > 0 || input.vagueDemoActions > 0) {
    steps.push("Replace missing or vague demo actions with concrete steps.");
  }
  if (input.missingVisuals > 0) steps.push("Attach a screenshot or visual cue to each uncovered row.");
  if (steps.length === 0) steps.push("Ready to record.");
  return steps;
}
