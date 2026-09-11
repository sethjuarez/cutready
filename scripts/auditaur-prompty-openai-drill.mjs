// Auditaur Prompty OpenAI battle drill.
//
// Runs real chat turns against a fresh CutReady project and asserts that the
// effective runtime provider is direct OpenAI through the Prompty harness.
// The drill intentionally does not seed API keys. Configure OpenAI in the app
// settings first, set it as the default provider, and keep the Prompty engine
// selected.
//
// Run: npm run test:e2e:harness-prompty-openai

import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { spawn, spawnSync } from "node:child_process";

const appName = "cutready";
const timeoutSeconds = Number(process.env.CUTREADY_AUDITAUR_OPENAI_TIMEOUT ?? "360");
const defaultTurnTimeoutMs = Number(process.env.CUTREADY_AUDITAUR_OPENAI_TURN_TIMEOUT ?? "240000");
const reportPath = resolve(
  process.env.CUTREADY_AUDITAUR_OPENAI_REPORT ??
    "target/auditaur-prompty-openai-battle-report.json",
);
const projectRoot = mkdtempSync(join(tmpdir(), "cutready-openai-battle-"));
const sessionFile = join(projectRoot, ".auditaur-session.json");
const appCommand = process.platform === "win32" ? ["cmd", "/c", "npm run debug"] : ["npm", "run", "debug"];
const env = { ...process.env, CUTREADY_PROJECT: projectRoot };

const sel = {
  composer: 'textarea[placeholder^="Ask about your demo plan"]',
  send: 'button[title="Send (Enter)"]',
  stop: 'button[title="Stop generation"]',
  transcript: '[data-testid="chat-messages-scroll"]',
  newChat: 'button[aria-label="New Chat"]',
  revealChat: '[data-testid="activity-chat"]',
};

const requiredTools = [
  "read_note",
  "read_sketch",
  "delegate_to_agent",
  "update_planning_row",
  "write_storyboard",
  "set_row_visual",
  "review_row_visual",
];

const report = {
  app: appName,
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

  console.log("Starting CutReady under Auditaur observation (Prompty OpenAI battle drill)...");
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
  report.instanceId = readyStatus.instanceId;
  recordPhase("readiness", "passed", readyStatus);

  await openFixtureProject();
  await revealChatComposer(60_000);
  await assertEffectiveOpenAi();

  await runScenario({
    id: "read-and-delegate",
    prompt:
      "You are Writer. Do this exactly once: read openai-brief.md, read openai-battle.sk, and call delegate_to_agent one time for a concise review. Do not repeat any successful tool call. After the delegated result returns, immediately reply with OPENAI-DELEGATE-4242 and stop.",
    turnTimeoutMs: 180_000,
  }, true);

  await runCancellationScenario();

  await runScenario({
    id: "mutate-sketch",
    prompt:
      "You are Writer. Call update_planning_row exactly once for path openai-battle.sk row_number 1. Use expected_narrative exactly: Open with the product promise. Set narrative exactly: Open with the product promise. OPENAI-MUTATION-4242. Then read openai-battle.sk once. Do not repeat any successful tool call. Reply when persisted and stop.",
    turnTimeoutMs: 180_000,
  });

  await runScenario({
    id: "storyboard-and-visual",
    prompt:
      "You are Writer. Do this exactly once: update openai-battle.sb description to include OPENAI-STORYBOARD-4242, set one valid simple Elucim v2 visual on row 2 of openai-battle.sk, then review that visual once. Do not repeat any successful tool call. Reply with OPENAI-VISUAL-4242 and stop.",
    turnTimeoutMs: 300_000,
  });

  assertDurableRunState();
  assertFixtureMutations();
  assertNoErrors();
  assertNoFailedIpc();
  recordExplain();

  const failed = report.assertions.filter((a) => a.status === "failed");
  report.status = failed.length === 0 ? "passed" : "failed";
  report.finishedAt = new Date().toISOString();
  writeReport();
  if (failed.length === 0) {
    console.log(`\nPrompty OpenAI battle drill PASSED. Report: ${reportPath}`);
  } else {
    console.error(`\nPrompty OpenAI battle drill FAILED (${failed.length} assertion(s)). Report: ${reportPath}`);
    for (const assertion of failed) console.error(` - ${assertion.id}: ${assertion.error}`);
    process.exitCode = 1;
  }
} catch (error) {
  report.status = "failed";
  report.error = String(error?.stack ?? error);
  report.finishedAt = new Date().toISOString();
  writeReport();
  console.error(`\nPrompty OpenAI battle drill errored. Report: ${reportPath}`);
  console.error(error);
  process.exitCode = 1;
} finally {
  stopSpawnedApp();
  removeProjectFromRecents();
  rmSync(projectRoot, { recursive: true, force: true });
}

