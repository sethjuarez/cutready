import { beforeEach, describe, expect, it, vi } from "vitest";

// Controllable secret layer: loadAllSecrets / getProviderSecret can be told to
// return blanks (simulating a transient vault miss) while we assert the loader
// never blanks a good in-memory value, and we count loads to prove single-flight.
let loadAllSecretsCalls = 0;
let secretsToReturn = { aiApiKey: "", aiAccessToken: "", aiRefreshToken: "" };
let providerSecretValue = "";
let lazyStoreConstructions = 0;

vi.mock("../hooks/useSecretStore", async () => {
  const actual = await vi.importActual<typeof import("../hooks/useSecretStore")>(
    "../hooks/useSecretStore",
  );
  return {
    ...actual,
    loadAllSecrets: vi.fn(async () => {
      loadAllSecretsCalls += 1;
      await Promise.resolve();
      return { ...secretsToReturn };
    }),
    getProviderSecret: vi.fn(async () => providerSecretValue),
    setProviderSecret: vi.fn(async () => {}),
    setSecret: vi.fn(async () => {}),
  };
});

vi.mock("@tauri-apps/plugin-store", () => ({
  LazyStore: class {
    constructor() {
      lazyStoreConstructions += 1;
    }
    async get() {
      return null;
    }
    async set() {}
    async save() {}
  },
}));

vi.mock("../services/tauri", () => ({ invoke: vi.fn(async () => ({})) }));

import { useSettingsStore } from "../hooks/useSettings";

describe("settings load coordinator", () => {
  beforeEach(() => {
    loadAllSecretsCalls = 0;
    lazyStoreConstructions = 0;
    secretsToReturn = { aiApiKey: "", aiAccessToken: "", aiRefreshToken: "" };
    providerSecretValue = "";
    useSettingsStore.setState({ loaded: false });
  });

  it("runs exactly one load when many consumers mount at once", async () => {
    await Promise.all([
      useSettingsStore.getState()._loadSettings(),
      useSettingsStore.getState()._loadSettings(),
      useSettingsStore.getState()._loadSettings(),
    ]);
    expect(loadAllSecretsCalls).toBe(1);
    expect(lazyStoreConstructions).toBe(1);
  });

  it("does not blank a good in-memory secret when the vault reads empty", async () => {
    const current = useSettingsStore.getState().settings;
    useSettingsStore.setState({
      loaded: false,
      settings: { ...current, aiAccessToken: "live-token" },
    });
    // Vault returns nothing for the tokens (transient miss / empty vault).
    secretsToReturn = { aiApiKey: "", aiAccessToken: "", aiRefreshToken: "" };
    providerSecretValue = "";

    await useSettingsStore.getState()._loadSettings();

    expect(useSettingsStore.getState().settings.aiAccessToken).toBe("live-token");
  });

  it("adopts a real vault value over the in-memory one", async () => {
    const current = useSettingsStore.getState().settings;
    useSettingsStore.setState({
      loaded: false,
      settings: { ...current, aiApiKey: "stale" },
    });
    providerSecretValue = "fresh-from-vault";

    await useSettingsStore.getState()._loadSettings();

    expect(useSettingsStore.getState().settings.aiApiKey).toBe("fresh-from-vault");
  });
});
