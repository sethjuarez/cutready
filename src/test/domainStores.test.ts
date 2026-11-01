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

const alpha = { root: "D:\\workspace\\alpha", repo_root: "D:\\workspace", name: "Alpha" };
const beta = { root: "D:\\workspace\\beta", repo_root: "D:\\workspace", name: "Beta" };
const gamma = { root: "D:\\other\\gamma", repo_root: "D:\\other", name: "Gamma" };
const startedBranch = { branchName: "from-old", snapshotId: "snapshot-1" };

const originalAppState = { ...useAppStore.getState() };
const originalVersioningState = { ...useVersioningStore.getState() };
const originalSyncState = { ...useSyncStore.getState() };

function pick<T extends object>(state: T, keys: string[]) {
  return Object.fromEntries(keys.map((key) => [key, (state as Record<string, unknown>)[key]]));
}

function dirtyDomainStores() {
  useVersioningStore.setState({
    versions: [{ id: "v1" }] as never,
    timelines: [{ name: "main", label: "main", is_active: true, snapshot_count: 1, color_index: 0 }],
    graphNodes: [{ id: "n1" }] as never,
    snapshotPromptOpen: true,
    pendingNavAfterSave: "abc" as never,
    pendingTimelineAfterSave: "feature" as never,
    startedBranchFromSnapshot: startedBranch,
    isDirty: true,
    changedFiles: [{ path: "intro.sk", status: "modified", additions: 1, deletions: 0 }],
    saving: true,
    hasStash: true,
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
  });

  it("keeps the moved versioning and sync keys out of appStore", () => {
    const appKeys = new Set(Object.keys(useAppStore.getState()));
    const versioningKeys = Object.keys(useVersioningStore.getState());
    const syncKeys = Object.keys(useSyncStore.getState());

    expect(versioningKeys.filter((key) => appKeys.has(key))).toEqual([]);
    expect(syncKeys.filter((key) => appKeys.has(key))).toEqual([]);
    expect(versioningKeys.filter((key) => syncKeys.includes(key))).toEqual([]);
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

    useAppStore.getState().closeProject();

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
});