async function openFixtureProject() {
  await drive("evaluate", {
    expression:
      `(async()=>{const store=window.__CUTREADY_STORE__?.getState?.();` +
      `if(!store) throw new Error('missing CutReady store');` +
      `await store.createProject(${JSON.stringify(projectRoot)});` +
      `store.setView?.('chat');` +
      `return {root:store.currentProject?.root,view:store.view};})()`,
  });
  recordPhase("open-fixture-project", "passed", { projectRoot });
}

async function assertEffectiveOpenAi() {
  const result = await drive("evaluate", {
    expression:
      `(()=>{const button=document.querySelector('button[title^="Select Model"]');` +
      `return button?{title:button.title,text:button.innerText}:null;})()`,
  });
  const value = result?.payload?.value ?? result?.payload ?? null;
  const ok = typeof value?.title === "string" &&
    value.title.includes("OpenAI") &&
    typeof value?.text === "string" &&
    value.text.includes("gpt-4o");
  recordAssertion(
    "model-picker-shows-openai",
    ok ? "passed" : "failed",
    value,
    ok ? null : "set OpenAI gpt-4o as the default provider before running this drill",
  );
  if (!ok) throw new Error("chat UI is not showing OpenAI gpt-4o");
}

async function runScenario(scenario, isFirst = false) {
  const entry = { id: scenario.id, status: "running", startedAt: new Date().toISOString() };
  report.scenarios.push(entry);
  console.log(`\nscenario: ${scenario.id}`);
  try {
    if (!isFirst) {
      await drive("click", { selector: sel.newChat });
      await delay(500);
      await waitForSelector(sel.composer, 15_000, "chat composer");
    }
    await drive("click", { selector: sel.composer });
    await drive("fill", { selector: sel.composer, value: scenario.prompt });
    await drive("click", { selector: sel.send });
    if (!await pollExists(sel.stop, true, 20_000)) throw new Error("turn did not start");
    if (!await pollExists(sel.stop, false, scenario.turnTimeoutMs ?? defaultTurnTimeoutMs)) {
      throw new Error("turn did not complete before timeout");
    }
    const transcript = await readTranscript();
    entry.transcriptChars = transcript.length;
    entry.status = "passed";
  } catch (error) {
    entry.status = "failed";
    entry.error = String(error?.message ?? error);
    throw new Error(`scenario ${scenario.id} failed: ${entry.error}`);
  } finally {
    entry.finishedAt = new Date().toISOString();
    writeReport();
  }

  console.log(`  passed: ${scenario.id}`);
}

