import { afterEach, describe, expect, it, vi } from "vitest";

const mockInvoke = vi.hoisted(() => vi.fn());
const mockGetGitHubAuthStatus = vi.hoisted(() => vi.fn());
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

vi.mock("../services/githubSetup", () => ({
  getGitHubAuthStatus: (...args: unknown[]) => mockGetGitHubAuthStatus(...args),
}));

import { registerEditorFlush, useAppStore } from "../stores/appStore";
import { useToastStore } from "../stores/toastStore";
import { setDraftlineWorkspacePath } from "../services/draftlineVersioning";
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
  loadProjects: useAppStore.getState().loadProjects,
  loadSidebarOrder: useAppStore.getState().loadSidebarOrder,
  loadVersions: useAppStore.getState().loadVersions,
  loadTimelines: useAppStore.getState().loadTimelines,
  loadGraphData: useAppStore.getState().loadGraphData,
  checkDirty: useAppStore.getState().checkDirty,
  checkRewound: useAppStore.getState().checkRewound,
  checkStash: useAppStore.getState().checkStash,
  detectRemote: useAppStore.getState().detectRemote,
  switchTimeline: useAppStore.getState().switchTimeline,
  refreshSyncStatus: useAppStore.getState().refreshSyncStatus,
  openProject: useAppStore.getState().openProject,
  createProject: useAppStore.getState().createProject,
};

