import { describe, it, expect, vi, beforeEach } from "vitest";
import type { AgentPreset, AiProviderConfig, GlobalSettings } from "../hooks/useSettings";

const mockInvoke = vi.fn();
vi.mock("../services/tauri", () => ({
  invoke: (...args: unknown[]) => mockInvoke(...args),
}));

const mockLoadProviderSecrets = vi.fn();
const mockSetProviderSecret = vi.fn();
vi.mock("../hooks/useSecretStore", () => ({
  loadProviderSecrets: (...args: unknown[]) => mockLoadProviderSecrets(...args),
  setProviderSecret: (...args: unknown[]) => mockSetProviderSecret(...args),
}));

// Live active-connection id, mutable so tests can simulate a switch mid-refresh.
let liveActiveProviderId = "A";
vi.mock("../hooks/useSettings", () => ({
  useSettingsStore: {
    getState: () => ({ settings: { aiActiveProviderId: liveActiveProviderId } }),
  },
}));

import { buildRefreshedProviderInput, clearConnectionTokens, persistConnectionTokens, resolveEffectiveProvider } from "../utils/agentProvider";

function provider(over: Partial<AiProviderConfig> & { id: string }): AiProviderConfig {
  return {
    id: over.id,
    name: over.name ?? over.id,
    provider: over.provider ?? "microsoft_foundry",
    authMode: over.authMode ?? "azure_oauth",
    endpoint: over.endpoint ?? `https://${over.id}.example`,
    model: over.model ?? `model-${over.id}`,
    contextLength: over.contextLength ?? 0,
    modelSupportsVision: over.modelSupportsVision ?? "",
    tenantId: over.tenantId ?? `tenant-${over.id}`,
    clientId: over.clientId ?? `client-${over.id}`,
    subscriptionId: "",
    resourceGroup: "",
    resourceName: "",
  };
}

const AGENT: AgentPreset = { id: "planner", name: "Planner", prompt: "" };

function makeSettings(over: Partial<GlobalSettings> = {}): GlobalSettings {
  return {
    aiProviders: [provider({ id: "A" }), provider({ id: "B" })],
    aiActiveProviderId: "A",
    aiDefaultProviderId: "B",
    aiApiKey: "active-key",
    aiAccessToken: "active-token",
    aiRefreshToken: "active-refresh",
    aiAgentProviderOverrides: {},
    aiVisionMode: "off",
    aiWebAccess: "disabled",
    aiMaxToolRounds: 50,
    ...over,
  } as unknown as GlobalSettings;
}

function secrets(over: Partial<Record<string, string>> = {}) {
  return {
    apiKey: over.apiKey ?? "",
    accessToken: over.accessToken ?? "",
    refreshToken: over.refreshToken ?? "",
    managementToken: over.managementToken ?? "",
  };
}

