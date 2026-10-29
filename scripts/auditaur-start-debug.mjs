import { spawn } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";

// Drill suites hand per-suite environment (fixture project, git identity, ...)
// through this file; see scripts/auditaur-drill-fixture.mjs. Only drill runs
// (marked by scripts/auditaur-drill.mjs) use it, so a stale file never leaks
// into other Auditaur launches.
const launchEnvPath = resolve("target", "auditaur-drill", "launch-env.json");
let drillEnv = {};
if (process.env.CUTREADY_AUDITAUR_DRILL === "1" && existsSync(launchEnvPath)) {
  drillEnv = JSON.parse(readFileSync(launchEnvPath, "utf8"));
  console.log(`[auditaur-start-debug] Using drill environment from ${launchEnvPath}`);
}

// scripts/auditaur-drill.mjs runs Auditaur from a verbatim (\\?\...) cwd to
// work around its hook cwd check; cmd.exe cannot start in such a path.
const cwd = process.cwd().replace(/^\\\\\?\\UNC\\/, "\\\\").replace(/^\\\\\?\\/, "");

const command = process.platform === "win32" ? "cmd" : "npm";
const args = process.platform === "win32" ? ["/c", "npm", "run", "debug"] : ["run", "debug"];
const child = spawn(command, args, {
  cwd,
  env: { ...process.env, ...drillEnv },
  stdio: "inherit",
  shell: false,
});

const forward = (signal) => {
  if (!child.killed) {
    child.kill(signal);
  }
};

process.on("SIGINT", forward);
process.on("SIGTERM", forward);

child.on("exit", (code, signal) => {
  if (signal) {
    process.kill(process.pid, signal);
    return;
  }
  process.exit(code ?? 0);
});

child.on("error", (error) => {
  console.error(`[auditaur-start-debug] Failed to start npm run debug: ${error.message}`);
  process.exit(1);
});
