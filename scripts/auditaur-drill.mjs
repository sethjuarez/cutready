import { mkdirSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { spawnSync } from "node:child_process";

const reportPath = resolve(
  process.env.CUTREADY_AUDITAUR_DRILL_REPORT ?? "target/auditaur-drill-report.json",
);

mkdirSync(dirname(reportPath), { recursive: true });

const appCommand =
  process.platform === "win32" ? ["cmd", "/c", "npm run debug"] : ["npm", "run", "debug"];

const args = [
  "drill",
  "run",
  "--app",
  "cutready",
  "--require-frontend",
  "--require-drive-bridge",
  "--timeout-seconds",
  process.env.CUTREADY_AUDITAUR_DRILL_TIMEOUT ?? "180",
  "--report",
  reportPath,
  "--selector",
  "body",
  "--expect-text",
  "CutReady",
  "--json",
  "--",
  ...appCommand,
];

const result = spawnSync("auditaur", args, {
  stdio: "inherit",
  shell: false,
});

if (result.error) {
  console.error(`Failed to run Auditaur drill: ${result.error.message}`);
  console.error("Install auditaur-cli 0.4.1+ and ensure `auditaur` is on PATH.");
  process.exit(1);
}

process.exit(result.status ?? 1);
