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
//   (<file> is fixture-relative, or app-data:<file> for the app data folder)
//   node scripts/auditaur-drill-fixture.mjs expect-file <file> <absent | exists | text it must contain | lacks:text>
//   node scripts/auditaur-drill-fixture.mjs expect-agent-runs --provider <id> [--model <m> | --model-prefix <p>]
//        [--engine <id>] [--min-completed <n>] [--tools a,b,...]
//   node scripts/auditaur-drill-fixture.mjs write <file> <text>
//   (writes a fixture-relative file mid-test, e.g. state under .git/ that only exists once the app opened the project)
//   node scripts/auditaur-drill-fixture.mjs connect-remote
//   (adds the `remote` spec's bare repo as `origin` once the app has created the project's .git)
//   node scripts/auditaur-drill-fixture.mjs collaborator-save <file> <text> <message>
//   (a collaborator's clone of the bare remote writes <file>, saves, and pushes to main)
//   node scripts/auditaur-drill-fixture.mjs expect-remote <message>
//   (main on the bare remote has a save with that message)
//
// Fixture spec (all optional):
//   prefix         temp folder prefix
//   copyFrom       repo-relative folder copied into the project
//   sketches       [{ path, title, description, narrative }]
//   notes          [{ path, body }]
//   files          [{ path, body } | { path, json }]  any other project file
//   projects       [{ path, name, description, sketches }]  (multi-project repo)
//   globalSettings { seed: { key: value } }  merged into app settings.json
//   appStores      [{ file, clear, json }]  app-data files or dirs backed up (then cleared and/or seeded)
//   recentProjects [{ name, sketches, notes, files }]  extra project folders (<root>-<name>) seeded as the only recents
//   remote         true: an empty bare repo at <root>-remote.git (main) for collaboration drills
//   remote         true: an empty bare repo at <root>-remote.git (main) for collaboration drills

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
import { dirname, join, resolve, sep } from "node:path";

const DRILL_DIR = resolve("target", "auditaur-drill");
const STATE = join(DRILL_DIR, "state.json");
const BACKUP_DIR = join(DRILL_DIR, "backup");

const [command, ...args] = process.argv.slice(2);
try {
  if (command === "setup") setup(args[0]);
  else if (command === "teardown") teardown();
  else if (command === "expect-json") expectJson(args[0], args[1]);
  else if (command === "expect-file") expectFile(args[0], args[1]);
  else if (command === "expect-agent-runs") await expectAgentRuns(parseFlags(args));
  else if (command === "write") writeProjectFile(args[0], args[1]);
  else if (command === "connect-remote") connectRemote();
  else if (command === "collaborator-save") collaboratorSave(args[0], args[1], args[2]);
  else if (command === "expect-remote") expectRemote(args[0]);
  else throw new Error(`unknown command ${JSON.stringify(command)}; use setup, teardown, expect-json, expect-file, expect-agent-runs, write, connect-remote, collaborator-save, or expect-remote`);
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
  waitForWebViewExit();
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
    if (store.clear) rmSync(path, { recursive: true, force: true });
    if (store.json !== undefined) {
      mkdirSync(dirname(path), { recursive: true });
      writeFileSync(path, `${JSON.stringify(store.json, null, 2)}\n`);
    }
  }

  if (spec.recentProjects?.length) {
    const path = recentProjectsPath();
    backup(state, path);
    state.extraRoots = spec.recentProjects.map(({ name }) => `${projectRoot}-${name}`);
    saveState();
    const recent = spec.recentProjects.map((project, index) => {
      const root = state.extraRoots[index];
      mkdirSync(root, { recursive: true });
      writeProject(root, project);
      return { path: root, last_opened: new Date(Date.now() - (index + 1) * 3_600_000).toISOString() };
    });
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, `${JSON.stringify({ recent_projects: recent }, null, 2)}\n`);
  }

  if (spec.remote) {
    state.extraRoots = [...(state.extraRoots ?? []), remotePath(projectRoot), collaboratorPath(projectRoot)];
    saveState();
    git(["init", "--bare", "--initial-branch=main", remotePath(projectRoot)]);
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
      rmSync(path, { recursive: true, force: true });
      if (existed) {
        mkdirSync(dirname(path), { recursive: true });
        cpSync(copy, path, { recursive: true });
      }
    } catch (error) {
      failed = true;
      console.error(`FAILED to restore ${path}: ${error.message}`);
    }
  }
  removeFromRecents(state.prefix);
  if (state.projectRoot) rmSync(state.projectRoot, { recursive: true, force: true });
  for (const root of state.extraRoots ?? []) rmSync(root, { recursive: true, force: true });
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

