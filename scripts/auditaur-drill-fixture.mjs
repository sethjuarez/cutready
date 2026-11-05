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
//   (<file> is fixture-relative, app-data:<file> for the app data folder, scratch:<file>, or repo:<file>
//   for the enclosing code repo of a hybrid fixture)
//   node scripts/auditaur-drill-fixture.mjs expect-file <file> <absent | exists | zip | text it must contain | lacks:text>
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
//   node scripts/auditaur-drill-fixture.mjs reset
//   (a `beforeEach` step, followed by `reload`: puts the open project back to the state
//   the app first opened it in — files, history, refs, remotes, Draftline's .git/draftline
//   state, agent state, the recent-projects store — plus the shared remote, and re-seeds
//   app stores, so tests in a suite don't depend on each other)
//
// Fixture spec (all optional):
//   prefix         temp folder prefix
//   copyFrom       repo-relative folder copied into the project
//   sketches       [{ path, title, description, narrative }]
//   notes          [{ path, body }]
//   files          [{ path, body } | { path, json } | { path, base64 }]  any other project file
//   projects       [{ path, name, description, sketches }]  (multi-project repo)
//   globalSettings { seed: { key: value } }  merged into app settings.json
//   appStores      [{ file, clear, json }]  app-data files or dirs backed up (then cleared and/or seeded)
//   recentProjects [{ name, sketches, notes, files }]  extra project folders (<root>-<name>) seeded as the only recents
//   remote         true: an empty bare repo at <root>-remote.git (main) for collaboration drills;
//                  { seedSave: "<message>" }: also gives the project a repo whose first save (the
//                  seeded files) is already on the remote's main, with the remote as `origin`
//                  (env CUTREADY_REMOTE_URL is the remote's path with forward slashes);
//                  { seedSave, origin: false }: the same, but the project has no remotes (to add one in the app)
//   history        [{ save: "<message>", notes, files, sketches } | { branch: "<name>" }]  saves made
//                  before the app opens, in order: a save writes its files and commits everything on
//                  main; a branch starts at the latest save (main stays checked out)
//   scratch        { sketches, notes, files }  a folder outside the project (<root>-scratch, env
//                  CUTREADY_SCRATCH) for dialog import sources and export targets; reset rebuilds it
//   hybrid         { folder, code: [{ path, body }], checkout }: a hybrid project. The repo (a code repo
//                  with `code` files) is the temp root and the project is its `folder` subfolder, with no
//                  .git of its own (CUTREADY_PROJECT is the folder, CUTREADY_REPO the repo). History,
//                  remotes and resets act on the repo; spec files land in the folder; collaborator paths
//                  are repo-relative. `checkout` switches to (creating) a branch after seeding.
//   mockLlm        true: starts scripts/auditaur-mock-llm.mjs on 127.0.0.1 and seeds an OpenAI
//                  provider (model drill-mock) pointing at it as the active and default provider.
//                  No key is seeded: tests type a dummy key in Settings, which lands in the
//                  throwaway drill vault. Teardown stops the server.
//   realVault      true: debug builds use the user's real credential vault (for @live suites that
//                  need real provider keys). Otherwise setup points CUTREADY_DRILL_VAULT_DIR at a
//                  throwaway folder (target/auditaur-drill/vault, expect-file prefix `drill-vault:`)
//                  that setup and teardown wipe.
//
//   node scripts/auditaur-drill-fixture.mjs expect-mock-llm <js expression over entry>
//   (some request the mock logged matches, e.g. "e.toolResult?.includes('X')"; retries for 5s)

import { spawn, spawnSync } from "node:child_process";
import { randomBytes } from "node:crypto";
import { pathToFileURL } from "node:url";
import {
  appendFileSync,
  cpSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  renameSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, relative, resolve, sep } from "node:path";

