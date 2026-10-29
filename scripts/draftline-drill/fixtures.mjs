// Real-git fixtures for Draftline drills. Every fixture lives under a fresh
// temp root so drills never touch a user's repositories.
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { spawnSync } from "node:child_process";

const IDENTITY = ["-c", "user.name=Drill Dev", "-c", "user.email=drill@example.test"];

export function gitTry(dir, ...args) {
  const result = spawnSync("git", [...IDENTITY, ...args], { cwd: dir, encoding: "utf8", maxBuffer: 64 * 1024 * 1024 });
  return { ok: result.status === 0, out: (result.stdout ?? "").trim(), err: (result.stderr ?? "").trim() };
}

export function git(dir, ...args) {
  const result = gitTry(dir, ...args);
  if (!result.ok) throw new Error(`git ${args.join(" ")} (in ${dir}) failed: ${result.err || result.out}`);
  return result.out;
}

export function write(path, content) {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, content);
}

export function read(path) {
  return existsSync(path) ? readFileSync(path, "utf8") : null;
}

export function bytes(path) {
  return existsSync(path) ? readFileSync(path) : null;
}

export function sketch(title, narrative = `${title} narration`) {
  return `${JSON.stringify({
    title,
    description: "",
    rows: [{ time: "0:00", narrative, demo_actions: "Drill step.", screenshot: null }],
    state: "draft",
    created_at: "2026-01-01T00:00:00Z",
    updated_at: "2026-01-01T00:00:00Z",
  }, null, 2)}\n`;
}

export function png(tag, repeat = 2000) {
  return Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), Buffer.from(`${tag}-`.repeat(repeat))]);
}

export function isLfsPointer(buffer) {
  return Boolean(buffer) && buffer.toString("utf8", 0, 60).startsWith("version https://git-lfs.github.com/spec/v1");
}

function bareRemote(root, name, base) {
  const remote = join(root, name);
  git(root, "init", "--bare", "-q", "-b", base, remote);
  return remote;
}

/** A standalone CutReady project: its own repo plus a bare origin. */
export function standalone(root, { base = "main", withRemote = true, committed = true } = {}) {
  const folder = join(root, "demo");
  mkdirSync(folder, { recursive: true });
  write(join(folder, "intro.sk"), sketch("Intro"));
  write(join(folder, "planning.md"), "# Planning\n");
  if (!committed) return { root, folder };
  git(folder, "init", "-q", "-b", base);
  git(folder, "config", "core.autocrlf", "false");
  git(folder, "add", "-A");
  git(folder, "commit", "-qm", "Start demo");
  let remote = null;
  if (withRemote) {
    remote = bareRemote(root, "origin.git", base);
    git(folder, "remote", "add", "origin", remote);
    git(folder, "push", "-q", "-u", "origin", base);
  }
  return { root, folder, remote, base };
}

/** A developer's code repo with a `cutready/` folder, a bare origin, and a second developer clone. */
export function hybrid(root, { base = "main", folderName = "cutready", marker = null, remoteName = "remote.git" } = {}) {
  const repo = join(root, "code");
  mkdirSync(repo, { recursive: true });
  const remote = bareRemote(root, remoteName, base);
  git(repo, "init", "-q", "-b", base);
  git(repo, "config", "core.autocrlf", "false");
  write(join(repo, "src", "app.rs"), "fn main() {}\n");
  write(join(repo, "README.md"), "# Contoso\n");
  write(join(repo, folderName, "intro.sk"), sketch("Intro"));
  write(join(repo, folderName, "planning.md"), "# Planning\n");
  if (marker !== null) write(join(repo, ".draftline"), marker);
  git(repo, "add", "-A");
  git(repo, "commit", "-qm", "Init");
  git(repo, "remote", "add", "origin", remote);
  git(repo, "push", "-q", "-u", "origin", base);
  const dev = join(root, "dev");
  clone(remote, dev);
  return { root, repo, folder: join(repo, folderName), remote, dev, base, folderName };
}

/** Clone without line-ending conversion, so a developer commit only changes what it touched. */
export function clone(remote, dest) {
  git(dirname(dest), "clone", "-q", "-c", "core.autocrlf=false", remote, dest);
  return dest;
}

/** Route `*.png` through Git LFS in `repo` and share the attributes. */
export function enableLfs(repo) {
  git(repo, "lfs", "install", "--local");
  write(join(repo, ".gitattributes"), "*.png filter=lfs diff=lfs merge=lfs -text\n");
  git(repo, "add", ".gitattributes");
  git(repo, "commit", "-qm", "Track PNGs with LFS");
  const branch = git(repo, "branch", "--show-current");
  git(repo, "push", "-q", "origin", branch);
}

/** A developer commit pushed from the second clone. */
export function devCommit(fx, relPath, content, message = `Dev edits ${relPath}`, branch = fx.base) {
  git(fx.dev, "fetch", "-q", "origin");
  const start = gitTry(fx.dev, "rev-parse", "--verify", "-q", `origin/${branch}`).ok ? branch : fx.base;
  git(fx.dev, "checkout", "-q", "-B", branch, `origin/${start}`);
  write(join(fx.dev, relPath), content);
  git(fx.dev, "add", "-A");
  git(fx.dev, "commit", "-qm", message);
  git(fx.dev, "push", "-q", "origin", branch);
}

/** `git status --porcelain` minus the folder marker Draftline writes on open and commits with the first save. */
export function gitChanges(dir) {
  return git(dir, "status", "--porcelain").split("\n").filter((line) => line && line !== "?? .draftline");
}

export function remoteHasBranch(remote, branch) {
  return gitTry(remote, `--git-dir=${remote}`, "rev-parse", "--verify", "-q", `refs/heads/${branch}`).ok;
}

export function remoteFile(remote, branch, relPath) {
  const result = gitTry(remote, `--git-dir=${remote}`, "show", `${branch}:${relPath}`);
  return result.ok ? result.out : null;
}
