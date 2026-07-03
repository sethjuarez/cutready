import { afterEach, describe, expect, it, vi } from "vitest";

const mockInvoke = vi.hoisted(() => vi.fn());
const mockPreflightDraftlineSwitchVariation = vi.hoisted(() => vi.fn());
const mockSwitchDraftlineVariation = vi.hoisted(() => vi.fn());

vi.mock("@tauri-apps/api/core", () => ({
  invoke: (...args: unknown[]) => mockInvoke(...args),
  Channel: class {},
}));

vi.mock("../services/draftlineVersioning", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../services/draftlineVersioning")>();
  return {
    ...actual,
    preflightDraftlineSwitchVariation: (...args: unknown[]) => mockPreflightDraftlineSwitchVariation(...args),
    switchDraftlineVariation: (...args: unknown[]) => mockSwitchDraftlineVariation(...args),
  };
});

import { useAppStore } from "../stores/appStore";
import type { Sketch, SketchSummary } from "../types/sketch";

const oldProject = {
  root: "D:\\workspace\\alpha",
  repo_root: "D:\\workspace",
  name: "Alpha",
};

const newProject = {
  root: "D:\\workspace\\beta",
  repo_root: "D:\\workspace",
  name: "Beta",
};

const restoredSketchSummary: SketchSummary = {
  path: "new.sk",
  title: "New sketch",
  state: "draft",
  row_count: 0,
  created_at: "2026-01-01T00:00:00Z",
  updated_at: "2026-01-01T00:00:00Z",
};

const restoredSketch: Sketch = {
  title: "New sketch",
  description: "",
  rows: [],
  state: "draft",
  created_at: "2026-01-01T00:00:00Z",
  updated_at: "2026-01-01T00:00:00Z",
};

const originalState = {
  loadSketches: useAppStore.getState().loadSketches,
  loadStoryboards: useAppStore.getState().loadStoryboards,
  loadNotes: useAppStore.getState().loadNotes,
  loadSidebarOrder: useAppStore.getState().loadSidebarOrder,
  loadVersions: useAppStore.getState().loadVersions,
  loadTimelines: useAppStore.getState().loadTimelines,
  loadGraphData: useAppStore.getState().loadGraphData,
  checkDirty: useAppStore.getState().checkDirty,
  checkRewound: useAppStore.getState().checkRewound,
  checkStash: useAppStore.getState().checkStash,
  loadChatSession: useAppStore.getState().loadChatSession,
  switchTimeline: useAppStore.getState().switchTimeline,
  refreshSyncStatus: useAppStore.getState().refreshSyncStatus,
};