function assertFixtureMutations() {
  const sketch = JSON.parse(readFileSync(join(projectRoot, "openai-battle.sk"), "utf8"));
  const storyboard = JSON.parse(readFileSync(join(projectRoot, "openai-battle.sb"), "utf8"));
  const visualRefs = (sketch.rows ?? []).map((row) => row.visual).filter(Boolean);
  const mutationOk = JSON.stringify(sketch).includes("OPENAI-MUTATION-4242");
  const storyboardOk = JSON.stringify(storyboard).includes("OPENAI-STORYBOARD-4242");
  const visualOk = visualRefs.length > 0;
  recordAssertion(
    "fixture-mutations-persisted",
    mutationOk && storyboardOk && visualOk ? "passed" : "failed",
    { mutationOk, storyboardOk, visualRefs },
    mutationOk && storyboardOk && visualOk ? null : "expected sketch/storyboard/visual mutations were not persisted",
  );
}

async function runCancellationScenario() {
  const entry = { id: "cancel", status: "running", startedAt: new Date().toISOString() };
  report.scenarios.push(entry);
  console.log("\nscenario: cancel");
  try {
    await drive("click", { selector: sel.newChat });
    await delay(500);
    await waitForSelector(sel.composer, 15_000, "chat composer");
    await drive("click", { selector: sel.composer });
    await drive("fill", {
      selector: sel.composer,
      value:
        "Read openai-brief.md, then write an extremely long, exhaustively detailed 2000-word narration script for a product demo about relational databases. Keep going with as much detail as possible.",
    });
    await drive("click", { selector: sel.send });
    if (!await pollExists(sel.stop, true, 20_000)) throw new Error("turn did not start");
    await delay(2500);
    if (await isVisible(sel.stop)) await drive("click", { selector: sel.stop });
    const returned = await pollExists(sel.send, true, 60_000);
    const stillRunning = await isVisible(sel.stop);
    entry.cancelled = returned && !stillRunning;
    if (!entry.cancelled) throw new Error("cancellation did not return composer to idle");
    entry.status = "passed";
  } catch (error) {
    entry.status = "failed";
    entry.error = String(error?.message ?? error);
    throw new Error(`scenario cancel failed: ${entry.error}`);
  } finally {
    entry.finishedAt = new Date().toISOString();
    writeReport();
  }
  console.log("  passed: cancel");
}

async function revealChatComposer(timeoutMs) {
  if (await isVisible(sel.composer)) return;
  if (sel.revealChat) {
    await waitForSelector(sel.revealChat, 30_000, "chat activity control");
    await drive("click", { selector: sel.revealChat });
    if (await pollExists(sel.composer, true, 8_000)) return;
    if (await isVisible(sel.revealChat)) await drive("click", { selector: sel.revealChat });
  }
  await waitForSelector(sel.composer, timeoutMs, "chat composer");
}

async function readTranscript() {
  const result = runDrive("text", { selector: sel.transcript });
  if (!result.ok) return "";
  return extractText(result.json);
}

function assertDurableRunState() {
  const dbPath = projectAgentStateDb();
  report.projectDatabasePath = dbPath;
  if (!dbPath) {
    return recordAssertion("project-agent-state-db", "failed", null, "agent-state.db was not created");
  }
  recordAssertion("project-agent-state-db", "passed", { path: dbPath });

  const runs = querySql(dbPath, `
    import sqlite3, json, sys
    conn=sqlite3.connect(sys.argv[1])
    for row in conn.execute('select run_id, parent_run_id, provider, model, status, metadata_json from agent_runs order by started_at'):
      meta=json.loads(row[5] or '{}')
      print(json.dumps({'run_id':row[0],'parent_run_id':row[1],'provider':row[2],'model':row[3],'status':row[4],'engine':meta.get('execution_engine')}))
  `);
  report.runs = runs;
  const completedRuns = runs.filter((run) => run.status === "completed");
  const runsOk = completedRuns.length >= 3 && completedRuns.every((run) =>
    run.provider === "openai" &&
    run.model === "gpt-4o" &&
    run.engine === "prompty"
  );
  recordAssertion(
    "runs-are-prompty-openai",
    runsOk ? "passed" : "failed",
    { completedRuns },
    runsOk ? null : "completed runs were not all direct OpenAI gpt-4o Prompty runs",
  );

  const checkpointTools = querySql(dbPath, `
    import sqlite3, json, sys
    conn=sqlite3.connect(sys.argv[1])
    seen=[]
    for (payload,) in conn.execute('select checkpoint_json from checkpoints order by created_at'):
      data=json.loads(payload or '{}')
      for item in data.get('completedToolResults') or []:
        seen.append({'tool': item.get('name'), 'outcome': item.get('outcome')})
    for item in seen:
      print(json.dumps(item))
  `);
  report.completedToolResults = checkpointTools;
  const missing = requiredTools.filter((tool) => !checkpointTools.some((item) => item.tool === tool));
  recordAssertion(
    "required-tools-observed",
    missing.length === 0 ? "passed" : "failed",
    { requiredTools, observed: checkpointTools },
    missing.length === 0 ? null : `missing tool result(s): ${missing.join(", ")}`,
  );
}

