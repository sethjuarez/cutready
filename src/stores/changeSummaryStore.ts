import { create } from "zustand";
import type { ChangeSummary } from "../domain/changes";

/** A versioning action stopped because open edits couldn't be written to disk. */
export interface SaveFailure {
  /** Action that was blocked, e.g. "Save version" or "Send". */
  operation: string;
  message: string;
  /** Runs the blocked action again, starting with the save. */
  retry: () => Promise<void>;
}

export interface ChangeSummaryState {
  summary: ChangeSummary | null;
  saveFailure: SaveFailure | null;
  /** Whether the status chip's popover is open. */
  popoverOpen: boolean;
  /** Bumped to ask the open popover to focus the version name (Ctrl+S). */
  nameFocusRequest: number;
  /** Versioning actions in flight; the chip shows Saving… while it's above zero. */
  busyCount: number;
  adjustBusy: (delta: 1 | -1) => void;
  setSummary:  (summary: ChangeSummary | null) => void;
  setSaveFailure: (failure: SaveFailure | null) => void;
  setPopoverOpen: (open: boolean) => void;
  /** Opens the popover with the version name focused. */
  openForSave: () => void;
  reset: () => void;
}

/** Document-aware summary of unsaved work, plus the "Couldn't save – Retry" state for the status chip. */
export const useChangeSummaryStore = create<ChangeSummaryState>((set) => ({
  summary: null,
  saveFailure: null,
  popoverOpen: false,
  nameFocusRequest: 0,
  busyCount: 0,
  adjustBusy: (delta) => set((s) => ({ busyCount: Math.max(0, s.busyCount + delta) })),
  setSummary: (summary) => set({ summary }),
  setSaveFailure: (saveFailure) => set({ saveFailure }),
  setPopoverOpen: (popoverOpen) => set({ popoverOpen }),
  openForSave: () => set((s) => ({ popoverOpen: true, nameFocusRequest: s.nameFocusRequest + 1 })),
  reset: () => set({ summary: null, saveFailure: null, popoverOpen: false }),
}));
