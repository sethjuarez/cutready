import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { spawn, spawnSync } from "node:child_process";

const definitionPath = resolve(
  process.env.CUTREADY_AUDITAUR_PROJECT_SWITCH_DEFINITION ?? "scripts/auditaur-project-switch-drill.json",
);
const definition = JSON.parse(readFileSync(definitionPath, "utf8"));
const appName = definition.app ?? "cutready";
const timeoutSeconds = Number(process.env.CUTREADY_AUDITAUR_PROJECT_SWITCH_TIMEOUT ?? definition.timeoutSeconds ?? "180");
const reportPath = resolve(
  process.env.CUTREADY_AUDITAUR_PROJECT_SWITCH_REPORT ?? "target/auditaur-project-switch-drill-report.json",
);
const projectRoot = mkdtempSync(join(tmpdir(), definition.fixture?.prefix ?? "cutready-project-switch-drill-"));
const sessionFile = join(projectRoot, ".auditaur-session.json");
const appCommand =
  process.platform === "win32" ? ["cmd", "/c", "npm run debug"] : ["npm", "run", "debug"];
const env = {
  ...process.env,
  CUTREADY_PROJECT: projectRoot,
};
const report = {
  app: appName,
  definition: definitionPath,
  startedAt: new Date().toISOString(),
  status: "running",
  phases: [],
};

let launcher;
let appPid;
let processPid;

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
  appPid = readyStatus.pid;
  processPid = readyStatus.processPid;
  report.sessionId = readyStatus.sessionId;
  report.databasePath = readyStatus.databasePath;
  recordPhase("readiness", "passed", readyStatus);

  for (const step of definition.steps ?? []) {
    await runStep(step);
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
  clearDrillStartupState();
  stopSpawnedApp();
  removeProjectFromRecents();
  rmSync(projectRoot, { recursive: true, force: true });
}

