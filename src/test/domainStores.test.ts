import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const mockInvoke = vi.hoisted(() => vi.fn());

vi.mock("@tauri-apps/api/core", () => ({
  invoke: (...args: unknown[]) => mockInvoke(...args),
  Channel: class {},
}));

import { useAppStore } from "../stores/appStore";
import {
  initialVersioningState,
  resetVersioningState,
  useVersioningStore,
} from "../stores/versioningStore";
import { initialSyncState, resetSyncState, useSyncStore } from "../stores/syncStore";
import { initialChatState, useChatStore } from "../stores/chatStore";
import { initialRecordingState, useRecordingStore } from "../stores/recordingStore";

const alpha = { root: "D:\\workspace\\alpha", repo_root: "D:\\workspace", name: "Alpha" };
const beta = { root: "D:\\workspace\\beta", repo_root: "D:\\workspace", name: "Beta" };
const gamma = { root: "D:\\other\\gamma", repo_root: "D:\\other", name: "Gamma" };
const startedBranch = { branchName: "from-old", snapshotId: "snapshot-1" };

const originalAppState = { ...useAppStore.getState() };
const originalVersioningState = { ...useVersioningStore.getState() };
const originalSyncState = { ...useSyncStore.getState() };
const originalChatState = { ...useChatStore.getState() };
const originalRecordingState = { ...useRecordingStore.getState() };

function pick<T extends object>(state: T, keys: string[]) {
  return Object.fromEntries(keys.map((key) => [key, (state as Record<string, unknown>)[key]]));
}

function dirtyDomainStores() {
  useVersioningStore.setState({
    versions: [{ id: "v1" }] as never,
    timelines: [{ name: "main", label: "main", is_active: true, snapshot_count: 1, color_index: 0 }],
    graphNodes: [{ id: "n1" }] as never,
    startedBranchFromSnapshot: startedBranch,
    isDirty: true,
    changedFiles: [{ path: "intro.sk", status: "modified", additions: 1, deletions: 0 }],
    saving: true,
    setAsideShelves: [{ id: "cutready-stash", name: "Set-aside changes", timeMs: 0 }],
    projectHealthBusy: true,
    isRewound: true,
    isMerging: true,
    mergeSource: "main",
    mergeTarget: "feature",
    mergeConflicts: [{ path: "intro.sk" }] as never,
    draftlineMergeToken: { source: "main" } as never,
    draftlineMergeRemote: "origin",
    diffResult: [{ path: "intro.sk" }] as never,
    diffSelection: { from: "a", to: "b" } as never,
  });
  useSyncStore.setState({
    currentRemote: { name: "origin", url: "https://github.com/example/repo.git" },
    remoteBranches: [{ name: "feature" }] as never,
    remoteBranchesLoading: true,
    syncStatus: { ahead: 1, behind: 2 },
    baseStatus: { ahead: 1, behind: 2, base: "main" },
    isSyncing: true,
    syncError: "stale",
    baseRename: { from: "master", to: "main" } as never,
    incomingCommits: [{ id: "c1" }] as never,
    shareUrl: "https://example.com/share",
    sendForReviewPrompt: { branch: "cutready/x" } as never,
  });
}

const dirtyChat = {
  chatMessages: [{ role: "user" as const, content: "old project question" }],
  chatSessionPath: "old-session",
  chatLoading: true,
  chatError: "old error",
  chatInputDraft: "old draft",
  chatStreamingText: "partial",
  chatStreamingThinking: "thinking",
  chatStreamingStatus: "Connecting…",
  chatStreamingDrafts: ["draft one"],
  pendingChatPrompt: { text: "queued", silent: true, agent: "writer" },
  chatFocusMode: true,
};

function dirtyChatStore() {
  useChatStore.setState(dirtyChat);
}

/** Chat fields a project lifecycle action clears; every other chat field must be left untouched. */
function expectChatReset(clearedKeys: (keyof typeof dirtyChat)[]) {
  const initial = initialChatState();
  const expected = Object.fromEntries(
    Object.keys(dirtyChat).map((key) => {
      const k = key as keyof typeof dirtyChat;
      return [k, clearedKeys.includes(k) ? initial[k] : dirtyChat[k]];
    }),
  );
  expect(pick(useChatStore.getState(), Object.keys(dirtyChat))).toEqual(expected);
}