describe("project switch store side effects", () => {
  afterEach(() => {
    mockInvoke.mockReset();
    mockGetGitHubAuthStatus.mockReset();
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
      chatMessages: [],
      chatSessionPath: null,
      chatLoading: false,
      chatError: null,
      chatInputDraft: "",
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
      adoptionPrompt: null,
      error: null,
    });
  });

  it("saves outgoing UI state and restores incoming UI state without abandoning dirty workspace content", async () => {
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
    });

    const switchPromise = useAppStore.getState().switchProject("beta");

    expect(useAppStore.getState().projectSwitching).toBe(true);

    await switchPromise;

    expect(mockInvoke).toHaveBeenCalledWith("set_workspace_state", {
      workspace: {
        open_tabs: [{ id: "sketch-old.sk", type: "sketch", path: "old.sk", title: "Old sketch" }],
        active_tab_id: "sketch-old.sk",
        chat_session_path: null,
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
    expect(useAppStore.getState().chatSessionPath).toBeNull();
  });

  it("clears stale chat when opening a project with no saved chat session", async () => {
    mockInvoke.mockImplementation((command: string) => {
      switch (command) {
        case "open_project_folder":
          return Promise.resolve(newProject);
        case "get_workspace_state":
          return Promise.resolve({
            open_tabs: [],
            active_tab_id: null,
            chat_session_path: null,
          });
        default:
          return Promise.resolve([]);
      }
    });

    useAppStore.setState({
      currentProject: oldProject,
      chatMessages: [
        { role: "user", content: "old project question" },
        { role: "assistant", content: "old project answer" },
      ],
      chatSessionPath: "cutready://legacy-chats/old.chat",
      chatLoading: true,
      chatError: "old error",
      chatInputDraft: "old draft",
      loadProjects: vi.fn(() => Promise.resolve()),
      loadSketches: async () => useAppStore.setState({ sketches: [] }),
      loadStoryboards: async () => useAppStore.setState({ storyboards: [] }),
      loadNotes: async () => useAppStore.setState({ notes: [] }),
      loadSidebarOrder: vi.fn(() => Promise.resolve()),
      loadVersions: vi.fn(() => Promise.resolve()),
      loadTimelines: vi.fn(() => Promise.resolve()),
      loadGraphData: vi.fn(() => Promise.resolve()),
      checkDirty: vi.fn(() => Promise.resolve()),
      checkRewound: vi.fn(() => Promise.resolve()),
      checkStash: vi.fn(() => Promise.resolve()),
      detectRemote: vi.fn(() => Promise.resolve()),
    });

    await useAppStore.getState().openProject("D:\\workspace\\beta");

    expect(useAppStore.getState().currentProject).toEqual(newProject);
    expect(useAppStore.getState().chatMessages).toEqual([]);
    expect(useAppStore.getState().chatSessionPath).toBeNull();
    expect(useAppStore.getState().chatLoading).toBe(false);
    expect(useAppStore.getState().chatError).toBeNull();
    expect(useAppStore.getState().chatInputDraft).toBe("");
  });

  it("asks before managing a code repository, then creates the suggested folder", async () => {
    const refusal = JSON.stringify({
      code: "not_a_cutready_project",
      message: "not a project",
      details: {
        folder: "D:\\code\\contoso",
        repository: "D:\\code\\contoso",
        suggested: "D:\\code\\contoso\\cutready",
        suggested_exists: false,
      },
    });
    const createProject = vi.fn(() => Promise.resolve());
    const openProject = useAppStore.getState().openProject;
    mockInvoke.mockImplementation((command: string) =>
      command === "open_project_folder" ? Promise.reject(refusal) : Promise.resolve([]),
    );
    useAppStore.setState({ createProject, error: null });

    await openProject("D:\\code\\contoso");

    expect(mockInvoke).toHaveBeenCalledWith("open_project_folder", { path: "D:\\code\\contoso", adopt: false });
    expect(useAppStore.getState().error).toBeNull();
    expect(useAppStore.getState().currentProject).toBeNull();
    expect(useAppStore.getState().adoptionPrompt).toEqual({
      folder: "D:\\code\\contoso",
      repository: "D:\\code\\contoso",
      suggested: "D:\\code\\contoso\\cutready",
      suggestedExists: false,
    });

    await useAppStore.getState().resolveAdoptionPrompt("create");

    expect(createProject).toHaveBeenCalledWith("D:\\code\\contoso\\cutready");
    expect(useAppStore.getState().adoptionPrompt).toBeNull();
  });

  it("manages the folder as-is only when the user confirms", async () => {
    const openProject = vi.fn(() => Promise.resolve());
    useAppStore.setState({
      openProject,
      adoptionPrompt: { folder: "D:\\code\\contoso", repository: null, suggested: "D:\\code\\contoso\\cutready", suggestedExists: true },
    });

    await useAppStore.getState().resolveAdoptionPrompt("cancel");
    expect(openProject).not.toHaveBeenCalled();
    expect(useAppStore.getState().adoptionPrompt).toBeNull();

    useAppStore.setState({
      adoptionPrompt: { folder: "D:\\code\\contoso", repository: null, suggested: "D:\\code\\contoso\\cutready", suggestedExists: true },
    });
    await useAppStore.getState().resolveAdoptionPrompt("adopt");
    expect(openProject).toHaveBeenCalledWith("D:\\code\\contoso", { adopt: true });

    useAppStore.setState({
      adoptionPrompt: { folder: "D:\\code\\contoso", repository: null, suggested: "D:\\code\\contoso\\cutready", suggestedExists: true },
    });
    await useAppStore.getState().resolveAdoptionPrompt("create");
    expect(openProject).toHaveBeenCalledWith("D:\\code\\contoso\\cutready", { adopt: true });
  });

  it("moves the project folder and reopens it at the new location", async () => {
    const openProject = vi.fn(async (path: string) => {
      useAppStore.setState({ currentProject: { root: path, name: "cutready", repo_root: path, hybrid: true } });
    });
    const removeRecentProject = vi.fn(() => Promise.resolve());
    const order: string[] = [];
    const unregister = registerEditorFlush(async () => {
      order.push("flush");
    });
    setDraftlineWorkspacePath("D:\\workspace");
    mockInvoke.mockImplementation((command: string) =>
      command === "move_project_folder"
        ? Promise.resolve({ projectRoot: "D:\\workspace\\cutready", from: "", to: "cutready", hybrid: true, leftBehind: [] })
        : Promise.resolve(null),
    );
    useAppStore.setState({
      currentProject: { root: "D:\\workspace", name: "workspace", repo_root: "D:\\workspace" },
      openProject,
      removeRecentProject,
      checkDirty: async () => {
        order.push("checkDirty");
        useAppStore.setState({ isDirty: false });
      },
      moveFolderDialogOpen: true,
    });

    const result = await useAppStore.getState().moveProjectFolder("cutready");
    unregister();

    expect(order).toEqual(["flush", "checkDirty"]);
    expect(result.hybrid).toBe(true);
    expect(mockInvoke).toHaveBeenCalledWith("move_project_folder", {
      request: { workspace_path: "D:\\workspace", to: "cutready" },
    });
    expect(mockInvoke).toHaveBeenCalledWith("add_recent_project", { path: "D:\\workspace\\cutready" });
    expect(removeRecentProject).toHaveBeenCalledWith("D:\\workspace");
    expect(openProject).toHaveBeenCalledWith("D:\\workspace\\cutready");
    expect(useAppStore.getState().moveFolderDialogOpen).toBe(false);
  });

  it("closes the old project and says where it went when the moved project won't reopen", async () => {
    const openProject = vi.fn(async () => {
      useAppStore.setState({ error: "folder is busy" });
    });
    const realCloseProject = useAppStore.getState().closeProject;
    const closeProject = vi.fn(() => useAppStore.setState({ currentProject: null }));
    setDraftlineWorkspacePath("D:\\workspace");
    mockInvoke.mockImplementation((command: string) =>
      command === "move_project_folder"
        ? Promise.resolve({ projectRoot: "D:\\workspace\\cutready", from: "", to: "cutready", hybrid: true, leftBehind: [] })
        : Promise.resolve(null),
    );
    useAppStore.setState({
      currentProject: { root: "D:\\workspace", name: "workspace", repo_root: "D:\\workspace" },
      openProject,
      closeProject,
      removeRecentProject: vi.fn(() => Promise.resolve()),
      checkDirty: async () => useAppStore.setState({ isDirty: false }),
    });
    const show = vi.spyOn(useToastStore.getState(), "show");

    await useAppStore.getState().moveProjectFolder("cutready");
    useAppStore.setState({ closeProject: realCloseProject });

    expect(closeProject).toHaveBeenCalled();
    expect(mockInvoke).toHaveBeenCalledWith("add_recent_project", { path: "D:\\workspace\\cutready" });
    expect(show).toHaveBeenCalledWith(expect.stringMatching(/couldn't reopen it \(folder is busy\)/), 10000, "error");
    show.mockRestore();
  });

  it("refuses to move the project folder with unsaved changes and keeps it open after a refusal", async () => {
    const openProject = vi.fn(() => Promise.resolve());
    setDraftlineWorkspacePath("D:\\workspace");
    useAppStore.setState({
      currentProject: { root: "D:\\workspace", name: "workspace", repo_root: "D:\\workspace" },
      openProject,
      checkDirty: async () => useAppStore.setState({ isDirty: true }),
      moveFolderDialogOpen: true,
    });
    await expect(useAppStore.getState().moveProjectFolder("cutready")).rejects.toThrow(/Save your changes/);
    expect(mockInvoke).not.toHaveBeenCalledWith("move_project_folder", expect.anything());

    mockInvoke.mockImplementation((command: string) =>
      command === "move_project_folder"
        ? Promise.reject({ code: "folder_move_refused", message: "cannot move the Draftline folder: occupied isn't empty" })
        : Promise.resolve(null),
    );
    useAppStore.setState({ checkDirty: async () => useAppStore.setState({ isDirty: false }) });
    await expect(useAppStore.getState().moveProjectFolder("occupied")).rejects.toMatchObject({ code: "folder_move_refused" });
    expect(openProject).not.toHaveBeenCalled();
    expect(useAppStore.getState().moveFolderDialogOpen).toBe(true);
  });

  it("lists remote-only branches and adopts one before switching", async () => {
    const switchTimeline = vi.fn(() => Promise.resolve());
    mockGetGitHubAuthStatus.mockResolvedValue({ connected: true });
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

  it("does not repopulate versions for a workspace closed mid-load (#263)", async () => {
    setDraftlineWorkspacePath("D:\\workspace");
    let resolveInspect!: (value: unknown) => void;
    mockInvoke.mockImplementation((command: string) => {
      if (command === "inspect_workspace") {
        return new Promise((resolve) => {
          resolveInspect = resolve;
        });
      }
      return Promise.resolve([]);
    });

    const sentinelVersions = [
      { id: "sentinel", message: "kept", timestamp: "2026-01-01T00:00:00Z", summary: "kept" },
    ];

    useAppStore.setState({ currentProject: oldProject, versions: [] });

    const load = useAppStore.getState().loadVersions();

    // The workspace closes while inspect is still pending.
    useAppStore.getState().closeProject();
    // A sentinel the new (empty) workspace owns; the stale load must not clobber it.
    useAppStore.setState({ versions: sentinelVersions });

    // The tauri invoke bridge dispatches asynchronously, so wait until the
    // inspect request has actually been issued before resolving it.
    await vi.waitFor(() => expect(resolveInspect).toBeTypeOf("function"));

    resolveInspect({
      summary: {
        active_variation: { id: "main", name: "main", metadata: { label: "main", slug: "main" }, is_current: true },
        variations: [],
        versions: [
          {
            id: "1111111111111111111111111111111111111111",
            label: "Stale head",
            author: { name: "Seth", email: null },
            saved_by: { name: "Seth", email: null },
            time_seconds: 1_700_000_000,
          },
        ],
        dirty_files: [],
        is_dirty: false,
        recovery: null,
        state_may_be_inconsistent: false,
      },
    });
    await load;

    expect(useAppStore.getState().versions).toEqual(sentinelVersions);
  });
});
