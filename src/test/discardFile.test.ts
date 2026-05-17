import { afterEach, describe, expect, it, vi } from "vitest";

const mockInvoke = vi.hoisted(() => vi.fn());

vi.mock("@tauri-apps/api/core", () => ({
  invoke: (...args: unknown[]) => mockInvoke(...args),
  Channel: class {},
}));

import { shouldSuppressEditorFlush, useAppStore } from "../stores/appStore";
import type { Sketch } from "../types/sketch";

const restoredSketch: Sketch = {
  title: "Restored sketch",
  description: "Back to the last snapshot",
  rows: [
    {
      time: "0:00",
      narrative: "Restored row",
      demo_actions: "Show restored content",
      screenshot: null,
    },
  ],
  state: "draft",
  created_at: "2026-01-01T00:00:00Z",
  updated_at: "2026-01-01T00:00:00Z",
};

describe("discardFile", () => {
  afterEach(() => {
    vi.useRealTimers();
    mockInvoke.mockReset();
    useAppStore.setState({
      activeSketchPath: null,
      activeSketch: null,
      activeStoryboardPath: null,
      activeStoryboard: null,
      activeNotePath: null,
      activeNoteContent: null,
      activeNoteLocked: false,
      currentProject: null,
      sketches: [],
      storyboards: [],
      notes: [],
      openTabs: [],
      activeTabId: null,
      changedFiles: [],
      isDirty: false,
      editorReloadKey: 0,
      editorReloadPath: null,
      splitTabs: [],
      splitActiveTabId: null,
    });
  });

  it("refreshes the active sketch after discarding its in-flight edits", async () => {
    vi.useFakeTimers();
    mockInvoke.mockImplementation((command: string) => {
      switch (command) {
        case "discard_file":
          return Promise.resolve();
        case "list_sketches":
          return Promise.resolve([
            { path: "demo.sk", title: "Restored sketch", state: "draft", row_count: 1, created_at: "", updated_at: "" },
          ]);
        case "list_storyboards":
        case "list_notes":
          return Promise.resolve([]);
        case "get_sketch":
          return Promise.resolve(restoredSketch);
        case "has_unsaved_changes":
          return Promise.resolve(false);
        case "diff_working_tree":
          return Promise.resolve([]);
        case "set_workspace_state":
          return Promise.resolve();
        default:
          return Promise.resolve(null);
      }
    });

    useAppStore.setState({
      activeSketchPath: "demo.sk",
      activeSketch: {
        ...restoredSketch,
        title: "Accidental edit",
        rows: [],
      },
      openTabs: [{ id: "sketch:demo.sk", type: "sketch", path: "demo.sk", title: "Demo" }],
      activeTabId: "sketch:demo.sk",
    });

    await useAppStore.getState().discardFile("demo.sk");

    expect(mockInvoke).toHaveBeenCalledWith("discard_file", { filePath: "demo.sk" });
    expect(mockInvoke).toHaveBeenCalledWith("get_sketch", { relativePath: "demo.sk" });
    expect(useAppStore.getState().activeSketch).toEqual(restoredSketch);
    expect(useAppStore.getState().editorReloadKey).toBe(1);
    expect(useAppStore.getState().editorReloadPath).toBe("demo.sk");
    expect(shouldSuppressEditorFlush("demo.sk")).toBe(true);
    vi.advanceTimersByTime(100);
    expect(shouldSuppressEditorFlush("demo.sk")).toBe(false);
    expect(useAppStore.getState().isDirty).toBe(false);
  });

  it("matches repo-scoped changed paths to project-relative open editors", async () => {
    vi.useFakeTimers();
    mockInvoke.mockImplementation((command: string) => {
      switch (command) {
        case "discard_file":
          return Promise.resolve();
        case "list_sketches":
          return Promise.resolve([
            { path: "demo.sk", title: "Restored sketch", state: "draft", row_count: 1, created_at: "", updated_at: "" },
          ]);
        case "list_storyboards":
        case "list_notes":
          return Promise.resolve([]);
        case "get_sketch":
          return Promise.resolve(restoredSketch);
        case "has_unsaved_changes":
          return Promise.resolve(false);
        case "diff_working_tree":
          return Promise.resolve([]);
        case "set_workspace_state":
          return Promise.resolve();
        default:
          return Promise.resolve(null);
      }
    });

    useAppStore.setState({
      currentProject: {
        root: "D:\\repo\\project-a",
        repo_root: "D:\\repo",
        name: "Project A",
      },
      activeSketchPath: "demo.sk",
      activeSketch: {
        ...restoredSketch,
        title: "Accidental edit",
        rows: [],
      },
      openTabs: [{ id: "sketch-demo.sk", type: "sketch", path: "demo.sk", title: "Demo" }],
      activeTabId: "sketch-demo.sk",
    });

    await useAppStore.getState().discardFile("project-a/demo.sk");

    expect(mockInvoke).toHaveBeenCalledWith("discard_file", { filePath: "project-a/demo.sk" });
    expect(mockInvoke).toHaveBeenCalledWith("get_sketch", { relativePath: "demo.sk" });
    expect(useAppStore.getState().activeSketch).toEqual(restoredSketch);
    expect(useAppStore.getState().editorReloadPath).toBe("demo.sk");
    expect(shouldSuppressEditorFlush("project-a/demo.sk")).toBe(true);
    expect(shouldSuppressEditorFlush("demo.sk")).toBe(true);
    vi.advanceTimersByTime(100);
    expect(shouldSuppressEditorFlush("project-a/demo.sk")).toBe(false);
    expect(shouldSuppressEditorFlush("demo.sk")).toBe(false);
  });

  it("signals a remount when discarding a file that is only open in the split pane", async () => {
    vi.useFakeTimers();
    mockInvoke.mockImplementation((command: string) => {
      switch (command) {
        case "discard_file":
          return Promise.resolve();
        case "list_sketches":
          return Promise.resolve([
            { path: "demo.sk", title: "Restored sketch", state: "draft", row_count: 1, created_at: "", updated_at: "" },
          ]);
        case "list_storyboards":
        case "list_notes":
          return Promise.resolve([]);
        case "has_unsaved_changes":
          return Promise.resolve(false);
        case "diff_working_tree":
          return Promise.resolve([]);
        case "set_workspace_state":
          return Promise.resolve();
        default:
          return Promise.resolve(null);
      }
    });

    useAppStore.setState({
      activeNotePath: "notes.md",
      activeNoteContent: "keep editing",
      openTabs: [{ id: "note-notes.md", type: "note", path: "notes.md", title: "Notes" }],
      activeTabId: "note-notes.md",
      splitTabs: [{ id: "split-sketch-demo.sk", type: "sketch", path: "demo.sk", title: "Demo" }],
      splitActiveTabId: "split-sketch-demo.sk",
      editorReloadKey: 3,
    });

    await useAppStore.getState().discardFile("demo.sk");

    expect(useAppStore.getState().splitTabs).toEqual([
      { id: "split-sketch-demo.sk", type: "sketch", path: "demo.sk", title: "Demo" },
    ]);
    expect(useAppStore.getState().editorReloadKey).toBe(4);
    expect(useAppStore.getState().editorReloadPath).toBe("demo.sk");
    expect(useAppStore.getState().activeNotePath).toBe("notes.md");
    expect(mockInvoke).not.toHaveBeenCalledWith("get_sketch", { relativePath: "demo.sk" });
    vi.advanceTimersByTime(100);
    expect(shouldSuppressEditorFlush("demo.sk")).toBe(false);
  });

  it("closes open tabs when discarding an untracked file removes it", async () => {
    vi.useFakeTimers();
    mockInvoke.mockImplementation((command: string) => {
      switch (command) {
        case "discard_file":
          return Promise.resolve();
        case "list_sketches":
        case "list_storyboards":
        case "list_notes":
        case "diff_working_tree":
          return Promise.resolve([]);
        case "has_unsaved_changes":
          return Promise.resolve(false);
        case "set_workspace_state":
          return Promise.resolve();
        default:
          return Promise.resolve(null);
      }
    });

    useAppStore.setState({
      activeNotePath: "notes.md",
      activeNoteContent: "keep editing",
      openTabs: [
        { id: "note-notes.md", type: "note", path: "notes.md", title: "Notes" },
        { id: "sketch-new.sk", type: "sketch", path: "new.sk", title: "New" },
      ],
      activeTabId: "note-notes.md",
      splitTabs: [{ id: "split-sketch-new.sk", type: "sketch", path: "new.sk", title: "New" }],
      splitActiveTabId: "split-sketch-new.sk",
    });

    await useAppStore.getState().discardFile("new.sk");

    expect(useAppStore.getState().openTabs).toEqual([
      { id: "note-notes.md", type: "note", path: "notes.md", title: "Notes" },
    ]);
    expect(useAppStore.getState().splitTabs).toEqual([]);
    expect(useAppStore.getState().splitActiveTabId).toBeNull();
    expect(useAppStore.getState().activeTabId).toBe("note-notes.md");
    vi.advanceTimersByTime(100);
    expect(shouldSuppressEditorFlush("new.sk")).toBe(false);
  });

  it("suppresses all open editor flushes when discarding every project change", async () => {
    vi.useFakeTimers();
    mockInvoke.mockImplementation((command: string) => {
      switch (command) {
        case "discard_changes":
          return Promise.resolve();
        case "list_sketches":
        case "list_storyboards":
        case "list_notes":
          return Promise.resolve([]);
        case "has_unsaved_changes":
          return Promise.resolve(false);
        default:
          return Promise.resolve(null);
      }
    });

    useAppStore.setState({
      activeSketchPath: "active.sk",
      activeSketch: restoredSketch,
      openTabs: [
        { id: "sketch-active.sk", type: "sketch", path: "active.sk", title: "Active" },
        { id: "note-notes.md", type: "note", path: "notes.md", title: "Notes" },
      ],
      activeTabId: "sketch-active.sk",
      splitTabs: [{ id: "split-storyboard-demo.sb", type: "storyboard", path: "demo.sb", title: "Demo" }],
      splitActiveTabId: "split-storyboard-demo.sb",
    });

    await useAppStore.getState().discardChanges();

    expect(useAppStore.getState().openTabs).toEqual([]);
    expect(useAppStore.getState().splitTabs).toEqual([]);
    expect(shouldSuppressEditorFlush("active.sk")).toBe(true);
    expect(shouldSuppressEditorFlush("notes.md")).toBe(true);
    expect(shouldSuppressEditorFlush("demo.sb")).toBe(true);
    vi.advanceTimersByTime(100);
    expect(shouldSuppressEditorFlush("active.sk")).toBe(false);
    expect(shouldSuppressEditorFlush("notes.md")).toBe(false);
    expect(shouldSuppressEditorFlush("demo.sb")).toBe(false);
  });
});
