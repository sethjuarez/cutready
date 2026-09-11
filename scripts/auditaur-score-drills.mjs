#!/usr/bin/env node
import { mkdirSync } from "node:fs";
import { spawnSync } from "node:child_process";
import path from "node:path";
import process from "node:process";

const REPORT_DIR = path.join(process.cwd(), "target", "auditaur-scorers");

const drills = [
  {
    name: "visuals",
    command: ["scripts/visual-eval/score-visuals.mjs", "--out", path.join(REPORT_DIR, "visuals.json")],
  },
  {
    name: "copy",
    command: ["scripts/agent-eval/score-copy.mjs", "--out", path.join(REPORT_DIR, "copy.json")],
  },
  {
    name: "instructions",
    command: ["scripts/agent-eval/score-instructions.mjs", "--out", path.join(REPORT_DIR, "instructions.json")],
  },
];

mkdirSync(REPORT_DIR, { recursive: true });

const failures = [];

for (const drill of drills) {
  console.log(`\n== ${drill.name} scorer ==`);
  const result = spawnSync(process.execPath, drill.command, {
    cwd: process.cwd(),
    stdio: "inherit",
    windowsHide: true,
  });
  if (result.error) {
    console.error(result.error.message);
    failures.push(drill.name);
    continue;
  }
  if (result.status !== 0) {
    failures.push(drill.name);
  }
}

console.log(`\nWrote scorer reports to ${REPORT_DIR}`);

if (failures.length > 0) {
  console.error(`\nFailed scorer drills: ${failures.join(", ")}`);
  process.exit(1);
}
