import { create } from "zustand";

export type TerminalStatus = "opening" | "open" | "exited" | "error";

export interface TerminalRecord {
  id: string;
  sessionId: string | null;
  title: string;
  cwd: string | null;
  shell: string | null;
  status: TerminalStatus;
  error: string | null;
}

interface TerminalState {
  terminals: TerminalRecord[];
  activeTerminalId: string | null;
  createTerminalRecord: (record: TerminalRecord) => void;
  updateTerminal: (id: string, patch: Partial<TerminalRecord>) => void;
  closeTerminalRecord: (id: string) => void;
  setActiveTerminal: (id: string | null) => void;
  resetTerminals: () => void;
}

export const useTerminalStore = create<TerminalState>((set) => ({
  terminals: [],
  activeTerminalId: null,
  createTerminalRecord: (record) =>
    set((state) => ({
      terminals: [...state.terminals, record],
      activeTerminalId: record.id,
    })),
  updateTerminal: (id, patch) =>
    set((state) => ({
      terminals: state.terminals.map((terminal) =>
        terminal.id === id ? { ...terminal, ...patch } : terminal,
      ),
    })),
  closeTerminalRecord: (id) =>
    set((state) => {
      const closedIndex = state.terminals.findIndex(
        (terminal) => terminal.id === id,
      );
      const terminals = state.terminals.filter(
        (terminal) => terminal.id !== id,
      );
      const closingActive = state.activeTerminalId === id;
      return {
        terminals,
        activeTerminalId: closingActive
          ? (terminals[Math.max(0, closedIndex - 1)]?.id ??
            terminals[terminals.length - 1]?.id ??
            null)
          : state.activeTerminalId,
      };
    }),
  setActiveTerminal: (id) => set({ activeTerminalId: id }),
  resetTerminals: () => set({ terminals: [], activeTerminalId: null }),
}));
