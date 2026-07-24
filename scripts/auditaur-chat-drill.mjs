// Auditaur chat acceptance drill.
//
// Drives real Prompty chat turns against an isolated temp project and asserts the
// host contract that Rust unit tests cannot cover end-to-end: tool round-trips,
// cancellation, provider health (no 4xx), IPC/error health, telemetry privacy, and
// that the Prompty execution path actually ran (not Agentive).
//
// Convention mirrors scripts/auditaur-project-switch-drill.mjs.
//
// Run: npm run test:e2e:chat
// Requires: auditaur 0.4.1+ on PATH; the app's global AI settings must select the
// Prompty engine (the drill fails loudly if the executed engine is not Prompty).

import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { spawn, spawnSync } from "node:child_process";

const definitionPath = resolve(
  process.env.CUTREADY_AUDITAUR_CHAT_DEFINITION ?? "scripts/auditaur-chat-drill.json",
);
const definition = JSON.parse(readFileSync(definitionPath, "utf8"));
const appName = definition.app ?? "cutready";
const sel = definition.selectors ?? {};
const timeoutSeconds = Number(
  process.env.CUTREADY_AUDITAUR_CHAT_TIMEOUT ?? definition.timeoutSeconds ?? "240",
);
const defaultTurnTimeoutMs = Number(definition.turnTimeoutMs ?? 120_000);
const reportPath = resolve(
  process.env.CUTREADY_AUDITAUR_CHAT_REPORT ?? "target/auditaur-chat-drill-report.json",
);
const projectRoot = mkdtempSync(join(tmpdir(), definition.fixture?.prefix ?? "cutready-chat-drill-"));
const sessionFile = join(projectRoot, ".auditaur-session.json");
const appCommand = process.platform === "win32" ? ["cmd", "/c", "npm run debug"] : ["npm", "run", "debug"];
const env = { ...process.env, CUTREADY_PROJECT: projectRoot };

const report = {
  app: appName,
  definition: definitionPath,
  startedAt: new Date().toISOString(),
  status: "running",
  fixtureProject: projectRoot,
  phases: [],
  scenarios: [],
  assertions: [],
};

let launcher;
let appPid;
let processPid;

mkdirSync(dirname(reportPath), { recursive: true });
writeProjectFixture();

try {
  ensureNoActiveCutReady();
  console.log("Starting CutReady under Auditaur observation...");

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

  // Chat auto-reveals when a project opens; wait for the composer.
  await waitForSelector(sel.composer, 60_000, "chat composer");
  recordPhase("composer-ready", "passed", { selector: sel.composer });

  let first = true;
  for (const scenario of definition.scenarios ?? []) {
    await runScenario(scenario, first);
    first = false;
  }

  // ── Post-run assertions ────────────────────────────────────────────────
  assertEngineWasPrompty();
  assertNoErrors();
  assertNoFailedIpc();
  assertNoPrivacyLeak();
  recordExplain();

  const failed = report.assertions.filter((a) => a.status === "failed");
  report.status = failed.length === 0 ? "passed" : "failed";
  report.finishedAt = new Date().toISOString();
  writeReport();
  if (failed.length === 0) {
    console.log(`\nChat drill PASSED. Report: ${reportPath}`);
  } else {
    console.error(`\nChat drill FAILED (${failed.length} assertion(s)). Report: ${reportPath}`);
    for (const a of failed) console.error(` - ${a.id}: ${a.error}`);
    process.exitCode = 1;
  }
} catch (error) {
  report.status = "failed";
  report.error = String(error);
  report.finishedAt = new Date().toISOString();
  writeReport();
  console.error(`\nChat drill errored. Report: ${reportPath}`);
  console.error(error);
  process.exitCode = 1;
} finally {
  stopSpawnedApp();
  removeProjectFromRecents();
  rmSync(projectRoot, { recursive: true, force: true });
}

// ── Scenario execution ─────────────────────────────────────────────────────

