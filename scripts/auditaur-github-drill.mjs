import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, resolve, join } from "node:path";
import { spawnSync } from "node:child_process";

const appName = "cutready";
const timeoutSeconds = process.env.CUTREADY_AUDITAUR_GITHUB_DRILL_TIMEOUT ?? "180";
const reportPath = resolve(
  process.env.CUTREADY_AUDITAUR_GITHUB_DRILL_REPORT ?? "target/auditaur-github-drill-report.json",
);
const projectRoot = mkdtempSync(join(tmpdir(), "cutready-github-drill-"));
const appCommand =
  process.platform === "win32" ? ["cmd", "/c", "npm run debug"] : ["npm", "run", "debug"];

mkdirSync(dirname(reportPath), { recursive: true });
writeFileSync(
  join(projectRoot, "github-auth-drill.sk"),
  JSON.stringify(
    {
      title: "GitHub auth drill",
      description: "Disposable project for Auditaur GitHub auth validation.",
      planning_table: [],
    },
    null,
    2,
  ),
);

try {
  const result = spawnSync("auditaur", [
    "drill",
    "run",
    "--app",
    appName,
    "--require-frontend",
    "--require-drive-bridge",
    "--timeout-seconds",
    timeoutSeconds,
    "--report",
    reportPath,
    "--selector",
    "[data-testid=\"github-connection-card\"]",
    "--expect-text",
    "GitHub account",
    "--json",
    "--",
    ...appCommand,
  ], {
    env: {
      ...process.env,
      CUTREADY_PROJECT: projectRoot,
      VITE_CUTREADY_STARTUP_VIEW: "settings",
      VITE_CUTREADY_STARTUP_SETTINGS_TAB: "repository",
    },
    stdio: "inherit",
    shell: false,
  });
  if (result.error) {
    throw result.error;
  }
  process.exitCode = result.status ?? 1;
} finally {
  rmSync(projectRoot, { recursive: true, force: true });
  console.log(`Auditaur GitHub drill report: ${reportPath}`);
}