describe("agent credential resolution binds to the effective connection (#262)", () => {
  beforeEach(() => {
    mockInvoke.mockReset();
    mockLoadProviderSecrets.mockReset();
    mockSetProviderSecret.mockReset();
    liveActiveProviderId = "A";
  });

  it("active A / default B uses B's endpoint, model, and refreshed credentials — not A's", async () => {
    const settings = makeSettings();
    mockLoadProviderSecrets.mockResolvedValue(secrets({ apiKey: "key-B", accessToken: "token-B", refreshToken: "refresh-B" }));
    mockInvoke.mockResolvedValue({ access_token: "fresh-B", refresh_token: "new-refresh-B" });
    const updateSetting = vi.fn();

    const input = await buildRefreshedProviderInput(settings, AGENT, updateSetting);

    expect(resolveEffectiveProvider(settings, AGENT)?.id).toBe("B");
    expect(mockLoadProviderSecrets).toHaveBeenCalledWith("B");
    // Refresh uses B's tenant/client and B's own refresh token.
    expect(mockInvoke).toHaveBeenCalledWith("azure_token_refresh", {
      tenantId: "tenant-B",
      refreshToken: "refresh-B",
      clientId: "client-B",
    });
    expect(input.endpoint).toBe("https://B.example");
    expect(input.model).toBe("model-B");
    expect(input.accessToken).toBe("fresh-B");
    // Refreshed tokens are written back to the connection that owns them.
    expect(mockSetProviderSecret).toHaveBeenCalledWith("B", "accessToken", "fresh-B");
    expect(mockSetProviderSecret).toHaveBeenCalledWith("B", "refreshToken", "new-refresh-B");
    // B is not the active connection, so the flat projection must not be touched.
    expect(updateSetting).not.toHaveBeenCalled();
  });

  it("override C refreshes C", async () => {
    const settings = makeSettings({
      aiProviders: [provider({ id: "A" }), provider({ id: "B" }), provider({ id: "C" })],
      aiAgentProviderOverrides: { planner: "C" },
    });
    mockLoadProviderSecrets.mockResolvedValue(secrets({ apiKey: "key-C", accessToken: "token-C", refreshToken: "refresh-C" }));
    mockInvoke.mockResolvedValue({ access_token: "fresh-C" });
    const updateSetting = vi.fn();

    const input = await buildRefreshedProviderInput(settings, AGENT, updateSetting);

    expect(resolveEffectiveProvider(settings, AGENT)?.id).toBe("C");
    expect(mockLoadProviderSecrets).toHaveBeenCalledWith("C");
    expect(mockInvoke).toHaveBeenCalledWith("azure_token_refresh", {
      tenantId: "tenant-C",
      refreshToken: "refresh-C",
      clientId: "client-C",
    });
    expect(input.endpoint).toBe("https://C.example");
    expect(input.accessToken).toBe("fresh-C");
    expect(mockSetProviderSecret).toHaveBeenCalledWith("C", "accessToken", "fresh-C");
    expect(updateSetting).not.toHaveBeenCalled();
  });

  it("switching the active connection while a refresh is pending cannot write into another connection", async () => {
    // Effective == active A at call time; A is oauth and uses the flat refresh token.
    const settings = makeSettings({ aiDefaultProviderId: "A" });
    mockLoadProviderSecrets.mockResolvedValue(secrets());
    let resolveRefresh: (v: { access_token: string; refresh_token?: string }) => void = () => {};
    mockInvoke.mockReturnValue(new Promise((resolve) => { resolveRefresh = resolve; }));
    const updateSetting = vi.fn();

    const pending = buildRefreshedProviderInput(settings, AGENT, updateSetting);
    // User switches the active connection to B before the refresh resolves.
    liveActiveProviderId = "B";
    resolveRefresh({ access_token: "fresh-A", refresh_token: "new-refresh-A" });
    const input = await pending;

    // A owns the credentials, so its vault entries are updated…
    expect(mockSetProviderSecret).toHaveBeenCalledWith("A", "accessToken", "fresh-A");
    // …but the flat active projection now represents B, so it must NOT be written.
    expect(updateSetting).not.toHaveBeenCalled();
    expect(input.accessToken).toBe("fresh-A");
  });

  it("updates the flat active projection when the effective connection is still active", async () => {
    const settings = makeSettings({ aiDefaultProviderId: "A" });
    mockLoadProviderSecrets.mockResolvedValue(secrets());
    mockInvoke.mockResolvedValue({ access_token: "fresh-A", refresh_token: "new-refresh-A" });
    const updateSetting = vi.fn();

    await buildRefreshedProviderInput(settings, AGENT, updateSetting);

    // A is active and oauth: refresh uses the flat refresh token.
    expect(mockInvoke).toHaveBeenCalledWith("azure_token_refresh", {
      tenantId: "tenant-A",
      refreshToken: "active-refresh",
      clientId: "client-A",
    });
    expect(updateSetting).toHaveBeenCalledWith("aiAccessToken", "fresh-A");
    expect(updateSetting).toHaveBeenCalledWith("aiRefreshToken", "new-refresh-A");
  });

  it("api-key connections skip OAuth refresh and keep their key", async () => {
    const settings = makeSettings({
      aiProviders: [provider({ id: "A" }), provider({ id: "B", authMode: "api_key" })],
    });
    mockLoadProviderSecrets.mockResolvedValue(secrets({ apiKey: "key-B", accessToken: "" }));
    const updateSetting = vi.fn();

    const input = await buildRefreshedProviderInput(settings, AGENT, updateSetting);

    expect(mockInvoke).not.toHaveBeenCalled();
    expect(mockSetProviderSecret).not.toHaveBeenCalled();
    expect(input.apiKey).toBe("key-B");
    expect(updateSetting).not.toHaveBeenCalled();
  });
});