async function runScenario(scenario, isFirst) {
  const id = scenario.id ?? "scenario";
  const entry = { id, status: "running", startedAt: new Date().toISOString() };
  report.scenarios.push(entry);
  console.log(`\n▶ scenario: ${id}`);

  try {
    if (!isFirst) {
      await drive("click", { selector: sel.newChat });
      await delay(500);
      await waitForSelector(sel.composer, 15_000, "chat composer (new chat)");
    }

    // Enter the prompt and send.
    await drive("click", { selector: sel.composer });
    await drive("fill", { selector: sel.composer, value: scenario.prompt });
    await drive("click", { selector: sel.send });

    // Wait for the turn to start (Stop button appears).
    const started = await pollExists(sel.stop, true, 12_000);
    entry.turnStarted = started;

    if (scenario.cancel) {
      await delay(Number(scenario.cancelAfterMs ?? 2_000));
      const stopVisible = await isVisible(sel.stop);
      if (stopVisible) {
        await drive("click", { selector: sel.stop });
      }
      // After cancel the composer must return to the idle Send state.
      const returned = await pollExists(sel.send, true, 20_000);
      const stillRunning = await isVisible(sel.stop);
      entry.cancelled = returned && !stillRunning;
      if (!entry.cancelled) {
        throw new Error("cancellation did not return the composer to idle Send state");
      }
      entry.status = "passed";
    } else {
      // Wait for completion (Stop disappears).
      const done = await pollExists(sel.stop, false, scenario.turnTimeoutMs ?? defaultTurnTimeoutMs);
      if (!done) throw new Error("turn did not complete before timeout");

      const transcript = await readTranscript();
      entry.transcriptChars = transcript.length;
      const expected = Array.isArray(scenario.expectResponse)
        ? scenario.expectResponse
        : scenario.expectResponse
        ? [scenario.expectResponse]
        : [];
      const missing = expected.filter((needle) => !transcript.includes(needle));
      entry.expected = expected;
      entry.missing = missing;
      if (missing.length > 0) {
        throw new Error(`assistant response missing expected text: ${missing.join(", ")}`);
      }
      entry.status = "passed";
    }
  } catch (error) {
    entry.status = "failed";
    entry.error = String(error?.message ?? error);
    writeReport();
    throw new Error(`scenario ${id} failed: ${entry.error}`);
  } finally {
    entry.finishedAt = new Date().toISOString();
    writeReport();
  }
  console.log(`  ✓ ${id}`);
}

async function readTranscript() {
  const result = runDrive("text", { selector: sel.transcript });
  if (!result.ok) return "";
  return extractText(result.json);
}

// ── Drive helpers ──────────────────────────────────────────────────────────

function driveArgs(action, opts) {
  const args = [
    "drive", "--app", appName, "--session-id", report.sessionId, "--json",
    action, "--target", "auditaur-bridge",
  ];
  if (opts.selector) args.push("--selector", opts.selector);
  if (opts.value !== undefined) args.push("--value", opts.value);
  if (opts.key) args.push("--key", opts.key);
  return args;
}

function runDrive(action, opts = {}) {
  return runJson(driveArgs(action, opts));
}

async function drive(action, opts = {}) {
  const result = runDrive(action, opts);
  if (!result.ok) {
    throw new Error(`drive ${action} ${opts.selector ?? ""} failed: ${result.error}`);
  }
  return result.json;
}

async function isVisible(selector) {
  const result = runDrive("exists", { selector });
  return existsTruthy(result.json);
}

async function pollExists(selector, wantVisible, timeoutMs) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if ((await isVisible(selector)) === wantVisible) return true;
    await delay(500);
  }
  return false;
}

async function waitForSelector(selector, timeoutMs, label) {
  const ok = await pollExists(selector, true, timeoutMs);
  if (!ok) throw new Error(`timed out waiting for ${label ?? selector}`);
}

function existsTruthy(json) {
  if (typeof json === "boolean") return json;
  if (json && typeof json === "object") {
    // The auditaur CLI wraps the drive-bridge result under `payload`.
    const scopes = [json.payload, json];
    for (const scope of scopes) {
      if (!scope || typeof scope !== "object") continue;
      for (const key of ["exists", "found", "visible", "present", "matched"]) {
        if (typeof scope[key] === "boolean") return scope[key];
      }
      if (typeof scope.count === "number") return scope.count > 0;
    }
  }
  return false;
}

