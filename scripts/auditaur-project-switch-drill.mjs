import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, resolve, join } from "node:path";
import { spawn, spawnSync } from "node:child_process";

const appName = "cutready";
const timeoutSeconds = Number(process.env.CUTREADY_AUDITAUR_PROJECT_SWITCH_TIMEOUT ?? "180");
const reportPath = resolve(
  process.env.CUTREADY_AUDITAUR_PROJECT_SWITCH_REPORT ?? "target/auditaur-project-switch-drill-report.json",
);
const projectRoot = mkdtempSync(join(tmpdir(), "cutready-project-switch-drill-"));
const sessionFile = join(projectRoot, ".auditaur-session.json");
const appCommand =
  process.platform === "win32" ? ["cmd", "/c", "npm run debug"] : ["npm", "run", "debug"];

const env = {
  ...process.env,
  CUTREADY_PROJECT: projectRoot,
};

const report = {
  app: appName,
  startedAt: new Date().toISOString(),
  status: "running",
  phases: [],
};

let launcher;
let appPid;

mkdirSync(dirname(reportPath), { recursive: true });
writeProjectFixture();

try {
  ensureNoActiveCutReady();
  console.log("Starting CutReady under Auditaur observation...");
  launcher = spawn("auditaur", [
    "debug",
    "--app",
    appName,
    "--active",
    "--json",
    "run",
    "--require-frontend",
    "--require-drive-bridge",
    "--timeout-seconds",
    String(timeoutSeconds),
    "--write-session",
    sessionFile,
    "--",
    ...appCommand,
  ], {
    env,
    shell: false,
    stdio: ["ignore", "pipe", "pipe"],
  });

  const readyStatus = await waitForLauncherReady();
  appPid = readyStatus?.pid;
  report.sessionId = readyStatus?.sessionId;
  report.databasePath = readyStatus?.databasePath;
  report.phases.push({ id: "readiness", status: "passed", result: readyStatus });
  writeReport();

  await runJsonPhase("wait-for-switcher", [
    "drive",
    "--app",
    appName,
    "--session-id",
    report.sessionId,
    "--target",
    "auditaur-bridge",
    "--json",
    "wait",
    "--selector",
    "[data-testid=\"project-switcher-title-trigger\"]",
    "--timeout-ms",
    "30000",
  ]);

  await assertProjectVisible("Alpha Project");
  await switchToProject("beta", "Beta Project");
  await switchToProject("alpha", "Alpha Project");
  await assertNoReloadFallback();

  if (report.sessionId) {
    await runJsonPhase("errors", ["errors", "--json", "--session", report.sessionId]);
    await runJsonPhase("failed-ipc", ["ipc", "--json", "--session", report.sessionId, "--failed"]);
    await runJsonPhase("explain", ["explain", "--json", "--session", report.sessionId]);
  }

  const errorsPhase = report.phases.find((phase) => phase.id === "errors");
  const failedIpcPhase = report.phases.find((phase) => phase.id === "failed-ipc");
  if (jsonCount(errorsPhase?.result) > 0 || jsonCount(failedIpcPhase?.result) > 0) {
    throw new Error("Auditaur reported frontend errors or failed IPC during project switching.");
  }

  report.status = "passed";
  report.finishedAt = new Date().toISOString();
  writeReport();
  console.log(`\nProject switch drill passed. Report: ${reportPath}`);
} catch (error) {
  report.status = "failed";
  report.error = String(error);
  report.finishedAt = new Date().toISOString();
  writeReport();
  console.error(`\nProject switch drill failed. Report: ${reportPath}`);
  console.error(error);
  process.exitCode = 1;
} finally {
  stopSpawnedApp();
  rmSync(projectRoot, { recursive: true, force: true });
}

function writeProjectFixture() {
  mkdirSync(join(projectRoot, ".cutready"), { recursive: true });
  mkdirSync(join(projectRoot, "alpha"), { recursive: true });
  mkdirSync(join(projectRoot, "beta"), { recursive: true });
  writeFileSync(
    join(projectRoot, ".cutready", "projects.json"),
    `${JSON.stringify({
      projects: [
        { path: "alpha", name: "Alpha Project", description: "First drill project" },
        { path: "beta", name: "Beta Project", description: "Second drill project" },
      ],
    }, null, 2)}\n`,
  );
  writeSketch(join(projectRoot, "alpha", "alpha.sk"), "Alpha Sketch");
  writeSketch(join(projectRoot, "beta", "beta.sk"), "Beta Sketch");
}

function writeSketch(path, title) {
  writeFileSync(
    path,
    `${JSON.stringify({
      title,
      description: "",
      rows: [
        {
          time: "0:00",
          narrative: `${title} narration`,
          demo_actions: "Show the project switch drill fixture.",
          screenshot: null,
        },
      ],
      state: "draft",
      created_at: new Date().toISOString(),
      updated_at: new Date().toISOString(),
    }, null, 2)}\n`,
  );
}

function ensureNoActiveCutReady() {
  const activeStatus = runJson([
    "debug",
    "--app",
    appName,
    "--active",
    "--json",
    "status",
  ]);
  if (!activeStatus.ok || !activeStatus.json?.app) {
    return;
  }

  const app = activeStatus.json.app;
  if (app.status === "active" && Number(app.heartbeatAgeSeconds ?? 999) < 30) {
    throw new Error(
      `An active CutReady Auditaur session is already running (pid ${app.pid}, session ${app.sessionId}). Close it before running the project switch drill so the drill can own a fresh app session.`,
    );
  }
}

