import { beforeEach, describe, expect, it, vi } from "vitest";
import tokenResponseJson from "./fixtures/oauth-token-response.json?raw";

// Controllable secret layer: loadAllSecrets / getProviderSecret can be told to
// return blanks (simulating a transient vault miss) while we assert the loader
// never blanks a good in-memory value, and we count loads to prove single-flight.
let loadAllSecretsCalls = 0;
let secretsToReturn = { aiApiKey: "", aiAccessToken: "", aiRefreshToken: "" };
let providerSecretValue = "";
let lazyStoreConstructions = 0;
let storedSettings: Record<string, unknown> = {};

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
    async get(key: string) {
      return storedSettings[key] ?? null;
    }
    async set() {}
    async save() {}
  },
}));

vi.mock("../services/tauri", () => ({ invoke: vi.fn(async () => ({})) }));

import { useSettingsStore } from "../hooks/useSettings";
import { setProviderSecret } from "../hooks/useSecretStore";
import { invoke } from "../services/tauri";

describe("settings load coordinator", () => {
  beforeEach(() => {
    loadAllSecretsCalls = 0;
    lazyStoreConstructions = 0;
    secretsToReturn = { aiApiKey: "", aiAccessToken: "", aiRefreshToken: "" };
    providerSecretValue = "";
    storedSettings = {};
    vi.mocked(invoke).mockReset().mockResolvedValue({});
    vi.mocked(setProviderSecret).mockClear();
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

  it("persists the canonical OAuth refresh response at startup", async () => {
    storedSettings = { aiProvider: "microsoft_foundry", aiAuthMode: "azure_oauth" };
    providerSecretValue = "expired-cached-token";
    const response = JSON.parse(tokenResponseJson);
    vi.mocked(invoke).mockResolvedValue(response);

    await useSettingsStore.getState()._loadSettings();

    const { settings, oauthRefreshPending } = useSettingsStore.getState();
    expect(invoke).toHaveBeenCalledWith("azure_token_refresh", expect.objectContaining({
      refreshToken: "expired-cached-token",
    }));
    expect(settings.aiAccessToken).toBe(response.accessToken);
    expect(settings.aiRefreshToken).toBe(response.refreshToken);
    expect(setProviderSecret).toHaveBeenCalledWith(settings.aiActiveProviderId, "accessToken", response.accessToken);
    expect(setProviderSecret).toHaveBeenCalledWith(settings.aiActiveProviderId, "refreshToken", response.refreshToken);
    expect(oauthRefreshPending).toBe(false);
  });

  it("keeps startup refresh tokens with their connection after an active-connection switch", async () => {
    storedSettings = { aiProvider: "microsoft_foundry", aiAuthMode: "azure_oauth" };
    providerSecretValue = "expired-cached-token";
    const response = JSON.parse(tokenResponseJson);
    let finishRefresh: (value: unknown) => void = () => {};
    const refresh = new Promise((resolve) => { finishRefresh = resolve; });
    let signalStarted: () => void = () => {};
    const started = new Promise<void>((resolve) => { signalStarted = resolve; });
    vi.mocked(invoke).mockImplementation(async () => {
      signalStarted();
      return refresh;
    });

    const loading = useSettingsStore.getState()._loadSettings();
    await started;
    const originalProviderId = useSettingsStore.getState().settings.aiActiveProviderId;
    useSettingsStore.setState((state) => ({
      settings: {
        ...state.settings,
        aiActiveProviderId: "connection-b",
        aiAccessToken: "access-b",
        aiRefreshToken: "refresh-b",
      },
    }));
    finishRefresh(response);
    await loading;

    const { settings } = useSettingsStore.getState();
    expect(settings.aiAccessToken).toBe("access-b");
    expect(settings.aiRefreshToken).toBe("refresh-b");
    expect(setProviderSecret).toHaveBeenCalledWith(originalProviderId, "accessToken", response.accessToken);
    expect(setProviderSecret).toHaveBeenCalledWith(originalProviderId, "refreshToken", response.refreshToken);
    expect(setProviderSecret).not.toHaveBeenCalledWith("connection-b", "accessToken", response.accessToken);
  });
});