const dirtyRecording = {
  profiles: [{ browser: "msedge", profile_directory: "Default", display_name: "Work", user_data_dir: "C:\\edge" }],
  selectedProfile: { browser: "msedge", profile_directory: "Default", display_name: "Work", user_data_dir: "C:\\edge" },
  browserRunning: { chrome: false, msedge: true },
  isBrowserReady: true,
  browserChannel: "msedge",
  isRecording: true,
  recordingSessionId: "session-1",
  capturedActions: [{ action: { type: "Click" } }],
  lastSession: { id: "previous" },
  _activeChannel: {},
} as never as ReturnType<typeof initialRecordingState>;

const RECORDING_ACTIONS = [
  "detectProfiles", "checkBrowsersRunning", "setSelectedProfile",
  "prepareBrowser", "disconnectBrowser", "startRecording", "stopRecording",
];

/** Project lifecycle actions leave browser recording state alone (as they did in appStore). */
function expectRecordingUntouched() {
  expect(pick(useRecordingStore.getState(), Object.keys(dirtyRecording))).toEqual(dirtyRecording);
}

function stubLoaders() {
  useAppStore.setState({
    loadProjects: vi.fn(() => Promise.resolve()),
    loadSketches: vi.fn(() => Promise.resolve()),
    loadStoryboards: vi.fn(() => Promise.resolve()),
    loadNotes: vi.fn(() => Promise.resolve()),
    loadChatArtifacts: vi.fn(() => Promise.resolve()),
    loadSidebarOrder: vi.fn(() => Promise.resolve()),
  });
  useVersioningStore.setState({
    checkProjectHealth: vi.fn(() => Promise.resolve()),
    loadVersions: vi.fn(() => Promise.resolve()),
    loadTimelines: vi.fn(() => Promise.resolve()),
    loadGraphData: vi.fn(() => Promise.resolve()),
    checkDirty: vi.fn(() => Promise.resolve()),
    checkRewound: vi.fn(() => Promise.resolve()),
    checkStash: vi.fn(() => Promise.resolve()),
  });
  useSyncStore.setState({
    detectRemote: vi.fn(() => Promise.resolve()),
  });
}

function expectVersioningReset(overrides: Record<string, unknown> = {}) {
  const expected = { ...resetVersioningState(), ...overrides };
  expect(pick(useVersioningStore.getState(), Object.keys(expected))).toEqual(expected);
}

function expectSyncReset() {
  const expected = resetSyncState();
  expect(pick(useSyncStore.getState(), Object.keys(expected))).toEqual(expected);
}

