// Auditaur feature drill — a reusable, definition-driven UI acceptance runner.
//
// Generalizes scripts/auditaur-project-switch-drill.mjs into a runner that any
// JSON definition can drive: it launches CutReady under Auditaur observation,
// seeds an isolated temp project (and, optionally, a backed-up global settings
// value), walks a list of steps against stable data-testid handles, then asserts
// telemetry health (no frontend errors / no failed IPC). The global settings file
// is always restored — the drill never leaves the user's real config mutated.
//
// Point it at a definition with the env var, e.g.:
//   CUTREADY_AUDITAUR_FEATURE_DEFINITION=scripts/auditaur-settings-drill.json \
//     node scripts/auditaur-feature-drill.mjs
//
// Step vocabulary (each step needs an `id`):
//   { drive: "wait|click|fill|press|evaluate|screenshot", selector, value, key,
//     expression, output, timeoutMs, expectValue, expectContains }
//   { expectText: "..." , timeoutMs }
//   { forbidText: ["..."] }
//   { telemetry: "errors|failed-ipc|explain", maxCount }
//   { trace: "logs|traces", contains: ["..."], notContains: ["..."], timeoutMs }
//   { manual: "instruction", gateFile: "target/...ok", timeoutMs }  // human gate
//
// Requires: auditaur 0.4.1+ on PATH.

