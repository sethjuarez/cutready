import { create } from "zustand";

export interface PreActionRequest {
  /** Operation name for the boundary and errors, e.g. "Switch to Draft 2". */
  operation: string;
  /** Finishes "Before …", e.g. "switching to Draft 2". */
  target: string;
  /** The action itself; runs once the workspace is clean. */
  run: () => Promise<void>;
  /**
   * Called just before the work is set aside. May return a follow-up that runs
   * after the action succeeds, e.g. offering to delete a timeline left empty.
   */
  onSetAside?: () => (() => Promise<void>) | void;
}

export interface PendingPreAction extends PreActionRequest {
  id: number;
  changeCount: number;
}

interface PreActionState {
  pending: PendingPreAction | null;
  /** Shows the dialog. False when another request is already waiting; it is never replaced. */
  ask: (pending: Omit<PendingPreAction, "id">) => boolean;
  dismiss: () => void;
}

let nextId = 1;

/** The one pre-action dialog's request: shown while unsaved work blocks an action. */
export const usePreActionStore = create<PreActionState>((set, get) => ({
  pending: null,
  ask: (pending) => {
    if (get().pending) return false;
    set({ pending: { ...pending, id: nextId++ } });
    return true;
  },
  dismiss: () => set({ pending: null }),
}));
