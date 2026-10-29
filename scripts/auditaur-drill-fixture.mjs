#!/usr/bin/env node
// Setup/teardown hooks for `auditaur drill test` suites.
//
// Auditaur suites launch the app with one shared start command, so per-suite
// state goes through files: `setup` builds an isolated temp project, backs up
// the user's app-data stores it will touch, and writes launch-env.json, which
// scripts/auditaur-start-debug.mjs merges into the app's environment.
// `teardown` restores everything. A crashed run is recovered by the next setup.
//
//   node scripts/auditaur-drill-fixture.mjs setup .auditaur/fixtures/<name>.json
//   node scripts/auditaur-drill-fixture.mjs teardown
//   node scripts/auditaur-drill-fixture.mjs expect-git <expected> <git args...>
//
// Fixture spec (all optional):
//   prefix         temp folder prefix
//   env            extra app environment
//   copyFrom       repo-relative folder copied into the project
//   sketches       [{ path, title, description, narrative }]
//   notes          [{ path, body }]
//   projects       [{ path, name, description, sketches }]  (multi-project repo)
//   globalSettings { seed: { key: value } }  merged into app settings.json
//   appStores      [{ file, clear }]        app-data files backed up (and cleared)

import { spawnSync } from "node:child_process";
import {
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
const LAUNCH_ENV = join(DRILL_DIR, "launch-env.json");
const STATE = join(DRILL_DIR, "state.json");
const BACKUP_DIR = join(DRILL_DIR, "backup");

const [command, ...args] = process.argv.slice(2);
try {
  if (command === "setup") setup(args[0]);
  else if (command === "teardown") teardown();
  else if (command === "expect-git") expectGit(args[0], args.slice(1));
  else throw new Error(`unknown command ${JSON.stringify(command)}; use setup, teardown, or expect-git`);
} catch (error) {
  console.error(`[auditaur-drill-fixture] ${error.message}`);
  process.exit(1);
}

function setup(specPath) {
  if (!specPath) throw new Error("setup needs a fixture spec path");
  if (existsSync(STATE)) {
    console.log("Recovering from an unfinished drill run first.");
    teardown();
  }
  rmSync(LAUNCH_ENV, { force: true });
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

  writeFileSync(
    LAUNCH_ENV,
    `${JSON.stringify({ ...(spec.env ?? {}), CUTREADY_PROJECT: projectRoot }, null, 2)}\n`,
  );
  console.log(`Drill fixture ready at ${projectRoot}`);
}

function teardown() {
  rmSync(LAUNCH_ENV, { force: true });
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

// Drill steps cannot run processes, so git assertions run as teardown hooks
// (the app has closed by then; the project still exists until `teardown`).
function expectGit(expected, gitArgs) {
  const { projectRoot } = JSON.parse(readFileSync(STATE, "utf8"));
  const result = spawnSync("git", gitArgs, { cwd: projectRoot, encoding: "utf8", windowsHide: true });
  const output = `${result.stdout ?? ""}${result.stderr ?? ""}`.trim();
  if (result.status !== 0 || !output.includes(expected)) {
    throw new Error(`expected \`git ${gitArgs.join(" ")}\` to contain ${JSON.stringify(expected)}, got ${JSON.stringify(output)}`);
  }
  console.log(`git ${gitArgs.join(" ")} -> ${output}`);
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
