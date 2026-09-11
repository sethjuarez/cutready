import { act, cleanup, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const tauriMocks = vi.hoisted(() => ({
  invoke: vi.fn(),
  listen: vi.fn(),
  terminalExitedHandler: null as null | ((event: { payload: { session_id: string } }) => void),
}));

vi.mock("@xterm/xterm", () => ({
  Terminal: class {
    cols = 80;
    rows = 24;
    options: Record<string, unknown>;

    constructor(options: Record<string, unknown>) {
      this.options = options;
    }

    loadAddon() {}

    open(host: HTMLElement) {
      host.appendChild(document.createElement("textarea"));
    }

    onData() {
      return { dispose: vi.fn() };
    }

    write() {}

    writeln() {}

    focus() {}

    resize(cols: number, rows: number) {
      this.cols = cols;
      this.rows = rows;
    }

    dispose() {}
  },
}));

vi.mock("@xterm/addon-fit", () => ({
  FitAddon: class {
    fit() {}
  },
}));

vi.mock("../services/tauri", () => ({
  invoke: (...args: unknown[]) => tauriMocks.invoke(...args),
  listen: (event: string, handler: (event: { payload: { session_id: string } }) => void) => {
    if (event === "terminal-exited") {
      tauriMocks.terminalExitedHandler = handler;
    }
    return tauriMocks.listen(event, handler);
  },
  Channel: class {
    onmessage: ((data: unknown) => void) | null = null;
  },
}));

vi.mock("../hooks/useSettings", () => ({
  useSettings: () => ({
    settings: {
      displayTerminalFontFamily: '"Cascadia Code", Consolas, monospace',
      displayTerminalFontSize: 12,
      displayTerminalColorMode: "auto",
      displayTerminalCustomTheme: null,
    },
  }),
}));

import { TerminalPanel } from "../components/TerminalPanel";
import { useAppStore } from "../stores/appStore";
import { useTerminalStore } from "../stores/terminalStore";

class MockResizeObserver {
  observe() {}
  disconnect() {}
}

describe("TerminalPanel", () => {
  beforeEach(() => {
    vi.stubGlobal("ResizeObserver", MockResizeObserver);
  });

  afterEach(async () => {
    cleanup();
    await act(async () => {
      useAppStore.setState({ currentProject: null });
      useTerminalStore.getState().resetTerminals();
    });
    tauriMocks.invoke.mockReset();
    tauriMocks.listen.mockReset();
    tauriMocks.terminalExitedHandler = null;
    vi.unstubAllGlobals();
  });

  it("marks the active terminal exited when the backend session exits", async () => {
    tauriMocks.listen.mockResolvedValue(() => undefined);
    tauriMocks.invoke.mockImplementation((command: string) => {
      if (command === "terminal_open") {
        return Promise.resolve({
          session_id: "terminal-session-1",
          cwd: "C:\\demo",
          shell: "pwsh",
        });
      }
      return Promise.resolve();
    });

    await act(async () => {
      useAppStore.setState({
        currentProject: {
          root: "C:\\demo",
          repo_root: "C:\\demo",
          name: "Demo",
        },
      });
    });

    render(<TerminalPanel active />);

    await waitFor(() =>
      expect(useTerminalStore.getState().terminals[0]).toMatchObject({
        sessionId: "terminal-session-1",
        status: "open",
      }),
    );
    expect(screen.getByText("pwsh")).toBeInTheDocument();

    await act(async () => {
      tauriMocks.terminalExitedHandler?.({
        payload: { session_id: "terminal-session-1" },
      });
    });

    await waitFor(() =>
      expect(useTerminalStore.getState().terminals[0]).toMatchObject({
        sessionId: null,
        status: "exited",
      }),
    );
    expect(screen.getByText("Terminal exited")).toBeInTheDocument();
    expect(
      screen.getByRole("button", { name: /restart terminal/i }),
    ).toBeInTheDocument();
  });
});
