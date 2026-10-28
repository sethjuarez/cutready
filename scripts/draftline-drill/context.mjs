// The API scenarios use: drive the real app's store, read state, and record checks.
import { join } from "node:path";
import { delay } from "./app.mjs";

const json = (value) => JSON.stringify(value);

export class DrillContext {
  constructor({ app, root, log, options }) {
    this.app = app;
    this.root = root;
    this.log = log;
    this.options = options;
    this.checks = [];
    this.notes = [];
  }

  path(...parts) {
    return join(this.root, ...parts);
  }

  note(text) {
    this.notes.push(text);
    this.log(`    · ${text}`);
  }

  check(ok, label, detail) {
    this.checks.push({ ok: Boolean(ok), label, detail: ok ? undefined : detail });
    this.log(`    ${ok ? "✓" : "✗"} ${label}${ok || detail === undefined ? "" : ` — ${typeof detail === "string" ? detail : json(detail)}`}`);
    return Boolean(ok);
  }

  /** Assert and stop the scenario when a precondition fails. */
  require(ok, label, detail) {
    if (!this.check(ok, label, detail)) throw new Error(`precondition failed: ${label}`);
  }

  /** Call an appStore action exactly as the UI does. */
  async act(action, ...args) {
    const value = await this.app.eval(`(async () => {
      const store = window.__appStore.getState();
      try {
        const value = await store[${json(action)}](...${json(args)});
        return { ok: true, value: value === undefined ? null : JSON.parse(JSON.stringify(value)) };
      } catch (error) {
        return { ok: false, error: error instanceof Error ? { message: error.message } : JSON.parse(JSON.stringify(error ?? null)) };
      }
    })()`);
    await this.settle();
    return value;
  }

  /** Raw Tauri command, bypassing the store. */
  async invoke(command, args = {}) {
    return this.app.eval(`(async () => {
      try {
        const value = await window.__TAURI_INTERNALS__.invoke(${json(command)}, ${json(args)});
        return { ok: true, value: value === undefined ? null : value };
      } catch (error) {
        return { ok: false, error: typeof error === "string" ? { message: error } : error };
      }
    })()`);
  }

  async state(...keys) {
    return this.app.eval(`(() => {
      const s = window.__appStore.getState();
      const pick = ${json(keys)};
      const out = {};
      for (const k of pick) out[k] = s[k] === undefined ? null : JSON.parse(JSON.stringify(s[k]));
      return out;
    })()`);
  }

  /** Wait for in-flight loading/sync work the store started in the background. */
  async settle(timeoutMs = 120_000) {
    const started = Date.now();
    while (Date.now() - started < timeoutMs) {
      const busy = await this.app.eval(`(() => { const s = window.__appStore.getState(); return Boolean(s.loading || s.isSyncing || s.projectSwitching); })()`);
      if (!busy) return;
      await delay(250);
    }
    throw new Error("app stayed busy");
  }

  async open(path) {
    await this.toasts();
    await this.app.eval(`(async () => {
      window.__appStore.setState({ error: null, syncError: null });
      await window.__appStore.getState().openProject(${json(path)});
      return true;
    })()`);
    await this.settle();
    // openProject fires a background fetch; let it land before asserting.
    await delay(500);
    await this.settle();
    return this.state("currentProject", "error", "syncError", "isDirty", "timelines", "currentRemote", "baseStatus");
  }

  workspace(state) {
    return state.currentProject?.repo_root;
  }

  /** Toasts shown since the last call. */
  async toasts() {
    return this.app.eval(`(() => { const t = window.__drillToasts ?? []; window.__drillToasts = []; return t; })()`);
  }

  async refresh() {
    await this.act("checkDirty");
    await this.act("refreshChangedFiles");
    await this.act("loadTimelines");
    await this.act("loadVersions");
  }

  async activeTimeline() {
    const { timelines } = await this.state("timelines");
    return timelines?.find((t) => t.is_active)?.name ?? null;
  }

  async bodyText() {
    return this.app.eval(`document.body.innerText`);
  }

  /** Restart the app on `projectPath` (after a crash or to test reopen). */
  async relaunch(projectPath) {
    this.app.stop();
    await delay(1000);
    await this.app.launch(projectPath);
    await this.settle();
    return this.state("currentProject", "error", "syncError", "isDirty", "timelines");
  }
}
