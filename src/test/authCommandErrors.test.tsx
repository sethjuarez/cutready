import { fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

// Sign-in/auth commands reject with the CmdError envelope (ADR 0003, F7b).
// Every caller that shows the rejection must show the same text it showed when
// the command rejected with a plain string.

vi.mock("../services/tauri", async () => {
  const { commandErrorText } = await vi.importActual<typeof import("../services/commandErrors")>(
    "../services/commandErrors",
  );
  return {
    invoke: vi.fn(),
    commandErrorText,
    convertFileSrc: (p: string) => p,
    Channel: class {},
    listen: vi.fn().mockResolvedValue(() => {}),
    once: vi.fn().mockResolvedValue(() => {}),
    emit: vi.fn().mockResolvedValue(undefined),
    emitTo: vi.fn().mockResolvedValue(undefined),
  };
});

vi.mock("@tauri-apps/plugin-shell", () => ({ open: vi.fn().mockResolvedValue(undefined) }));

const settingsState = vi.hoisted(() => ({ current: null as unknown }));

vi.mock("../hooks/useSettings", async () => {
  const actual = await vi.importActual<typeof import("../hooks/useSettings")>("../hooks/useSettings");
  return {
    ...actual,
    useSettings: () => settingsState.current,
  };
});

import { invoke } from "../services/tauri";
import { useSettingsStore, type AppSettings } from "../hooks/useSettings";
import { FoundryResourcePicker } from "../components/FoundryResourcePicker";
import { HarnessPicker, SettingsPanel } from "../components/SettingsPanel";

const MESSAGE = "AADSTS70000: The provided grant has expired";

/** The old plain-string rejection and the CmdError envelope carrying the same text. */
const REJECTIONS: [string, unknown][] = [
  ["a plain string", MESSAGE],
  ["a CmdError", { code: "command_failed", message: MESSAGE }],
];

type Handler = (args?: Record<string, unknown>) => unknown;

function mockCommands(handlers: Record<string, Handler>) {
  vi.mocked(invoke).mockImplementation(((cmd: string, args?: Record<string, unknown>) => {
    const handler = handlers[cmd];
    if (!handler) return Promise.resolve(null);
    try {
      return Promise.resolve(handler(args));
    } catch (error) {
      return Promise.reject(error);
    }
  }) as typeof invoke);
}

function reject(rejection: unknown): Handler {
  return () => {
    throw rejection;
  };
}

afterEach(() => {
  vi.mocked(invoke).mockReset();
  localStorage.clear();
});

describe("copilot_sign_in rejection (AgentsTab CopilotConnect)", () => {
  // The re-probe after a failed sign-in clears the error before it renders, so
  // the panel falls back to the probed status and its guided steps.
  it.each(REJECTIONS)("re-probes and shows the guided steps when it rejects with %s", async (_label, rejection) => {
    mockCommands({
      list_agent_harnesses: () => [{ id: "copilot-sdk", display_name: "GitHub Copilot", available: true }],
      copilot_auth_status: () => ({ installed: true, authenticated: false }),
      copilot_sign_in: reject(rejection),
    });
    render(<HarnessPicker value="copilot-sdk" onChange={vi.fn()} />);

    fireEvent.click(await screen.findByTestId("copilot-sign-in"));

    await vi.waitFor(() =>
      expect(vi.mocked(invoke).mock.calls.filter(([cmd]) => cmd === "copilot_auth_status")).toHaveLength(2),
    );
    expect(await screen.findByTestId("copilot-sign-in")).toBeTruthy();
    expect(screen.getByTestId("copilot-connect").getAttribute("data-state")).toBe("needs-sign-in");
    expect(screen.queryByText(MESSAGE)).toBeNull();
    expect(screen.queryByText("[object Object]")).toBeNull();
  });
});

describe("Foundry resource discovery rejections (FoundryResourcePicker)", () => {
  const settings = {
    aiRefreshToken: "rt",
    aiManagementToken: "mt",
    aiTenantId: "",
    aiClientId: "",
    aiSubscriptionId: "sub-1",
    aiResourceGroup: "rg",
    aiResourceName: "res",
    aiEndpoint: "https://res.services.ai.azure.com",
  } as unknown as AppSettings;
  const subscription = { subscriptionId: "sub-1", displayName: "Dev", state: "Enabled" };
  const resource = { name: "res", resourceGroup: "rg", kind: "AIServices", endpoint: "https://res.services.ai.azure.com", location: "eastus" };

  function renderPicker() {
    render(<FoundryResourcePicker settings={settings} updateSetting={vi.fn().mockResolvedValue(undefined)} />);
  }

  it.each(REJECTIONS)("list_azure_subscriptions failure with %s", async (_label, rejection) => {
    mockCommands({ list_azure_subscriptions: reject(rejection) });
    renderPicker();
    expect(await screen.findByText(`Failed to list subscriptions: ${MESSAGE}`)).toBeTruthy();
  });

  it.each(REJECTIONS)("list_azure_ai_resources failure with %s", async (_label, rejection) => {
    mockCommands({ list_azure_subscriptions: () => [subscription], list_azure_ai_resources: reject(rejection) });
    renderPicker();
    expect(await screen.findByText(`Failed to list AI resources: ${MESSAGE}`)).toBeTruthy();
  });

  it.each(REJECTIONS)("list_foundry_projects failure with %s", async (_label, rejection) => {
    mockCommands({
      list_azure_subscriptions: () => [subscription],
      list_azure_ai_resources: () => [resource],
      list_foundry_projects: reject(rejection),
    });
    renderPicker();
    expect(await screen.findByText(`Failed to list projects: ${MESSAGE}`)).toBeTruthy();
  });

  it("falls back to its own message when azure_token_refresh rejects", async () => {
    mockCommands({ azure_token_refresh: reject({ code: "command_failed", message: MESSAGE }) });
    render(
      <FoundryResourcePicker
        settings={{ ...settings, aiManagementToken: "" } as AppSettings}
        updateSetting={vi.fn().mockResolvedValue(undefined)}
      />,
    );
    expect(await screen.findByText("Could not obtain management token. Try signing in again.")).toBeTruthy();
  });
});

describe("browser sign-in rejections (SettingsPanel startOAuthFlow)", () => {
  function renderSignIn() {
    settingsState.current = {
      settings: {
        ...useSettingsStore.getState().settings,
        aiProvider: "microsoft_foundry",
        aiAuthMode: "azure_oauth",
        aiAccessToken: "",
        aiRefreshToken: "",
      },
      updateSetting: vi.fn().mockResolvedValue(undefined),
      loaded: true,
      oauthRefreshPending: false,
    };
    localStorage.setItem("cutready:requested-settings-tab", "ai");
    render(<SettingsPanel onClose={vi.fn()} />);
  }

  it.each(REJECTIONS)("azure_browser_auth_start failure with %s", async (_label, rejection) => {
    vi.spyOn(console, "warn").mockImplementation(() => {});
    mockCommands({ azure_browser_auth_start: reject(rejection) });
    renderSignIn();
    fireEvent.click(await screen.findByText("Sign in with Microsoft Entra"));
    expect(await screen.findByText(MESSAGE)).toBeTruthy();
  });

  it.each(REJECTIONS)("azure_browser_auth_complete failure with %s", async (_label, rejection) => {
    vi.spyOn(console, "warn").mockImplementation(() => {});
    mockCommands({
      azure_browser_auth_start: () => ({ auth_url: "https://login.microsoftonline.com/mock" }),
      azure_browser_auth_complete: reject(rejection),
    });
    renderSignIn();
    fireEvent.click(await screen.findByText("Sign in with Microsoft Entra"));
    expect(await screen.findByText(MESSAGE)).toBeTruthy();
  });
});