async function waitForLauncherReady() {
  let stdout = "";
  let stderr = "";
  launcher.stdout.on("data", (chunk) => {
    const text = chunk.toString();
    stdout += text;
    process.stdout.write(text);
  });
  launcher.stderr.on("data", (chunk) => {
    const text = chunk.toString();
    stderr += text;
    process.stdout.write(text);
  });

  const status = await new Promise((resolveStatus, rejectStatus) => {
    const timer = setTimeout(() => {
      rejectStatus(new Error(`CutReady did not become Auditaur-ready within ${timeoutSeconds}s.`));
    }, timeoutSeconds * 1000 + 15_000);
    launcher.on("error", (error) => {
      clearTimeout(timer);
      rejectStatus(error);
    });
    launcher.on("close", (code) => {
      clearTimeout(timer);
      resolveStatus(code);
    });
  });

  if (status !== 0) {
    throw new Error([stderr, stdout].filter(Boolean).join("\n").trim() || `auditaur debug run exited ${status}`);
  }

  const readyStatus = parseLastJson(stdout);
  if (!readyStatus?.ready || !readyStatus?.sessionId) {
    throw new Error(`Auditaur did not report a ready session: ${stdout}`);
  }
  return readyStatus;
}

async function switchToProject(projectPath, expectedText) {
  await runJsonPhase(`open-switcher-${projectPath}`, [
    "drive",
    "--app",
    appName,
    "--session-id",
    report.sessionId,
    "--target",
    "auditaur-bridge",
    "--json",
    "click",
    "--selector",
    "[data-testid=\"project-switcher-title-trigger\"]",
  ]);
  await runJsonPhase(`click-project-${projectPath}`, [
    "drive",
    "--app",
    appName,
    "--session-id",
    report.sessionId,
    "--target",
    "auditaur-bridge",
    "--json",
    "click",
    "--selector",
    `[data-testid="project-switcher-option-${projectPath}"]`,
  ]);
  await assertProjectVisible(expectedText);
  await assertNoReloadFallback();
}

async function assertProjectVisible(expectedText) {
  await waitForText(expectedText, `project-visible-${expectedText.replace(/\W+/g, "-").toLowerCase()}`);
}

async function assertNoReloadFallback() {
  const bodyText = await runJsonPhase("body-text", [
    "drive",
    "--app",
    appName,
    "--session-id",
    report.sessionId,
    "--target",
    "auditaur-bridge",
    "--json",
    "text",
    "--selector",
    "body",
  ]);
  const text = JSON.stringify(bodyText ?? "");
  if (text.includes("Something went wrong") || text.includes("Reload interface")) {
    throw new Error("Project switching showed the reload/error fallback.");
  }
}

async function waitForText(text, phaseId) {
  const deadline = Date.now() + 30_000;
  let lastText = "";
  while (Date.now() < deadline) {
    const result = runJson([
      "drive",
      "--app",
      appName,
      "--session-id",
      report.sessionId,
      "--target",
      "auditaur-bridge",
      "--json",
      "text",
      "--selector",
      "body",
    ]);
    if (result.ok) {
      lastText = JSON.stringify(result.json ?? "");
      if (lastText.includes(text)) {
        report.phases.push({ id: phaseId, status: "passed", result: result.json ?? null });
        writeReport();
        return;
      }
    }
    await delay(1_000);
  }
  throw new Error(`Timed out waiting for ${text}. Last body text: ${lastText}`);
}

async function runJsonPhase(id, args) {
  const result = runJson(args);
  report.phases.push({
    id,
    status: result.ok ? "passed" : "failed",
    result: result.json ?? null,
    error: result.error || null,
  });
  writeReport();
  if (!result.ok) {
    throw new Error(`${id} failed: ${result.error}`);
  }
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

function jsonCount(value) {
  if (Array.isArray(value)) return value.length;
  if (Array.isArray(value?.items)) return value.items.length;
  if (Array.isArray(value?.errors)) return value.errors.length;
  if (Array.isArray(value?.records)) return value.records.length;
  return 0;
}

function writeReport() {
  writeFileSync(reportPath, `${JSON.stringify(report, null, 2)}\n`);
}

function stopSpawnedApp() {
  const stopped = spawnSync("auditaur", ["stop", "--session-file", sessionFile, "--json"], {
    stdio: "ignore",
    shell: false,
  });
  if (stopped.status === 0) {
    return;
  }

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
      // The app may already be closed.
    }
  }
  if (launcher && !launcher.killed) {
    launcher.kill();
  }
}

function delay(ms) {
  return new Promise((resolveDelay) => setTimeout(resolveDelay, ms));
}

function parseLastJson(output) {
  const lines = output.split(/\r?\n/).map((line) => line.trim()).filter(Boolean);
  for (let index = lines.length - 1; index >= 0; index -= 1) {
    try {
      return JSON.parse(lines[index]);
    } catch {
      // Keep scanning backward in case diagnostic text preceded the JSON line.
    }
  }
  return null;
}