function writeProjectFixture() {
  const projects = definition.fixture?.projects ?? [];
  mkdirSync(join(projectRoot, ".cutready"), { recursive: true });
  writeFileSync(
    join(projectRoot, ".cutready", "projects.json"),
    `${JSON.stringify({
      projects: projects.map((project) => ({
        path: project.path,
        name: project.name,
        description: project.description ?? "",
      })),
    }, null, 2)}\n`,
  );

  for (const project of projects) {
    const projectPath = join(projectRoot, project.path);
    mkdirSync(projectPath, { recursive: true });
    for (const sketch of project.sketches ?? []) {
      writeSketch(join(projectPath, sketch.path), sketch.title);
    }
  }
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

async function runStep(step) {
  if (!step?.id) {
    throw new Error(`Drill step is missing an id: ${JSON.stringify(step)}`);
  }

  if (step.drive) {
    const result = await runDriveStep(step);
    recordPhase(step.id, "passed", result);
    return result;
  }

  if (step.expectText) {
    const result = await waitForText(step.expectText, step.timeoutMs);
    recordPhase(step.id, "passed", result);
    return result;
  }

  if (step.forbidText) {
    const result = runDriveText();
    assertOk(step.id, result);
    const text = JSON.stringify(result.json ?? "");
    for (const forbidden of step.forbidText) {
      if (text.includes(forbidden)) {
        throw new Error(`${step.id} failed: found forbidden text "${forbidden}".`);
      }
    }
    recordPhase(step.id, "passed", result.json);
    return result.json;
  }

  if (step.telemetry) {
    const result = runTelemetryStep(step);
    assertOk(step.id, result);
    const count = jsonCount(result.json);
    if (Number.isFinite(step.maxCount) && count > step.maxCount) {
      recordPhase(step.id, "failed", result.json);
      throw new Error(`${step.id} failed: expected at most ${step.maxCount} item(s), found ${count}.`);
    }
    recordPhase(step.id, "passed", result.json);
    return result.json;
  }

  throw new Error(`Unsupported drill step: ${JSON.stringify(step)}`);
}

async function runDriveStep(step) {
  const args = [
    "drive",
    "--app",
    appName,
    "--session-id",
    report.sessionId,
    "--json",
    step.drive,
    "--target",
    "auditaur-bridge",
  ];
  if (step.selector) {
    args.push("--selector", expandValue(step.selector));
  }
  if (step.timeoutMs) {
    args.push("--timeout-ms", String(step.timeoutMs));
  }
  if (step.expression) {
    args.push("--expression", expandValue(step.expression));
  }

  const result = runJson(args);
  assertOk(step.id, result);
  return result.json;
}

async function waitForText(expectedText, timeoutMs = 30_000) {
  const deadline = Date.now() + timeoutMs;
  let lastText = "";
  while (Date.now() < deadline) {
    const result = runDriveText();
    if (result.ok) {
      lastText = JSON.stringify(result.json ?? "");
      if (lastText.includes(expectedText)) {
        return result.json;
      }
    }
    await delay(1_000);
  }
  throw new Error(`Timed out waiting for ${expectedText}. Last body text: ${lastText}`);
}

function runDriveText() {
  return runJson([
    "drive",
    "--app",
    appName,
    "--session-id",
    report.sessionId,
    "--json",
    "text",
    "--target",
    "auditaur-bridge",
    "--selector",
    "body",
  ]);
}

function runTelemetryStep(step) {
  if (step.telemetry === "errors") {
    return runJson(["errors", "--json", "--session", report.sessionId]);
  }
  if (step.telemetry === "failed-ipc") {
    return runJson(["ipc", "--json", "--session", report.sessionId, "--failed"]);
  }
  if (step.telemetry === "explain") {
    return runJson(["explain", "--json", "--session", report.sessionId]);
  }
  throw new Error(`Unsupported telemetry step kind: ${step.telemetry}`);
}

function ensureNoActiveCutReady() {
  const activeStatus = runJson(["debug", "--app", appName, "--active", "--json", "status"]);
  const app = activeStatus.json?.app;
  if (activeStatus.ok && app?.status === "active" && Number(app.heartbeatAgeSeconds ?? 999) < 30 && pidIsRunning(app.pid)) {
    throw new Error(
      `An active CutReady Auditaur session is already running (pid ${app.pid}, session ${app.sessionId}). Close it before running the project switch drill so the drill can own a fresh app session.`,
    );
  }
}

async function waitForLauncherReady() {
  let stdout = "";
  let stderr = "";
  let pendingStdout = "";

  return new Promise((resolveReady, rejectReady) => {
    let settled = false;
    const timer = setTimeout(() => {
      settleFailure(new Error(`CutReady did not become Auditaur-ready within ${timeoutSeconds}s.`));
    }, timeoutSeconds * 1000 + 15_000);

    const settleReady = (readyStatus) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolveReady(readyStatus);
    };
    const settleFailure = (error) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      rejectReady(error);
    };

    launcher.stdout.on("data", (chunk) => {
      const text = chunk.toString();
      stdout += text;
      pendingStdout += text;
      process.stdout.write(text);

      const lines = pendingStdout.split(/\r?\n/);
      pendingStdout = lines.pop() ?? "";
      for (const line of lines) {
        const readyStatus = normalizeReadyStatus(parseJsonLine(line));
        if (readyStatus?.sessionId) {
          settleReady(readyStatus);
          return;
        }
      }
    });
    launcher.stderr.on("data", (chunk) => {
      const text = chunk.toString();
      stderr += text;
      process.stdout.write(text);
    });
    launcher.on("error", settleFailure);
    launcher.on("close", (code) => {
      if (settled) return;
      settleFailure(new Error(
        code === 0
          ? `Auditaur exited before reporting a ready session: ${stdout}`
          : [stderr, stdout].filter(Boolean).join("\n").trim() || `auditaur debug run exited ${code}`,
      ));
    });
  });
}

