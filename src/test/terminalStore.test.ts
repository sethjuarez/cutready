import { afterEach, describe, expect, it } from "vitest";
import { useTerminalStore, type TerminalRecord } from "../stores/terminalStore";

function terminal(
  id: string,
  status: TerminalRecord["status"] = "open",
): TerminalRecord {
  return {
    id,
    sessionId: `${id}-session`,
    title: id,
    cwd: "C:/demo",
    shell: "pwsh",
    status,
    error: null,
  };
}

describe("terminalStore", () => {
  afterEach(() => {
    useTerminalStore.getState().resetTerminals();
  });

  it("tracks multiple terminals and activates the newest one", () => {
    const store = useTerminalStore.getState();

    store.createTerminalRecord(terminal("terminal-1"));
    store.createTerminalRecord(terminal("terminal-2"));

    const state = useTerminalStore.getState();
    expect(state.terminals.map((item) => item.id)).toEqual([
      "terminal-1",
      "terminal-2",
    ]);
    expect(state.activeTerminalId).toBe("terminal-2");
  });

  it("moves focus to the previous terminal when closing the active terminal", () => {
    const store = useTerminalStore.getState();
    store.createTerminalRecord(terminal("terminal-1"));
    store.createTerminalRecord(terminal("terminal-2"));

    store.closeTerminalRecord("terminal-2");

    const state = useTerminalStore.getState();
    expect(state.terminals.map((item) => item.id)).toEqual(["terminal-1"]);
    expect(state.activeTerminalId).toBe("terminal-1");
  });

  it("selects the previous neighbor when closing an active middle terminal", () => {
    const store = useTerminalStore.getState();
    store.createTerminalRecord(terminal("terminal-1"));
    store.createTerminalRecord(terminal("terminal-2"));
    store.createTerminalRecord(terminal("terminal-3"));
    store.setActiveTerminal("terminal-2");

    store.closeTerminalRecord("terminal-2");

    const state = useTerminalStore.getState();
    expect(state.terminals.map((item) => item.id)).toEqual([
      "terminal-1",
      "terminal-3",
    ]);
    expect(state.activeTerminalId).toBe("terminal-1");
  });

  it("allows the last terminal to close", () => {
    const store = useTerminalStore.getState();
    store.createTerminalRecord(terminal("terminal-1"));

    store.closeTerminalRecord("terminal-1");

    const state = useTerminalStore.getState();
    expect(state.terminals).toEqual([]);
    expect(state.activeTerminalId).toBeNull();
  });

  it("keeps active focus when closing a background terminal", () => {
    const store = useTerminalStore.getState();
    store.createTerminalRecord(terminal("terminal-1"));
    store.createTerminalRecord(terminal("terminal-2"));

    store.closeTerminalRecord("terminal-1");

    const state = useTerminalStore.getState();
    expect(state.terminals.map((item) => item.id)).toEqual(["terminal-2"]);
    expect(state.activeTerminalId).toBe("terminal-2");
  });

  it("tracks exited terminals for restart affordances", () => {
    const store = useTerminalStore.getState();
    store.createTerminalRecord(terminal("terminal-1"));

    store.updateTerminal("terminal-1", {
      status: "exited",
      sessionId: null,
      error: "Terminal session not found: terminal-1-session",
    });

    expect(useTerminalStore.getState().terminals[0]).toMatchObject({
      id: "terminal-1",
      status: "exited",
      sessionId: null,
    });
  });
});