// Editors save on a debounce, so file checks retry briefly before failing.
function eventually(check, timeoutMs = 5000) {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    try {
      return check();
    } catch (error) {
      if (Date.now() >= deadline) throw error;
      Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 200);
    }
  }
}

function expectJson(file, expression) {
  if (!file || !expression) throw new Error("expect-json needs <file> <expression>");
  const predicate = new Function("doc", `return (${expression});`);
  eventually(() => {
    const doc = JSON.parse(readFileSync(resolveExpectPath(file), "utf8"));
    if (!predicate(doc)) throw new Error(`expected ${file} to satisfy ${expression}; got ${JSON.stringify(doc)}`);
  });
  console.log(`${file} satisfies ${expression}`);
}

// `absent`, `exists`, or text the file must contain.
function expectFile(file, expectation) {
  if (!file || !expectation) throw new Error("expect-file needs <file> <absent|exists|text|lacks:text>");
  const path = resolveExpectPath(file);
  eventually(() => {
    const exists = existsSync(path);
    if (expectation === "absent") {
      if (exists) throw new Error(`expected ${file} to be absent`);
    } else if (!exists) {
      throw new Error(`expected ${file} to exist`);
    } else if (expectation.startsWith("lacks:")) {
      if (readFileSync(path, "utf8").includes(expectation.slice(6))) {
        throw new Error(`expected ${file} not to contain ${JSON.stringify(expectation.slice(6))}`);
      }
    } else if (expectation !== "exists" && !readFileSync(path, "utf8").includes(expectation)) {
      throw new Error(`expected ${file} to contain ${JSON.stringify(expectation)}`);
    }
  });
  console.log(`${file}: ${expectation}`);
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
  if (existed) cpSync(path, copy, { recursive: true });
  state.backups.push({ path, existed, copy });
}

function writeProject(root, spec) {
  if (spec.copyFrom) cpSync(resolve(spec.copyFrom), root, { recursive: true });
  for (const note of spec.notes ?? []) writeFileSync(join(root, note.path), note.body ?? "");
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
// Workaround for Auditaur AR-28: on 0.4.20, cleanup can give up while a WebView2
// child is still tearing down. That child keeps the EBWebView user-data folder
// locked, so the next launch fails with 0x800700AA ("The requested resource is in
// use"). Wait for it here before the next launch.
function waitForWebViewExit(timeoutSeconds = 120) {
  if (process.platform !== "win32") return;
  const script =
    `$deadline = (Get-Date).AddSeconds(${timeoutSeconds}); ` +
    "while ((Get-Date) -lt $deadline) { " +
    "$p = Get-CimInstance Win32_Process -Filter \"Name='msedgewebview2.exe'\" | Where-Object { $_.CommandLine -like '*com.cutready.app*' }; " +
    "if (-not $p) { exit 0 }; Start-Sleep -Milliseconds 250 }; exit 1";
  const result = spawnSync("powershell", ["-NoProfile", "-NonInteractive", "-Command", script], {
    encoding: "utf8",
    windowsHide: true,
  });
  if (result.error) throw new Error(`could not check for CutReady WebView2 processes: ${result.error.message}`);
  if (result.status !== 0) {
    throw new Error(`CutReady WebView2 processes still running after ${timeoutSeconds}s; close them before running drills.`);
  }
}

// Writes text to a fixture-relative file (never app data or outside the project).
function writeProjectFile(file, text) {
  if (!file || text === undefined) throw new Error("write needs <file> <text>");
  if (file.startsWith("app-data:")) throw new Error("write only targets the fixture project, not app data");
  const root = resolve(fixtureRoot());
  const path = resolve(root, file);
  if (!path.startsWith(root + sep)) throw new Error(`write target ${file} is outside the fixture project`);
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, text);
}

