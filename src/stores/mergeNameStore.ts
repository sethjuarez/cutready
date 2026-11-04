import { create } from "zustand";

export interface PendingMergeName {
  id: number;
  /** Where the incoming changes come from, e.g. a timeline or base branch. */
  source: string;
  defaultName: string;
  /** The approved commit message, or null when the merge is cancelled. */
  resolve: (message: string | null) => void;
}

interface MergeNameState {
  pending: PendingMergeName | null;
  /** Shows the prompt. A second request while one is open is cancelled. */
  ask: (source: string, defaultName: string) => Promise<string | null>;
  answer: (message: string | null) => void;
}

let nextId = 1;

/** The merge-name prompt: a merge runs only after its name is approved. */
export const useMergeNameStore = create<MergeNameState>((set, get) => ({
  pending: null,
  ask: (source, defaultName) => {
    if (get().pending) return Promise.resolve(null);
    return new Promise((resolve) => {
      set({ pending: { id: nextId++, source, defaultName, resolve } });
    });
  },
  answer: (message) => {
    const pending = get().pending;
    if (!pending) return;
    set({ pending: null });
    pending.resolve(message);
  },
}));
