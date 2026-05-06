#!/usr/bin/env node
import { existsSync, mkdirSync, readdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";
import process from "node:process";
import {
  applyCommand,
  applyNudge,
  diffDocuments,
  normalizeToV2,
  summarizeDocument,
  suggestDocumentNudges,
  toRenderableV1,
  validate,
  validateForAgent,
  validateV2,
} from "@elucim/dsl";

const DEFAULT_TARGET = "D:\\cutready";
const REPORT_DIR = path.join(process.cwd(), "scripts", "visual-eval", "reports");
const DEFAULT_OUT = path.join(REPORT_DIR, "v2-smoke-report.json");

const MINIMAL_V2_DOC = {
  version: "2.0",
  scene: {
    type: "player",
    width: 1920,
    height: 1080,
    durationInFrames: 90,
    children: ["title", "metric"],
  },
  elements: {
    title: {
      id: "title",
      type: "text",
      layout: { x: 120, y: 120, zIndex: 0 },
      props: { type: "text", content: "CutReady + Elucim v2", x: 120, y: 120, fontSize: 52, fill: "$title" },
    },
    metric: {
      id: "metric",
      type: "text",
      layout: { x: 120, y: 240, zIndex: 1 },
      props: { type: "text", content: "Agent-editable IDs", x: 120, y: 240, fontSize: 34, fill: "$subtitle" },
    },
  },
  timelines: {
    intro: {
      id: "intro",
      duration: 30,
      tracks: [
        { target: "title", property: "opacity", keyframes: [{ frame: 0, value: 0 }, { frame: 30, value: 1 }] },
        { target: "metric", property: "opacity", keyframes: [{ frame: 6, value: 0 }, { frame: 30, value: 1 }] },
      ],
    },
  },
  stateMachines: {
    deck: {
      id: "deck",
      initial: "idle",
      states: {
        idle: { on: { start: { target: "intro", timeline: "intro" } } },
        intro: { timeline: "intro" },
      },
    },
  },
};

function parseArgs(argv) {
  const options = {
    target: DEFAULT_TARGET,
    out: DEFAULT_OUT,
    limit: Number.POSITIVE_INFINITY,
    applyReviewNudges: false,
    json: false,
  };

  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === "--out") {
      options.out = argv[++i];
    } else if (arg === "--limit") {
      options.limit = Number.parseInt(argv[++i], 10);
    } else if (arg === "--apply-review-nudges") {
      options.applyReviewNudges = true;
    } else if (arg === "--json") {
      options.json = true;
    } else if (arg === "--help" || arg === "-h") {
      printHelp();
      process.exit(0);
    } else if (!arg.startsWith("--")) {
      options.target = arg;
    } else {
      throw new Error(`Unknown argument: ${arg}`);
    }
  }

  return options;
}

function printHelp() {
  console.log(`Usage: npm run visual:smoke-v2 -- [project-or-visual-path] [--limit n] [--out report.json] [--apply-review-nudges] [--json]

Smoke-tests Elucim v2 internals against CutReady visuals:
  - load v1/v2 visual JSON
  - migrate v1 -> v2 when needed
  - validate/summarize/validateForAgent
  - apply deterministic metadata command
  - apply safe nudges, optionally review nudges
  - validate after nudges
  - convert v2 -> v1 and validate current renderer/editor compatibility

Default target: ${DEFAULT_TARGET}`);
}

function collectVisualFiles(target) {
  if (!existsSync(target)) {
    throw new Error(`Target does not exist: ${target}`);
  }

  if (statSync(target).isFile()) {
    return target.endsWith(".json") ? [target] : [];
  }

  const files = [];
  const stack = [target];
  while (stack.length > 0) {
    const current = stack.pop();
    for (const entry of readdirSync(current, { withFileTypes: true })) {
      if (entry.name === ".git" || entry.name === "node_modules" || entry.name === "target" || entry.name === "dist") {
        continue;
      }
      const full = path.join(current, entry.name);
      if (entry.isDirectory()) {
        stack.push(full);
      } else if (entry.isFile() && entry.name.endsWith(".json") && full.includes(`${path.sep}.cutready${path.sep}visuals${path.sep}`)) {
        files.push(full);
      }
    }
  }

  return files.sort((a, b) => statSync(b).mtimeMs - statSync(a).mtimeMs || a.localeCompare(b));
}

function loadJson(file) {
  return JSON.parse(readFileSync(file, "utf8"));
}