function remotePath(root) {
  return `${root}-remote.git`;
}

function collaboratorPath(root) {
  return `${root}-collab`;
}

function git(args, cwd, env) {
  const result = spawnSync("git", args, { cwd, env: { ...process.env, ...env }, encoding: "utf8", windowsHide: true });
  if (result.error) throw new Error(`git ${args[0]} failed: ${result.error.message}`);
  if (result.status !== 0) throw new Error(`git ${args.join(" ")} failed: ${result.stderr.trim()}`);
  return result.stdout;
}

function connectRemote() {
  const root = fixtureRoot();
  if (!existsSync(remotePath(root))) throw new Error("connect-remote needs a fixture spec with `remote: true`");
  if (!existsSync(join(root, ".git"))) throw new Error("the project has no .git yet; open it in the app first");
  git(["remote", "add", "origin", remotePath(root)], root);
}

// A second contributor saving and sending from their own clone.
function collaboratorSave(file, text, message) {
  if (!file || text === undefined || !message) throw new Error("collaborator-save needs <file> <text> <message>");
  const root = fixtureRoot();
  const clone = collaboratorPath(root);
  if (existsSync(clone)) git(["pull", "--ff-only", "origin", "main"], clone);
  else git(["clone", "--branch", "main", remotePath(root), clone]);
  const path = resolve(clone, file);
  if (!path.startsWith(resolve(clone) + sep)) throw new Error(`collaborator-save target ${file} is outside the clone`);
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, text);
  git(["add", "--", file], clone);
  // The drill env sets GIT_AUTHOR_* for the app, which would override -c user.name here.
  const who = { name: "Drill Collaborator", email: "collaborator@drill.test" };
  git(["commit", "-m", message], clone, {
    GIT_AUTHOR_NAME: who.name,
    GIT_AUTHOR_EMAIL: who.email,
    GIT_COMMITTER_NAME: who.name,
    GIT_COMMITTER_EMAIL: who.email,
  });
  git(["push", "origin", "HEAD:main"], clone);
}

function expectRemote(message) {
  if (!message) throw new Error("expect-remote needs <message>");
  // Send finishes in the background after the button settles, so retry briefly.
  eventually(() => {
    const log = git(["--git-dir", remotePath(fixtureRoot()), "log", "--format=%s", "main"]);
    if (!log.split("\n").includes(message)) {
      throw new Error(`main on the remote has no save named ${JSON.stringify(message)}; it has:\n${log.trim()}`);
    }
  }, 30000);
}

// Fixture-relative path, or `app-data:<file>` for CutReady's app data folder.
function resolveExpectPath(file) {
  return file.startsWith("app-data:") ? join(appDataDir(), file.slice(9)) : join(fixtureRoot(), file);
}

function appDataDir() {
  if (process.platform === "win32" && process.env.APPDATA) return join(process.env.APPDATA, "com.cutready.app");
  if (process.platform === "darwin") return join(process.env.HOME, "Library", "Application Support", "com.cutready.app");
  // Tauri's app_data_dir on Linux is the XDG data dir, not ~/.config.
  return join(process.env.XDG_DATA_HOME || join(process.env.HOME, ".local", "share"), "com.cutready.app");
}

function globalSettingsPath() {
  return process.env.CUTREADY_GLOBAL_SETTINGS_STORE ?? join(appDataDir(), "settings.json");
}

function recentProjectsPath() {
  return process.env.CUTREADY_RECENT_PROJECTS_STORE ?? join(appDataDir(), "recent-projects.json");
}

function removeFromRecents(prefix) {
  const path = recentProjectsPath();
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
