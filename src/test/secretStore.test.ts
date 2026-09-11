import { beforeEach, describe, expect, it, vi } from "vitest";

// A controllable fake Stronghold client store. It tracks concurrency so we can
// assert that the subsystem never lets two vault operations overlap, and it can
// be told to fail the next read to simulate a transient vault error.
const fakeStore = {
  data: new Map<string, number[]>(),
  failNextGet: false,
  active: 0,
  maxActive: 0,
  async _enter() {
    this.active += 1;
    if (this.active > this.maxActive) this.maxActive = this.active;
    // Yield a microtask so overlapping callers would be observable if the
    // subsystem failed to serialize.
    await Promise.resolve();
  },
  _leave() {
    this.active -= 1;
  },
  async get(key: string) {
    await this._enter();
    try {
      if (this.failNextGet) {
        this.failNextGet = false;
        throw new Error("vault busy");
      }
      return this.data.get(key) ?? null;
    } finally {
      this._leave();
    }
  },
  async insert(key: string, value: number[]) {
    await this._enter();
    try {
      this.data.set(key, value);
    } finally {
      this._leave();
    }
  },
  async remove(key: string) {
    await this._enter();
    try {
      this.data.delete(key);
    } finally {
      this._leave();
    }
  },
};

const fakeStronghold = {
  async loadClient() {
    return { getStore: () => fakeStore };
  },
  async createClient() {
    return { getStore: () => fakeStore };
  },
  async save() {
    await fakeStore._enter();
    fakeStore._leave();
  },
};

vi.mock("@tauri-apps/plugin-stronghold", () => ({
  Stronghold: { load: vi.fn(async () => fakeStronghold) },
}));
vi.mock("@tauri-apps/api/path", () => ({ appDataDir: vi.fn(async () => "/tmp/") }));

async function importSecretStore() {
  // isTauri is captured at module load, so the flag must be set before import.
  (globalThis as unknown as { window: unknown }).window = globalThis;
  (globalThis as unknown as { __TAURI_INTERNALS__: unknown }).__TAURI_INTERNALS__ = {};
  vi.resetModules();
  return import("../hooks/useSecretStore");
}

describe("useSecretStore hardening", () => {
  beforeEach(() => {
    fakeStore.data.clear();
    fakeStore.failNextGet = false;
    fakeStore.active = 0;
    fakeStore.maxActive = 0;
  });

  it("returns last-known-good on a transient read failure instead of empty", async () => {
    const mod = await importSecretStore();
    await mod.setSecret("aiApiKey", "sk-good");
    expect(await mod.getSecret("aiApiKey")).toBe("sk-good"); // prime the cache

    fakeStore.failNextGet = true;
    // A transient failure must not blank a configured secret.
    expect(await mod.getSecret("aiApiKey")).toBe("sk-good");
  });

  it("still reports a genuinely empty secret as empty", async () => {
    const mod = await importSecretStore();
    expect(await mod.getSecret("aiAccessToken")).toBe("");
  });

  it("serializes concurrent vault operations (never overlaps)", async () => {
    const mod = await importSecretStore();
    await Promise.all([
      mod.setSecret("aiApiKey", "a"),
      mod.setSecret("aiAccessToken", "b"),
      mod.setSecret("aiRefreshToken", "c"),
      mod.getSecret("aiApiKey"),
      mod.getSecret("aiAccessToken"),
    ]);

    expect(fakeStore.maxActive).toBe(1);
    expect(await mod.getSecret("aiRefreshToken")).toBe("c");
  });

  it("preserves the written value even if the subsequent read fails", async () => {
    const mod = await importSecretStore();
    await mod.setSecret("aiApiKey", "written");
    fakeStore.failNextGet = true;
    expect(await mod.getSecret("aiApiKey")).toBe("written");
  });

  it("retries once so a single transient read hiccup still returns the value", async () => {
    const mod = await importSecretStore();
    // Write directly into the vault without priming the cache via a read.
    fakeStore.data.set("aiApiKey", Array.from(new TextEncoder().encode("vault-only")));
    fakeStore.failNextGet = true; // first attempt throws, retry succeeds
    expect(await mod.getSecret("aiApiKey")).toBe("vault-only");
  });

  it("propagates a failed remove instead of reporting false success", async () => {
    const mod = await importSecretStore();
    await mod.setSecret("aiApiKey", "keep");
    const originalRemove = fakeStore.remove.bind(fakeStore);
    fakeStore.remove = async () => {
      throw new Error("vault busy");
    };
    await expect(mod.removeSecret("aiApiKey")).rejects.toThrow();
    fakeStore.remove = originalRemove;
    // The cache must not have been cleared by the failed remove.
    expect(await mod.getSecret("aiApiKey")).toBe("keep");
  });
});
