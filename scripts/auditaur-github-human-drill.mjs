import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, resolve, join } from "node:path";
import { spawn, spawnSync } from "node:child_process";
import { createInterface } from "node:readline/promises";
import { stdin as input, stdout as output } from "node:process";

const appName = "cutready";
const selector = "[data-testid=\"github-connection-card\"]";
const timeoutSeconds = Number(process.env.CUTREADY_AUDITAUR_GITHUB_HUMAN_TIMEOUT ?? "180");
const reportPath = resolve(
  process.env.CUTREADY_AUDITAUR_GITHUB_HUMAN_REPORT ?? "target/auditaur-github-human-drill-report.json",
);
const projectRoot = mkdtempSync(join(tmpdir(), "cutready-github-human-drill-"));
const appCommand =
  process.platform === "win32" ? ["cmd", "/c", "npm run debug"] : ["npm", "run", "debug"];

const env = {
  ...process.env,
  CUTREADY_PROJECT: projectRoot,
  VITE_CUTREADY_STARTUP_VIEW: "settings",
  VITE_CUTREADY_STARTUP_SETTINGS_TAB: "repository",
};

mkdirSync(dirname(reportPath), { recursive: true });
writeFileSync(
  join(projectRoot, "github-human-drill.sk"),
  JSON.stringify(
    {
      title: "GitHub human auth drill",
      description: "Disposable project for a manual GitHub device-flow validation.",
      planning_table: [],
    },
    null,
    2,
  ),
);

const report = {
  app: appName,
  selector,
  startedAt: new Date().toISOString(),
  status: "running",
  phases: [],
};

let launcher;
let appPid;

try {
  if (!hasGitHubOAuthClientId()) {
    throw new Error(
      "GitHub OAuth is not configured locally. Set CUTREADY_GITHUB_OAUTH_CLIENT_ID in the environment or in .env before running the manual drill.",
    );
  }

  console.log("Starting CutReady under Auditaur observation...");
  launcher = spawn("auditaur", [
    "debug",
    "--app",
    appName,
    "--active",
    "--json",
    "run",
    "--timeout-seconds",
    String(timeoutSeconds),
    "--",
    ...appCommand,
  ], {
    env,
    shell: false,
    stdio: ["ignore", "pipe", "pipe"],
  });

  launcher.stdout.on("data", (chunk) => output.write(chunk));
  launcher.stderr.on("data", (chunk) => output.write(chunk));

  const readyStatus = await waitForReady();
  appPid = readyStatus?.pid;
  report.sessionId = readyStatus?.sessionId;
  report.databasePath = readyStatus?.databasePath;
  report.phases.push({ id: "readiness", status: "passed", result: readyStatus });

  await runJsonPhase("wait-for-card", [
    "drive",
    "--app",
    appName,
    "--active",
    "--json",
    "wait",
    "--selector",
    selector,
  ]);
  const initialCard = await runJsonPhase("initial-card-text", [
    "drive",
    "--app",
    appName,
    "--active",
    "--json",
    "text",
    "--selector",
    selector,
  ]);

  console.log("\nManual GitHub device-flow drill");
  console.log("1. In CutReady, use Settings > Repository > GitHub account.");
  if (jsonIncludes(initialCard, "Connected as")) {
    console.log("2. The card already appears connected. Click Disconnect first if you want to prove a fresh device registration.");
    console.log("3. Click Connect GitHub, approve the device code in the browser, and wait until the card says Connected as <user>.");
  } else {
    console.log("2. Click Connect GitHub, approve the device code in the browser, and wait until the card says Connected as <user>.");
  }
  console.log("4. Return here and press Enter to collect Auditaur evidence and close the spawned app.\n");

  const rl = createInterface({ input, output });
  await rl.question("Press Enter after the GitHub card shows a connected account...");
  rl.close();

  const finalCard = await runJsonPhase("final-card-text", [
    "drive",
    "--app",
    appName,
    "--active",
    "--json",
    "text",
    "--selector",
    selector,
  ]);
  await runJsonPhase("final-readiness", [
    "debug",
    "--app",
    appName,
    "--active",
    "--require-frontend",
    "--require-drive-bridge",
    "--json",
    "status",
  ]);

  if (report.sessionId) {
    await runJsonPhase("errors", ["errors", "--json", "--session", report.sessionId]);
    await runJsonPhase("failed-ipc", ["ipc", "--json", "--session", report.sessionId, "--failed"]);
    await runJsonPhase("explain", ["explain", "--json", "--session", report.sessionId]);
  }

  report.status = jsonIncludes(finalCard, "Connected as") ? "passed" : "needs-review";
  report.finishedAt = new Date().toISOString();
  writeReport();

  if (report.status === "passed") {
    console.log(`\nGitHub human drill passed. Report: ${reportPath}`);
  } else {
    console.log(`\nGitHub human drill needs review; the final card text did not include "Connected as". Report: ${reportPath}`);
    process.exitCode = 1;
  }
} catch (error) {
  report.status = "failed";
  report.error = String(error);
  report.finishedAt = new Date().toISOString();
  writeReport();
  console.error(`\nGitHub human drill failed. Report: ${reportPath}`);
  console.error(error);
  process.exitCode = 1;
} finally {
  stopSpawnedApp();
  rmSync(projectRoot, { recursive: true, force: true });
}

