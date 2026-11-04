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
  setSummary: (summary: ChangeSummary | null) => void;
  setSaveFailure: (failure: SaveFailure | null) => void;
  reset: () => void;
}

/** Document-aware summary of unsaved work, plus the "Couldn't save – Retry" state for the status chip. */
export const useChangeSummaryStore = create<ChangeSummaryState>((set) => ({
  summary: null,
  saveFailure: null,
  setSummary: (summary) => set({ summary }),
  setSaveFailure: (saveFailure) => set({ saveFailure }),
  reset: () => set({ summary: null, saveFailure: null }),
}));