function extractText(json) {
  if (typeof json === "string") return json;
  if (json && typeof json === "object") {
    // The auditaur CLI wraps the drive-bridge result under `payload`.
    const scopes = [json.payload, json];
    for (const scope of scopes) {
      if (!scope || typeof scope !== "object") continue;
      for (const key of ["text", "value", "content", "innerText", "textContent"]) {
        if (typeof scope[key] === "string") return scope[key];
      }
    }
  }
  return JSON.stringify(json ?? "");
}

// ── Post-run assertions ──────────────────────────────────────────────────────

function assertEngineWasPrompty() {
  const result = runJson(["logs", "--json", "--session", report.sessionId]);
  if (!result.ok) return recordAssertion("engine-is-prompty", "failed", null, result.error);
  const items = asArray(result.json);
  const starts = items
    .map((item) => JSON.stringify(item))
    .filter((s) => s.includes("agent_chat_with_tools_start"));
  const prompty = starts.filter((s) => s.includes("prompty"));
  const agentive = starts.filter((s) => /\\?"execution_engine\\?":\\?"agentive/.test(s) || s.includes("\"agentive\""));
  if (starts.length === 0) {
    return recordAssertion("engine-is-prompty", "failed", { starts: 0 }, "no agent_chat_with_tools_start trace found");
  }
  if (prompty.length === 0) {
    return recordAssertion("engine-is-prompty", "failed", { starts: starts.length }, "runs did not use the Prompty engine (set aiAgentExecutionEngine=prompty)");
  }
  if (agentive.length > 0) {
    return recordAssertion("engine-is-prompty", "failed", { agentive: agentive.length }, "an Agentive-engine run was observed");
  }
  recordAssertion("engine-is-prompty", "passed", { starts: starts.length, prompty: prompty.length });
}

function assertNoErrors() {
  const result = runJson(["errors", "--json", "--session", report.sessionId]);
  if (!result.ok) return recordAssertion("no-frontend-errors", "failed", null, result.error);
  const count = jsonCount(result.json);
  recordAssertion(
    "no-frontend-errors",
    count === 0 ? "passed" : "failed",
    result.json,
    count === 0 ? null : `${count} error record(s)`,
  );
}

function assertNoFailedIpc() {
  const result = runJson(["ipc", "--json", "--session", report.sessionId, "--failed"]);
  if (!result.ok) return recordAssertion("no-failed-ipc", "failed", null, result.error);
  const count = jsonCount(result.json);
  recordAssertion(
    "no-failed-ipc",
    count === 0 ? "passed" : "failed",
    result.json,
    count === 0 ? null : `${count} failed IPC record(s)`,
  );
}

function assertNoPrivacyLeak() {
  const forbid = definition.privacyForbid ?? [];
  if (forbid.length === 0) return;
  const result = runJson(["logs", "--json", "--session", report.sessionId]);
  if (!result.ok) return recordAssertion("no-privacy-leak", "failed", null, result.error);
  const blob = JSON.stringify(result.json ?? "");
  const leaked = forbid.filter((marker) => blob.includes(marker));
  recordAssertion(
    "no-privacy-leak",
    leaked.length === 0 ? "passed" : "failed",
    { forbid, leaked },
    leaked.length === 0 ? null : `sensitive markers found in telemetry logs: ${leaked.join(", ")}`,
  );
}

function recordExplain() {
  const result = runJson(["explain", "--json", "--session", report.sessionId]);
  report.explain = result.ok ? result.json : { error: result.error };
  writeReport();
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
            {
              time: "0:00",
              narrative: sketch.narrative ?? "",
              demo_actions: "",
              screenshot: null,
            },
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

// ── Launch / lifecycle (mirrors project-switch drill) ────────────────────────

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
      `An active CutReady Auditaur session is already running (pid ${app.pid}, session ${app.sessionId}). Close it before running the chat drill.`,
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
      (project) => !String(project?.path ?? "").includes(definition.fixture?.prefix ?? "cutready-chat-drill-"),
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

function recordPhase(id, status, result, error = null) {
  report.phases.push({ id, status, result: result ?? null, error });
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
