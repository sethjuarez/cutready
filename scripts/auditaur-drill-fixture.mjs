#!/usr/bin/env node
// Setup/teardown hooks for `auditaur drill test` suites.
//
// `setup` builds an isolated temp project, backs up the user's app-data stores
// it will touch, and appends CUTREADY_PROJECT to $AUDITAUR_DRILL_ENV_FILE so the
// app launch, later hooks, and `run` steps see it (`"cwd": "${CUTREADY_PROJECT}"`).
// `teardown` restores everything. A crashed run is recovered by the next setup.
//
// The expect-* commands are `run` steps that check durable project state.
//
//   node scripts/auditaur-drill-fixture.mjs setup .auditaur/fixtures/<name>.json
//   node scripts/auditaur-drill-fixture.mjs teardown
//   node scripts/auditaur-drill-fixture.mjs expect-json <file> <js expression over doc>
//   node scripts/auditaur-drill-fixture.mjs expect-agent-runs --provider <id> [--model <m> | --model-prefix <p>]
//        [--engine <id>] [--min-completed <n>] [--tools a,b,...]
//
// Fixture spec (all optional):
//   prefix         temp folder prefix
//   copyFrom       repo-relative folder copied into the project
//   sketches       [{ path, title, description, narrative }]
//   notes          [{ path, body }]
//   files          [{ path, body } | { path, json }]  any other project file
//   projects       [{ path, name, description, sketches }]  (multi-project repo)
//   globalSettings { seed: { key: value } }  merged into app settings.json
//   appStores      [{ file, clear }]        app-data files backed up (and cleared)

import { spawnSync } from "node:child_process";
import {
  appendFileSync,
  cpSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  renameSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";

const DRILL_DIR = resolve("target", "auditaur-drill");
const STATE = join(DRILL_DIR, "state.json");
const BACKUP_DIR = join(DRILL_DIR, "backup");

const [command, ...args] = process.argv.slice(2);
try {
  if (command === "setup") setup(args[0]);
  else if (command === "teardown") teardown();
  else if (command === "expect-json") expectJson(args[0], args[1]);
  else if (command === "expect-agent-runs") await expectAgentRuns(parseFlags(args));
  else throw new Error(`unknown command ${JSON.stringify(command)}; use setup, teardown, expect-json, or expect-agent-runs`);
} catch (error) {
  console.error(`[auditaur-drill-fixture] ${error.message}`);
  process.exit(1);
}

function setup(specPath) {
  if (!specPath) throw new Error("setup needs a fixture spec path");
  const envFile = process.env.AUDITAUR_DRILL_ENV_FILE;
  if (!envFile) throw new Error("setup must run as an `auditaur drill test` setup hook (AUDITAUR_DRILL_ENV_FILE is unset)");
  if (existsSync(STATE)) {
    console.log("Recovering from an unfinished drill run first.");
    teardown();
  }
  ensureNoRunningCutReady();
  const spec = JSON.parse(readFileSync(resolve(specPath), "utf8"));
  const prefix = spec.prefix ?? "cutready-drill-";
  const projectRoot = mkdtempSync(join(tmpdir(), prefix));
  const state = { projectRoot, prefix, backups: [] };
  mkdirSync(BACKUP_DIR, { recursive: true });
  // Persist state (atomically) before mutating user stores so a crash can always be undone.
  const saveState = () => {
    const temp = `${STATE}.tmp`;
    writeFileSync(temp, `${JSON.stringify(state, null, 2)}\n`);
    renameSync(temp, STATE);
  };
  saveState();

  writeProject(projectRoot, spec);
  if (spec.globalSettings?.seed) {
    const path = globalSettingsPath();
    backup(state, path);
    saveState();
    let store = {};
    try {
      store = existsSync(path) ? JSON.parse(readFileSync(path, "utf8")) : {};
    } catch {
      store = {};
    }
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, `${JSON.stringify({ ...store, ...spec.globalSettings.seed }, null, 2)}\n`);
  }
  for (const store of spec.appStores ?? []) {
    const path = join(appDataDir(), store.file);
    backup(state, path);
    saveState();
    if (store.clear) rmSync(path, { force: true });
  }

  appendFileSync(envFile, `CUTREADY_PROJECT=${projectRoot}\n`);
  console.log(`Drill fixture ready at ${projectRoot}`);
}