import {
  copyFileSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { spawn, spawnSync } from "node:child_process";

const definitionPath = resolve(
  process.argv[2] ??
    process.env.CUTREADY_AUDITAUR_FEATURE_DEFINITION ??
    "scripts/auditaur-settings-drill.json",
);
const definition = JSON.parse(readFileSync(definitionPath, "utf8"));
const appName = definition.app ?? "cutready";
const drillLabel = definition.label ?? "feature";
const timeoutSeconds = Number(
  process.env.CUTREADY_AUDITAUR_FEATURE_TIMEOUT ?? definition.timeoutSeconds ?? "240",
);
const reportPath = resolve(
  process.env.CUTREADY_AUDITAUR_FEATURE_REPORT ??
    `target/auditaur-${drillLabel}-drill-report.json`,
);
const fixturePrefix = definition.fixture?.prefix ?? `cutready-${drillLabel}-drill-`;
const projectRoot = mkdtempSync(join(tmpdir(), fixturePrefix));
const sessionFile = join(projectRoot, ".auditaur-session.json");
const appCommand =
  process.platform === "win32" ? ["cmd", "/c", "npm run debug"] : ["npm", "run", "debug"];
const env = { ...process.env, CUTREADY_PROJECT: projectRoot };

const report = {
  app: appName,
  label: drillLabel,
  definition: definitionPath,
  startedAt: new Date().toISOString(),
  status: "running",
  fixtureProject: projectRoot,
  phases: [],
  assertions: [],
};

let launcher;
let appPid;
let processPid;
// { path, existed, original } — captured so finally can always restore.
let settingsBackup = null;

mkdirSync(dirname(reportPath), { recursive: true });
writeProjectFixture();

try {
  ensureNoActiveCutReady();
  seedGlobalSettings();

  console.log(`Starting CutReady under Auditaur observation (${drillLabel} drill)...`);
  launcher = spawn(
    "auditaur",
    [
      "debug", "--app", appName, "--active", "--json",
      "run", "--require-frontend", "--require-drive-bridge",
      "--timeout-seconds", String(timeoutSeconds),
      "--write-session", sessionFile,
      "--", ...appCommand,
    ],
    { env, shell: false, stdio: ["ignore", "pipe", "pipe"] },
  );

  const readyStatus = await waitForLauncherReady();
  appPid = readyStatus.pid;
  processPid = readyStatus.processPid;
  report.sessionId = readyStatus.sessionId;
  report.databasePath = readyStatus.databasePath;
  recordPhase("readiness", "passed", readyStatus);

  for (const step of definition.steps ?? []) {
    await runStep(step);
  }

  const failed = report.assertions.filter((a) => a.status === "failed");
  report.status = failed.length === 0 ? "passed" : "failed";
  report.finishedAt = new Date().toISOString();
  writeReport();
  if (failed.length === 0) {
    console.log(`\n${drillLabel} drill PASSED. Report: ${reportPath}`);
  } else {
    console.error(`\n${drillLabel} drill FAILED (${failed.length} assertion(s)). Report: ${reportPath}`);
    for (const a of failed) console.error(` - ${a.id}: ${a.error}`);
    process.exitCode = 1;
  }
} catch (error) {
  report.status = "failed";
  report.error = String(error);
  report.finishedAt = new Date().toISOString();
  writeReport();
  console.error(`\n${drillLabel} drill errored. Report: ${reportPath}`);
  console.error(error);
  process.exitCode = 1;
} finally {
  // Order matters: stop the app first so it can't re-persist settings after we
  // restore them, then restore, then clean the project fixture.
  stopSpawnedApp();
  restoreGlobalSettings();
  removeProjectFromRecents();
  rmSync(projectRoot, { recursive: true, force: true });
}

// ── Step execution ───────────────────────────────────────────────────────────

async function runStep(step) {
  if (!step?.id) throw new Error(`Drill step is missing an id: ${JSON.stringify(step)}`);
  console.log(`▶ ${step.id}`);

  if (step.drive) return runDriveStep(step);
  if (step.expectText) {
    const result = await waitForText(step.expectText, step.timeoutMs);
    recordPhase(step.id, "passed", { expectText: step.expectText });
    return result;
  }
  if (step.forbidText) {
    const result = runDriveText();
    assertOk(step.id, result);
    const text = JSON.stringify(result.json ?? "");
    for (const forbidden of step.forbidText) {
      if (text.includes(forbidden)) {
        recordPhase(step.id, "failed", null, `found forbidden text "${forbidden}"`);
        throw new Error(`${step.id} failed: found forbidden text "${forbidden}".`);
      }
    }
    recordPhase(step.id, "passed", { forbidText: step.forbidText });
    return result.json;
  }
  if (step.telemetry) return runTelemetryStep(step);
  if (step.trace) return runTraceStep(step);
  if (step.manual) return runManualStep(step);
  throw new Error(`Unsupported drill step: ${JSON.stringify(step)}`);
}

// A human-in-the-loop gate. The drill prints instructions and then waits for a
// gate file to appear on disk before continuing. An orchestrator (a person, or
// an agent coordinating a sign-in) creates the gate file once the manual action
// is done. Used for the copilot-sdk drill, where the GitHub Copilot CLI must be
// signed in before a run can resolve the copilot-sdk harness.
async function runManualStep(step) {
  const gateFile = resolve(step.gateFile ?? `target/auditaur-${drillLabel}-gate.ok`);
  const timeoutMs = step.timeoutMs ?? 600_000;
  const deadline = Date.now() + timeoutMs;
  mkdirSync(dirname(gateFile), { recursive: true });
  if (existsSync(gateFile)) rmSync(gateFile, { force: true });
  console.log(`\n⏸  MANUAL GATE: ${step.manual}`);
  console.log(`   Waiting for gate file: ${gateFile}`);
  console.log(`   Create it to continue (e.g. New-Item -ItemType File -Force "${gateFile}").\n`);
  while (Date.now() < deadline) {
    if (existsSync(gateFile)) {
      rmSync(gateFile, { force: true });
      return recordPhase(step.id, "passed", { manual: step.manual, gateFile });
    }
    await delay(2_000);
  }
  recordPhase(step.id, "failed", { gateFile }, `manual gate timed out after ${timeoutMs}ms`);
  throw new Error(`${step.id} failed: manual gate timed out waiting for ${gateFile}.`);
}

// Polls a telemetry stream (logs/traces) until at least one record whose
// serialized JSON contains ALL of `contains` appears, and asserts that no
// record contains ALL of `notContains`. This is how the drill proves the
// switched harness actually executed a run (the run-start trace names the
// resolved execution_engine) without depending on a fully healthy LLM call.
async function runTraceStep(step) {
  const stream = step.trace === "traces" ? "traces" : "logs";
  const contains = step.contains ?? [];
  const notContains = step.notContains ?? [];
  const timeoutMs = step.timeoutMs ?? 60_000;
  const deadline = Date.now() + timeoutMs;
  let lastItems = [];

  const matchesAll = (item, needles) => {
    const text = JSON.stringify(item);
    return needles.every((n) => text.includes(n));
  };

  while (Date.now() < deadline) {
    const result = runJson([stream, "--json", "--session", report.sessionId]);
    if (result.ok) {
      lastItems = asArray(result.json);
      const hit = contains.length === 0 || lastItems.some((item) => matchesAll(item, contains));
      if (hit) {
        const forbidden = notContains.length > 0
          ? lastItems.find((item) => matchesAll(item, notContains))
          : null;
        if (forbidden) {
          return recordAssertion(step.id, "failed", { forbidden }, `found forbidden trace matching ${JSON.stringify(notContains)}`);
        }
        return recordAssertion(step.id, "passed", { contains, matched: lastItems.length });
      }
    }
    await delay(1_500);
  }
  return recordAssertion(step.id, "failed", { items: lastItems.length }, `timed out waiting for ${stream} matching ${JSON.stringify(contains)}`);
}

async function runDriveStep(step) {
  const args = [
    "drive", "--app", appName, "--session-id", report.sessionId, "--json",
    step.drive, "--target", "auditaur-bridge",
  ];
  if (step.selector) args.push("--selector", expandValue(step.selector));
  if (step.value !== undefined) args.push("--value", expandValue(step.value));
  if (step.key) args.push("--key", step.key);
  if (step.expression) args.push("--expression", expandValue(step.expression));
  if (step.output) args.push("--output", resolve(expandValue(step.output)));
  if (step.timeoutMs) args.push("--timeout-ms", String(step.timeoutMs));

  const result = runJson(args);
  assertOk(step.id, result);

  // Evaluate steps can assert on the returned payload value, which is how the
  // drill checks post-click UI state deterministically (e.g. warning cleared).
  if (step.expectValue !== undefined || step.expectContains !== undefined) {
    const value = drivePayloadValue(result.json);
    if (step.expectValue !== undefined && value !== step.expectValue) {
      recordAssertion(step.id, "failed", { value }, `expected value ${JSON.stringify(step.expectValue)}, got ${JSON.stringify(value)}`);
      return result.json;
    }
    if (step.expectContains !== undefined && !String(value ?? "").includes(step.expectContains)) {
      recordAssertion(step.id, "failed", { value }, `expected value to contain ${JSON.stringify(step.expectContains)}, got ${JSON.stringify(value)}`);
      return result.json;
    }
    recordAssertion(step.id, "passed", { value });
    return result.json;
  }

  recordPhase(step.id, "passed", { drive: step.drive, selector: step.selector ?? null });
  return result.json;
}

function runTelemetryStep(step) {
  let result;
  if (step.telemetry === "errors") {
    result = runJson(["errors", "--json", "--session", report.sessionId]);
  } else if (step.telemetry === "failed-ipc") {
    result = runJson(["ipc", "--json", "--session", report.sessionId, "--failed"]);
  } else if (step.telemetry === "explain") {
    result = runJson(["explain", "--json", "--session", report.sessionId]);
    report.explain = result.ok ? result.json : { error: result.error };
    recordPhase(step.id, result.ok ? "passed" : "failed", null, result.ok ? null : result.error);
    writeReport();
    return result.json;
  } else {
    throw new Error(`Unsupported telemetry step kind: ${step.telemetry}`);
  }
  if (!result.ok) return recordAssertion(step.id, "failed", null, result.error);
  const count = jsonCount(result.json);
  const max = Number.isFinite(step.maxCount) ? step.maxCount : 0;
  recordAssertion(
    step.id,
    count <= max ? "passed" : "failed",
    result.json,
    count <= max ? null : `expected at most ${max} item(s), found ${count}`,
  );
  return result.json;
}

// ── Drive helpers ────────────────────────────────────────────────────────────

async function waitForText(expectedText, timeoutMs = 30_000) {
  const deadline = Date.now() + timeoutMs;
  let lastText = "";
  while (Date.now() < deadline) {
    const result = runDriveText();
    if (result.ok) {
      lastText = JSON.stringify(result.json ?? "");
      if (lastText.includes(expectedText)) return result.json;
    }
    await delay(1_000);
  }
  throw new Error(`Timed out waiting for "${expectedText}".`);
}

function runDriveText() {
  return runJson([
    "drive", "--app", appName, "--session-id", report.sessionId, "--json",
    "text", "--target", "auditaur-bridge", "--selector", "body",
  ]);
}

function drivePayloadValue(json) {
  if (json && typeof json === "object") {
    if (json.payload && typeof json.payload === "object" && "value" in json.payload) {
      return json.payload.value;
    }
    if ("value" in json) return json.value;
  }
  return json;
}

// ── Global settings seed / restore ───────────────────────────────────────────

function globalSettingsPath() {
  if (process.env.CUTREADY_GLOBAL_SETTINGS_STORE) return process.env.CUTREADY_GLOBAL_SETTINGS_STORE;
  if (process.platform === "win32" && process.env.APPDATA) {
    return join(process.env.APPDATA, "com.cutready.app", "settings.json");
  }
  if (process.platform === "darwin" && process.env.HOME) {
    return join(process.env.HOME, "Library", "Application Support", "com.cutready.app", "settings.json");
  }
  if (process.env.HOME) {
    return join(process.env.HOME, ".config", "com.cutready.app", "settings.json");
  }
  return null;
}

function seedGlobalSettings() {
  const seed = definition.globalSettings?.seed;
  if (!seed || Object.keys(seed).length === 0) return;
  const path = globalSettingsPath();
  if (!path) {
    console.warn("Could not resolve the global settings path; skipping seed.");
    return;
  }
  const existed = existsSync(path);
  const original = existed ? readFileSync(path) : null;
  settingsBackup = { path, existed, original };

  let store = {};
  if (existed) {
    try {
      store = JSON.parse(original.toString("utf8"));
    } catch {
      store = {};
    }
  }
  const merged = { ...store, ...seed };
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, `${JSON.stringify(merged, null, 2)}\n`);
  console.log(`Seeded global settings ${JSON.stringify(seed)} (backup captured).`);
}