const DRILL_DIR = resolve("target", "auditaur-drill");
const STATE = join(DRILL_DIR, "state.json");
const BACKUP_DIR = join(DRILL_DIR, "backup");
const PRISTINE_DIR = join(DRILL_DIR, "pristine");
const BASELINE_DRAFTLINE_DIR = join(DRILL_DIR, "baseline-draftline");
// Debug builds keep credentials here instead of the user's vault (CUTREADY_DRILL_VAULT_DIR).
const DRILL_VAULT_DIR = join(DRILL_DIR, "vault");
// A throwaway WebView2 profile, so drill `clearStorage` and `cutready:lastProject`
// never touch the user's localStorage. WEBVIEW2_USER_DATA_FOLDER overrides the
// folder Tauri passes. Windows only: WKWebView and WebKitGTK have no equivalent.
const DRILL_WEBVIEW_DIR = join(DRILL_DIR, "webview");
const COLLABORATOR = { name: "Drill Collaborator", email: "collaborator@drill.test" };
const SEEDER = { name: "Drill Seed", email: "seed@drill.test" };

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
  else if (command === "collaborator-branch") collaboratorSave(args[1], args[2], args[3], args[0]);
  else if (command === "expect-remote") expectRemote(args[0]);
  else if (command === "reset") reset();
  else if (command === "expect-mock-llm") expectMockLlm(args[0]);
  else throw new Error(`unknown command ${JSON.stringify(command)}; use setup, teardown, reset, expect-json, expect-file, expect-agent-runs, expect-mock-llm, write, connect-remote, collaborator-save, collaborator-branch, or expect-remote`);
} catch (error) {
  console.error(`[auditaur-drill-fixture] ${error.message}`);
  // A failed setup must not leave the mock model server running.
  if (command === "setup" && existsSync(STATE)) stopMockLlm(JSON.parse(readFileSync(STATE, "utf8")));
  process.exit(1);
}

function setup(specPath) {
  if (!specPath) throw new Error("setup needs a fixture spec path");
  const envFile = process.env.AUDITAUR_DRILL_ENV_FILE;
  if (!envFile) throw new Error("setup must run as an `auditaur drill test` setup hook (AUDITAUR_DRILL_ENV_FILE is unset)");
  ensureNoRunningCutReady();
  if (existsSync(STATE)) {
    console.log("Recovering from an unfinished drill run first.");
    teardown();
  }
  const spec = JSON.parse(readFileSync(resolve(specPath), "utf8"));
  const prefix = spec.prefix ?? "cutready-drill-";
  const repoRoot = mkdtempSync(join(tmpdir(), prefix));
  const projectRoot = spec.hybrid ? childPath(repoRoot, spec.hybrid.folder ?? "cutready") : repoRoot;
  const state = { projectRoot, repoRoot, prefix, backups: [] };
  mkdirSync(BACKUP_DIR, { recursive: true });
  // Persist state (atomically) before mutating user stores so a crash can always be undone.
  const saveState = () => {
    const temp = `${STATE}.tmp`;
    writeFileSync(temp, `${JSON.stringify(state, null, 2)}\n`);
    renameSync(temp, STATE);
  };
  saveState();

  mkdirSync(projectRoot, { recursive: true });
  if (spec.hybrid) writeProject(repoRoot, { files: spec.hybrid.code ?? [] });
  writeProject(projectRoot, spec);
  if (spec.history?.length) seedHistory(repoRoot, spec.history, projectRoot);
  // A hybrid project lives in a code repo that already has history.
  else if (spec.hybrid && !spec.remote?.seedSave) seedHistory(repoRoot, [{ save: "Initial code" }], projectRoot);
  // Reset re-seeds exactly these (backed-up) stores, even if the spec file changes mid-run.
  state.stores = { settingsSeed: spec.globalSettings?.seed, appStores: spec.appStores ?? [] };
  saveState();
  if (spec.mockLlm) {
    state.mockLlm = startMockLlm(saveState, state);
    state.stores.settingsSeed = { ...state.stores.settingsSeed, ...mockProviderSettings(state.mockLlm.url) };
    saveState();
    appendFileSync(envFile, `CUTREADY_MOCK_LLM_LOG=${state.mockLlm.log}\n`);
  }
  // Every launch refreshes OAuth and rewrites the credential vault; keep the user's real one intact.
  // Back up both locations: the app moves a legacy vault into the app data folder on first use.
  // The backup stays as a safety net even when the app uses the throwaway drill vault.
  for (const path of vaultPaths()) {
    backup(state, path);
    saveState();
  }
  rmSync(DRILL_VAULT_DIR, { recursive: true, force: true });
  if (!spec.realVault) {
    mkdirSync(DRILL_VAULT_DIR, { recursive: true });
    appendFileSync(envFile, `CUTREADY_DRILL_VAULT_DIR=${DRILL_VAULT_DIR}\n`);
  }
  if (process.platform === "win32") {
    rmSync(DRILL_WEBVIEW_DIR, { recursive: true, force: true });
    mkdirSync(DRILL_WEBVIEW_DIR, { recursive: true });
    appendFileSync(envFile, `WEBVIEW2_USER_DATA_FOLDER=${DRILL_WEBVIEW_DIR}\n`);
  }
  if (state.stores.settingsSeed) {
    backup(state, globalSettingsPath());
    saveState();
  }
  for (const store of state.stores.appStores) {
    backup(state, appStorePath(store.file));
    saveState();
  }
  seedAppStores(state.stores);

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
    state.extraRoots = [...(state.extraRoots ?? []), remotePath(repoRoot), collaboratorPath(repoRoot)];
    saveState();
    git(["init", "--bare", "--initial-branch=main", remotePath(repoRoot)]);
    if (spec.remote.seedSave) seedSharedSave(repoRoot, spec.remote.seedSave);
    if (spec.remote.seedSave && spec.remote.origin === false) git(["remote", "remove", "origin"], repoRoot);
    state.remoteRefs = gitRefs(["--git-dir", remotePath(repoRoot)]);
    saveState();
    appendFileSync(envFile, `CUTREADY_REMOTE_URL=${pathToFileURL(remotePath(repoRoot)).href}\n`);
  }
  if (spec.hybrid?.checkout) git(["switch", "-C", spec.hybrid.checkout], repoRoot);
  // Files as written, before the app opens (and imports, e.g., legacy .chats) — `reset` restores them.
  rmSync(PRISTINE_DIR, { recursive: true, force: true });
  cpSync(repoRoot, PRISTINE_DIR, { recursive: true, filter: (src) => !isGitDir(repoRoot, src) });

  if (spec.scratch) {
    state.scratch = spec.scratch;
    state.extraRoots = [...(state.extraRoots ?? []), scratchPath(repoRoot)];
    saveState();
    writeScratch(state);
    appendFileSync(envFile, `CUTREADY_SCRATCH=${scratchPath(repoRoot)}\n`);
  }

  appendFileSync(envFile, `CUTREADY_PROJECT=${projectRoot}\nCUTREADY_REPO=${repoRoot}\n`);
  console.log(`Drill fixture ready at ${projectRoot}`);
}

