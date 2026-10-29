// Owns one CutReady debug app under Auditaur observation and talks to it
// through the Tauri-native drive bridge.
import { readFileSync, rmSync } from "node:fs";
import { spawn, spawnSync } from "node:child_process";

const APP = "cutready";
const APP_COMMAND = process.platform === "win32" ? ["cmd", "/c", "npm run debug"] : ["npm", "run", "debug"];

export class AppSession {
  constructor({ sessionFile, timeoutSeconds = 900, log = console.log }) {
    this.sessionFile = sessionFile;
    this.timeoutSeconds = timeoutSeconds;
    this.log = log;
    this.sessionId = null;
    this.pid = null;
    this.processPid = null;
    this.attached = false;
  }

  /** Reuse a session started elsewhere (fast iteration; crash scenarios are skipped). */
  async attach(sessionFile) {
    const session = JSON.parse(readFileSync(sessionFile, "utf8"));
    this.sessionId = session.app?.sessionId ?? session.sessionId;
    this.pid = session.app?.pid ?? session.pid;
    this.attached = true;
    if (!this.sessionId) throw new Error(`No sessionId in ${sessionFile}`);
    await this.installProbes();
  }

  async launch(projectPath) {
    rmSync(this.sessionFile, { force: true });
    this.log(`  launching CutReady on ${projectPath}`);
    const started = Date.now();
    const launcher = spawn("auditaur", [
      "debug", "--app", APP, "--json", "run",
      "--require-frontend", "--require-drive-bridge",
      "--timeout-seconds", String(this.timeoutSeconds),
      "--write-session", this.sessionFile,
      "--", ...APP_COMMAND,
    ], {
      env: { ...process.env, CUTREADY_PROJECT: projectPath },
      shell: false,
      stdio: ["ignore", "pipe", "pipe"],
    });
    this.launcherPid = launcher.pid;
    let ready;
    try {
      ready = await waitForReady(launcher, this.timeoutSeconds);
    } catch (err) {
      killTrees([launcher.pid]);
      this.launcherPid = null;
      throw err;
    }
    this.sessionId = ready.sessionId;
    this.pid = ready.pid;
    this.processPid = ready.processPid;
    this.log(`  ready in ${Math.round((Date.now() - started) / 1000)}s (session ${this.sessionId}, pid ${this.pid})`);
    await this.installProbes();
  }

  async installProbes() {
    // Wait for the dev-only store hooks, then record every toast (they expire in seconds).
    for (let i = 0; i < 60; i += 1) {
      const ok = await this.eval(`Boolean(window.__appStore && window.__toastStore)`);
      if (ok) break;
      await delay(500);
    }
    await this.eval(`(() => {
      if (window.__drillToasts) return true;
      window.__drillToasts = [];
      window.__toastStore.subscribe((s, p) => {
        for (const t of s.toasts) {
          if (!p.toasts.some((x) => x.id === t.id)) window.__drillToasts.push({ message: t.message, type: t.type });
        }
      });
      return true;
    })()`);
  }

  /** Evaluate JavaScript in the WebView; the bridge awaits promises. */
  async eval(expression, { timeoutMs = 600_000 } = {}) {
    const result = spawnSync("auditaur", [
      "drive", "--app", APP, "--session-id", this.sessionId, "--json",
      "evaluate", "--target", "auditaur-bridge", "--expression", expression,
    ], { encoding: "utf8", shell: false, timeout: timeoutMs, maxBuffer: 64 * 1024 * 1024 });
    if (result.error) throw new Error(`drive evaluate failed: ${result.error}`);
    let json;
    try {
      json = JSON.parse(result.stdout);
    } catch {
      throw new Error(`drive evaluate returned non-JSON (exit ${result.status}): ${(result.stderr || result.stdout).slice(0, 2000)}`);
    }
    if (!json.ok || !json.payload?.ok) {
      throw new Error(`drive evaluate error: ${JSON.stringify(json.payload ?? json).slice(0, 2000)}`);
    }
    return json.payload.value;
  }

