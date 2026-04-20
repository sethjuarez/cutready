import { act, fireEvent, render, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { NoteEditor } from "../components/NoteEditor";
import { useAppStore } from "../stores/appStore";

const openNote = vi.fn();

vi.mock("@tauri-apps/api/core", () => ({
  invoke: vi.fn(),
  convertFileSrc: (path: string) => path,
}));

vi.mock("../hooks/useSettings", () => ({
  useSettings: () => ({
    settings: {},
    updateSetting: vi.fn(),
  }),
}));

vi.mock("../utils/exportToWord", () => ({
  exportNoteToWord: vi.fn(),
}));

vi.mock("../components/MarkdownEditor", () => ({
  MarkdownEditor: ({ value, onChange }: { value: string; onChange: (value: string) => void }) => (
    <textarea aria-label="note markdown" value={value} onChange={(event) => onChange(event.target.value)} />
  ),
}));

describe("NoteEditor", () => {
  const addActivityEntries = vi.fn();

  beforeEach(() => {
    openNote.mockClear();
    addActivityEntries.mockClear();
    useAppStore.setState({
      activeNotePath: "notes/demo.md",
      activeNoteContent: "Initial content",
      activeNoteLocked: false,
      currentProject: null,
      addActivityEntries,
      openNote,
      updateNote: vi.fn(),
      setNoteLocked: vi.fn(),
      setNotePreview: vi.fn(),
      notePreviewPaths: new Set(),
    });
  });

  it("refreshes the active note when an AI update event names the same path", async () => {
    render(<NoteEditor />);

    act(() => {
      window.dispatchEvent(new CustomEvent("cutready:ai-note-updated", {
        detail: { path: "notes/demo.md" },
      }));
    });

    await waitFor(() => expect(openNote).toHaveBeenCalledWith("notes/demo.md"));
  });

  it("does not refresh over unsaved local edits", async () => {
    render(<NoteEditor />);

    fireEvent.change(document.querySelector("textarea")!, {
      target: { value: "Unsaved local edit" },
    });
    act(() => {
      window.dispatchEvent(new CustomEvent("cutready:ai-note-updated", {
        detail: { path: "notes/demo.md" },
      }));
    });

    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(openNote).not.toHaveBeenCalled();
    expect(addActivityEntries).toHaveBeenCalledWith([
      expect.objectContaining({
        level: "warn",
        content: expect.stringContaining("local unsaved edits were preserved"),
      }),
    ]);
  });

  it("ignores AI update events for a different note path", async () => {
    render(<NoteEditor />);

    act(() => {
      window.dispatchEvent(new CustomEvent("cutready:ai-note-updated", {
        detail: { path: "notes/other.md" },
      }));
    });

    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(openNote).not.toHaveBeenCalled();
    expect(addActivityEntries).not.toHaveBeenCalled();
  });
});