function restoreGlobalSettings() {
  if (!settingsBackup) return;
  const { path, existed, original } = settingsBackup;
  try {
    if (existed && original) {
      writeFileSync(path, original);
    } else if (existsSync(path)) {
      rmSync(path, { force: true });
    }
    console.log("Restored global settings.");
  } catch (error) {
    console.error(`FAILED to restore global settings at ${path}: ${error}`);
  } finally {
    settingsBackup = null;
  }
}

// ── Fixture ──────────────────────────────────────────────────────────────────

function writeProjectFixture() {
  mkdirSync(projectRoot, { recursive: true });
  for (const note of definition.fixture?.notes ?? []) {
    writeFileSync(join(projectRoot, note.path), note.body ?? "");
  }
  for (const sketch of definition.fixture?.sketches ?? []) {
    writeFileSync(
      join(projectRoot, sketch.path),
      `${JSON.stringify(
        {
          title: sketch.title,
          description: sketch.description ?? "",
          rows: [
            { time: "0:00", narrative: sketch.narrative ?? "", demo_actions: "", screenshot: null },
          ],
          state: "draft",
          created_at: new Date().toISOString(),
          updated_at: new Date().toISOString(),
        },
        null,
        2,
      )}\n`,
    );
  }
}

// ── Launch / lifecycle (mirrors the sibling drills) ──────────────────────────