  /** Start an expression without waiting for it (used to crash mid-operation). */
  fire(expression) {
    return spawn("auditaur", [
      "drive", "--app", APP, "--session-id", this.sessionId, "--json",
      "evaluate", "--target", "auditaur-bridge", "--expression", expression,
    ], { stdio: "ignore", shell: false });
  }

  /** Simulate a crash: hard-kill only the app process, as a power loss would. */
  crash() {
    this.log(`  crashing app pid ${this.pid}`);
    if (process.platform === "win32") {
      spawnSync("taskkill", ["/PID", String(this.pid), "/F"], { stdio: "ignore" });
    } else {
      try { process.kill(Number(this.pid), "SIGKILL"); } catch { /* gone */ }
    }
  }

  stop() {
    if (this.attached) return;
    if (this.sessionId) {
      spawnSync("auditaur", ["stop", "--session-file", this.sessionFile, "--json"], { stdio: "ignore", shell: false });
    }
    killTrees([this.processPid, this.pid, this.launcherPid]);
    this.sessionId = null;
    this.processPid = null;
    this.pid = null;
    this.launcherPid = null;
  }

  errorsSince(sinceIso) {
    const result = spawnSync("auditaur", ["errors", "--session", this.sessionId, "--json"], { encoding: "utf8" });
    try {
      const parsed = JSON.parse(result.stdout);
      const items = Array.isArray(parsed) ? parsed : parsed.items ?? parsed.errors ?? parsed.records ?? [];
      return items.filter((item) => !sinceIso || String(item.timestamp ?? item.time ?? "") >= sinceIso);
    } catch {
      return [];
    }
  }
}

export function killTrees(pids) {
  for (const pid of pids.filter((p) => Number.isFinite(Number(p)) && Number(p) > 0)) {
    if (process.platform === "win32") {
      spawnSync("taskkill", ["/PID", String(pid), "/T", "/F"], { stdio: "ignore" });
    } else {
      try { process.kill(Number(pid), "SIGKILL"); } catch { /* gone */ }
    }
  }
}

export function pidAlive(pid) {
  if (!Number.isFinite(Number(pid))) return false;
  try { process.kill(Number(pid), 0); return true; } catch { return false; }
}

export function activeCutReadySession() {
  const result = spawnSync("auditaur", ["debug", "--app", APP, "--active", "--json", "status"], { encoding: "utf8" });
  try {
    const app = JSON.parse(result.stdout)?.app;
    if (app?.status === "active" && Number(app.heartbeatAgeSeconds ?? 999) < 30 && pidAlive(app.pid)) return app;
  } catch { /* none */ }
  return null;
}

export function delay(ms) {
  return new Promise((resolveDelay) => setTimeout(resolveDelay, ms));
}

function waitForReady(launcher, timeoutSeconds) {
  let pending = "";
  let output = "";
  return new Promise((resolveReady, rejectReady) => {
    let settled = false;
    const finish = (fn, value) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      fn(value);
    };
    const timer = setTimeout(
      () => finish(rejectReady, new Error(`CutReady was not Auditaur-ready within ${timeoutSeconds}s`)),
      timeoutSeconds * 1000 + 15_000,
    );
    launcher.stdout.on("data", (chunk) => {
      const text = chunk.toString();
      output += text;
      pending += text;
      const lines = pending.split(/\r?\n/);
      pending = lines.pop() ?? "";
      for (const line of lines) {
        let parsed = null;
        try { parsed = JSON.parse(line.trim()); } catch { /* not JSON */ }
        if (parsed?.status?.ready && parsed?.app?.sessionId) {
          finish(resolveReady, { sessionId: parsed.app.sessionId, pid: parsed.app.pid, processPid: parsed.process?.pid });
        }
      }
    });
    launcher.stderr.on("data", (chunk) => { output += chunk.toString(); });
    launcher.on("error", (error) => finish(rejectReady, error));
    launcher.on("close", (code) => finish(rejectReady, new Error(`auditaur exited ${code} before ready:\n${output.slice(-3000)}`)));
  });
}
