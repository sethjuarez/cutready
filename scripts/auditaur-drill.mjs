#!/usr/bin/env node
// Runs `auditaur drill test` for the suites in .auditaur/drills.
//
//   node scripts/auditaur-drill.mjs [suite filters] [auditaur drill test flags]
//
// Workaround (Auditaur AR-3): on Windows, `drill test` rejects every hook cwd as
// "outside workspace" because it compares a canonicalized \\?\ path with a
// non-verbatim workspace root. Running from the verbatim form of the repo path
// makes both sides match. Drop this once Auditaur normalizes the comparison.
import { spawn } from "node:child_process";
import { toNamespacedPath } from "node:path";

const cwd = toNamespacedPath(process.cwd());
const child = spawn("auditaur", ["drill", "test", ...process.argv.slice(2)], {
  cwd,
  // Lets scripts/auditaur-start-debug.mjs apply the suite's launch-env.json.
  env: { ...process.env, CUTREADY_AUDITAUR_DRILL: "1" },
  stdio: "inherit",
  windowsHide: true,
});

child.on("exit", (code, signal) => process.exit(signal ? 1 : code ?? 1));
child.on("error", (error) => {
  console.error(`[auditaur-drill] Could not start auditaur: ${error.message}`);
  process.exit(1);
});