function teardown() {
  if (!existsSync(STATE)) return;
  const state = JSON.parse(readFileSync(STATE, "utf8"));
  // Stop the mock first so a refused restore below can't leave it running.
  try {
    stopMockLlm(state);
  } catch (error) {
    console.error(`could not stop the mock model server: ${error.message}`);
  }
  // Restoring app stores (notably the credential vault) under a live app would let it overwrite them.
  ensureNoRunningCutReady();
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
  const root = state.repoRoot ?? state.projectRoot;
  for (const path of [root, ...(state.extraRoots ?? [])].filter(Boolean)) {
    if (!isTempFixturePath(path, state.prefix)) {
      failed = true;
      console.error(`REFUSED to remove ${path}: it is not a drill fixture under ${tmpdir()}`);
      continue;
    }
    rmSync(path, { recursive: true, force: true });
  }
  rmSync(PRISTINE_DIR, { recursive: true, force: true });
  rmSync(BASELINE_DRAFTLINE_DIR, { recursive: true, force: true });
  rmSync(DRILL_VAULT_DIR, { recursive: true, force: true });
  try {
    // WebView2 helper processes can outlive the app for a moment.
    eventually(() => rmSync(DRILL_WEBVIEW_DIR, { recursive: true, force: true }), 10000);
  } catch (error) {
    console.warn(`Could not remove the drill WebView profile: ${error.message}`);
  }
  if (failed) throw new Error(`restore failed; backups kept in ${BACKUP_DIR}`);
  rmSync(BACKUP_DIR, { recursive: true, force: true });
  rmSync(STATE, { force: true });
  console.log("Drill fixture removed and app stores restored.");
}

function appStorePath(file) {
  const path = resolve(appDataDir(), file);
  if (!path.startsWith(resolve(appDataDir()) + sep)) throw new Error(`app store ${file} is outside the app data folder`);
  return path;
}