async function waitForReady() {
  const deadline = Date.now() + timeoutSeconds * 1000;
  let lastError = "";
  while (Date.now() < deadline) {
    const result = runJson([
      "debug",
      "--app",
      appName,
      "--active",
      "--require-frontend",
      "--require-drive-bridge",
      "--json",
      "status",
    ]);
    if (result.ok && result.json?.ready) {
      return result.json;
    }
    lastError = result.error || JSON.stringify(result.json ?? {});
    await delay(2_000);
  }
  throw new Error(`CutReady did not become Auditaur-ready within ${timeoutSeconds}s. Last status: ${lastError}`);
}

async function runJsonPhase(id, args) {
  const result = runJson(args);
  report.phases.push({
    id,
    status: result.ok ? "passed" : "failed",
    result: result.json ?? null,
    error: result.error || null,
  });
  if (!result.ok) {
    throw new Error(`${id} failed: ${result.error}`);
  }
  writeReport();
  return result.json;
}

function runJson(args) {
  const result = spawnSync("auditaur", args, {
    env,
    encoding: "utf8",
    shell: false,
  });
  if (result.error) {
    return { ok: false, error: String(result.error) };
  }
  if (result.status !== 0) {
    return {
      ok: false,
      error: [result.stderr, result.stdout].filter(Boolean).join("\n").trim() || `auditaur exited ${result.status}`,
    };
  }
  try {
    return { ok: true, json: JSON.parse(result.stdout) };
  } catch (error) {
    return { ok: false, error: `Could not parse Auditaur JSON: ${error}\n${result.stdout}` };
  }
}

function jsonIncludes(value, text) {
  return JSON.stringify(value ?? "").includes(text);
}

function writeReport() {
  writeFileSync(reportPath, `${JSON.stringify(report, null, 2)}\n`);
}

function hasGitHubOAuthClientId() {
  if (process.env.CUTREADY_GITHUB_OAUTH_CLIENT_ID?.trim()) {
    return true;
  }
  return [".env", "src-tauri/.env"].some((path) => readEnvValue(path, "CUTREADY_GITHUB_OAUTH_CLIENT_ID"));
}

function readEnvValue(path, key) {
  if (!existsSync(path)) {
    return null;
  }
  const prefix = `${key}=`;
  return readFileSync(path, "utf8")
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => line && !line.startsWith("#"))
    .find((line) => line.startsWith(prefix))
    ?.slice(prefix.length)
    .trim()
    .replace(/^['"]|['"]$/g, "") || null;
}

function stopSpawnedApp() {
  if (appPid && process.platform === "win32") {
    spawnSync("powershell", [
      "-NoProfile",
      "-Command",
      `Stop-Process -Id ${Number(appPid)} -Force -ErrorAction SilentlyContinue`,
    ], { stdio: "ignore" });
  } else if (appPid) {
    try {
      process.kill(Number(appPid), "SIGTERM");
    } catch {
      // The app may already be closed by the user.
    }
  }
  if (launcher && !launcher.killed) {
    launcher.kill();
  }
}

function delay(ms) {
  return new Promise((resolveDelay) => setTimeout(resolveDelay, ms));
}
