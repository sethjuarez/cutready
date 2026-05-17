import { afterEach, describe, expect, it, vi } from "vitest";

const mockInvoke = vi.hoisted(() => vi.fn());

vi.mock("@tauri-apps/api/core", () => ({
  invoke: (...args: unknown[]) => mockInvoke(...args),
  Channel: class {},
}));

import { useAppStore } from "../stores/appStore";
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
    mockInvoke.mockReset();
    useAppStore.setState({
      activeSketchPath: null,
      activeSketch: null,
      activeStoryboardPath: null,
      activeStoryboard: null,
      activeNotePath: null,
      activeNoteContent: null,
      activeNoteLocked: false,
      sketches: [],
      storyboards: [],
      notes: [],
      openTabs: [],
      activeTabId: null,
      changedFiles: [],
      isDirty: false,
      editorReloadKey: 0,
    });
  });

  it("refreshes the active sketch after discarding its in-flight edits", async () => {
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
    expect(useAppStore.getState().isDirty).toBe(false);
  });
});
