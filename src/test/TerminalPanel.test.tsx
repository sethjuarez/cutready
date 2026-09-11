import { act, cleanup, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const tauriMocks = vi.hoisted(() => ({
  invoke: vi.fn(),
  listen: vi.fn(),
  emitXtermDataOnInput: false,
  emitXtermDataOnEnter: false,
  xtermDataDelayMs: 0,
  terminalExitedHandler: null as null | ((event: { payload: { session_id: string } }) => void),
}));

vi.mock("@xterm/xterm", () => ({
  Terminal: class {
    cols = 80;
    rows = 24;
    options: Record<string, unknown>;
    dataHandler: ((data: string) => void) | null = null;

    constructor(options: Record<string, unknown>) {
      this.options = options;
    }

    loadAddon() {}

    open(host: HTMLElement) {
      const helper = document.createElement("textarea");
      helper.className = "xterm-helper-textarea";
      helper.addEventListener("keydown", (event) => {
        if (event.key === "Enter" && tauriMocks.emitXtermDataOnEnter) {
          window.setTimeout(() => {
            this.dataHandler?.("\r");
          }, tauriMocks.xtermDataDelayMs);
        }
      });
      helper.addEventListener("input", () => {
        if (tauriMocks.emitXtermDataOnInput) {
          this.dataHandler?.(helper.value);
        }
      });
      host.appendChild(helper);
    }

    onData(handler: (data: string) => void) {
      this.dataHandler = handler;
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
    document.body.innerHTML = "";
    await act(async () => {
      useAppStore.setState({ currentProject: null });
      useTerminalStore.getState().resetTerminals();
    });
    tauriMocks.invoke.mockReset();
    tauriMocks.listen.mockReset();
    tauriMocks.emitXtermDataOnInput = false;
    tauriMocks.emitXtermDataOnEnter = false;
    tauriMocks.xtermDataDelayMs = 0;
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
      if (command === "terminal_is_alive") return Promise.resolve(true);
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

  it("renders terminal tabs in a provided toolbar host", async () => {
    tauriMocks.listen.mockResolvedValue(() => undefined);
    tauriMocks.invoke.mockImplementation((command: string) => {
      if (command === "terminal_open") {
        return Promise.resolve({
          session_id: "terminal-session-1",
          cwd: "C:\\demo",
          shell: "pwsh",
        });
      }
      if (command === "terminal_is_alive") return Promise.resolve(true);
      return Promise.resolve();
    });
    const toolbarHost = document.createElement("div");
    document.body.appendChild(toolbarHost);

    await act(async () => {
      useAppStore.setState({
        currentProject: {
          root: "C:\\demo",
          repo_root: "C:\\demo",
          name: "Demo",
        },
      });
    });

    render(<TerminalPanel active toolbarHost={toolbarHost} />);

    await waitFor(() =>
      expect(useTerminalStore.getState().terminals[0]).toMatchObject({
        sessionId: "terminal-session-1",
        status: "open",
      }),
    );
    expect(toolbarHost).toHaveTextContent(/Terminal \d+/);
    expect(toolbarHost.querySelector("[title='New terminal']")).toBeTruthy();
  });

  it("submits pending helper text on Enter when xterm leaves it stuck", async () => {
    tauriMocks.listen.mockResolvedValue(() => undefined);
    tauriMocks.invoke.mockImplementation((command: string) => {
      if (command === "terminal_open") {
        return Promise.resolve({
          session_id: "terminal-session-1",
          cwd: "C:\\demo",
          shell: "pwsh",
        });
      }
      if (command === "terminal_is_alive") return Promise.resolve(true);
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
    const helper = document.querySelector<HTMLTextAreaElement>(
      ".xterm-helper-textarea",
    );
    expect(helper).toBeTruthy();
    helper!.value = "exit\n";

    await act(async () => {
      helper!.dispatchEvent(
        new KeyboardEvent("keydown", { key: "Enter", bubbles: true }),
      );
    });

    await waitFor(() =>
      expect(tauriMocks.invoke).toHaveBeenCalledWith("terminal_write", {
        sessionId: "terminal-session-1",
        data: Array.from(new TextEncoder().encode("exit\r")),
      }),
    );
    expect(helper!.value).toBe("");
  });

  it("does not double-submit helper text when xterm already emitted it", async () => {
    tauriMocks.emitXtermDataOnInput = true;
    tauriMocks.emitXtermDataOnEnter = true;
    tauriMocks.xtermDataDelayMs = 1;
    tauriMocks.listen.mockResolvedValue(() => undefined);
    tauriMocks.invoke.mockImplementation((command: string) => {
      if (command === "terminal_open") {
        return Promise.resolve({
          session_id: "terminal-session-1",
          cwd: "C:\\demo",
          shell: "pwsh",
        });
      }
      if (command === "terminal_is_alive") return Promise.resolve(true);
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
    const helper = document.querySelector<HTMLTextAreaElement>(
      ".xterm-helper-textarea",
    );
    expect(helper).toBeTruthy();
    helper!.value = "exit";
    await act(async () => {
      helper!.dispatchEvent(new Event("input", { bubbles: true }));
    });

    await act(async () => {
      helper!.dispatchEvent(
        new KeyboardEvent("keydown", { key: "Enter", bubbles: true }),
      );
    });

    await waitFor(() => expect(helper!.value).toBe(""));
    const writeCalls = tauriMocks.invoke.mock.calls.filter(
      ([command]) => command === "terminal_write",
    );
    expect(writeCalls).toHaveLength(2);
    expect(writeCalls[0][1]).toEqual({
      sessionId: "terminal-session-1",
      data: Array.from(new TextEncoder().encode("exit")),
    });
    expect(writeCalls[1][1]).toEqual({
      sessionId: "terminal-session-1",
      data: Array.from(new TextEncoder().encode("\r")),
    });
  });

  it("sends only Enter when helper text was already emitted but Enter was stuck", async () => {
    tauriMocks.emitXtermDataOnInput = true;
    tauriMocks.listen.mockResolvedValue(() => undefined);
    tauriMocks.invoke.mockImplementation((command: string) => {
      if (command === "terminal_open") {
        return Promise.resolve({
          session_id: "terminal-session-1",
          cwd: "C:\\demo",
          shell: "pwsh",
        });
      }
      if (command === "terminal_is_alive") return Promise.resolve(true);
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
    const helper = document.querySelector<HTMLTextAreaElement>(
      ".xterm-helper-textarea",
    );
    expect(helper).toBeTruthy();
    helper!.value = "exit";
    await act(async () => {
      helper!.dispatchEvent(new Event("input", { bubbles: true }));
    });

    await act(async () => {
      helper!.dispatchEvent(
        new KeyboardEvent("keydown", { key: "Enter", bubbles: true }),
      );
    });

    await waitFor(() => expect(helper!.value).toBe(""));
    const writeCalls = tauriMocks.invoke.mock.calls.filter(
      ([command]) => command === "terminal_write",
    );
    expect(writeCalls).toHaveLength(2);
    expect(writeCalls[0][1]).toEqual({
      sessionId: "terminal-session-1",
      data: Array.from(new TextEncoder().encode("exit")),
    });
    expect(writeCalls[1][1]).toEqual({
      sessionId: "terminal-session-1",
      data: Array.from(new TextEncoder().encode("\r")),
    });
  });

  it("marks the terminal exited when the backend status check reports exit", async () => {
    tauriMocks.emitXtermDataOnInput = true;
    tauriMocks.listen.mockResolvedValue(() => undefined);
    tauriMocks.invoke.mockImplementation((command: string) => {
      if (command === "terminal_open") {
        return Promise.resolve({
          session_id: "terminal-session-1",
          cwd: "C:\\demo",
          shell: "pwsh",
        });
      }
      if (command === "terminal_is_alive") return Promise.resolve(false);
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
    const helper = document.querySelector<HTMLTextAreaElement>(
      ".xterm-helper-textarea",
    );
    expect(helper).toBeTruthy();
    helper!.value = "exit";

    await act(async () => {
      helper!.dispatchEvent(new Event("input", { bubbles: true }));
    });
    await act(async () => {
      helper!.dispatchEvent(
        new KeyboardEvent("keydown", { key: "Enter", bubbles: true }),
      );
    });

    await waitFor(() =>
      expect(useTerminalStore.getState().terminals[0]).toMatchObject({
        sessionId: null,
        status: "exited",
      }),
    );
    expect(
      screen.getByRole("button", { name: /restart terminal/i }),
    ).toBeInTheDocument();
  });
});