describe("project switch store side effects", () => {
  afterEach(() => {
    mockInvoke.mockReset();
    mockPreflightDraftlineSwitchVariation.mockReset();
    mockSwitchDraftlineVariation.mockReset();
    useAppStore.setState({
      ...originalState,
      currentProject: null,
      openTabs: [],
      activeTabId: null,
      sketches: [],
      storyboards: [],
      notes: [],
      activeSketchPath: null,
      activeSketch: null,
      chatSessionPath: null,
      isDirty: false,
      loading: false,
      projectSwitching: false,
      startedBranchFromSnapshot: null,
      currentRemote: null,
      remoteBranches: [],
      remoteBranchesLoading: false,
      timelines: [],
      isSyncing: false,
      syncError: null,
    });
  });

  it("saves outgoing UI state and restores incoming UI state without abandoning dirty workspace content", async () => {
    const loadChatSession = vi.fn(() => Promise.resolve());

    mockInvoke.mockImplementation((command: string) => {
      switch (command) {
        case "set_workspace_state":
          return Promise.resolve(null);
        case "switch_project":
          return Promise.resolve(newProject);
        case "get_workspace_state":
          return Promise.resolve({
            open_tabs: [{ id: "sketch-new.sk", type: "sketch", path: "new.sk", title: "New sketch" }],
            active_tab_id: "sketch-new.sk",
            chat_session_path: "cutready://legacy-chats/chat.chat",
          });
        case "get_sketch":
          return Promise.resolve(restoredSketch);
        default:
          return Promise.resolve([]);
      }
    });

    useAppStore.setState({
      currentProject: oldProject,
      openTabs: [{ id: "sketch-old.sk", type: "sketch", path: "old.sk", title: "Old sketch" }],
      activeTabId: "sketch-old.sk",
      chatSessionPath: "cutready://legacy-chats/old.chat",
      isDirty: true,
      startedBranchFromSnapshot: { branchName: "from-old", snapshotId: "snapshot-1" },
      loadSketches: async () => useAppStore.setState({ sketches: [restoredSketchSummary] }),
      loadStoryboards: async () => useAppStore.setState({ storyboards: [] }),
      loadNotes: async () => useAppStore.setState({ notes: [] }),
      loadSidebarOrder: vi.fn(() => Promise.resolve()),
      loadVersions: vi.fn(() => Promise.resolve()),
      loadTimelines: vi.fn(() => Promise.resolve()),
      loadGraphData: vi.fn(() => Promise.resolve()),
      checkDirty: async () => useAppStore.setState({ isDirty: true }),
      checkRewound: vi.fn(() => Promise.resolve()),
      checkStash: vi.fn(() => Promise.resolve()),
      loadChatSession,
    });

    const switchPromise = useAppStore.getState().switchProject("beta");

    expect(useAppStore.getState().projectSwitching).toBe(true);

    await switchPromise;

    expect(mockInvoke).toHaveBeenCalledWith("set_workspace_state", {
      workspace: {
        open_tabs: [{ id: "sketch-old.sk", type: "sketch", path: "old.sk", title: "Old sketch" }],
        active_tab_id: "sketch-old.sk",
        chat_session_path: "cutready://legacy-chats/old.chat",
      },
    });
    expect(mockInvoke).toHaveBeenCalledWith("switch_project", { projectPath: "beta" });
    expect(useAppStore.getState().currentProject).toEqual(newProject);
    expect(useAppStore.getState().openTabs).toEqual([
      { id: "sketch-new.sk", type: "sketch", path: "new.sk", title: "New sketch" },
    ]);
    expect(useAppStore.getState().activeSketch).toEqual(restoredSketch);
    expect(useAppStore.getState().isDirty).toBe(true);
    expect(useAppStore.getState().startedBranchFromSnapshot).toEqual({
      branchName: "from-old",
      snapshotId: "snapshot-1",
    });
    expect(useAppStore.getState().projectSwitching).toBe(false);
    expect(loadChatSession).toHaveBeenCalledWith("cutready://legacy-chats/chat.chat");
  });

  it("lists remote-only branches and adopts one before switching", async () => {
    const switchTimeline = vi.fn(() => Promise.resolve());
    mockInvoke.mockImplementation((command: string) => {
      switch (command) {
        case "list_remote_variations":
          return Promise.resolve([
            { id: "main", name: "main", remote: "origin", head_version: null },
            { id: "teammate-option", name: "teammate-option", remote: "origin", head_version: null },
          ]);
        case "adopt_remote_variation":
          return Promise.resolve({
            variation: { id: "teammate-option", name: "teammate-option", metadata: {}, is_current: false },
            postconditions: { errors: [] },
          });
        default:
          return Promise.resolve([]);
      }
    });

    useAppStore.setState({
      currentRemote: { name: "origin", url: "https://github.com/example/repo.git" },
      timelines: [{ name: "main", label: "main", is_active: true, snapshot_count: 1, color_index: 0 }],
      isDirty: false,
      switchTimeline,
      loadTimelines: vi.fn(() => Promise.resolve()),
      loadGraphData: vi.fn(() => Promise.resolve()),
      refreshSyncStatus: vi.fn(() => Promise.resolve()),
    });

    await expect(useAppStore.getState().loadRemoteBranches()).resolves.toEqual([
      { id: "teammate-option", name: "teammate-option", remote: "origin", head_message: undefined, head_author: undefined, head_timestamp: undefined },
    ]);
    expect(useAppStore.getState().remoteBranches).toEqual([
      { id: "teammate-option", name: "teammate-option", remote: "origin", head_message: undefined, head_author: undefined, head_timestamp: undefined },
    ]);

    await useAppStore.getState().checkoutRemoteTimeline("teammate-option");

    expect(mockInvoke).toHaveBeenCalledWith("adopt_remote_variation", {
      request: { workspace_path: "D:\\workspace", remote: "origin", variation_id: "teammate-option" },
    });
    expect(switchTimeline).toHaveBeenCalledWith("teammate-option");
  });

  it("reconciles active tabs and documents after switching timelines", async () => {
    mockPreflightDraftlineSwitchVariation.mockResolvedValueOnce({ can_proceed: true, dirty_files: [] });
    mockSwitchDraftlineVariation.mockResolvedValueOnce(null);
    mockInvoke.mockImplementation((command: string) => {
      switch (command) {
        case "get_note":
          return Promise.resolve("kept note content");
        case "get_note_lock":
          return Promise.resolve({ locked: false });
        default:
          return Promise.resolve(null);
      }
    });

    useAppStore.setState({
      openTabs: [
        { id: "sketch-old.sk", type: "sketch", path: "old.sk", title: "Old sketch" },
        { id: "note-keep.md", type: "note", path: "keep.md", title: "Keep" },
        { id: "storyboard-old.sb", type: "storyboard", path: "old.sb", title: "Old storyboard" },
      ],
      activeTabId: "sketch-old.sk",
      splitTabs: [
        { id: "split-sketch-old.sk", type: "sketch", path: "old.sk", title: "Old sketch" },
        { id: "split-note-keep.md", type: "note", path: "keep.md", title: "Keep" },
      ],
      splitActiveTabId: "split-sketch-old.sk",
      activeEditorGroup: "split",
      activeSketchPath: "old.sk",
      activeSketch: { title: "Old sketch", description: "", rows: [], state: "draft", created_at: "", updated_at: "" },
      loadSketches: async () => useAppStore.setState({ sketches: [] }),
      loadStoryboards: async () => useAppStore.setState({ storyboards: [] }),
      loadNotes: async () => useAppStore.setState({
        notes: [{ path: "keep.md", title: "Keep", size: 17, updated_at: "2026-01-01T00:00:00Z" }],
      }),
      loadTimelines: vi.fn(() => Promise.resolve()),
      loadVersions: vi.fn(() => Promise.resolve()),
      loadGraphData: vi.fn(() => Promise.resolve()),
      checkDirty: vi.fn(() => Promise.resolve()),
    });

    await useAppStore.getState().switchTimeline("next");

    expect(mockPreflightDraftlineSwitchVariation).toHaveBeenCalledWith("next");
    expect(mockSwitchDraftlineVariation).toHaveBeenCalledWith("next");
    expect(useAppStore.getState().openTabs).toEqual([
      { id: "note-keep.md", type: "note", path: "keep.md", title: "Keep" },
    ]);
    expect(useAppStore.getState().splitTabs).toEqual([
      { id: "split-note-keep.md", type: "note", path: "keep.md", title: "Keep" },
    ]);
    expect(useAppStore.getState().activeTabId).toBe("note-keep.md");
    expect(useAppStore.getState().splitActiveTabId).toBe("split-note-keep.md");
    expect(useAppStore.getState().activeNotePath).toBe("keep.md");
    expect(useAppStore.getState().activeNoteContent).toBe("kept note content");
    expect(useAppStore.getState().activeSketchPath).toBeNull();
    expect(useAppStore.getState().activeSketch).toBeNull();
  });

  it("ignores a late sketch open after another sketch becomes active", async () => {
    let resolveOld!: (sketch: Sketch) => void;
    let resolveNew!: (sketch: Sketch) => void;
    const oldSketchRequest = new Promise<Sketch>((resolve) => {
      resolveOld = resolve;
    });
    const newSketchRequest = new Promise<Sketch>((resolve) => {
      resolveNew = resolve;
    });

    mockInvoke.mockImplementation((command: string, args: { relativePath?: string }) => {
      if (command !== "get_sketch") return Promise.resolve(null);
      if (args.relativePath === "old.sk") return oldSketchRequest;
      return newSketchRequest;
    });

    const oldOpen = useAppStore.getState().openSketch("old.sk");
    const newOpen = useAppStore.getState().openSketch("new.sk");

    resolveNew({ title: "New sketch", description: "", rows: [], state: "draft", created_at: "", updated_at: "" });
    await newOpen;
    resolveOld({ title: "Old sketch", description: "", rows: [], state: "draft", created_at: "", updated_at: "" });
    await oldOpen;

    expect(useAppStore.getState().activeSketchPath).toBe("new.sk");
    expect(useAppStore.getState().activeSketch?.title).toBe("New sketch");
    expect(useAppStore.getState().openTabs).toContainEqual({
      id: "sketch-new.sk",
      type: "sketch",
      path: "new.sk",
      title: "New sketch",
    });
    expect(useAppStore.getState().openTabs).not.toContainEqual({
      id: "sketch-old.sk",
      type: "sketch",
      path: "old.sk",
      title: "Old sketch",
    });
  });
});