function clearDrillStartupState() {
  if (!report.sessionId) return;

  runJson([
    "drive",
    "--app",
    appName,
    "--session-id",
    report.sessionId,
    "--json",
    "evaluate",
    "--target",
    "auditaur-bridge",
    "--expression",
    `(() => {
      const value = localStorage.getItem("cutready:lastProject");
      if (value && value.includes("cutready-project-switch-drill-")) {
        localStorage.removeItem("cutready:lastProject");
      }
      return localStorage.getItem("cutready:lastProject") ?? null;
    })()`,
  ]);
}

function stopSpawnedApp() {
  spawnSync("auditaur", ["stop", "--session-file", sessionFile, "--json"], {
    stdio: "ignore",
    shell: false,
  });

  const fallbackPids = [processPid, appPid].filter((pid) => Number.isFinite(Number(pid)));
  if (fallbackPids.length === 0) return;

  if (process.platform === "win32") {
    spawnSync("powershell", [
      "-NoProfile",
      "-Command",
      `Stop-Process -Id ${fallbackPids.map((pid) => Number(pid)).join(",")} -Force -ErrorAction SilentlyContinue`,
    ], { stdio: "ignore" });
    return;
  }

  for (const pid of fallbackPids) {
    try {
      process.kill(Number(pid), "SIGTERM");
    } catch {
      // The app may already be closed.
    }
  }
}

function removeProjectFromRecents() {
  const storePath = recentProjectsStorePath();
  if (!storePath || !existsSync(storePath)) return;

  try {
    const store = JSON.parse(readFileSync(storePath, "utf8"));
    if (!Array.isArray(store.recent_projects)) return;

    const before = store.recent_projects.length;
    store.recent_projects = store.recent_projects.filter((project) => {
      const path = String(project?.path ?? "");
      return !path.includes("cutready-project-switch-drill-");
    });
    if (store.recent_projects.length !== before) {
      writeFileSync(storePath, `${JSON.stringify(store, null, 2)}\n`);
    }
  } catch (error) {
    console.warn(`Could not remove drill project from recent workspaces: ${error}`);
  }
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

function assertOk(id, result) {
  if (!result.ok) {
    recordPhase(id, "failed", result.json ?? null, result.error);
    throw new Error(`${id} failed: ${result.error}`);
  }
}

function recordPhase(id, status, result, error = null) {
  report.phases.push({ id, status, result: result ?? null, error });
  writeReport();
}

function writeReport() {
  writeFileSync(reportPath, `${JSON.stringify(report, null, 2)}\n`);
}

function jsonCount(value) {
  if (Array.isArray(value)) return value.length;
  if (Array.isArray(value?.items)) return value.items.length;
  if (Array.isArray(value?.errors)) return value.errors.length;
  if (Array.isArray(value?.records)) return value.records.length;
  return 0;
}

function normalizeReadyStatus(parsed) {
  if (parsed?.status?.ready && parsed?.app?.sessionId) {
    return {
      ...parsed.status,
      sessionId: parsed.app.sessionId,
      databasePath: parsed.app.databasePath ?? parsed.status.databasePath,
      instanceId: parsed.app.instanceId,
      pid: parsed.app.pid,
      processPid: parsed.process?.pid,
    };
  }
  return null;
}

function parseJsonLine(line) {
  try {
    return JSON.parse(line.trim());
  } catch {
    return null;
  }
}

function expandValue(value) {
  return String(value).replaceAll("${projectRoot}", projectRoot);
}

function recentProjectsStorePath() {
  if (process.env.CUTREADY_RECENT_PROJECTS_STORE) {
    return process.env.CUTREADY_RECENT_PROJECTS_STORE;
  }
  if (process.platform === "win32" && process.env.APPDATA) {
    return join(process.env.APPDATA, "com.cutready.app", "recent-projects.json");
  }
  return null;
}

function pidIsRunning(pid) {
  if (!Number.isFinite(Number(pid))) return false;

  try {
    process.kill(Number(pid), 0);
    return true;
  } catch {
    return false;
  }
}

function delay(ms) {
  return new Promise((resolveDelay) => setTimeout(resolveDelay, ms));
}