function seedAppStores({ settingsSeed, appStores }) {
  if (settingsSeed) {
    const path = globalSettingsPath();
    let store = {};
    try {
      store = existsSync(path) ? JSON.parse(readFileSync(path, "utf8")) : {};
    } catch {
      store = {};
    }
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, `${JSON.stringify({ ...store, ...settingsSeed }, null, 2)}\n`);
  }
  for (const store of appStores) {
    const path = appStorePath(store.file);
    if (store.clear) rmSync(path, { recursive: true, force: true });
    if (store.json !== undefined) {
      mkdirSync(dirname(path), { recursive: true });
      writeFileSync(path, `${JSON.stringify(store.json, null, 2)}\n`);
    }
  }
}

// Restores the history the app made when it first opened the project (recorded by the
// first reset, in the first test's beforeEach) plus the files setup wrote.
function reset() {
  if (!existsSync(STATE)) throw new Error("reset needs a fixture from `setup`");
  const state = JSON.parse(readFileSync(STATE, "utf8"));
  if (resolve(fixtureRoot()) !== resolve(state.projectRoot)) throw new Error(`CUTREADY_PROJECT ${fixtureRoot()} is not the fixture project`);
  const root = state.repoRoot ?? state.projectRoot;
  const gitDir = join(root, ".git");

  if (!state.baseline) {
    // The app creates the project's repo (without a first save) when it opens it.
    eventually(() => {
      if (!existsSync(join(gitDir, "HEAD"))) throw new Error("the app has not opened the project yet");
    }, 20000);
    if (resolve(root, git(["rev-parse", "--git-dir"], root).trim()) !== resolve(gitDir)) {
      throw new Error("reset only supports a project (or hybrid project's repo) that owns its .git");
    }
    const head = spawnSync("git", ["rev-parse", "--verify", "--quiet", "HEAD"], { cwd: root, encoding: "utf8", windowsHide: true });
    state.baseline = {
      head: head.status === 0 ? head.stdout.trim() : null,
      branch: git(["symbolic-ref", "--short", "HEAD"], root).trim(),
      remotes: git(["remote"], root).split("\n").filter(Boolean),
      refs: gitRefs([], root),
      // Which workspace and project the app last had open (`last_active_project`) lives here.
      recents: existsSync(recentProjectsPath()) ? readFileSync(recentProjectsPath(), "utf8") : null,
    };
    // Draftline's own state (recovery records, locks, pending saves) sits beside the refs.
    rmSync(BASELINE_DRAFTLINE_DIR, { recursive: true, force: true });
    if (existsSync(join(gitDir, "draftline"))) cpSync(join(gitDir, "draftline"), BASELINE_DRAFTLINE_DIR, { recursive: true });
    writeFileSync(STATE, `${JSON.stringify(state, null, 2)}\n`);
  }

  const { head, branch, remotes } = state.baseline;
  const baselineRefs = state.baseline.refs ?? {};
  const branchRef = `refs/heads/${branch}`;
  git(["symbolic-ref", "HEAD", branchRef], root);
  for (const ref of git(["for-each-ref", "--format=%(refname)"], root).split("\n").filter(Boolean)) {
    if (ref !== branchRef && !(ref in baselineRefs)) git(["update-ref", "-d", ref], root);
  }
  for (const [ref, sha] of Object.entries(baselineRefs)) {
    if (ref !== branchRef) git(["update-ref", ref, sha], root);
  }
  if (head) {
    git(["update-ref", branchRef, head], root);
    git(["reset", "--hard", head], root);
  } else {
    // No saves yet: an unborn branch with an empty index.
    git(["update-ref", "-d", branchRef], root);
    rmSync(join(gitDir, "index"), { force: true });
  }
  git(["clean", "-ffdx"], root);
  for (const remote of git(["remote"], root).split("\n").filter(Boolean)) {
    if (!remotes.includes(remote)) git(["remote", "remove", remote], root);
  }
  cpSync(PRISTINE_DIR, root, { recursive: true });
  eventually(() => rmSync(join(gitDir, "draftline"), { recursive: true, force: true }), 10000);
  if (existsSync(BASELINE_DRAFTLINE_DIR)) cpSync(BASELINE_DRAFTLINE_DIR, join(gitDir, "draftline"), { recursive: true });
  if (state.baseline.recents !== null && state.baseline.recents !== undefined) {
    writeFileSync(recentProjectsPath(), state.baseline.recents);
  }
  if (state.remoteRefs) resetRemote(root, state.remoteRefs);

  // Agent state lives in .git/cutready (.git/cutready/<folder> for a hybrid project); the app
  // opens it per call and re-imports the project's legacy .chats when it recreates it.
  const stateDir = agentStateDir(root, state.projectRoot);
  for (const name of existsSync(stateDir) ? readdirSync(stateDir) : []) {
    if (/^(agent-state\.db(-wal|-shm|-journal)?|memory\.json)$/.test(name)) {
      eventually(() => rmSync(join(stateDir, name), { force: true }), 10000);
    }
  }
  seedAppStores(state.stores);
  writeScratch(state);
  console.log(`Fixture reset to ${head ? head.slice(0, 7) : "no saves"} on ${branch}`);
}