function assertNoErrors() {
  const result = runJson(readArgs("errors"));
  if (!result.ok) return recordAssertion("no-frontend-errors", "failed", null, result.error);
  const count = jsonCount(result.json);
  recordAssertion(
    "no-frontend-errors",
    count === 0 ? "passed" : "failed",
    result.json,
    count === 0 ? null : `${count} frontend error record(s)`,
  );
}

function assertNoFailedIpc() {
  const result = runJson(readArgs("ipc", "--failed"));
  if (!result.ok) return recordAssertion("no-failed-ipc", "failed", null, result.error);
  const count = jsonCount(result.json);
  recordAssertion(
    "no-failed-ipc",
    count === 0 ? "passed" : "failed",
    result.json,
    count === 0 ? null : `${count} failed IPC record(s)`,
  );
}

function recordExplain() {
  const result = runJson(readArgs("explain"));
  report.explain = result.ok ? result.json : { error: result.error };
  writeReport();
}

function writeProjectFixture() {
  const now = new Date().toISOString();
  mkdirSync(projectRoot, { recursive: true });
  mkdirSync(join(projectRoot, ".cutready", "visuals"), { recursive: true });
  writeFileSync(
    join(projectRoot, "openai-brief.md"),
    "# OpenAI Battle Brief\n\nExercise Prompty direct OpenAI with reading, delegation, mutation, storyboard updates, and visual tools.\n",
  );
  writeFileSync(
    join(projectRoot, "openai-battle.sk"),
    `${JSON.stringify({
      title: "OpenAI Battle Sketch",
      description: "Fixture sketch for direct OpenAI Prompty battle testing.",
      rows: [
        {
          time: "~10s",
          narrative: "Open with the product promise.",
          demo_actions: "Show the project overview.",
          screenshot: null,
        },
        {
          time: "~20s",
          narrative: "Explain the automation payoff.",
          demo_actions: "Show the refined script.",
          screenshot: null,
        },
      ],
      state: "draft",
      created_at: now,
      updated_at: now,
    }, null, 2)}\n`,
  );
  writeFileSync(
    join(projectRoot, "openai-battle.sb"),
    `${JSON.stringify({
      title: "OpenAI Battle Storyboard",
      description: "Storyboard fixture.",
      items: [{ type: "sketch_ref", path: "openai-battle.sk" }],
      created_at: now,
      updated_at: now,
    }, null, 2)}\n`,
  );
}

function driveArgs(action, opts) {
  const args = [
    "drive", "--app", appName,
    "--session-id", report.sessionId,
    "--instance-id", report.instanceId,
    "--pid", String(appPid),
    "--json", action, "--target", "auditaur-bridge",
  ];
  if (opts.selector) args.push("--selector", opts.selector);
  if (opts.value !== undefined) args.push("--value", opts.value);
  if (opts.expression !== undefined) args.push("--expression", opts.expression);
  if (opts.key) args.push("--key", opts.key);
  return args;
}