describe("domain stores", () => {
  beforeEach(() => {
    mockInvoke.mockImplementation((command: string) => {
      switch (command) {
        case "open_project_folder":
          return Promise.resolve(beta);
        case "get_workspace_state":
          return Promise.resolve(null);
        default:
          return Promise.resolve([]);
      }
    });
  });

  afterEach(() => {
    mockInvoke.mockReset();
    useAppStore.setState(originalAppState, true);
    useVersioningStore.setState(originalVersioningState, true);
    useSyncStore.setState(originalSyncState, true);
    useChatStore.setState(originalChatState, true);
    useRecordingStore.setState(originalRecordingState, true);
  });

  it("keeps the moved versioning and sync keys out of appStore", () => {
    const appKeys = new Set(Object.keys(useAppStore.getState()));
    const versioningKeys = Object.keys(useVersioningStore.getState());
    const syncKeys = Object.keys(useSyncStore.getState());

    expect(versioningKeys.filter((key) => appKeys.has(key))).toEqual([]);
    expect(syncKeys.filter((key) => appKeys.has(key))).toEqual([]);
    expect(versioningKeys.filter((key) => syncKeys.includes(key))).toEqual([]);
    const chatKeys = Object.keys(useChatStore.getState());
    expect(chatKeys.filter((key) => appKeys.has(key))).toEqual([]);
    expect(chatKeys.filter((key) => versioningKeys.includes(key) || syncKeys.includes(key))).toEqual([]);
    for (const key of [...Object.keys(initialChatState()),
      "setChatMessages", "restoreChatSession", "newChatSession", "setChatLoading", "setChatError",
      "setChatInputDraft", "setChatStreamingState", "resetChatStreaming", "sendChatPrompt", "setChatFocusMode",
    ]) {
      expect(appKeys.has(key)).toBe(false);
      expect(chatKeys).toContain(key);
    }
    for (const key of ["chatArtifacts", "activeChatArtifactPath", "loadChatArtifacts", "openChatArtifact", "deleteChatArtifact", "activityLog", "debugLog"]) {
      expect(appKeys.has(key)).toBe(true);
    }
    for (const key of [
      "isDirty", "changedFiles", "saving", "isMerging", "saveVersion", "switchTimeline", "mergeTimelines",
      "syncStatus", "isSyncing", "syncError", "currentRemote", "pushToRemote", "sendForReview", "refreshSyncStatus",
    ]) {
      expect(appKeys.has(key)).toBe(false);
    }
  });

  it("starts the new stores from their initial state", () => {
    expect(pick(useVersioningStore.getState(), Object.keys(initialVersioningState()))).toEqual(initialVersioningState());
    expect(pick(useSyncStore.getState(), Object.keys(initialSyncState()))).toEqual(initialSyncState());
    expect(pick(useChatStore.getState(), Object.keys(initialChatState()))).toEqual(initialChatState());
  });

  it("opening a project resets versioning and sync state but leaves an in-flight save alone", async () => {
    useAppStore.setState({ currentProject: alpha });
    dirtyDomainStores();
    stubLoaders();

    await useAppStore.getState().openProject(beta.root);

    expect(useAppStore.getState().currentProject).toEqual(beta);
    expectVersioningReset();
    expect(useVersioningStore.getState().saving).toBe(true);
    expectSyncReset();
  });

  it("closing a project resets versioning and sync state synchronously", () => {
    useAppStore.setState({ currentProject: alpha });
    dirtyDomainStores();

    void useAppStore.getState().closeProject({ force: true });

    expect(useAppStore.getState().currentProject).toBeNull();
    expectVersioningReset();
    expect(useVersioningStore.getState().saving).toBe(true);
    expectSyncReset();
  });

  it("switching within the same repository keeps the started-from-snapshot branch and resets the rest", async () => {
    mockInvoke.mockImplementation((command: string) =>
      command === "switch_project" ? Promise.resolve(beta) : Promise.resolve(null),
    );
    useAppStore.setState({ currentProject: alpha });
    dirtyDomainStores();
    stubLoaders();

    await useAppStore.getState().switchProject(beta.root);

    expect(useAppStore.getState().currentProject).toEqual(beta);
    expectVersioningReset({ startedBranchFromSnapshot: startedBranch });
    expectSyncReset();
  });

  it("switching to another repository clears the started-from-snapshot branch", async () => {
    mockInvoke.mockImplementation((command: string) =>
      command === "switch_project" ? Promise.resolve(gamma) : Promise.resolve(null),
    );
    useAppStore.setState({ currentProject: alpha });
    dirtyDomainStores();
    stubLoaders();

    await useAppStore.getState().switchProject(gamma.root);

    expect(useAppStore.getState().currentProject).toEqual(gamma);
    expectVersioningReset();
    expectSyncReset();
  });

  it("opening a project clears the conversation but keeps focus mode, streaming state and any queued prompt", async () => {
    useAppStore.setState({ currentProject: alpha });
    dirtyChatStore();
    stubLoaders();

    await useAppStore.getState().openProject(beta.root);

    expect(useAppStore.getState().currentProject).toEqual(beta);
    expectChatReset(["chatMessages", "chatSessionPath", "chatLoading", "chatError", "chatInputDraft"]);
  });

  it("creating a project clears only the conversation and its session", async () => {
    mockInvoke.mockImplementation((command: string) =>
      command === "create_project_folder" ? Promise.resolve(beta) : Promise.resolve([]),
    );
    useAppStore.setState({ currentProject: alpha, loadRecentProjects: vi.fn(() => Promise.resolve()) });
    dirtyChatStore();
    stubLoaders();

    await useAppStore.getState().createProject(beta.root);

    expect(useAppStore.getState().currentProject).toEqual(beta);
    expectChatReset(["chatMessages", "chatSessionPath"]);
  });

  it("closing a project clears the conversation and queued prompt synchronously but keeps the draft", () => {
    useAppStore.setState({ currentProject: alpha });
    dirtyChatStore();

    void useAppStore.getState().closeProject({ force: true });

    expect(useAppStore.getState().currentProject).toBeNull();
    expectChatReset(["chatMessages", "chatSessionPath", "chatLoading", "chatError", "pendingChatPrompt"]);
  });

  it("switching projects clears the conversation but keeps focus mode, streaming state and any queued prompt", async () => {
    mockInvoke.mockImplementation((command: string) =>
      command === "switch_project" ? Promise.resolve(gamma) : Promise.resolve(null),
    );
    useAppStore.setState({ currentProject: alpha });
    dirtyChatStore();
    stubLoaders();

    await useAppStore.getState().switchProject(gamma.root);

    expect(useAppStore.getState().currentProject).toEqual(gamma);
    expectChatReset(["chatMessages", "chatSessionPath", "chatLoading", "chatError", "chatInputDraft"]);
  });

  it("restoring saved workspace tabs clears the conversation after the project loads", async () => {
    mockInvoke.mockImplementation((command: string) => {
      switch (command) {
        case "open_project_folder":
          return Promise.resolve(beta);
        case "get_workspace_state":
          return Promise.resolve({ open_tabs: [], active_tab_id: null, chat_session_path: null });
        default:
          return Promise.resolve([]);
      }
    });
    useAppStore.setState({ currentProject: alpha });
    stubLoaders();
    useAppStore.setState({
      loadNotes: vi.fn(() => {
        dirtyChatStore();
        return Promise.resolve();
      }),
    });

    await useAppStore.getState().openProject(beta.root);

    expectChatReset(["chatMessages", "chatSessionPath", "chatLoading", "chatError", "chatInputDraft"]);
  });

  it("starting a new chat clears the conversation and the output activity log, then persists tabs", () => {
    const persistTabs = vi.fn();
    useAppStore.setState({
      activityLog: [{ id: "a1", timestamp: new Date(0), source: "t", content: "x", level: "info" }],
      _persistTabs: persistTabs,
    });
    dirtyChatStore();

    useChatStore.getState().newChatSession();

    expectChatReset(["chatMessages", "chatSessionPath", "chatLoading", "chatError", "chatInputDraft"]);
    expect(useAppStore.getState().activityLog).toEqual([]);
    expect(persistTabs).toHaveBeenCalledTimes(1);
  });

  it("keeps the moved recording keys out of appStore", () => {
    const appKeys = new Set(Object.keys(useAppStore.getState()));
    const recordingKeys = Object.keys(useRecordingStore.getState());
    for (const key of [...Object.keys(initialRecordingState()), ...RECORDING_ACTIONS]) {
      expect(appKeys.has(key)).toBe(false);
      expect(recordingKeys).toContain(key);
    }
    const otherKeys = new Set([
      ...Object.keys(useVersioningStore.getState()),
      ...Object.keys(useSyncStore.getState()),
      ...Object.keys(useChatStore.getState()),
    ]);
    expect(recordingKeys.filter((key) => appKeys.has(key) || otherKeys.has(key))).toEqual([]);
    for (const key of ["loading", "error", "view", "clearError"]) {
      expect(appKeys.has(key)).toBe(true);
    }
  });

  it("starts the recording store from its initial state", () => {
    expect(pick(useRecordingStore.getState(), Object.keys(initialRecordingState()))).toEqual(initialRecordingState());
  });

  it("opening a project leaves recording state alone", async () => {
    useAppStore.setState({ currentProject: alpha });
    useRecordingStore.setState(dirtyRecording);
    stubLoaders();

    await useAppStore.getState().openProject(beta.root);

    expect(useAppStore.getState().currentProject).toEqual(beta);
    expectRecordingUntouched();
  });

  it("closing a project leaves recording state alone", () => {
    useAppStore.setState({ currentProject: alpha });
    useRecordingStore.setState(dirtyRecording);

    void useAppStore.getState().closeProject({ force: true });

    expect(useAppStore.getState().currentProject).toBeNull();
    expectRecordingUntouched();
  });

  it("switching projects leaves recording state alone", async () => {
    mockInvoke.mockImplementation((command: string) =>
      command === "switch_project" ? Promise.resolve(gamma) : Promise.resolve(null),
    );
    useAppStore.setState({ currentProject: alpha });
    useRecordingStore.setState(dirtyRecording);
    stubLoaders();

    await useAppStore.getState().switchProject(gamma.root);

    expect(useAppStore.getState().currentProject).toEqual(gamma);
    expectRecordingUntouched();
  });

  it("preparing a browser updates recording state and the shared app loading, error and view", async () => {
    mockInvoke.mockImplementation((command: string) =>
      command === "prepare_browser" ? Promise.resolve("msedge") : Promise.resolve([]),
    );
    useAppStore.setState({ view: "project", error: "old", loading: false });
    useRecordingStore.setState({ ...dirtyRecording, isBrowserReady: false, browserChannel: null });

    const pending = useRecordingStore.getState().prepareBrowser();
    expect(useAppStore.getState().loading).toBe(true);
    expect(useAppStore.getState().error).toBeNull();
    await pending;

    expect(mockInvoke).toHaveBeenCalledWith("prepare_browser", {
      userDataDir: "C:\\edge",
      profileDirectory: "Default",
      browserChannel: "msedge",
    });
    expect(useRecordingStore.getState()).toMatchObject({
      isBrowserReady: true,
      browserChannel: "msedge",
      capturedActions: [],
      lastSession: null,
    });
    expect(useAppStore.getState()).toMatchObject({ view: "recording", loading: false });
  });

  it("a failed browser launch reports the error on appStore", async () => {
    mockInvoke.mockImplementation(() => Promise.reject("no browser"));
    const consoleError = vi.spyOn(console, "error").mockImplementation(() => {});

    await useRecordingStore.getState().prepareBrowser();
    consoleError.mockRestore();

    expect(useAppStore.getState()).toMatchObject({ error: "no browser", loading: false });
    expect(useRecordingStore.getState().isBrowserReady).toBe(false);
  });

  it("starting and stopping a recording streams captured actions into the recording store", async () => {
    const session = { id: "s1", actions: [] };
    mockInvoke.mockImplementation((command: string) => {
      if (command === "start_recording_session") return Promise.resolve("session-1");
      if (command === "stop_recording_session") return Promise.resolve(session);
      return Promise.resolve([]);
    });
    useRecordingStore.setState({ capturedActions: [{ action: "old" }] as never, lastSession: { id: "x" } as never });

    await useRecordingStore.getState().startRecording();

    const channel = useRecordingStore.getState()._activeChannel as unknown as { onmessage: (action: unknown) => void };
    expect(mockInvoke).toHaveBeenCalledWith("start_recording_session", { onAction: channel });
    expect(useRecordingStore.getState()).toMatchObject({ isRecording: true, recordingSessionId: "session-1", capturedActions: [], lastSession: null });
    channel.onmessage({ action: "click" });
    expect(useRecordingStore.getState().capturedActions).toEqual([{ action: "click" }]);
    expect(useAppStore.getState().loading).toBe(false);

    await useRecordingStore.getState().stopRecording();

    expect(useRecordingStore.getState()).toMatchObject({
      isRecording: false,
      recordingSessionId: null,
      lastSession: session,
      _activeChannel: null,
      capturedActions: [{ action: "click" }],
    });
    expect(useAppStore.getState().loading).toBe(false);
  });
});