describe("persistConnectionTokens binds sign-in/refresh completion to its initiating connection (#262)", () => {
  beforeEach(() => {
    mockInvoke.mockReset();
    mockLoadProviderSecrets.mockReset();
    mockSetProviderSecret.mockReset();
    liveActiveProviderId = "A";
  });

  it("writes to the initiating connection's vault and mirrors the flat projection while it stays active", async () => {
    const updateSetting = vi.fn();

    await persistConnectionTokens("A", { accessToken: "tok", refreshToken: "ref" }, updateSetting);

    expect(mockSetProviderSecret).toHaveBeenCalledWith("A", "accessToken", "tok");
    expect(mockSetProviderSecret).toHaveBeenCalledWith("A", "refreshToken", "ref");
    expect(updateSetting).toHaveBeenCalledWith("aiAccessToken", "tok");
    expect(updateSetting).toHaveBeenCalledWith("aiRefreshToken", "ref");
  });

  it("switching the active connection during sign-in keeps tokens in the initiating connection only", async () => {
    const updateSetting = vi.fn();
    // Sign-in began on A, but the user switched active to B before completion.
    liveActiveProviderId = "B";

    await persistConnectionTokens("A", { accessToken: "tok-A", refreshToken: "ref-A" }, updateSetting);

    expect(mockSetProviderSecret).toHaveBeenCalledWith("A", "accessToken", "tok-A");
    expect(mockSetProviderSecret).toHaveBeenCalledWith("A", "refreshToken", "ref-A");
    // Flat projection now represents B — it must not be overwritten with A's token.
    expect(updateSetting).not.toHaveBeenCalled();
  });

  it("falls back to the flat projection for a single-connection / unmanaged pool (no provider id)", async () => {
    const updateSetting = vi.fn();

    await persistConnectionTokens("", { accessToken: "tok", refreshToken: "ref" }, updateSetting);

    expect(mockSetProviderSecret).not.toHaveBeenCalled();
    expect(updateSetting).toHaveBeenCalledWith("aiAccessToken", "tok");
    expect(updateSetting).toHaveBeenCalledWith("aiRefreshToken", "ref");
  });

  it("re-checks the active connection between flat writes so a mid-write switch skips the refresh mirror", async () => {
    // Switching from A to B happens during the first (access-token) flat write.
    const updateSetting = vi.fn().mockImplementationOnce(() => { liveActiveProviderId = "B"; });

    await persistConnectionTokens("A", { accessToken: "tok-A", refreshToken: "ref-A" }, updateSetting);

    // Vault still gets both of A's tokens.
    expect(mockSetProviderSecret).toHaveBeenCalledWith("A", "accessToken", "tok-A");
    expect(mockSetProviderSecret).toHaveBeenCalledWith("A", "refreshToken", "ref-A");
    // Access token was mirrored while A was active…
    expect(updateSetting).toHaveBeenCalledWith("aiAccessToken", "tok-A");
    // …but the refresh mirror is skipped because A is no longer active.
    expect(updateSetting).not.toHaveBeenCalledWith("aiRefreshToken", "ref-A");
  });
});

describe("clearConnectionTokens binds sign-out to its initiating connection (#262)", () => {
  beforeEach(() => {
    mockInvoke.mockReset();
    mockLoadProviderSecrets.mockReset();
    mockSetProviderSecret.mockReset();
    liveActiveProviderId = "A";
  });

  it("clears the owning connection's vault tokens (including management) and the active flat projection", async () => {
    const updateSetting = vi.fn();

    await clearConnectionTokens("A", updateSetting);

    expect(mockSetProviderSecret).toHaveBeenCalledWith("A", "accessToken", "");
    expect(mockSetProviderSecret).toHaveBeenCalledWith("A", "refreshToken", "");
    expect(mockSetProviderSecret).toHaveBeenCalledWith("A", "managementToken", "");
    expect(updateSetting).toHaveBeenCalledWith("aiAccessToken", "");
    expect(updateSetting).toHaveBeenCalledWith("aiRefreshToken", "");
    expect(updateSetting).toHaveBeenCalledWith("aiManagementToken", "");
  });

  it("does not clear the flat projection when the initiating connection is no longer active", async () => {
    const updateSetting = vi.fn();
    liveActiveProviderId = "B";

    await clearConnectionTokens("A", updateSetting);

    // A's vault is still cleared by id…
    expect(mockSetProviderSecret).toHaveBeenCalledWith("A", "accessToken", "");
    expect(mockSetProviderSecret).toHaveBeenCalledWith("A", "managementToken", "");
    // …but the flat projection (now B's) must not be wiped.
    expect(updateSetting).not.toHaveBeenCalled();
  });
});