function ensureNoActiveCutReady() {
  const activeStatus = runJson(["debug", "--app", appName, "--active", "--json", "status"]);
  const app = activeStatus.json?.app;
  if (
    activeStatus.ok &&
    app?.status === "active" &&
    Number(app.heartbeatAgeSeconds ?? 999) < 30 &&
    pidIsRunning(app.pid)
  ) {
    throw new Error(
      `An active CutReady Auditaur session is already running (pid ${app.pid}, session ${app.sessionId}). Close it before running the ${drillLabel} drill.`,
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
    const settleReady = (s) => { if (!settled) { settled = true; clearTimeout(timer); resolveReady(s); } };
    const settleFailure = (e) => { if (!settled) { settled = true; clearTimeout(timer); rejectReady(e); } };

    launcher.stdout.on("data", (chunk) => {
      const text = chunk.toString();
      stdout += text;
      pendingStdout += text;
      process.stdout.write(text);
      const lines = pendingStdout.split(/\r?\n/);
      pendingStdout = lines.pop() ?? "";
      for (const line of lines) {
        const s = normalizeReadyStatus(parseJsonLine(line));
        if (s?.sessionId) { settleReady(s); return; }
      }
    });
    launcher.stderr.on("data", (chunk) => { const t = chunk.toString(); stderr += t; process.stdout.write(t); });
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

function stopSpawnedApp() {
  spawnSync("auditaur", ["stop", "--session-file", sessionFile, "--json"], { stdio: "ignore", shell: false });
  const fallbackPids = [processPid, appPid].filter((pid) => Number.isFinite(Number(pid)));
  if (fallbackPids.length === 0) return;
  if (process.platform === "win32") {
    spawnSync("powershell", [
      "-NoProfile", "-Command",
      `Stop-Process -Id ${fallbackPids.map((pid) => Number(pid)).join(",")} -Force -ErrorAction SilentlyContinue`,
    ], { stdio: "ignore" });
    return;
  }
  for (const pid of fallbackPids) {
    try { process.kill(Number(pid), "SIGTERM"); } catch { /* already gone */ }
  }
}

function removeProjectFromRecents() {
  const storePath = recentProjectsStorePath();
  if (!storePath || !existsSync(storePath)) return;
  try {
    const store = JSON.parse(readFileSync(storePath, "utf8"));
    if (!Array.isArray(store.recent_projects)) return;
    const before = store.recent_projects.length;
    store.recent_projects = store.recent_projects.filter(
      (project) => !String(project?.path ?? "").includes(fixturePrefix),
    );
    if (store.recent_projects.length !== before) {
      writeFileSync(storePath, `${JSON.stringify(store, null, 2)}\n`);
    }
  } catch (error) {
    console.warn(`Could not remove drill project from recent workspaces: ${error}`);
  }
}

// ── Small utilities ──────────────────────────────────────────────────────────

function runJson(args) {
  const result = spawnSync("auditaur", args, { env, encoding: "utf8", shell: false });
  if (result.error) return { ok: false, error: String(result.error) };
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
  const label = status === "passed" ? "✓" : "✗";
  console.log(`  ${label} ${id}${error ? `: ${error}` : ""}`);
  writeReport();
}

function recordAssertion(id, status, result, error = null) {
  report.assertions.push({ id, status, result: result ?? null, error });
  const label = status === "passed" ? "✓" : "✗";
  console.log(`  ${label} assert ${id}${error ? `: ${error}` : ""}`);
  writeReport();
}

function writeReport() {
  writeFileSync(reportPath, `${JSON.stringify(report, null, 2)}\n`);
}

function asArray(value) {
  if (Array.isArray(value)) return value;
  for (const key of ["items", "records", "logs", "errors", "entries"]) {
    if (Array.isArray(value?.[key])) return value[key];
  }
  return [];
}

function jsonCount(value) {
  return asArray(value).length;
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
  try { return JSON.parse(line.trim()); } catch { return null; }
}

function expandValue(value) {
  return String(value).replaceAll("${projectRoot}", projectRoot);
}

function recentProjectsStorePath() {
  if (process.env.CUTREADY_RECENT_PROJECTS_STORE) return process.env.CUTREADY_RECENT_PROJECTS_STORE;
  if (process.platform === "win32" && process.env.APPDATA) {
    return join(process.env.APPDATA, "com.cutready.app", "recent-projects.json");
  }
  return null;
}

function pidIsRunning(pid) {
  if (!Number.isFinite(Number(pid))) return false;
  try { process.kill(Number(pid), 0); return true; } catch { return false; }
}

function delay(ms) {
  return new Promise((resolveDelay) => setTimeout(resolveDelay, ms));
}