function isGitDir(root, path) {
  const rel = path.slice(resolve(root).length + 1);
  return rel === ".git" || rel.startsWith(`.git${sep}`);
}

function fixtureRoot() {
  const root = process.env.CUTREADY_PROJECT;
  if (!root) throw new Error("CUTREADY_PROJECT is unset; run this as an `auditaur drill test` step");
  return root;
}

// The git repo the fixture owns: the project, or a hybrid project's enclosing code repo.
function repoRoot() {
  if (!existsSync(STATE)) return fixtureRoot();
  const state = JSON.parse(readFileSync(STATE, "utf8"));
  return state.repoRoot ?? state.projectRoot;
}

// A standalone project keeps agent state in .git/cutready; a hybrid one in .git/cutready/<folder>.
function agentStateDir(repo, project) {
  return join(repo, ".git", "cutready", relative(repo, project));
}

// Resolves a fixture-controlled relative path, refusing anything that escapes `root`.
function childPath(root, path) {
  const base = resolve(root);
  const child = resolve(base, path);
  const rel = relative(base, child);
  if (!rel || rel === ".." || rel.startsWith(`..${sep}`) || resolve(rel) === rel) {
    throw new Error(`fixture path ${JSON.stringify(path)} must stay inside ${base}`);
  }
  return child;
}