function teardown() {
  if (!existsSync(STATE)) return;
  const state = JSON.parse(readFileSync(STATE, "utf8"));
  let failed = false;
  for (const { path, existed, copy } of state.backups ?? []) {
    try {
      if (existed) {
        mkdirSync(dirname(path), { recursive: true });
        writeFileSync(path, readFileSync(copy));
      } else {
        rmSync(path, { force: true });
      }
    } catch (error) {
      failed = true;
      console.error(`FAILED to restore ${path}: ${error.message}`);
    }
  }
  removeFromRecents(state.prefix);
  if (state.projectRoot) rmSync(state.projectRoot, { recursive: true, force: true });
  if (failed) throw new Error(`restore failed; backups kept in ${BACKUP_DIR}`);
  rmSync(BACKUP_DIR, { recursive: true, force: true });
  rmSync(STATE, { force: true });
  console.log("Drill fixture removed and app stores restored.");
}

function fixtureRoot() {
  const root = process.env.CUTREADY_PROJECT;
  if (!root) throw new Error("CUTREADY_PROJECT is unset; run this as an `auditaur drill test` step");
  return root;
}

function expectJson(file, expression) {
  if (!file || !expression) throw new Error("expect-json needs <file> <expression>");
  const doc = JSON.parse(readFileSync(join(fixtureRoot(), file), "utf8"));
  if (!new Function("doc", `return (${expression});`)(doc)) {
    throw new Error(`expected ${file} to satisfy ${expression}; got ${JSON.stringify(doc)}`);
  }
  console.log(`${file} satisfies ${expression}`);
}

// Reads the project's agent-state.db after the app closes: completed runs must
// use the expected provider/model/engine, and checkpoints must show the tools.
async function expectAgentRuns(flags) {
  const dbPath = join(fixtureRoot(), ".git", "cutready", "agent-state.db");
  if (!existsSync(dbPath)) throw new Error(`agent-state.db was not created at ${dbPath}`);
  const { DatabaseSync } = await import("node:sqlite");
  const db = new DatabaseSync(dbPath, { readOnly: true });
  try {
    const runs = db.prepare("select provider, model, status, metadata_json from agent_runs order by started_at").all()
      .map((row) => ({ ...row, engine: JSON.parse(row.metadata_json || "{}").execution_engine, metadata_json: undefined }));
    const completed = runs.filter((run) => run.status === "completed");
    const wrong = completed.filter((run) =>
      run.provider !== flags.provider ||
      (flags.model && run.model !== flags.model) ||
      (flags["model-prefix"] && !String(run.model).startsWith(flags["model-prefix"])) ||
      (flags.engine && run.engine !== flags.engine));
    const min = Number(flags["min-completed"] ?? 1);
    if (completed.length < min || wrong.length > 0) {
      throw new Error(`expected >=${min} completed runs matching ${JSON.stringify(flags)}; got ${JSON.stringify(runs)}`);
    }
    const seen = new Set();
    for (const { checkpoint_json } of db.prepare("select checkpoint_json from checkpoints").all()) {
      for (const item of JSON.parse(checkpoint_json || "{}").completedToolResults ?? []) seen.add(item.name);
    }
    const missing = (flags.tools ?? "").split(",").filter(Boolean).filter((tool) => !seen.has(tool));
    if (missing.length > 0) throw new Error(`missing tool results: ${missing.join(", ")}; saw ${[...seen].join(", ")}`);
    console.log(`${completed.length} completed ${flags.provider} runs; tools seen: ${[...seen].join(", ")}`);
  } finally {
    db.close();
  }
}

function parseFlags(args) {
  const flags = {};
  for (let i = 0; i < args.length; i += 2) {
    if (!args[i].startsWith("--") || args[i + 1] === undefined) throw new Error(`bad flag ${args[i]}`);
    flags[args[i].slice(2)] = args[i + 1];
  }
  return flags;
}

