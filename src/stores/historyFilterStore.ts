import { create } from "zustand";

export interface HistoryDocument {
  /** Draftline path of the document. */
  path: string;
  title: string;
}

interface HistoryFilterState {
  /** When set, the History tab's timeline only lists versions that changed this document. */
  document: HistoryDocument | null;
  setDocument: (document: HistoryDocument | null) => void;
}

export const useHistoryFilterStore = create<HistoryFilterState>((set) => ({
  document: null,
  setDocument: (document) => set({ document }),
}));