function runDrive(action, opts = {}) {
  return runJson(driveArgs(action, opts));
}

async function drive(action, opts = {}) {
  const result = runDrive(action, opts);
  if (!result.ok) throw new Error(`drive ${action} ${opts.selector ?? ""} failed: ${result.error}`);
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

function readArgs(command, ...rest) {
  return [command, "--json", "--db", report.databasePath, "--session", report.sessionId, ...rest];
}

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
  const label = status === "passed" ? "passed" : "failed";
  console.log(`  ${label} assert ${id}${error ? `: ${error}` : ""}`);
  writeReport();
}

function writeReport() {
  writeFileSync(reportPath, `${JSON.stringify(report, null, 2)}\n`);
}

function querySql(dbPath, script) {
  const normalizedScript = script
    .replace(/^\n/, "")
    .split("\n")
    .map((line) => line.replace(/^ {4}/, ""))
    .join("\n");
  const result = spawnSync("python", ["-c", normalizedScript, dbPath], { encoding: "utf8", shell: false });
  if (result.status !== 0) {
    recordAssertion("sqlite-query", "failed", { stderr: result.stderr }, result.stderr || `python exited ${result.status}`);
    return [];
  }
  return result.stdout.trim().split(/\r?\n/).filter(Boolean).map((line) => JSON.parse(line));
}

function projectAgentStateDb() {
  const candidate = join(projectRoot, ".git", "cutready", "agent-state.db");
  return existsSync(candidate) ? candidate : null;
}

function asArray(value) {
  if (Array.isArray(value)) return value;
  for (const key of ["items", "records", "logs", "errors", "entries", "ipc"]) {
    if (Array.isArray(value?.[key])) return value[key];
  }
  return [];
}

function jsonCount(value) {
  return asArray(value).length;
}

function existsTruthy(json) {
  if (typeof json === "boolean") return json;
  const scopes = [json?.payload, json];
  for (const scope of scopes) {
    if (!scope || typeof scope !== "object") continue;
    for (const key of ["exists", "found", "visible", "present", "matched"]) {
      if (typeof scope[key] === "boolean") return scope[key];
    }
    if (typeof scope.count === "number") return scope.count > 0;
  }
  return false;
}

function extractText(json) {
  if (typeof json === "string") return json;
  const scopes = [json?.payload, json];
  for (const scope of scopes) {
    if (!scope || typeof scope !== "object") continue;
    for (const key of ["text", "value", "content", "innerText", "textContent"]) {
      if (typeof scope[key] === "string") return scope[key];
    }
  }
  return JSON.stringify(json ?? "");
}

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
      `An active CutReady Auditaur session is already running (pid ${app.pid}, session ${app.sessionId}). Close it before running the OpenAI battle drill.`,
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
    const settleReady = (status) => {
      if (!settled) {
        settled = true;
        clearTimeout(timer);
        resolveReady(status);
      }
    };
    const settleFailure = (error) => {
      if (!settled) {
        settled = true;
        clearTimeout(timer);
        rejectReady(error);
      }
    };

    launcher.stdout.on("data", (chunk) => {
      const text = chunk.toString();
      stdout += text;
      pendingStdout += text;
      process.stdout.write(text);
      const lines = pendingStdout.split(/\r?\n/);
      pendingStdout = lines.pop() ?? "";
      for (const line of lines) {
        const status = normalizeReadyStatus(parseJsonLine(line));
        if (status?.sessionId) {
          settleReady(status);
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
    try { process.kill(Number(pid), "SIGTERM"); } catch { /* already stopped */ }
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
      (project) => !String(project?.path ?? "").includes("cutready-openai-battle-"),
    );
    if (store.recent_projects.length !== before) {
      writeFileSync(storePath, `${JSON.stringify(store, null, 2)}\n`);
    }
  } catch (error) {
    console.warn(`Could not remove drill project from recent workspaces: ${error}`);
  }
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
