#!/usr/bin/env node
// Live Draftline drills: real CutReady debug app, real git, Auditaur-observed.
//
//   node scripts/draftline-drill/run.mjs [--only S01,S02] [--group core]
//        [--attach <auditaur session file>] [--keep] [--report <path>]
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { AppSession, activeCutReadySession } from "./app.mjs";
import { DrillContext } from "./context.mjs";
import { fakeGitHub } from "./fakeGitHub.mjs";
import { standalone } from "./fixtures.mjs";
import { scenarios } from "./scenarios/index.mjs";

const FIXTURE_PREFIX = "cutready-draftline-drill-";
const args = parseArgs(process.argv.slice(2));
const reportPath = resolve(args.report ?? "target/draftline-drill-report.json");
const root = mkdtempSync(join(tmpdir(), FIXTURE_PREFIX));
const log = (line) => console.log(line);
const app = new AppSession({ sessionFile: join(root, ".auditaur-session.json"), log });
const report = { startedAt: new Date().toISOString(), root, scenarios: [] };

const selected = scenarios.filter((s) =>
  (!args.only || args.only.split(",").includes(s.id))
  && (!args.group || s.group === args.group)
  && (!args.attach || !s.restartsApp));

const wanted = typeof args.only === "string" ? args.only.split(",") : [];
const unknown = wanted.filter((id) => !scenarios.some((s) => s.id === id));
if (args.group && !scenarios.some((s) => s.group === args.group)) unknown.push(`group ${args.group}`);
if (unknown.length || !selected.length) {
  console.error(unknown.length ? `Unknown: ${unknown.join(", ")}` : "No scenarios selected.");
  rmSync(root, { recursive: true, force: true });
  process.exit(2);
}

mkdirSync(dirname(reportPath), { recursive: true });
process.env.CUTREADY_GITHUB_API_BASE = await fakeGitHub.start();
let exitCode = 0;
try {
  if (args.attach) {
    await app.attach(args.attach);
  } else {
    const active = activeCutReadySession();
    if (active) throw new Error(`A CutReady Auditaur session is already running (pid ${active.pid}); close it or pass --attach.`);
    const home = standalone(join(root, "_home"));
    await app.launch(home.folder);
  }

  for (const scenario of selected) {
    const dir = join(root, scenario.id);
    mkdirSync(dir, { recursive: true });
    const ctx = new DrillContext({ app, root: dir, log, options: args });
    const started = Date.now();
    log(`\n${scenario.id} ${scenario.title}`);
    let error = null;
    try {
      await scenario.run(ctx);
    } catch (err) {
      error = String(err?.stack ?? err);
      log(`    ! ${String(err?.message ?? err)}`);
    }
    const failed = ctx.checks.filter((c) => !c.ok);
    const status = error || failed.length ? "failed" : "passed";
    report.scenarios.push({
      id: scenario.id,
      group: scenario.group,
      title: scenario.title,
      status,
      seconds: Math.round((Date.now() - started) / 1000),
      checks: ctx.checks,
      notes: ctx.notes,
      error,
    });
    writeReport();
    if (!args.attach && !(await alive(app))) {
      log("    app is gone; relaunching");
      app.stop();
      await app.launch(standalone(join(root, `_home-${scenario.id}`)).folder);
    }
  }
} catch (err) {
  report.error = String(err?.stack ?? err);
  console.error(err);
  exitCode = 1;
} finally {
  report.finishedAt = new Date().toISOString();
  writeReport();
  await forgetDrillProjects();
  app.stop();
  fakeGitHub.stop();
  if (!args.keep) rmSync(root, { recursive: true, force: true });
}

const failed = report.scenarios.filter((s) => s.status === "failed");
log(`\n${report.scenarios.length - failed.length}/${report.scenarios.length} scenarios passed. Report: ${reportPath}`);
for (const s of failed) {
  log(`  ✗ ${s.id} ${s.title}`);
  for (const c of s.checks.filter((x) => !x.ok)) log(`      - ${c.label}`);
  if (s.error) log(`      ! ${s.error.split("\n")[0]}`);
}
process.exitCode = exitCode || (failed.length ? 1 : 0);

function writeReport() {
  writeFileSync(reportPath, `${JSON.stringify(report, null, 2)}\n`);
}

async function alive(session) {
  try {
    await session.eval("true", { timeoutMs: 15_000 });
    return true;
  } catch {
    return false;
  }
}

async function forgetDrillProjects() {
  if (app.sessionId) {
    try {
      await app.eval(`(() => {
        const v = localStorage.getItem("cutready:lastProject");
        if (v && v.includes(${JSON.stringify(FIXTURE_PREFIX)})) localStorage.removeItem("cutready:lastProject");
        return true;
      })()`, { timeoutMs: 15_000 });
    } catch { /* app may be gone */ }
  }
  const store = process.platform === "win32" && process.env.APPDATA
    ? join(process.env.APPDATA, "com.cutready.app", "recent-projects.json")
    : null;
  if (!store || !existsSync(store)) return;
  try {
    const data = JSON.parse(readFileSync(store, "utf8"));
    if (!Array.isArray(data.recent_projects)) return;
    data.recent_projects = data.recent_projects.filter((p) => !String(p?.path ?? "").includes(FIXTURE_PREFIX));
    writeFileSync(store, `${JSON.stringify(data, null, 2)}\n`);
  } catch (err) {
    log(`Could not prune recent projects: ${err}`);
  }
}

function parseArgs(argv) {
  const out = {};
  for (let i = 0; i < argv.length; i += 1) {
    const key = argv[i].replace(/^--/, "");
    const next = argv[i + 1];
    if (next === undefined || next.startsWith("--")) out[key] = true;
    else { out[key] = next; i += 1; }
  }
  return out;
}
