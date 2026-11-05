// Project imports in flight. Entry points (sidebar, palette, file drops) request an import here,
// and the ProjectImport controller runs it, so only one import runs at a time.
import { create } from "zustand";

export type ImportRequest =
  | { kind: "files" }
  | { kind: "video" }
  | { kind: "clipboard" }
  | { kind: "paths"; paths: string[] };

/** A request bound to the project that was open when it was made. */
export type PendingImport = ImportRequest & { projectRoot: string };

interface ImportState {
  /** True from the moment a request is accepted until its import finishes or is cancelled. */
  busy: boolean;
  pending: PendingImport | null;
  /** A file drag is over the sidebar. */
  dropActive: boolean;
  /** Accepts `request` for `projectRoot` unless another import is running; returns whether it was accepted. */
  requestImport: (request: ImportRequest, projectRoot: string | null | undefined) => boolean;
  /** Hands the pending request to the controller, leaving the store busy until `finish`. */
  take: () => PendingImport | null;
  finish: () => void;
  setDropActive: (active: boolean) => void;
}

export const useImportStore = create<ImportState>((set, get) => ({
  busy: false,
  pending: null,
  dropActive: false,
  requestImport: (request, projectRoot) => {
    if (!projectRoot || get().busy) return false;
    set({ busy: true, pending: { ...request, projectRoot } });
    return true;
  },
  take: () => {
    const pending = get().pending;
    if (pending) set({ pending: null });
    return pending;
  },
  finish: () => set({ busy: false, pending: null }),
  setDropActive: (active) => {
    if (get().dropActive !== active) set({ dropActive: active });
  },
}));