function backup(state, path) {
  if (state.backups.some((entry) => entry.path === path)) return;
  const existed = existsSync(path);
  const copy = join(BACKUP_DIR, `${state.backups.length}.bak`);
  if (existed) writeFileSync(copy, readFileSync(path));
  state.backups.push({ path, existed, copy });
}

function writeProject(root, spec) {
  if (spec.copyFrom) cpSync(resolve(spec.copyFrom), root, { recursive: true });
  for (const note of spec.notes ?? []) writeFileSync(join(root, note.path), note.body ?? "");
  for (const file of spec.files ?? []) {
    mkdirSync(dirname(join(root, file.path)), { recursive: true });
    writeFileSync(join(root, file.path), file.json ? `${JSON.stringify(file.json, null, 2)}\n` : file.body ?? "");
  }
  for (const file of spec.files ?? []) {
    mkdirSync(dirname(join(root, file.path)), { recursive: true });
    writeFileSync(join(root, file.path), file.json ? `${JSON.stringify(file.json, null, 2)}\n` : file.body ?? "");
  }
  for (const sketch of spec.sketches ?? []) writeSketch(join(root, sketch.path), sketch);
  const projects = spec.projects ?? [];
  if (projects.length > 0) {
    mkdirSync(join(root, ".cutready"), { recursive: true });
    writeFileSync(
      join(root, ".cutready", "projects.json"),
      `${JSON.stringify({
        projects: projects.map(({ path, name, description }) => ({ path, name, description: description ?? "" })),
      }, null, 2)}\n`,
    );
    for (const project of projects) {
      mkdirSync(join(root, project.path), { recursive: true });
      for (const sketch of project.sketches ?? []) writeSketch(join(root, project.path, sketch.path), sketch);
    }
  }
}

function writeSketch(path, sketch) {
  const now = new Date().toISOString();
  writeFileSync(
    path,
    `${JSON.stringify({
      title: sketch.title,
      description: sketch.description ?? "",
      rows: [{
        time: "0:00",
        narrative: sketch.narrative ?? `${sketch.title} narration`,
        demo_actions: "",
        screenshot: null,
      }],
      state: "draft",
      created_at: now,
      updated_at: now,
    }, null, 2)}\n`,
  );
}

// Any running CutReady (installed or debug) shares the app-data stores we
// back up, and the single-instance plugin would hand our launch to it.
function ensureNoRunningCutReady() {
  const result = process.platform === "win32"
    ? spawnSync("tasklist", ["/FI", "IMAGENAME eq cutready.exe", "/FO", "CSV", "/NH"], { encoding: "utf8", windowsHide: true })
    : spawnSync("pgrep", ["-ix", "cutready"], { encoding: "utf8" });
  if (result.error || (process.platform === "win32" && result.status !== 0)) {
    throw new Error(`could not check for a running CutReady: ${result.error?.message ?? result.stderr}`);
  }
  if (/cutready/i.test(result.stdout ?? "")) {
    throw new Error("CutReady is already running; close it before running drills.");
  }
}

function appDataDir() {
  if (process.platform === "win32" && process.env.APPDATA) return join(process.env.APPDATA, "com.cutready.app");
  if (process.platform === "darwin") return join(process.env.HOME, "Library", "Application Support", "com.cutready.app");
  return join(process.env.HOME, ".config", "com.cutready.app");
}

function globalSettingsPath() {
  return process.env.CUTREADY_GLOBAL_SETTINGS_STORE ?? join(appDataDir(), "settings.json");
}

function removeFromRecents(prefix) {
  const path = process.env.CUTREADY_RECENT_PROJECTS_STORE ?? join(appDataDir(), "recent-projects.json");
  if (!prefix || !existsSync(path)) return;
  try {
    const store = JSON.parse(readFileSync(path, "utf8"));
    if (!Array.isArray(store.recent_projects)) return;
    const kept = store.recent_projects.filter((project) => !String(project?.path ?? "").includes(prefix));
    if (kept.length !== store.recent_projects.length) {
      writeFileSync(path, `${JSON.stringify({ ...store, recent_projects: kept }, null, 2)}\n`);
    }
  } catch (error) {
    console.warn(`Could not prune drill projects from recents: ${error.message}`);
  }
}