function smokeDocument(file, doc, options) {
  const result = {
    file,
    inputVersion: doc?.version ?? null,
    passed: false,
    migrated: false,
    elementCount: 0,
    timelineCount: 0,
    stateMachineCount: 0,
    nudgeCount: 0,
    appliedNudges: [],
    diffCount: 0,
    warnings: [],
    errors: [],
  };

  try {
    const normalized = normalizeToV2(doc);
    result.inputVersion = normalized.inputFormat;
    result.migrated = normalized.migrated;
    result.warnings.push(...normalized.warnings);
    let current = normalized.document;

    const initialValidation = validateV2(current);
    if (!initialValidation.valid) {
      result.errors.push({
        stage: "validateV2.initial",
        errors: initialValidation.errors,
        repairHints: validateForAgent(current).repairHints,
      });
      return result;
    }

    const summary = summarizeDocument(current);
    result.elementCount = summary.elementCount;
    result.timelineCount = summary.timelines.length;
    result.stateMachineCount = summary.stateMachines.length;

    const metadataResult = applyCommand(current, {
      op: "updateMetadata",
      metadata: {
        generatedBy: "cutready-v2-smoke",
      },
    });
    current = metadataResult.document;

    const nudges = suggestDocumentNudges(current);
    result.nudgeCount = nudges.length;
    const selectedNudges = nudges.filter((nudge) => nudge.confidence === "safe" || options.applyReviewNudges);
    for (const nudge of selectedNudges) {
      const before = current;
      const nudgeResult = applyNudge(current, nudge);
      current = nudgeResult.document;
      const patch = diffDocuments(before, current);
      result.appliedNudges.push({
        id: nudge.id,
        confidence: nudge.confidence,
        summaries: nudgeResult.summaries,
        diffCount: patch.length,
      });
      result.diffCount += patch.length;
    }

    const finalValidation = validateForAgent(current);
    if (!finalValidation.valid) {
      result.errors.push({
        stage: "validateForAgent.afterNudges",
        errors: finalValidation.errors,
        repairHints: finalValidation.repairHints,
      });
      return result;
    }

    const renderableV1 = toRenderableV1(current);
    const rendererValidation = validate(renderableV1);
    if (!rendererValidation.valid) {
      result.errors.push({
        stage: "migrateV2ToV1.validate",
        errors: rendererValidation.errors,
      });
      return result;
    }

    result.passed = true;
    return result;
  } catch (error) {
    result.errors.push({
      stage: "exception",
      message: error instanceof Error ? error.message : String(error),
    });
    return result;
  }
}

function smokeMinimalV2(options) {
  return smokeDocument("(minimal-v2-fixture)", MINIMAL_V2_DOC, options);
}

function summarize(results) {
  const failures = results.filter((result) => !result.passed);
  const nudgeCounts = new Map();
  for (const result of results) {
    for (const nudge of result.appliedNudges) {
      nudgeCounts.set(nudge.id, (nudgeCounts.get(nudge.id) ?? 0) + 1);
    }
  }

  return {
    visualCount: results.length,
    passed: results.length - failures.length,
    failed: failures.length,
    passRate: results.length > 0 ? Math.round(((results.length - failures.length) / results.length) * 100) : 100,
    inputVersions: countBy(results, (result) => result.inputVersion ?? "unknown"),
    appliedNudges: Object.fromEntries([...nudgeCounts.entries()].sort((a, b) => b[1] - a[1])),
  };
}

function countBy(items, keyFn) {
  const counts = new Map();
  for (const item of items) {
    const key = keyFn(item);
    counts.set(key, (counts.get(key) ?? 0) + 1);
  }
  return Object.fromEntries([...counts.entries()].sort((a, b) => String(a[0]).localeCompare(String(b[0]))));
}

function formatConsoleReport(report) {
  const lines = [];
  lines.push("Elucim v2 smoke report");
  lines.push(`Target: ${report.target}`);
  lines.push(`Visuals: ${report.summary.visualCount}`);
  lines.push(`Pass rate: ${report.summary.passRate}% (${report.summary.passed}/${report.summary.visualCount})`);
  lines.push(`Input versions: ${Object.entries(report.summary.inputVersions).map(([version, count]) => `${version}: ${count}`).join(", ") || "none"}`);
  lines.push(`Applied nudges: ${Object.entries(report.summary.appliedNudges).map(([id, count]) => `${id}: ${count}`).join(", ") || "none"}`);
  lines.push("");

  const failures = report.results.filter((result) => !result.passed);
  if (failures.length === 0) {
    lines.push("Failures: none");
  } else {
    lines.push("Failures:");
    for (const failure of failures.slice(0, 20)) {
      lines.push(`${path.basename(failure.file)} (${failure.inputVersion ?? "unknown"})`);
      for (const error of failure.errors.slice(0, 3)) {
        lines.push(`  - ${error.stage}: ${error.message ?? JSON.stringify(error.errors?.slice?.(0, 3) ?? error.errors)}`);
      }
    }
  }

  return lines.join("\n");
}

function main() {
  const options = parseArgs(process.argv.slice(2));
  const files = collectVisualFiles(options.target).slice(0, options.limit);
  const results = [smokeMinimalV2(options)];

  for (const file of files) {
    results.push(smokeDocument(file, loadJson(file), options));
  }

  const report = {
    generatedAt: new Date().toISOString(),
    target: options.target,
    applyReviewNudges: options.applyReviewNudges,
    summary: summarize(results),
    results,
  };

  mkdirSync(path.dirname(options.out), { recursive: true });
  writeFileSync(options.out, `${JSON.stringify(report, null, 2)}\n`, "utf8");

  if (options.json) {
    console.log(JSON.stringify(report, null, 2));
  } else {
    console.log(formatConsoleReport(report));
    console.log("");
    console.log(`Wrote ${options.out}`);
  }

  if (report.summary.failed > 0) {
    process.exitCode = 1;
  }
}

if (import.meta.url === pathToFileURL(process.argv[1]).href) {
  try {
    main();
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    process.exit(1);
  }
}