// Teardown only deletes what setup created: a prefixed directory (or its sibling) in tmpdir.
function isTempFixturePath(path, prefix = "cutready-drill-") {
  const rel = relative(resolve(tmpdir()), resolve(path));
  return Boolean(rel) && !rel.startsWith("..") && !rel.includes(sep) && rel.startsWith(prefix);
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
    } else if (expectation === "zip") {
      // .docx, .pptx and .zip exports are zip containers.
      if (readFileSync(path).subarray(0, 4).toString("binary") !== "PK\x03\x04") throw new Error(`expected ${file} to be a zip file`);
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
  const dbPath = join(agentStateDir(repoRoot(), fixtureRoot()), "agent-state.db");
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

// Spawns the mock detached (it outlives this hook) and waits for it to report its port.
// Any failure after spawning stops this child before rethrowing.
function startMockLlm(saveState, state) {
  const dir = join(DRILL_DIR, "mock-llm");
  rmSync(dir, { recursive: true, force: true });
  mkdirSync(dir, { recursive: true });
  const portFile = join(dir, "port");
  const log = join(dir, "requests.jsonl");
  writeFileSync(log, "");
  const token = randomBytes(16).toString("hex");
  const child = spawn(process.execPath, [resolve("scripts", "auditaur-mock-llm.mjs"), "--port-file", portFile, "--log", log, "--token", token], {
    detached: true,
    stdio: "ignore",
    windowsHide: true,
  });
  child.on("error", () => {});
  child.unref();
  if (!child.pid) throw new Error("could not spawn the mock model server");
  try {
    state.mockLlm = { pid: child.pid, log, portFile, token };
    saveState();
    eventually(() => {
      if (!existsSync(portFile) || !readFileSync(portFile, "utf8").trim()) throw new Error("the mock model server did not start");
    }, 10000);
    state.mockLlm.url = `http://127.0.0.1:${readFileSync(portFile, "utf8").trim()}`;
    return state.mockLlm;
  } catch (error) {
    try {
      child.kill();
    } catch {
      // Already gone.
    }
    delete state.mockLlm;
    throw error;
  }
}

// Asks the mock to exit via its token-guarded endpoint, then kills the pid only if it is
// still this mock: after the mock's own lifetime expires, Windows may reuse the pid.
function stopMockLlm(state) {
  const mock = state.mockLlm;
  if (!mock?.pid) return;
  if (mock.url && mock.token) {
    spawnSync(
      process.execPath,
      ["-e", `fetch(process.argv[1] + "/__drill/shutdown", { method: "POST", headers: { "x-drill-token": process.argv[2] }, signal: AbortSignal.timeout(3000) }).catch(() => {})`, mock.url, mock.token],
      { stdio: "ignore", windowsHide: true, timeout: 5000 },
    );
  }
  if (!isMockProcess(mock)) return;
  try {
    process.kill(mock.pid);
  } catch {
    // Exited meanwhile.
  }
}

function isMockProcess({ pid, portFile }) {
  const result =
    process.platform === "win32"
      ? spawnSync("powershell.exe", ["-NoProfile", "-NonInteractive", "-Command", `(Get-CimInstance Win32_Process -Filter "ProcessId=${Number(pid)}").CommandLine`], { encoding: "utf8", windowsHide: true })
      : spawnSync("ps", ["-o", "command=", "-p", String(Number(pid))], { encoding: "utf8" });
  const commandLine = result.stdout ?? "";
  return commandLine.includes("auditaur-mock-llm.mjs") && (!portFile || commandLine.includes(portFile));
}

function mockProviderSettings(url) {
  const MOCK_PROVIDER_ID = "drill-mock-openai";
  const provider = {
    id: MOCK_PROVIDER_ID,
    name: "Drill mock (OpenAI)",
    provider: "openai",
    authMode: "api_key",
    endpoint: url,
    model: "drill-mock",
    contextLength: 128000,
    modelSupportsVision: "false",
    tenantId: "",
    clientId: "",
    subscriptionId: "",
    resourceGroup: "",
    resourceName: "",
  };
  return {
    aiProviders: [provider],
    aiActiveProviderId: MOCK_PROVIDER_ID,
    aiDefaultProviderId: MOCK_PROVIDER_ID,
    aiProvider: "openai",
    aiEndpoint: url,
    aiModel: "drill-mock",
    aiAuthMode: "api_key",
  };
}

function expectMockLlm(expression) {
  const log = process.env.CUTREADY_MOCK_LLM_LOG;
  if (!log) throw new Error("CUTREADY_MOCK_LLM_LOG is unset; the fixture needs `mockLlm: true`");
  const matches = new Function("e", `return (${expression});`);
  eventually(() => {
    const entries = readFileSync(log, "utf8").split("\n").filter(Boolean).map((line) => JSON.parse(line));
    if (!entries.some((entry) => matches(entry))) {
      throw new Error(`no mock request matched ${expression}; saw ${JSON.stringify(entries.map(({ at, ...entry }) => entry)).slice(0, 1500)}`);
    }
  });
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
  for (const note of spec.notes ?? []) writeFileSync(childPath(root, note.path), note.body ?? "");
  for (const file of spec.files ?? []) {
    mkdirSync(dirname(childPath(root, file.path)), { recursive: true });
    const content = file.json
      ? `${JSON.stringify(file.json, null, 2)}\n`
      : file.base64 ? Buffer.from(file.base64, "base64") : file.body ?? "";
    writeFileSync(join(root, file.path), content);
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

function scratchPath(projectRoot) {
  return `${projectRoot}-scratch`;
}

function writeScratch(state) {
  if (!state.scratch) return;
  const root = scratchPath(state.repoRoot ?? state.projectRoot);
  rmSync(root, { recursive: true, force: true });
  mkdirSync(root, { recursive: true });
  writeProject(root, state.scratch);
}

function writeSketch(path, sketch) {
  mkdirSync(dirname(path), { recursive: true });
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

function authorEnv(who) {
  return { GIT_AUTHOR_NAME: who.name, GIT_AUTHOR_EMAIL: who.email, GIT_COMMITTER_NAME: who.name, GIT_COMMITTER_EMAIL: who.email };
}

function seedHistory(root, steps, projectRoot = root) {
  git(["init", "--initial-branch=main"], root);
  // Seeded files are checked out byte-for-byte, so a reset never shows them as edited.
  git(["config", "core.autocrlf", "false"], root);
  for (const step of steps) {
    if (step.branch) {
      git(["branch", step.branch], root);
      continue;
    }
    writeProject(projectRoot, step);
    git(["add", "-A"], root);
    git(["commit", "-m", step.save], root, authorEnv(SEEDER));
  }
}

// The project's first save, already shared: a repo with the seeded files on main, pushed to the remote.
function seedSharedSave(root, message) {
  git(["init", "--initial-branch=main"], root);
  // Seeded files are checked out byte-for-byte, so a reset never shows them as edited.
  git(["config", "core.autocrlf", "false"], root);
  git(["add", "-A"], root);
  git(["commit", "-m", message], root, authorEnv(SEEDER));
  git(["remote", "add", "origin", remotePath(root)], root);
  git(["push", "origin", "main"], root);
  git(["fetch", "origin"], root);
}

function gitRefs(prefixArgs, cwd) {
  const refs = {};
  for (const line of git([...prefixArgs, "for-each-ref", "--format=%(objectname) %(refname)"], cwd).split("\n").filter(Boolean)) {
    const [sha, ref] = line.split(" ");
    refs[ref] = sha;
  }
  return refs;
}

// Puts the shared remote back to its seeded refs and drops the collaborator's clone.
function resetRemote(root, refs) {
  const gitDirArgs = ["--git-dir", remotePath(root)];
  for (const ref of Object.keys(gitRefs(gitDirArgs))) {
    if (!(ref in refs)) git([...gitDirArgs, "update-ref", "-d", ref]);
  }
  for (const [ref, sha] of Object.entries(refs)) git([...gitDirArgs, "update-ref", ref, sha]);
  eventually(() => rmSync(collaboratorPath(root), { recursive: true, force: true }), 10000);
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
  const root = repoRoot();
  if (!existsSync(remotePath(root))) throw new Error("connect-remote needs a fixture spec with `remote: true`");
  if (!existsSync(join(root, ".git"))) throw new Error("the project has no .git yet; open it in the app first");
  git(["remote", "add", "origin", remotePath(root)], root);
}

// A second contributor saving and sending from their own clone, to main or to a new branch from main.
function collaboratorSave(file, text, message, branch) {
  if (!file || text === undefined || !message || branch === "") {
    throw new Error("collaborator-save needs <file> <text> <message>; collaborator-branch needs <branch> <file> <text> <message>");
  }
  const root = repoRoot();
  const clone = collaboratorPath(root);
  if (existsSync(clone)) {
    git(["checkout", "main"], clone);
    git(["pull", "--ff-only", "origin", "main"], clone);
  } else git(["clone", "--branch", "main", remotePath(root), clone]);
  if (branch) git(["checkout", "-B", branch], clone);
  const path = resolve(clone, file);
  if (!path.startsWith(resolve(clone) + sep)) throw new Error(`collaborator-save target ${file} is outside the clone`);
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, text);
  git(["add", "--", file], clone);
  // The drill env sets GIT_AUTHOR_* for the app, which would override -c user.name here.
  git(["commit", "-m", message], clone, authorEnv(COLLABORATOR));
  git(["push", "origin", `HEAD:refs/heads/${branch ?? "main"}`], clone);
}

function expectRemote(message) {
  if (!message) throw new Error("expect-remote needs <message>");
  // Send finishes in the background after the button settles, so retry briefly.
  eventually(() => {
    const log = git(["--git-dir", remotePath(repoRoot()), "log", "--format=%s", "main"]);
    if (!log.split("\n").includes(message)) {
      throw new Error(`main on the remote has no save named ${JSON.stringify(message)}; it has:\n${log.trim()}`);
    }
  }, 30000);
}

// Fixture-relative path, `app-data:<file>` for CutReady's app data folder, or `scratch:<file>`.
function resolveExpectPath(file) {
  if (file.startsWith("app-data:")) return join(appDataDir(), file.slice(9));
  if (file.startsWith("drill-vault:")) return join(DRILL_VAULT_DIR, file.slice(12));
  if (file.startsWith("scratch:")) return join(scratchPath(repoRoot()), file.slice(8));
  if (file.startsWith("repo:")) return join(repoRoot(), file.slice(5));
  return join(fixtureRoot(), file);
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

// Current builds keep the vault in the app data folder (engine/secret_vault.rs); older builds put it beside it.
function vaultPaths() {
  return [join(appDataDir(), "vault.hold"), join(appDataDir(), "vault.hold.bak"), `${appDataDir()}vault.hold`];
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
