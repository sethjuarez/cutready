import { act, cleanup, fireEvent, render, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const ipc = vi.hoisted(() => ({ read: vi.fn(), save: vi.fn(), createCopy: vi.fn() }));

vi.mock("@tauri-apps/api/core", () => ({
  invoke: vi.fn(() => Promise.resolve([])),
  Channel: class {},
  convertFileSrc: (path: string) => path,
}));
vi.mock("../ipc/documents", () => ({ documentsIpc: ipc }));
vi.mock("../hooks/useSettings", () => ({ useSettings: () => ({ settings: {}, updateSetting: vi.fn() }) }));
vi.mock("../utils/exportToWord", () => ({ exportNoteToWord: vi.fn() }));
vi.mock("../components/MarkdownEditor", () => ({
  MarkdownEditor: ({ value, onChange }: { value: string; onChange: (value: string) => void }) => (
    <textarea aria-label="note markdown" value={value} onChange={(event) => onChange(event.target.value)} />
  ),
}));

import { NoteEditor } from "../components/NoteEditor";
import { INSTALL_SETTLE_MS, isDocumentConflict, loadDocument, saveDocument } from "../services/documentSaves";
import { useAppStore } from "../stores/appStore";
import { resetDocumentVersions } from "../stores/documentVersionStore";
import type { ProjectView } from "../types/project";

const PATH = "notes/demo.md";
const note = (content: string, version: string) => ({ document: content, content, version, merged: false });
const settle = () => new Promise((resolve) => setTimeout(resolve, INSTALL_SETTLE_MS + 20));

beforeEach(() => {
  resetDocumentVersions();
  ipc.read.mockReset();
  ipc.save.mockReset();
  ipc.createCopy.mockReset();
  useAppStore.setState({
    currentProject: { root: "D:\\demo", name: "demo" } as unknown as ProjectView,
    openTabs: [{ id: `main:note:${PATH}`, type: "note", path: PATH, title: "demo" }],
    splitTabs: [],
    activeNotePath: PATH,
    activeNoteContent: "base",
    activeNoteLocked: false,
    notePreviewPaths: new Set(),
  });
});

afterEach(() => {
  cleanup();
  useAppStore.setState({ currentProject: null, openTabs: [], activeNotePath: null, activeNoteContent: null });
});

describe("main note editor during a conflict", () => {
  it("refuses the conflict reload while typing is pending, so that typing goes to the copy", async () => {
    ipc.read.mockResolvedValueOnce(note("base", "h0"));
    await loadDocument("note", PATH);
    await settle();
    render(<NoteEditor />);

    const saves: Array<{ path: unknown; content: string; expectedVersion: unknown }> = [];
    ipc.save.mockImplementation((_: string, args: Record<string, unknown>) => {
      saves.push({ path: args.relativePath, content: String(args.content), expectedVersion: args.expectedVersion });
      if (saves.length === 1) return Promise.reject({ code: "stale_document" });
      return Promise.resolve(note(String(args.content), `v${saves.length}`));
    });
    ipc.createCopy.mockResolvedValue(note("", "c0"));
    let finishReload!: (value: unknown) => void;
    ipc.read.mockReturnValueOnce(new Promise((resolve) => (finishReload = resolve)));
    ipc.read.mockResolvedValue(note("theirs", "h9"));

    await expect(saveDocument("update_note", { relativePath: PATH, content: "mine" })).rejects.toSatisfy(isDocumentConflict);
    const copyPath = ipc.createCopy.mock.calls[0][0] as string;
    await waitFor(() => expect(ipc.read).toHaveBeenCalledTimes(2));

    // The user types in the main editor while the reload reads the document.
    const textarea = document.querySelector("textarea")!;
    fireEvent.change(textarea, { target: { value: "typed" } });
    await act(async () => finishReload(note("theirs", "h9")));

    // The redirect stays: the next save, of the pending typing, goes to the copy.
    await waitFor(() => expect(saves.length).toBeGreaterThan(2));
    expect(saves[2]).toMatchObject({ path: copyPath, content: expect.stringContaining("typed") });

    // Once the typing is saved the reload is accepted, and saves go to the document again.
    await waitFor(() => expect(textarea.value).toBe("theirs"));
    await settle();
    await saveDocument("update_note", { relativePath: PATH, content: "after" });
    expect(saves.filter((save) => save.content.includes("typed")).map((save) => save.path)).toEqual([copyPath]);
    expect(saves[saves.length - 1]).toMatchObject({ path: PATH, content: "after", expectedVersion: "h9" });
  });
});
