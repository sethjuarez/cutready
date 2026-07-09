import { create } from "zustand";
import { invoke, Channel } from "../services/tauri";
import {
  applyDraftlineIncoming,
  adoptDraftlineRemoteBranch,
  createDraftlineVariation,
  deleteDraftlineVariation,
  discardDraftlineChanges,
  discardDraftlineFile,
  diffDraftlineVersions,
  fetchDraftlineRemote,
  getDraftlineSyncStatus,
  hasDraftlineShelf,
  hasDraftlineChanges,
  isDraftlineHistoryCleanupBlockedError,
  isDraftlineVariationCreateConflictError,
  listDraftlineIncomingCommits,
  listDraftlineChangedFiles,
  listDraftlineGraphNodes,
  listDraftlinePendingSnapshotCleanups,
  listDraftlineLargeChangedFiles,
  listDraftlineRemoteBranches,
  listDraftlineRemotes,
  listDraftlineSnapshotCleanupCandidates,
  listDraftlineTimelines,
  listDraftlineVersions,
  preflightDraftlineIncoming,
  preflightDraftlineMergeIncoming,
  preflightDraftlinePublishSnapshotCleanup,
  preflightDraftlineSwitchVariation,
  mergeDraftlineIncoming,
  mergeDraftlineIncomingWithResolutions,
  publishDraftlineChanges,
  publishDraftlinePendingSnapshotCleanup,
  publishDraftlineSnapshotCleanup,
  popDraftlineShelf,
  preflightDraftlineRenameVariation,
  applyDraftlineSnapshotCleanup,
  preflightDraftlineUndoSnapshotCleanup,
  previewDraftlineSnapshotCleanup,
  restoreDraftlineVersionAsNewSave,
  restoreDraftlineVersionAsNewSaveToVariation,
  renameDraftlineVariation,
  saveDraftlineVersion,
  setDraftlineWorkspacePath,
  shelveDraftlineChanges,
  switchDraftlineVariation,
  undoDraftlineSnapshotCleanup,
  undoDraftlinePendingSnapshotCleanup,
  type DraftlineRestoreVersionTarget,
  type DraftlineMergeIncomingToken,
  type DraftlineHistoryCleanupPreview,
  type DraftlineHistoryCleanupPublishResult,
  type DraftlineHistoryCompactionCandidates,
  type DraftlineTimelineCleanupResult,
  type DraftlinePendingHistoryCleanup,
} from "../services/draftlineVersioning";
import { recordActivityEntries } from "../services/telemetry";
import { getGitHubAuthStatus } from "../services/githubSetup";
import { useToastStore } from "./toastStore";
import { cleanupRange, firstParentTimelineNodes } from "../utils/historyCleanupSelection";
import { getStoryboardSketchPaths } from "../utils/storyboard";
import type { ProjectView, ProjectEntry, RecentProject } from "../types/project";
import type {
  BrowserProfile,
  BrowserRunningStatus,
  CapturedAction,
  RecordedSession,
} from "../types/recording";
import type {
  Sketch,
  SketchSummary,
  Storyboard,
  StoryboardSummary,
  StoryboardItem,
  VersionEntry,
  TimelineInfo,
  GraphNode,
  NoteSummary,
  ChatMessage,
  ChatSessionSummary,
  RemoteBranchInfo,
  RemoteInfo,
  SyncStatus,
  IncomingCommit,
  DiffEntry,
  ConflictFile,
  MergeResult,
  FileResolution,
} from "../types/sketch";

const suppressedEditorFlushPaths = new Set<string>();
const LOCAL_CHAT_SESSION_PREFIX = "cutready://legacy-chats/";

function randomSessionSuffix(): string {
  if (globalThis.crypto?.randomUUID) {
    return globalThis.crypto.randomUUID().slice(0, 8);
  }
  return Math.random().toString(36).slice(2, 10);
}

export function createLocalChatSessionPath(now = new Date()): string {
  const timestamp = now.toISOString()
    .replace(/\.\d{3}Z$/, "Z")
    .replace(/[:.]/g, "-");
  return `${LOCAL_CHAT_SESSION_PREFIX}chat-${timestamp}-${randomSessionSuffix()}.chat`;
}

export function errorMessage(error: unknown): string {
  if (error instanceof Error) return error.message;
  if (typeof error === "string") return error;
  if (error && typeof error === "object") {
    const maybeMessage = (error as { message?: unknown }).message;
    if (typeof maybeMessage === "string" && maybeMessage.trim()) return maybeMessage;
    const maybeError = (error as { error?: unknown }).error;
    if (typeof maybeError === "string" && maybeError.trim()) return maybeError;
    try {
      return JSON.stringify(error);
    } catch {
      return String(error);
    }
  }
  return String(error);
}

export interface PrePushMilestonePrompt {
  snapshotCount: number;
  newestCommitId: string;
  oldestCommitId: string;
  latestSnapshotLabel: string;
  suggestedLabel: string;
  remoteName: string;
}

export type PrePushMilestoneDecision =
  | { type: "milestone"; label: string }
  | { type: "pushAsIs" }
  | { type: "cancel" };

let prePushMilestoneResolve: ((decision: PrePushMilestoneDecision) => void) | null = null;

function isGeneratedSnapshotLabel(label: string): boolean {
  return /^(Sun|Mon|Tue|Wed|Thu|Fri|Sat) (morning|afternoon|evening) \d{1,2}:\d{2}$/.test(label.trim());
}

function localPrePushMilestoneRange(nodes: GraphNode[], ahead: number | null | undefined): GraphNode[] | null {
  if (!ahead || ahead < 2) return null;
  const activeNodes = firstParentTimelineNodes(nodes);
  if (activeNodes.length < ahead) return null;
  const range = activeNodes.slice(0, ahead);
  return range[0]?.is_head ? range : null;
}

function suggestedMilestoneLabel(nodes: GraphNode[]): string {
  const meaningful = nodes
    .map((node) => node.message.trim())
    .find((label) => label && !isGeneratedSnapshotLabel(label));
  return meaningful ?? "Shared milestone";
}

function cancelPendingPrePushMilestonePrompt() {
  prePushMilestoneResolve?.({ type: "cancel" });
  prePushMilestoneResolve = null;
}

export function remoteSyncErrorMessage(error: unknown): string {
  if (isDraftlineHistoryCleanupBlockedError(error)) {
    return PENDING_CLEANUP_INCOMING_MESSAGE;
  }
  const message = errorMessage(error);
  const lower = message.toLowerCase();
  if (
    lower.includes("status code: 401")
    || lower.includes("\"code\":\"unauthorized\"")
    || lower.includes("authentication required")
    || lower.includes("unauthorized")
  ) {
    return GITHUB_REMOTE_AUTH_FAILED_MESSAGE;
  }
  return message;
}

const PENDING_CLEANUP_INCOMING_MESSAGE =
  "Publish or undo milestone history before getting incoming remote saves. Pulling first would change the local timeline and invalidate the milestone publish.";

function chatMessagePreviewContent(message: ChatMessage): string {
  if (typeof message.content === "string") return message.content;
  if (Array.isArray(message.content)) {
    return message.content
      .filter((part) => part.type === "text" && part.text)
      .map((part) => part.text)
      .join("\n");
  }
  return "";
}

export function suppressEditorFlush(relativePath: string) {
  suppressedEditorFlushPaths.add(normalizeRelativePath(relativePath));
}

export function shouldSuppressEditorFlush(relativePath: string | null | undefined): boolean {
  return !!relativePath && suppressedEditorFlushPaths.has(normalizeRelativePath(relativePath));
}

export function clearSuppressedEditorFlush(relativePath: string) {
  suppressedEditorFlushPaths.delete(normalizeRelativePath(relativePath));
}

function clearSuppressedEditorFlushes(relativePaths: string[]) {
  for (const relativePath of relativePaths) {
    clearSuppressedEditorFlush(relativePath);
  }
}

function isDocumentTab(tab: EditorTab): tab is EditorTab & { type: "sketch" | "storyboard" | "note" } {
  return tab.type === "sketch" || tab.type === "storyboard" || tab.type === "note";
}

function isDatabasePath(path: string): boolean {
  const databasePath = path.split("#", 1)[0];
  return databasePath === "cutready://agent-state" || /\.(db|sqlite|sqlite3)$/i.test(databasePath);
}

function nextActiveTabIdAfterFiltering(previousTabs: EditorTab[], nextTabs: EditorTab[], activeTabId: string | null): string | null {
  if (!activeTabId) return null;
  if (nextTabs.some((tab) => tab.id === activeTabId)) return activeTabId;
  if (nextTabs.length === 0) return null;
  const previousIndex = previousTabs.findIndex((tab) => tab.id === activeTabId);
  return nextTabs[Math.min(Math.max(previousIndex, 0), nextTabs.length - 1)]?.id ?? null;
}

function normalizeRelativePath(path: string): string {
  return path.replace(/\\/g, "/").replace(/^\.\/+/, "").replace(/^\/+/, "").replace(/\/+$/, "");
}

function normalizeAbsolutePath(path: string): string {
  return path.replace(/\\/g, "/").replace(/\/+$/, "");
}

function activeProjectScope(currentProject: ProjectView | null): string | null {
  if (!currentProject) return null;
  const root = normalizeAbsolutePath(currentProject.root);
  const repoRoot = normalizeAbsolutePath(currentProject.repo_root);
  if (root.toLowerCase() === repoRoot.toLowerCase()) return null;
  const repoPrefix = `${repoRoot}/`;
  if (!root.toLowerCase().startsWith(repoPrefix.toLowerCase())) return null;
  return normalizeRelativePath(root.slice(repoPrefix.length));
}

function scopedPathVariants(filePath: string, currentProject: ProjectView | null) {
  const normalized = normalizeRelativePath(filePath);
  const scope = activeProjectScope(currentProject);
  if (!scope) {
    return { repoPath: normalized, projectPath: normalized };
  }
  if (normalized === scope) {
    return { repoPath: normalized, projectPath: "" };
  }
  const scopePrefix = `${scope}/`;
  if (normalized.startsWith(scopePrefix)) {
    return { repoPath: normalized, projectPath: normalized.slice(scopePrefix.length) };
  }
  return { repoPath: `${scopePrefix}${normalized}`, projectPath: normalized };
}

/** The panels / views available in the app. */
export type AppView = "home" | "project" | "sketch" | "assets" | "narrations" | "editor" | "recording" | "settings" | "chat" | "changes";

/** Sidebar position. */
export type SidebarPosition = "left" | "right";

/** Output panel tabs. */
export type OutputTab = "activity" | "debug" | "terminal";

/** Activity log entry for the output panel. */
export interface ActivityEntry {
  id: string;
  timestamp: Date;
  source: string;
  content: string;
  level: "info" | "warn" | "error" | "success";
}

/** Sidebar display order manifest. */
export interface SidebarOrder {
  storyboards: string[];
  sketches: string[];
  notes: string[];
}

/** An open tab in the editor area. */
export interface EditorTab {
  id: string;
  type: "sketch" | "storyboard" | "note" | "history" | "snapshot-preview" | "asset" | "diff" | "agent-run" | "database";
  path: string;
  title: string;
}

/** Generate a deterministic main-pane tab ID from type + path. */
export function makeMainTabId(type: EditorTab["type"], path: string): string {
  return `${type}-${path}`;
}

/** Generate a deterministic split-pane tab ID from type + path. */
export function makeSplitTabId(type: EditorTab["type"], path: string): string {
  return `split-${type}-${path}`;
}

function buildShareUrl(remoteUrl: string, branch: string): string | null {
  const match = remoteUrl.match(/github\.com[/:]([^/]+\/[^/.]+)(?:\.git)?$/);
  if (!match) return null;
  const repo = match[1];
  if (branch === "main" || branch === "master") return `https://github.com/${repo}`;
  return `https://github.com/${repo}/compare/${branch}?expand=1`;
}

const GITHUB_REMOTE_AUTH_MESSAGE =
  "This project has a GitHub remote. Connect GitHub in Settings > Repository before syncing.";
const GITHUB_REMOTE_AUTH_FAILED_MESSAGE =
  "GitHub rejected the remote operation. Reconnect GitHub in Settings, then try again.";

function isGitHubRemoteUrl(remoteUrl: string): boolean {
  return /github\.com[/:][^/]+\/[^\s/]+(?:\.git)?$/i.test(remoteUrl.trim());
}

async function ensureGitHubRemoteCredential(remote: RemoteInfo | null, notify = false): Promise<boolean> {
  if (!remote || !isGitHubRemoteUrl(remote.url)) return true;

  try {
    const status = await getGitHubAuthStatus();
    if (status.connected) return true;

    useAppStore.setState({ syncStatus: null, incomingCommits: [], syncError: GITHUB_REMOTE_AUTH_MESSAGE });
    if (notify) {
      useToastStore.getState().show(GITHUB_REMOTE_AUTH_MESSAGE, 6000, "warning");
    }
    return false;
  } catch (error) {
    console.warn("Could not confirm GitHub auth status before sync; continuing remote operation.", error);
    return true;
  }
}

function snapshotIdFromPreviewPath(path: string): string | null {
  return path.startsWith("snapshot:") ? path.slice("snapshot:".length) : null;
}

function cleanupRewriteTarget(result: DraftlineTimelineCleanupResult, versionId: string): string | null | undefined {
  const entry = result.snapshot_map.find((candidate) => candidate.old === versionId)
    ?? result.commit_map.find((candidate) => candidate.old === versionId);
  if (!entry) return undefined;

  switch (entry.disposition.kind) {
    case "preserved":
    case "squashed_into":
      return entry.disposition.new_id || entry.new || null;
    case "dropped_as_noise":
    case "orphaned_but_backed_up":
    case "conflict_requires_user_choice":
      return null;
  }
}

function rewriteSnapshotPreviewTabs(
  tabs: EditorTab[],
  result: DraftlineTimelineCleanupResult,
  idForPath: (type: EditorTab["type"], path: string) => string,
): { tabs: EditorTab[]; remappedIds: Map<string, string | null>; changed: boolean } {
  const remappedIds = new Map<string, string | null>();
  const seen = new Set<string>();
  const next: EditorTab[] = [];
  let changed = false;

  for (const tab of tabs) {
    const snapshotId = tab.type === "snapshot-preview" ? snapshotIdFromPreviewPath(tab.path) : null;
    const target = snapshotId ? cleanupRewriteTarget(result, snapshotId) : undefined;
    if (target === null) {
      remappedIds.set(tab.id, null);
      changed = true;
      continue;
    }

    const path = target && target !== snapshotId ? `snapshot:${target}` : tab.path;
    const id = path === tab.path ? tab.id : idForPath(tab.type, path);
    const title = path === tab.path || !target ? tab.title : `Snapshot: ${target.slice(0, 7)}`;
    const key = `${tab.type}\u0000${path}`;
    if (seen.has(key)) {
      remappedIds.set(tab.id, id);
      changed = true;
      continue;
    }
    seen.add(key);
    next.push(path === tab.path ? tab : { ...tab, id, path, title });
    if (id !== tab.id) {
      remappedIds.set(tab.id, id);
      changed = true;
    }
  }

  return { tabs: next, remappedIds, changed };
}

function remapActiveTabId(activeId: string | null, tabs: EditorTab[], remappedIds: Map<string, string | null>): string | null {
  if (!activeId) return null;
  if (!remappedIds.has(activeId)) {
    return tabs.some((tab) => tab.id === activeId) ? activeId : tabs[0]?.id ?? null;
  }
  const mapped = remappedIds.get(activeId) ?? null;
  return mapped && tabs.some((tab) => tab.id === mapped) ? mapped : tabs[0]?.id ?? null;
}

/** A project asset (screenshot or visual) with reference info. */
export interface AssetInfo {
  path: string;
  size: number;
  assetType: "screenshot" | "visual";
  referencedBy: string[];
  modifiedAt: number;
}

/** A project narration/audio cut available for reuse. */
export interface NarrationAssetInfo {
  path: string;
  size: number;
  mimeType: string;
  modifiedAt: number;
  referencedBy: string[];
}

interface AppStoreState {
  /** Current active view. */
  view: AppView;
  /** Currently open project (null if none). */
  currentProject: ProjectView | null;
  /** Recent projects for the home screen. */
  recentProjects: RecentProject[];
  /** All projects in the current repo (empty for single-project repos). */
  projects: ProjectEntry[];
  /** Whether the current repo has multiple projects. */
  isMultiProject: boolean;
  /** Whether an operation is in progress. */
  loading: boolean;
  /** Whether a multi-project workspace is actively switching projects. */
  projectSwitching: boolean;
  /** Last error message to display in the UI. */
  error: string | null;
  /** Width of the sidebar panel in pixels. */
  sidebarWidth: number;
  /** Whether the sidebar panel is visible. */
  sidebarVisible: boolean;
  /** Whether the output/activity panel is visible. */
  outputVisible: boolean;
  /** Active output panel tab. */
  outputActiveTab: OutputTab;
  /** Height of the output panel in pixels. */
  outputHeight: number;
  /** Width of the secondary chat/history panel in pixels. */
  secondaryWidth: number;
  /** Sidebar position: left or right. */
  sidebarPosition: SidebarPosition;

  // ── Tabs ───────────────────────────────────────────────

  /** Open editor tabs. */
  openTabs: EditorTab[];
  /** Currently active tab id. */
  activeTabId: string | null;
  /** Tabs open in the split (right) pane. Empty = split hidden. */
  splitTabs: EditorTab[];
  /** Currently active tab in the split pane. */
  splitActiveTabId: string | null;
  /** Which editor group currently has focus ("main" or "split"). */
  activeEditorGroup: "main" | "split";
  /** Incremented to force the active editor to remount after external file restoration. */
  editorReloadKey: number;
  /** The file path associated with the latest forced editor remount. */
  editorReloadPath: string | null;

  // ── Sketch state ───────────────────────────────────────

  /** Sketch summaries for the current project. */
  sketches: SketchSummary[];
  /** The currently active sketch path (relative). */
  activeSketchPath: string | null;
  /** The full active sketch (loaded when editing). */
  activeSketch: Sketch | null;

  // ── Storyboard state ─────────────────────────────────

  /** Storyboard summaries for the current project. */
  storyboards: StoryboardSummary[];
  /** The currently active storyboard path (relative). */
  activeStoryboardPath: string | null;
  /** The full active storyboard (loaded when viewing). */
  activeStoryboard: Storyboard | null;

  // ── Note state ──────────────────────────────────────────

  /** Note summaries for the current project. */
  notes: NoteSummary[];
  /** The currently active note path (relative). */
  activeNotePath: string | null;
  /** The full active note content (loaded when editing). */
  activeNoteContent: string | null;
  /** Whether the active note is locked against editing. */
  activeNoteLocked: boolean;
  /** Note paths currently in preview mode (persists across tab switches). */
  notePreviewPaths: Set<string>;

  // ── Asset state ──────────────────────────────────────────
  /** All project assets (screenshots + visuals) with reference info. */
  assets: AssetInfo[];
  /** All project narration/audio cuts available for reuse. */
  narrationAssets: NarrationAssetInfo[];

  // ── Chat state ──────────────────────────────────────────────
  /** Messages in the current chat session. */
  chatMessages: ChatMessage[];
  /** Relative path of the current chat session file (null = unsaved). */
  chatSessionPath: string | null;
  /** Whether the chat is waiting for a response. */
  chatLoading: boolean;
  /** Last chat error message. */
  chatError: string | null;
  /** Current unsent chat input text, shared between normal and focus mode. */
  chatInputDraft: string;
  /** Live assistant text currently streaming from the agent. */
  chatStreamingText: string;
  /** Live reasoning text currently streaming from the agent. */
  chatStreamingThinking: string;
  /** Live status text currently streaming from the agent. */
  chatStreamingStatus: string;
  /** Assistant drafts captured before tool-round resets. */
  chatStreamingDrafts: string[];
  /** A prompt queued from outside the chat (e.g. sparkle buttons). ChatPanel picks this up and sends it. */
  pendingChatPrompt: { text: string; silent?: boolean; agent?: string } | null;
  /** Whether chat is occupying the main work area as an intentional focus mode. */
  chatFocusMode: boolean;
  /** Whether the terminal output tab is occupying the main work area as an intentional focus mode. */
  terminalFocusMode: boolean;
  /** Activity log entries for the output panel. */
  activityLog: ActivityEntry[];
  /** Debug log entries for the debug panel. */
  debugLog: ActivityEntry[];

  /** Version history for the current project. */
  versions: VersionEntry[];
  /** All timelines (branches) in the project. */
  timelines: TimelineInfo[];
  /** Full graph data for SVG rendering. */
  graphNodes: GraphNode[];
  /** Whether the secondary panel is visible. */
  showSecondaryPanel: boolean;
  /** Whether the snapshot name prompt should be shown (triggered by Ctrl+S). */
  snapshotPromptOpen: boolean;
  /** After saving a snapshot, navigate to this commit ID (used by nav-save flow). */
  pendingNavAfterSave: string | null;
  /** After saving a snapshot, switch to this branch. */
  pendingTimelineAfterSave: string | null;
  /** Branch created from a historical snapshot that has not recorded its first new save yet. */
  startedBranchFromSnapshot: { branchName: string; snapshotId: string } | null;
  /** Most recent Draftline history cleanup result, used for guarded undo. */
  lastHistoryCleanup: DraftlineTimelineCleanupResult | null;
  /** Durable Draftline pending cleanup that blocks normal remote operations until resolved. */
  pendingHistoryCleanup: DraftlinePendingHistoryCleanup | null;
  /** Pre-push prompt for compressing unpublished local snapshots into one milestone. */
  prePushMilestonePrompt: PrePushMilestonePrompt | null;
  /** Whether there are unsaved changes since the last snapshot. */
  isDirty: boolean;
  /** List of changed files since last snapshot (for Changes panel). */
  changedFiles: DiffEntry[];
  /** Whether a quickSave is in progress. */
  saving: boolean;
  /** Whether a stash (temporarily saved work) exists. */
  hasStash: boolean;
  /** Whether we are viewing a rewound snapshot (prev-tip exists). */
  isRewound: boolean;

  // ── Remote sync ─────────────────────────────────────────
  /** Detected/configured remote, null if none. */
  currentRemote: RemoteInfo | null;
  /** Branches that exist on the selected remote but have not been adopted locally. */
  remoteBranches: RemoteBranchInfo[];
  /** Whether remote-only branches are currently being refreshed. */
  remoteBranchesLoading: boolean;
  /** Ahead/behind counts vs remote tracking branch. */
  syncStatus: SyncStatus | null;
  /** Whether a fetch/push/pull is in progress. */
  isSyncing: boolean;
  /** Last error from a sync operation. */
  syncError: string | null;
  /** Incoming snapshots discovered by the latest fetch. */
  incomingCommits: IncomingCommit[];
  /** Share/PR URL for the latest successful share operation. */
  shareUrl: string | null;

  // ── Merge ──────────────────────────────────────────────────
  /** Whether a merge is in progress (conflicts being resolved). */
  isMerging: boolean;
  /** Source timeline for the in-progress merge. */
  mergeSource: string | null;
  /** Target timeline for the in-progress merge. */
  mergeTarget: string | null;
  /** Conflict files from the merge engine (empty = clean merge). */
  mergeConflicts: ConflictFile[];
  /** Draftline token for the currently displayed incoming conflict set. */
  draftlineMergeToken: DraftlineMergeIncomingToken | null;
  /** Remote that produced the currently displayed incoming conflict set. */
  draftlineMergeRemote: string | null;

  // ── Diff ──────────────────────────────────────────────────
  /** Currently selected diff result (file changes between two snapshots). */
  diffResult: DiffEntry[] | null;
  /** The two commit IDs being compared for diff. */
  diffSelection: { from: string; to: string } | null;

  // ── Sidebar order ────────────────────────────────────────
  /** Sidebar display order manifest (paths per category). */
  sidebarOrder: SidebarOrder | null;

  // ── Profile detection ─────────────────────────────────────

  /** Browser profiles detected on the system. */
  profiles: BrowserProfile[];
  /** Which profile the user has selected (null for fresh browser). */
  selectedProfile: BrowserProfile | null;
  /** Which browsers are currently running. */
  browserRunning: BrowserRunningStatus | null;

  // ── Browser lifecycle ─────────────────────────────────────

  /** Whether a recording browser is connected and ready. */
  isBrowserReady: boolean;
  /** Which browser channel was used ("chrome", "msedge", "chromium"). */
  browserChannel: string | null;

  // ── Recording lifecycle ───────────────────────────────────

  /** Whether a recording (observation) is currently active. */
  isRecording: boolean;
  /** The ID of the active recording session. */
  recordingSessionId: string | null;
  /** Captured actions from the active (or most recent) recording session. */
  capturedActions: CapturedAction[];
  /** The most recently completed session. */
  lastSession: RecordedSession | null;
  /** Active channel reference (prevents GC during recording). */
  _activeChannel: Channel<CapturedAction> | null;

  /** Clear the current error. */
  clearError: () => void;
  /** Switch to a different view. */
  setView: (view: AppView) => void;
  /** Set sidebar width. */
  setSidebarWidth: (width: number | ((current: number) => number)) => void;
  /** Toggle sidebar visibility. */
  toggleSidebar: () => void;
  /** Toggle output panel visibility. */
  toggleOutput: () => void;
  /** Show the output panel with a specific active tab. */
  showOutputTab: (tab: OutputTab) => void;
  /** Set output panel height. */
  setOutputHeight: (height: number) => void;
  /** Set secondary chat/history panel width. */
  setSecondaryWidth: (width: number | ((current: number) => number)) => void;
  /** Toggle sidebar position (left/right). */
  toggleSidebarPosition: () => void;

  // ── Tab actions ────────────────────────────────────────

  /** Open a tab (or focus if already open). */
  openTab: (tab: Omit<EditorTab, "id">) => void;
  /** Close a tab by id. */
  closeTab: (tabId: string) => void;
  /** Close all tabs except the given one. */
  closeOtherTabs: (tabId: string) => void;
  /** Close all tabs to the right of the given tab. */
  closeTabsToRight: (tabId: string) => void;
  /** Close all tabs to the left of the given tab. */
  closeTabsToLeft: (tabId: string) => void;
  /** Close all open tabs (main and split). */
  closeAllTabs: () => void;
  /** Set the active tab. */
  setActiveTab: (tabId: string) => void;
  /** Open a tab in the split (right) pane. */
  openTabInSplit: (tabId: string) => void;
  /** Close a specific tab in the split pane. */
  closeTabInSplit: (tabId: string) => void;
  /** Switch the active tab within the split pane. */
  setActiveSplitTab: (tabId: string) => void;
  /** Close the split pane (clears all split tabs). */
  closeSplit: () => void;
  /** Reorder tabs. */
  reorderTabs: (tabIds: string[]) => void;
  /** Set the active editor group ("main" or "split"). */
  setActiveEditorGroup: (group: "main" | "split") => void;
  /** Move a main tab to the split pane (removes from main, adds to split). */
  moveTabToSplit: (tabId: string) => void;
  /** Move a split tab back to the main pane (removes from split, adds/focuses in main). */
  moveTabFromSplit: (splitTabId: string) => void;
  /** Reorder tabs in the split pane. */
  reorderSplitTabs: (tabIds: string[]) => void;
  /** @internal Remove a split tab matching type+path (used by delete actions). */
  _removeSplitTabByPath: (type: EditorTab["type"], path: string) => void;
  /** @internal Persist open tabs to localStorage. */
  _persistTabs: () => void;

  // ── Project actions ───────────────────────────────────────

  loadRecentProjects: () => Promise<void>;
  removeRecentProject: (path: string) => Promise<void>;
  createProject: (path: string) => Promise<void>;
  openProject: (path: string) => Promise<void>;
  closeProject: () => void;

  // ── Multi-project actions ──────────────────────────────────

  /** Load the list of projects in the current repo. */
  loadProjects: () => Promise<void>;
  /** Switch to a different project within the repo. */
  switchProject: (projectPath: string) => Promise<void>;
  /** Create a new project within the current repo. */
  createProjectInRepo: (name: string, description?: string) => Promise<void>;
  /** Delete a project from the repo. */
  deleteProjectFromRepo: (projectPath: string, deleteFiles?: boolean) => Promise<void>;

  // ── Sketch actions ─────────────────────────────────────

  /** Load sketch list for current project. */
  loadSketches: () => Promise<void>;
  /** Create a new sketch and open it. */
  createSketch: (title: string) => Promise<void>;
  /** Open a sketch for editing by path. */
  openSketch: (sketchPath: string) => Promise<void>;
  /** Update the active sketch (description and/or rows). */
  updateSketch: (update: { description?: unknown; rows?: import("../types/sketch").PlanningRow[]; metadata?: import("../types/sketch").DocumentMetadata }) => Promise<void>;
  /** Update a sketch's title. */
  updateSketchTitle: (sketchPath: string, title: string) => Promise<void>;
  /** Delete a sketch. */
  deleteSketch: (sketchPath: string) => Promise<void>;
  /** Close the active sketch (return to storyboard). */
  closeSketch: () => void;

  // ── Storyboard actions ───────────────────────────────

  /** Load storyboard list for current project. */
  loadStoryboards: () => Promise<void>;
  /** Create a new storyboard and open it. */
  createStoryboard: (title: string) => Promise<void>;
  /** Open a storyboard for viewing by path. */
  openStoryboard: (storyboardPath: string) => Promise<void>;
  /** Update storyboard title/description. */
  updateStoryboard: (update: { title?: string; description?: string; metadata?: import("../types/sketch").DocumentMetadata }) => Promise<void>;
  /** Lock or unlock the active storyboard. */
  setStoryboardLocked: (locked: boolean) => Promise<void>;
  /** Delete a storyboard. */
  deleteStoryboard: (storyboardPath: string) => Promise<void>;
  /** Add a sketch to the active storyboard. */
  addSketchToStoryboard: (sketchPath: string, position?: number) => Promise<void>;
  /** Remove an item from the active storyboard. */
  removeFromStoryboard: (position: number) => Promise<void>;
  /** Add a section to the active storyboard. */
  addSectionToStoryboard: (title: string, position?: number) => Promise<void>;
  /** Reorder storyboard items. */
  reorderStoryboardItems: (items: StoryboardItem[]) => Promise<void>;
  /** Close the active storyboard (return to list). */
  closeStoryboard: () => void;

  // ── Note actions ─────────────────────────────────────────

  /** Load note list for current project. */
  loadNotes: () => Promise<void>;
  /** Create a new note and open it. */
  createNote: (title: string) => Promise<void>;
  /** Open a note for editing by path. */
  openNote: (notePath: string) => Promise<void>;
  /** Update the active note content. */
  updateNote: (content: string) => Promise<void>;
  /** Lock or unlock a note. */
  setNoteLocked: (notePath: string, locked: boolean) => Promise<void>;
  /** Delete a note. */
  deleteNote: (notePath: string) => Promise<void>;
  /** Close the active note. */
  closeNote: () => void;
  /** Set preview mode for a note path. */
  setNotePreview: (notePath: string, preview: boolean) => void;

  // ── Asset actions ──────────────────────────────────────────

  /** Load assets (screenshots + visuals) for current project. */
  loadAssets: () => Promise<void>;
  /** Load narration/audio cuts for current project. */
  loadNarrationAssets: () => Promise<void>;
  /** Open an asset in a new tab. */
  openAsset: (path: string, assetType: "screenshot" | "visual") => void;
  /** Open a SQLite database in a read-only inspector tab. */
  openDatabase: (path: string, tableName?: string) => void;
  /** Import an image from the filesystem into the project. */
  importAsset: () => Promise<void>;
  /** Delete an asset file. */
  deleteAsset: (path: string) => Promise<void>;
  /** Delete unreferenced screenshot and visual files. */
  deleteUnlinkedAssets: () => Promise<number>;
  /** Delete unreferenced narration/audio files. */
  deleteUnlinkedNarrationAssets: () => Promise<number>;

  // ── Chat actions ────────────────────────────────────────────

  /** Set chat messages (updates store + auto-saves to disk). */
  setChatMessages: (messages: ChatMessage[]) => void;
  /** Start a new chat session (clears messages, assigns path). */
  newChatSession: () => void;
  /** Load a saved chat session by path. */
  loadChatSession: (sessionPath: string) => Promise<void>;
  /** Save the current chat session to disk. */
  saveChatSession: () => Promise<void>;
  /** Set chat loading state. */
  setChatLoading: (loading: boolean) => void;
  /** Set chat error. */
  setChatError: (error: string | null) => void;
  /** Set current unsent chat input text. */
  setChatInputDraft: (draft: string) => void;
  /** Update live streaming chat state. */
  setChatStreamingState: (state: Partial<Pick<AppStoreState, "chatStreamingText" | "chatStreamingThinking" | "chatStreamingStatus" | "chatStreamingDrafts">>) => void;
  /** Clear live streaming chat state. */
  resetChatStreaming: () => void;
  /** Queue a prompt to be sent by the chat panel. */
  sendChatPrompt: (prompt: string, opts?: { silent?: boolean; agent?: string }) => void;
  /** Enter or exit chat focus mode. */
  setChatFocusMode: (enabled: boolean) => void;
  /** Enter or exit terminal focus mode. */
  setTerminalFocusMode: (enabled: boolean) => void;
  /** Add entries to activity log. */
  addActivityEntries: (entries: ActivityEntry[]) => void;
  /** Clear activity log. */
  clearActivityLog: () => void;
  /** Add a debug log entry. */
  addDebugEntry: (entry: ActivityEntry) => void;
  /** Clear debug log. */
  clearDebugLog: () => void;
  /** List saved chat sessions. */
  listChatSessions: () => Promise<ChatSessionSummary[]>;
  /** Delete a chat session. */
  deleteChatSession: (sessionPath: string) => Promise<void>;

  // ── Versioning actions ───────────────────────────────────

  /** Load version history. */
  loadVersions: () => Promise<void>;
  /** Check if working directory has unsaved changes. */
  checkDirty: () => Promise<void>;
  /** Refresh list of changed files since last snapshot. */
  refreshChangedFiles: () => Promise<void>;
  /** Save a labeled version. Optional forkLabel for naming the old timeline when forking. */
  saveVersion: (label: string, forkLabel?: string) => Promise<void>;
  /** Stash dirty working tree before browsing snapshots. */
  stashChanges: () => Promise<void>;
  /** Discard all working-directory changes, resetting to last snapshot. */
  discardChanges: () => Promise<void>;
  /** Discard changes for one file. */
  discardFile: (filePath: string) => Promise<void>;
  /** Pop stash (restore stashed work). */
  popStash: () => Promise<void>;
  /** Check whether a stash exists. */
  checkStash: () => Promise<void>;
  /** Check whether we are in a rewound state (prev-tip exists). */
  checkRewound: () => Promise<void>;
  /** Navigate to any snapshot. Defers fork until commit. */
  navigateToSnapshot: (commitId: string) => Promise<void>;
  /** Open a read-only snapshot preview tab. */
  openSnapshotPreview: (commitId: string) => Promise<void>;
  /** Restore a snapshot as a new Draftline save. */
  restoreSnapshotAsNewSave: (commitId: string, label: string) => Promise<void>;
  /** Restore a snapshot as a new Draftline save on a chosen variation. */
  restoreSnapshotAsNewSaveToVariation: (
    commitId: string,
    label: string,
    target: DraftlineRestoreVersionTarget,
  ) => Promise<void>;
  /** Create a new timeline from a snapshot. */
  createTimeline: (fromCommitId: string, name: string) => Promise<void>;
  /** Create a named branch from a snapshot and switch to it for editing. */
  startTimelineFromSnapshot: (fromCommitId: string, name: string) => Promise<void>;
  /** Load all timelines. */
  loadTimelines: () => Promise<void>;
  /** Switch to a different timeline. */
  switchTimeline: (name: string) => Promise<void>;
  /** Rename the legacy Draftline master variation to main. */
  renameLegacyMasterTimeline: () => Promise<void>;
  /** Delete a non-active timeline. */
  deleteTimeline: (name: string) => Promise<void>;
  /** Promote a fork timeline to become the new main. */
  promoteTimeline: (name: string) => Promise<void>;
  /** Load full graph data for SVG rendering. */
  loadGraphData: () => Promise<void>;
  /** Toggle the secondary panel. */
  toggleSecondaryPanel: () => void;
  /** Open the named snapshot flow for legacy quick-save callers. */
  quickSave: () => Promise<void>;
  /** Open snapshot name prompt (and ensure panel is visible). */
  promptSnapshot: () => Promise<void>;
  /** Compact a HEAD-anchored range of snapshots into one named milestone. */
  squashSnapshots: (oldestCommitId: string, newestCommitId: string, label: string) => Promise<void>;
  /** Load Draftline's valid compact-range endpoint candidates for one selected snapshot. */
  findSnapshotCleanupCandidates: (selectedCommitId: string) => Promise<DraftlineHistoryCompactionCandidates>;
  /** Preview compacting a contiguous range of snapshots through Draftline cleanup. */
  previewSnapshotCleanup: (oldestCommitId: string, newestCommitId: string, label: string, selectedRangeCommitIds?: string[]) => Promise<DraftlineHistoryCleanupPreview>;
  /** Apply a previously previewed Draftline cleanup plan. */
  applySnapshotCleanup: (planId: string) => Promise<DraftlineTimelineCleanupResult>;
  /** Refresh Draftline's durable pending history-cleanup state for the active timeline. */
  loadPendingHistoryCleanup: () => Promise<DraftlinePendingHistoryCleanup | null>;
  /** Publish an applied Draftline cleanup plan to the remote with Draftline's lease-protected token. */
  publishSnapshotCleanup: (planId: string, remote: string) => Promise<DraftlineHistoryCleanupPublishResult | null>;
  /** Undo a previously applied Draftline cleanup plan using Draftline's guarded backup token. */
  undoSnapshotCleanup: (planId?: string) => Promise<DraftlineTimelineCleanupResult>;

  // ── Remote sync actions ────────────────────────────────────
  /** Detect configured remote for the project. */
  detectRemote: () => Promise<void>;
  /** Fetch from the remote. */
  fetchFromRemote: (options?: { notifyAuthRequired?: boolean }) => Promise<void>;
  /** Push current timeline to the remote. */
  pushToRemote: () => Promise<void>;
  /** Pull from remote (fast-forward merge). */
  pullFromRemote: () => Promise<void>;
  /** Sync: fetch then push (or pull if behind). */
  syncWithRemote: () => Promise<void>;
  /** Share local changes safely with collaborators. */
  shareChanges: () => Promise<void>;
  /** Refresh incoming remote snapshot preview. */
  refreshIncomingCommits: () => Promise<void>;
  /** Refresh the ahead/behind sync status. */
  refreshSyncStatus: () => Promise<void>;
  /** List branches available on the remote. */
  loadRemoteBranches: () => Promise<RemoteBranchInfo[]>;
  /** Checkout a remote-only branch as a local tracking branch. */
  checkoutRemoteTimeline: (branch: string) => Promise<void>;
  /** Publish (push) the current local-only timeline to the remote. */
  publishTimeline: () => Promise<void>;
  /** Ask the user whether to compact unpublished local snapshots before push. */
  requestPrePushMilestone: (prompt: PrePushMilestonePrompt) => Promise<PrePushMilestoneDecision>;
  /** Resolve the active pre-push milestone prompt. */
  resolvePrePushMilestone: (decision: PrePushMilestoneDecision) => void;

  // ── Diff ──────────────────────────────────────────────────
  /** Compare two snapshots and return file-level diffs. */
  diffSnapshots: (fromCommit: string, toCommit: string) => Promise<DiffEntry[]>;
  /** Compare HEAD against the working directory. */
  diffWorkingTree: () => Promise<DiffEntry[]>;
  /** Check for large files before pushing. Returns list of (path, size). */
  checkLargeFiles: () => Promise<Array<[string, number]>>;
  /** Clone a workspace from a GitHub URL. */
  cloneFromUrl: (url: string, destPath: string) => Promise<boolean>;

  // ── Merge actions ────────────────────────────────────────
  /** Merge source timeline into target timeline. */
  mergeTimelines: (source: string, target: string) => Promise<MergeResult>;
  /** Apply user-provided conflict resolutions and create merge commit. */
  applyMergeResolution: (resolutions: FileResolution[]) => Promise<string>;
  /** Cancel an in-progress merge. */
  cancelMerge: () => void;

  // ── Sidebar order actions ──────────────────────────────────

  /** Load sidebar order manifest from project. */
  loadSidebarOrder: () => Promise<void>;
  /** Save sidebar order manifest. */
  saveSidebarOrder: (order: SidebarOrder) => Promise<void>;

  // ── Profile actions ───────────────────────────────────────

  /** Detect browser profiles available on the system. */
  detectProfiles: () => Promise<void>;
  /** Check which browsers are currently running. */
  checkBrowsersRunning: () => Promise<void>;
  /** Select a profile (or null for fresh browser). */
  setSelectedProfile: (profile: BrowserProfile | null) => void;

  // ── Browser actions ───────────────────────────────────────

  /** Launch a recording browser (with selected profile or fresh). */
  prepareBrowser: () => Promise<void>;
  /** Close the recording browser and disconnect. */
  disconnectBrowser: () => Promise<void>;

  // ── Recording actions ─────────────────────────────────────

  /** Start observing in the prepared browser. */
  startRecording: () => Promise<void>;
  /** Stop the active recording (browser stays open). */
  stopRecording: () => Promise<void>;
}

// ── Layout persistence helpers ─────────────────────────────────
const LAYOUT_KEY = "cutready:layout";

function loadLayout(): Partial<{
  sidebarWidth: number;
  sidebarVisible: boolean;
  sidebarPosition: "left" | "right";
  outputVisible: boolean;
  outputHeight: number;
  secondaryWidth: number;
  showSecondaryPanel: boolean;
}> {
  try {
    const raw = localStorage.getItem(LAYOUT_KEY);
    if (!raw) return {};
    const parsed = JSON.parse(raw) as Record<string, unknown>;
    const legacySecondary = typeof parsed["showSecondaryPanel"] === "boolean"
      ? parsed["showSecondaryPanel"]
      : typeof parsed["showVersionHistory"] === "boolean"
        ? parsed["showVersionHistory"]
        : undefined;
    return {
      ...parsed,
      ...(legacySecondary === undefined ? {} : { showSecondaryPanel: legacySecondary }),
    };
  } catch {
    return {};
  }
}

function saveLayout(partial: Record<string, unknown>) {
  try {
    const current = loadLayout();
    localStorage.setItem(LAYOUT_KEY, JSON.stringify({ ...current, ...partial }));
  } catch { /* ignore */ }
}

const savedLayout = loadLayout();

type PersistedWorkspaceState = {
  open_tabs: { id: string; type: string; path: string; title: string }[];
  active_tab_id: string | null;
  chat_session_path: string | null;
};

async function restoreWorkspaceState(get: () => AppStoreState, set: (partial: Partial<AppStoreState>) => void) {
  try {
    const ws = await invoke<PersistedWorkspaceState>("get_workspace_state");
    const { sketches, storyboards, notes } = get();
    const validTabs: EditorTab[] = (ws.open_tabs ?? [])
      .map((t) => ({ id: t.id, type: t.type as EditorTab["type"], path: t.path, title: t.title }))
      .filter((t) => {
        if (t.type === "sketch") return sketches.some((s) => s.path === t.path);
        if (t.type === "storyboard") return storyboards.some((s) => s.path === t.path);
        if (t.type === "note") return notes.some((n) => n.path === t.path);
        if (t.type === "database") return isDatabasePath(t.path);
        return false;
      });

    if (validTabs.length > 0) {
      const activeId = validTabs.find((t) => t.id === ws.active_tab_id)
        ? ws.active_tab_id!
        : validTabs[0].id;
      set({ openTabs: validTabs, activeTabId: activeId });
      const active = validTabs.find((t) => t.id === activeId);
      if (active?.type === "sketch") await get().openSketch(active.path);
      else if (active?.type === "storyboard") await get().openStoryboard(active.path);
      else if (active?.type === "note") await get().openNote(active.path);
    }

    if (ws.chat_session_path) {
      get().loadChatSession(ws.chat_session_path).catch(() => {});
    }
  } catch {
    // First launch or corrupted local workspace UI state; project content still loads normally.
  }
}

function viewportWidth() {
  return typeof window === "undefined" ? 1440 : window.innerWidth;
}

function viewportHeight() {
  return typeof window === "undefined" ? 900 : window.innerHeight;
}

function clamp(value: number, min: number, max: number) {
  return Math.min(max, Math.max(min, value));
}

function maxWidthWithRemainder(min: number, desired: number, minRemainder: number) {
  return Math.max(min, Math.min(Math.max(min, desired), Math.max(min, viewportWidth() - minRemainder)));
}

function maxHeightWithRemainder(min: number, desired: number, minRemainder: number) {
  return Math.max(min, Math.min(Math.max(min, desired), Math.max(min, viewportHeight() - minRemainder)));
}

function clampSidebarWidth(width: number) {
  return clamp(width, 160, maxWidthWithRemainder(160, Math.max(400, viewportWidth() - 420), 320));
}

function clampSecondaryWidth(width: number) {
  return clamp(width, 260, maxWidthWithRemainder(260, Math.max(720, viewportWidth() - 360), 320));
}

function clampOutputHeight(height: number) {
  return clamp(height, 72, maxHeightWithRemainder(72, Math.max(500, viewportHeight() - 220), 160));
}

function resetPersistenceState(): Pick<AppStoreState,
  | "versions"
  | "timelines"
  | "graphNodes"
  | "snapshotPromptOpen"
  | "pendingNavAfterSave"
  | "pendingTimelineAfterSave"
  | "startedBranchFromSnapshot"
  | "lastHistoryCleanup"
  | "pendingHistoryCleanup"
  | "prePushMilestonePrompt"
  | "isDirty"
  | "changedFiles"
  | "hasStash"
  | "isRewound"
  | "currentRemote"
  | "remoteBranches"
  | "remoteBranchesLoading"
  | "syncStatus"
  | "isSyncing"
  | "syncError"
  | "incomingCommits"
  | "shareUrl"
  | "isMerging"
  | "mergeSource"
  | "mergeTarget"
  | "mergeConflicts"
  | "draftlineMergeToken"
  | "draftlineMergeRemote"
  | "diffResult"
  | "diffSelection"
> {
  cancelPendingPrePushMilestonePrompt();
  return {
    versions: [],
    timelines: [],
    graphNodes: [],
    snapshotPromptOpen: false,
    pendingNavAfterSave: null,
    pendingTimelineAfterSave: null,
    startedBranchFromSnapshot: null,
    lastHistoryCleanup: null,
    pendingHistoryCleanup: null,
    prePushMilestonePrompt: null,
    isDirty: false,
    changedFiles: [],
    hasStash: false,
    isRewound: false,
    currentRemote: null,
    remoteBranches: [],
    remoteBranchesLoading: false,
    syncStatus: null,
    isSyncing: false,
    syncError: null,
    incomingCommits: [],
    shareUrl: null,
    isMerging: false,
    mergeSource: null,
    mergeTarget: null,
    mergeConflicts: [],
    draftlineMergeToken: null,
    draftlineMergeRemote: null,
    diffResult: null,
    diffSelection: null,
  };
}

function clearActiveDocumentState(): Pick<AppStoreState,
  | "activeSketchPath"
  | "activeSketch"
  | "activeStoryboardPath"
  | "activeStoryboard"
  | "activeNotePath"
  | "activeNoteContent"
  | "activeNoteLocked"
> {
  return {
    activeSketchPath: null,
    activeSketch: null,
    activeStoryboardPath: null,
    activeStoryboard: null,
    activeNotePath: null,
    activeNoteContent: null,
    activeNoteLocked: false,
  };
}

function loadingDocumentStateForTab(tab: EditorTab): Partial<AppStoreState> {
  if (tab.type === "sketch") {
    return {
      activeSketchPath: tab.path,
      activeSketch: null,
      activeStoryboardPath: null,
      activeStoryboard: null,
      activeNotePath: null,
      activeNoteContent: null,
      activeNoteLocked: false,
    };
  }
  if (tab.type === "storyboard") {
    return {
      activeSketchPath: null,
      activeSketch: null,
      activeStoryboardPath: tab.path,
      activeStoryboard: null,
      activeNotePath: null,
      activeNoteContent: null,
      activeNoteLocked: false,
    };
  }
  if (tab.type === "note") {
    return {
      activeSketchPath: null,
      activeSketch: null,
      activeStoryboardPath: null,
      activeStoryboard: null,
      activeNotePath: tab.path,
      activeNoteContent: null,
      activeNoteLocked: false,
    };
  }
  return clearActiveDocumentState();
}

function tabExistsInLoadedProject(tab: EditorTab, state: AppStoreState): boolean {
  if (tab.type === "sketch") return state.sketches.some((sketch) => sketch.path === tab.path);
  if (tab.type === "storyboard") return state.storyboards.some((storyboard) => storyboard.path === tab.path);
  if (tab.type === "note") return state.notes.some((note) => note.path === tab.path);
  return true;
}

export const useAppStore = create<AppStoreState>((set, get) => ({
  view: "home",
  currentProject: null,
  recentProjects: [],
  projects: [],
  isMultiProject: false,
  loading: false,
  projectSwitching: false,
  error: null,
  sidebarWidth: clampSidebarWidth(savedLayout.sidebarWidth ?? 240),
  sidebarVisible: savedLayout.sidebarVisible ?? true,
  outputVisible: savedLayout.outputVisible ?? false,
  outputActiveTab: "activity",
  outputHeight: clampOutputHeight(savedLayout.outputHeight ?? 200),
  secondaryWidth: clampSecondaryWidth(savedLayout.secondaryWidth ?? 420),
  sidebarPosition: savedLayout.sidebarPosition ?? "left",

  openTabs: [],
  activeTabId: null,
  splitTabs: [],
  splitActiveTabId: null,
  activeEditorGroup: "main",
  editorReloadKey: 0,
  editorReloadPath: null,

  sketches: [],
  activeSketchPath: null,
  activeSketch: null,
  storyboards: [],
  activeStoryboardPath: null,
  activeStoryboard: null,
  notes: [],
  activeNotePath: null,
  activeNoteContent: null,
  activeNoteLocked: false,
  notePreviewPaths: new Set(),
  assets: [],
  narrationAssets: [],
  chatMessages: [],
  chatSessionPath: null,
  chatLoading: false,
  chatError: null,
  chatInputDraft: "",
  chatStreamingText: "",
  chatStreamingThinking: "",
  chatStreamingStatus: "",
  chatStreamingDrafts: [],
  pendingChatPrompt: null,
  chatFocusMode: false,
  terminalFocusMode: false,
  activityLog: [],
  debugLog: [],
  versions: [],
  timelines: [],
  graphNodes: [],
  showSecondaryPanel: savedLayout.showSecondaryPanel ?? false,
  snapshotPromptOpen: false,
  pendingNavAfterSave: null,
  pendingTimelineAfterSave: null,
  startedBranchFromSnapshot: null,
  lastHistoryCleanup: null,
  pendingHistoryCleanup: null,
  prePushMilestonePrompt: null,
  isDirty: false,
  changedFiles: [],
  saving: false,
  hasStash: false,
  isRewound: false,
  currentRemote: null,
  remoteBranches: [],
  remoteBranchesLoading: false,
  syncStatus: null,
  isSyncing: false,
  syncError: null,
  incomingCommits: [],
  shareUrl: null,
  isMerging: false,
  mergeSource: null,
  mergeTarget: null,
  mergeConflicts: [],
  draftlineMergeToken: null,
  draftlineMergeRemote: null,
  diffResult: null,
  diffSelection: null,
  sidebarOrder: null,

  profiles: [],

  selectedProfile: null,
  browserRunning: null,

  isBrowserReady: false,
  browserChannel: null,

  isRecording: false,
  recordingSessionId: null,
  capturedActions: [],
  lastSession: null,
  _activeChannel: null,

  clearError: () => set({ error: null }),
  setView: (view) => set({ view }),
  setSidebarWidth: (width) => {
    const next = typeof width === "function" ? width(get().sidebarWidth) : width;
    const w = clampSidebarWidth(next);
    set({ sidebarWidth: w });
    saveLayout({ sidebarWidth: w });
  },
  toggleSidebar: () => set((s) => {
    saveLayout({ sidebarVisible: !s.sidebarVisible });
    return { sidebarVisible: !s.sidebarVisible };
  }),
  toggleOutput: () => set((s) => {
    saveLayout({ outputVisible: !s.outputVisible });
    return { outputVisible: !s.outputVisible };
  }),
  showOutputTab: (tab) => {
    saveLayout({ outputVisible: true });
    set({ outputVisible: true, outputActiveTab: tab });
  },
  setOutputHeight: (height) => {
    const h = clampOutputHeight(height);
    set({ outputHeight: h });
    saveLayout({ outputHeight: h });
  },
  setSecondaryWidth: (width) => {
    const next = typeof width === "function" ? width(get().secondaryWidth) : width;
    const w = clampSecondaryWidth(next);
    set({ secondaryWidth: w });
    saveLayout({ secondaryWidth: w });
  },
  toggleSidebarPosition: () => set((s) => {
    const pos = s.sidebarPosition === "left" ? "right" : "left";
    saveLayout({ sidebarPosition: pos });
    return { sidebarPosition: pos };
  }),

  // Persist workspace state (tabs + chat session) to local repo state.
  _persistTabs: () => {
    const { openTabs, activeTabId, chatSessionPath } = get();
    invoke("set_workspace_state", {
      workspace: {
        open_tabs: openTabs.map((t) => ({ id: t.id, type: t.type, path: t.path, title: t.title })),
        active_tab_id: activeTabId,
        chat_session_path: chatSessionPath,
      },
    }).catch(() => {});
  },

  openTab: (tab) => {
    const { openTabs, view } = get();
    const existing = openTabs.find((t) => t.path === tab.path && t.type === tab.type);
    if (existing) {
      set({ activeTabId: existing.id });
    } else {
      const id = makeMainTabId(tab.type, tab.path);
      const newTab: EditorTab = { ...tab, id };
      set({ openTabs: [...openTabs, newTab], activeTabId: id });
    }
    // Navigate away from non-editor views (settings, home) to show the tab
    if (view === "settings" || view === "home" || view === "chat") {
      set({ view: "project" });
    }
    get()._persistTabs();
  },
  closeTab: (tabId) => {
    const { openTabs, activeTabId } = get();
    const idx = openTabs.findIndex((t) => t.id === tabId);
    if (idx === -1) return;
    const next = openTabs.filter((t) => t.id !== tabId);
    let nextActive = activeTabId;
    if (activeTabId === tabId) {
      // Activate adjacent tab
      if (next.length === 0) {
        nextActive = null;
      } else if (idx < next.length) {
        nextActive = next[idx].id;
      } else {
        nextActive = next[next.length - 1].id;
      }
    }
    const nextTab = nextActive ? next.find((t) => t.id === nextActive) : undefined;
    set({
      openTabs: next,
      activeTabId: nextActive,
      ...(nextTab ? loadingDocumentStateForTab(nextTab) : clearActiveDocumentState()),
    });
    // Split tabs are independent — closing a main tab does not close its split counterpart
    // Load the new active tab's content
    if (nextTab) {
      if (nextTab?.type === "sketch") {
        get().openSketch(nextTab.path);
      } else if (nextTab?.type === "storyboard") {
        get().openStoryboard(nextTab.path);
      } else if (nextTab?.type === "note") {
        get().openNote(nextTab.path);
      }
    }
    get()._persistTabs();
  },
  closeOtherTabs: (tabId) => {
    const { openTabs } = get();
    const keep = openTabs.find((t) => t.id === tabId);
    if (!keep) return;
    set({ openTabs: [keep], activeTabId: tabId, ...loadingDocumentStateForTab(keep) });
    if (keep.type === "sketch") get().openSketch(keep.path);
    else if (keep.type === "storyboard") get().openStoryboard(keep.path);
    else if (keep.type === "note") get().openNote(keep.path);
    get()._persistTabs();
  },
  closeTabsToRight: (tabId) => {
    const { openTabs, activeTabId } = get();
    const idx = openTabs.findIndex((t) => t.id === tabId);
    if (idx === -1) return;
    const next = openTabs.slice(0, idx + 1);
    const nextActive = next.find((t) => t.id === activeTabId) ? activeTabId : next[next.length - 1]?.id ?? null;
    const nextTab = nextActive ? next.find((t) => t.id === nextActive) : undefined;
    set({
      openTabs: next,
      activeTabId: nextActive,
      ...(nextTab && nextActive !== activeTabId ? loadingDocumentStateForTab(nextTab) : {}),
      ...(!nextTab ? clearActiveDocumentState() : {}),
    });
    if (nextActive && nextActive !== activeTabId) get().setActiveTab(nextActive);
    get()._persistTabs();
  },
  closeTabsToLeft: (tabId) => {
    const { openTabs, activeTabId } = get();
    const idx = openTabs.findIndex((t) => t.id === tabId);
    if (idx === -1) return;
    const next = openTabs.slice(idx);
    const nextActive = next.find((t) => t.id === activeTabId) ? activeTabId : next[0]?.id ?? null;
    const nextTab = nextActive ? next.find((t) => t.id === nextActive) : undefined;
    set({
      openTabs: next,
      activeTabId: nextActive,
      ...(nextTab && nextActive !== activeTabId ? loadingDocumentStateForTab(nextTab) : {}),
      ...(!nextTab ? clearActiveDocumentState() : {}),
    });
    if (nextActive && nextActive !== activeTabId) get().setActiveTab(nextActive);
    get()._persistTabs();
  },
  closeAllTabs: () => {
    set({
      openTabs: [], activeTabId: null, splitTabs: [], splitActiveTabId: null, activeEditorGroup: "main",
      ...clearActiveDocumentState(),
    });
    get()._persistTabs();
  },
  setActiveTab: (tabId) => {
    const { openTabs } = get();
    const tab = openTabs.find((t) => t.id === tabId);
    if (!tab) return;
    set({ activeTabId: tabId, ...loadingDocumentStateForTab(tab) });
    if (tab.type === "sketch") {
      get().openSketch(tab.path);
    } else if (tab.type === "storyboard") {
      get().openStoryboard(tab.path);
    } else if (tab.type === "note") {
      get().openNote(tab.path);
    }
    get()._persistTabs();
  },
  openTabInSplit: (tabId) => {
    const { openTabs, splitTabs } = get();
    const tab = openTabs.find((t) => t.id === tabId);
    if (!tab) return;
    // Focus existing split tab if same document is already there
    const existing = splitTabs.find((t) => t.path === tab.path && t.type === tab.type);
    if (existing) {
      set({ splitActiveTabId: existing.id });
    } else {
      const splitId = makeSplitTabId(tab.type, tab.path);
      const newSplitTab: EditorTab = { ...tab, id: splitId };
      set({ splitTabs: [...splitTabs, newSplitTab], splitActiveTabId: splitId });
    }
  },
  closeTabInSplit: (tabId) => {
    const { splitTabs, splitActiveTabId } = get();
    const idx = splitTabs.findIndex((t) => t.id === tabId);
    if (idx === -1) return;
    const next = splitTabs.filter((t) => t.id !== tabId);
    if (next.length === 0) {
      set({ splitTabs: [], splitActiveTabId: null, activeEditorGroup: "main" });
    } else {
      let nextActive = splitActiveTabId;
      if (splitActiveTabId === tabId) {
        nextActive = idx < next.length ? next[idx].id : next[next.length - 1].id;
      }
      set({ splitTabs: next, splitActiveTabId: nextActive });
    }
  },
  setActiveSplitTab: (tabId) => {
    set({ splitActiveTabId: tabId });
  },
  closeSplit: () => {
    set({ splitTabs: [], splitActiveTabId: null, activeEditorGroup: "main" });
  },
  reorderTabs: (tabIds) => {
    const { openTabs } = get();
    const reordered = tabIds
      .map((id) => openTabs.find((t) => t.id === id))
      .filter(Boolean) as EditorTab[];
    set({ openTabs: reordered });
    get()._persistTabs();
  },

  setActiveEditorGroup: (group) => {
    set({ activeEditorGroup: group });
  },

  moveTabToSplit: (tabId) => {
    const { openTabs, activeTabId, splitTabs } = get();
    const tab = openTabs.find((t) => t.id === tabId);
    if (!tab) return;
    if (openTabs.length < 2) return;
    // Guard: only splittable types
    if (tab.type === "history" || tab.type === "snapshot-preview" || tab.type === "asset" || tab.type === "agent-run" || tab.type === "diff" || tab.type === "database") return;

    // Remove from main
    const newOpenTabs = openTabs.filter((t) => t.id !== tabId);
    let newActiveTabId = activeTabId;
    if (activeTabId === tabId) {
      const idx = openTabs.findIndex((t) => t.id === tabId);
      newActiveTabId = newOpenTabs.length > 0
        ? (idx < newOpenTabs.length ? newOpenTabs[idx].id : newOpenTabs[newOpenTabs.length - 1].id)
        : null;
    }

    // Add to split (focus existing if same doc already there)
    const existing = splitTabs.find((t) => t.path === tab.path && t.type === tab.type);
    if (existing) {
      const nextMainTab = newActiveTabId ? newOpenTabs.find((t) => t.id === newActiveTabId) : undefined;
      set({
        openTabs: newOpenTabs,
        activeTabId: newActiveTabId,
        splitActiveTabId: existing.id,
        activeEditorGroup: "split",
        ...(nextMainTab ? loadingDocumentStateForTab(nextMainTab) : clearActiveDocumentState()),
      });
    } else {
      const splitId = makeSplitTabId(tab.type, tab.path);
      const newSplitTab: EditorTab = { ...tab, id: splitId };
      const nextMainTab = newActiveTabId ? newOpenTabs.find((t) => t.id === newActiveTabId) : undefined;
      set({
        openTabs: newOpenTabs,
        activeTabId: newActiveTabId,
        splitTabs: [...splitTabs, newSplitTab],
        splitActiveTabId: splitId,
        activeEditorGroup: "split",
        ...(nextMainTab ? loadingDocumentStateForTab(nextMainTab) : clearActiveDocumentState()),
      });
    }

    // Load content for the new active main tab (or clear)
    if (newActiveTabId) get().setActiveTab(newActiveTabId);
    else set(clearActiveDocumentState());

    get()._persistTabs();
  },

  moveTabFromSplit: (splitTabId) => {
    const { splitTabs, splitActiveTabId, openTabs } = get();
    const splitTab = splitTabs.find((t) => t.id === splitTabId);
    if (!splitTab) return;

    // Remove from split
    const newSplitTabs = splitTabs.filter((t) => t.id !== splitTabId);
    let newSplitActiveTabId = splitActiveTabId;
    if (splitActiveTabId === splitTabId) {
      const idx = splitTabs.findIndex((t) => t.id === splitTabId);
      newSplitActiveTabId = newSplitTabs.length > 0
        ? (idx < newSplitTabs.length ? newSplitTabs[idx].id : newSplitTabs[newSplitTabs.length - 1].id)
        : null;
    }
    const nextActiveEditorGroup = newSplitTabs.length === 0 ? "main" : "main";

    // Add/focus in main
    const existing = openTabs.find((t) => t.path === splitTab.path && t.type === splitTab.type);
    if (existing) {
      set({ splitTabs: newSplitTabs, splitActiveTabId: newSplitActiveTabId, activeEditorGroup: nextActiveEditorGroup });
      get().setActiveTab(existing.id);
    } else {
      const mainId = makeMainTabId(splitTab.type, splitTab.path);
      const mainTab: EditorTab = { ...splitTab, id: mainId };
      set({ splitTabs: newSplitTabs, splitActiveTabId: newSplitActiveTabId, openTabs: [...openTabs, mainTab], activeEditorGroup: nextActiveEditorGroup });
      get().setActiveTab(mainId);
    }

    get()._persistTabs();
  },

  reorderSplitTabs: (tabIds) => {
    const { splitTabs } = get();
    const reordered = tabIds.map((id) => splitTabs.find((t) => t.id === id)).filter(Boolean) as EditorTab[];
    set({ splitTabs: reordered });
  },

  _removeSplitTabByPath: (type, path) => {
    const { splitTabs, splitActiveTabId } = get();
    const next = splitTabs.filter((t) => !(t.type === type && t.path === path));
    if (next.length === splitTabs.length) return; // nothing to remove
    if (next.length === 0) {
      set({ splitTabs: [], splitActiveTabId: null, activeEditorGroup: "main" });
    } else {
      const stillActive = next.find((t) => t.id === splitActiveTabId);
      set({ splitTabs: next, splitActiveTabId: stillActive ? splitActiveTabId : next[0].id });
    }
  },

  // ── Project actions ───────────────────────────────────────

  loadRecentProjects: async () => {
    try {
      const recentProjects = await invoke<RecentProject[]>("get_recent_projects");
      set({ recentProjects });
    } catch (err) {
      console.error("Failed to load recent projects:", err);
    }
  },

  removeRecentProject: async (path) => {
    try {
      await invoke("remove_recent_project", { path });
      await get().loadRecentProjects();
    } catch (err) {
      console.error("Failed to remove recent project:", err);
    }
  },

  createProject: async (path) => {
    set({ loading: true });
    try {
      const project = await invoke<ProjectView>("create_project_folder", { path });
      setDraftlineWorkspacePath(project.repo_root);
      set({
        ...resetPersistenceState(),
        currentProject: project,
        view: "project",
        openTabs: [],
        activeTabId: null,
        splitTabs: [],
        splitActiveTabId: null,
        activeEditorGroup: "main",
        activeSketchPath: null,
        activeSketch: null,
        activeStoryboardPath: null,
        activeStoryboard: null,
        activeNotePath: null,
        activeNoteContent: null,
        activeNoteLocked: false,
        chatMessages: [],
        chatSessionPath: null,
      });
      localStorage.setItem("cutready:lastProject", path);
      await get().loadRecentProjects();
      await get().loadProjects();
      await get().loadSketches();
      await get().loadStoryboards();
      await get().loadNotes();
      await get().loadSidebarOrder();
      await get().loadVersions();
      await get().loadTimelines();
      await get().loadGraphData();
      await get().checkDirty();
      await get().checkRewound();
      await get().checkStash();
    } catch (err) {
      console.error("Failed to create project:", err);
      set({ error: String(err) });
    } finally {
      set({ loading: false });
    }
  },

  openProject: async (path) => {
    set({ loading: true });
    try {
      const project = await invoke<ProjectView>("open_project_folder", { path });
      setDraftlineWorkspacePath(project.repo_root);
      set({
        ...resetPersistenceState(),
        currentProject: project,
        view: "project",
        openTabs: [],
        activeTabId: null,
        splitTabs: [],
        splitActiveTabId: null,
        activeEditorGroup: "main",
        activeSketchPath: null,
        activeSketch: null,
        activeStoryboardPath: null,
        activeStoryboard: null,
        activeNotePath: null,
        activeNoteContent: null,
        activeNoteLocked: false,
      });
      localStorage.setItem("cutready:lastProject", path);
      // Load multi-project state
      await get().loadProjects();
      // Load workspace settings
      const { useSettingsStore } = await import("../hooks/useSettings");
      await useSettingsStore.getState()._loadWorkspaceSettings();
      await get().loadSketches();
      await get().loadStoryboards();
      await get().loadNotes();
      await get().loadSidebarOrder();
      await restoreWorkspaceState(get, set);
      await get().loadVersions();
      await get().loadTimelines();
      await get().loadGraphData();
      await get().checkDirty();
      await get().checkRewound();
      await get().checkStash();
      // Auto-detect remote and fetch in background (non-blocking)
      get().detectRemote().then(() => {
        if (get().currentRemote) {
          get().fetchFromRemote({ notifyAuthRequired: false }).catch(() => {});
        }
      });
    } catch (err) {
      console.error("Failed to open project:", err);
      set({ error: String(err) });
    } finally {
      set({ loading: false });
    }
  },

  closeProject: () => {
    invoke("close_project").catch(console.error);
    setDraftlineWorkspacePath(null);
    localStorage.removeItem("cutready:lastProject");
    // Clear workspace settings
    import("../hooks/useSettings").then(({ useSettingsStore }) => {
      useSettingsStore.getState()._clearWorkspaceSettings();
    });
    set({
      ...resetPersistenceState(),
      currentProject: null,
      projects: [],
      isMultiProject: false,
      view: "home",
      sketches: [],
      activeSketchPath: null,
      activeSketch: null,
      storyboards: [],
      activeStoryboardPath: null,
      activeStoryboard: null,
      notes: [],
      activeNotePath: null,
      activeNoteContent: null,
      activeNoteLocked: false,
      assets: [],
      narrationAssets: [],
      chatMessages: [],
      chatSessionPath: null,
      chatLoading: false,
      chatError: null,
      pendingChatPrompt: null,
      activityLog: [],
      debugLog: [],
      sidebarOrder: null,
      openTabs: [],
      activeTabId: null,
      splitTabs: [],
      splitActiveTabId: null,
      activeEditorGroup: "main",
    });
  },

  // ── Multi-project actions ──────────────────────────────────

  loadProjects: async () => {
    try {
      const [projects, isMulti] = await Promise.all([
        invoke<ProjectEntry[]>("list_projects"),
        invoke<boolean>("is_multi_project"),
      ]);
      set({ projects, isMultiProject: isMulti });
    } catch {
      set({ projects: [], isMultiProject: false });
    }
  },

  switchProject: async (projectPath) => {
    set({ loading: true, projectSwitching: true });
    try {
      // Save current workspace state before switching
      const { openTabs, activeTabId, chatSessionPath, currentProject, startedBranchFromSnapshot } = get();
      await invoke("set_workspace_state", {
        workspace: {
          open_tabs: openTabs.map((t) => ({
            id: t.id,
            type: t.type,
            path: t.path,
            title: t.title,
          })),
          active_tab_id: activeTabId,
          chat_session_path: chatSessionPath,
        },
      }).catch(() => {});

      const project = await invoke<ProjectView>("switch_project", { projectPath });
      const preservesDraftlineWorkspace = currentProject?.repo_root === project.repo_root;
      setDraftlineWorkspacePath(project.repo_root);
      set({
        ...resetPersistenceState(),
        startedBranchFromSnapshot: preservesDraftlineWorkspace ? startedBranchFromSnapshot : null,
        currentProject: project,
        openTabs: [],
        activeTabId: null,
        splitTabs: [],
        splitActiveTabId: null,
        activeEditorGroup: "main",
        activeSketchPath: null,
        activeSketch: null,
        activeStoryboardPath: null,
        activeStoryboard: null,
        activeNotePath: null,
        activeNoteContent: null,
        activeNoteLocked: false,
        chatMessages: [],
        chatSessionPath: null,
      });
      await get().loadSketches();
      await get().loadStoryboards();
      await get().loadNotes();
      await get().loadSidebarOrder();
      await restoreWorkspaceState(get, set);
      await get().loadVersions();
      await get().loadTimelines();
      await get().loadGraphData();
      await get().checkDirty();
      await get().checkRewound();
      await get().checkStash();
    } catch (err) {
      console.error("Failed to switch project:", err);
      set({ error: String(err) });
    } finally {
      set({ loading: false, projectSwitching: false });
    }
  },

  createProjectInRepo: async (name, description) => {
    try {
      await invoke("create_project_in_repo", { name, description: description ?? null });
      await get().loadProjects();
    } catch (err) {
      console.error("Failed to create project:", err);
      set({ error: String(err) });
    }
  },

  deleteProjectFromRepo: async (projectPath, deleteFiles = false) => {
    try {
      await invoke("delete_project", { projectPath, deleteFiles });
      await get().loadProjects();
      await get().checkDirty();
      await get().refreshChangedFiles();
      await get().loadGraphData();
    } catch (err) {
      console.error("Failed to delete project:", err);
      const message = `Could not delete project: ${err}`;
      set({ error: message });
      useToastStore.getState().show(message, 5000, "error");
      throw err;
    }
  },

  // ── Sketch actions ─────────────────────────────────────

  loadSketches: async () => {
    try {
      const sketches = await invoke<SketchSummary[]>("list_sketches");
      set({ sketches });
    } catch (err) {
      console.error("Failed to load sketches:", err);
    }
  },

  createSketch: async (title) => {
    try {
      let slug = title.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "");
      if (!slug) slug = `untitled-${Date.now()}`;
      const relativePath = slug + ".sk";
      const sketch = await invoke<Sketch>("create_sketch", { relativePath, title });
      set({
        activeSketchPath: relativePath,
        activeSketch: sketch,
        activeStoryboardPath: null,
        activeStoryboard: null,
        activeNotePath: null,
        activeNoteContent: null,
        activeNoteLocked: false,
      });
      get().openTab({ type: "sketch", path: relativePath, title });
      await get().loadSketches();
    } catch (err) {
      console.error("Failed to create sketch:", err);
    }
  },

  openSketch: async (sketchPath) => {
    set({
      activeSketchPath: sketchPath,
      activeSketch: null,
      activeStoryboardPath: null,
      activeStoryboard: null,
      activeNotePath: null,
      activeNoteContent: null,
      activeNoteLocked: false,
    });
    try {
      const sketch = await invoke<Sketch>("get_sketch", { relativePath: sketchPath });
      if (get().activeSketchPath !== sketchPath) return;
      set({
        activeSketchPath: sketchPath,
        activeSketch: sketch,
      });
      get().openTab({ type: "sketch", path: sketchPath, title: sketch.title });
    } catch (err) {
      console.error("Failed to open sketch:", err);
    }
  },

  updateSketch: async (update) => {
    const { activeSketchPath } = get();
    if (!activeSketchPath) return;
    if (shouldSuppressEditorFlush(activeSketchPath)) return;
    try {
      await invoke("update_sketch", { relativePath: activeSketchPath, ...update });
      const { activeSketch, activeSketchPath: currentActiveSketchPath } = get();
      if (activeSketch && currentActiveSketchPath === activeSketchPath) {
        set({ activeSketch: { ...activeSketch, ...update } });
      }
      set({ isDirty: true });
      await get().refreshChangedFiles();
    } catch (err) {
      console.error("Failed to update sketch:", err);
    }
  },

  updateSketchTitle: async (sketchPath, title) => {
    // Guard: skip if navigation has cleared the active sketch
    if (!get().activeSketchPath) return;
    if (shouldSuppressEditorFlush(sketchPath)) return;
    try {
      await invoke("update_sketch_title", { relativePath: sketchPath, title });
      await get().loadSketches();
      const { activeSketch, activeSketchPath } = get();
      if (activeSketch && activeSketchPath === sketchPath) {
        set({ activeSketch: { ...activeSketch, title } });
      }
      set({ isDirty: true });
      await get().refreshChangedFiles();
    } catch (err) {
      console.error("Failed to update sketch title:", err);
    }
  },

  deleteSketch: async (sketchPath) => {
    try {
      await invoke("delete_sketch", { relativePath: sketchPath });
      const { activeSketchPath, openTabs } = get();
      if (activeSketchPath === sketchPath) {
        set({ activeSketchPath: null, activeSketch: null });
      }
      // Close any tab for this sketch in both panes
      const tab = openTabs.find((t) => t.path === sketchPath && t.type === "sketch");
      if (tab) get().closeTab(tab.id);
      get()._removeSplitTabByPath("sketch", sketchPath);
      await get().loadSketches();
      await get().loadStoryboards();
      const { activeStoryboardPath: currentActiveStoryboardPath } = get();
      if (currentActiveStoryboardPath) {
        const storyboard = await invoke<Storyboard>("get_storyboard", { relativePath: currentActiveStoryboardPath });
        if (get().activeStoryboardPath === currentActiveStoryboardPath) {
          set({ activeStoryboard: storyboard });
        }
      }
      set({ isDirty: true });
      await get().refreshChangedFiles();
    } catch (err) {
      console.error("Failed to delete sketch:", err);
    }
  },

  closeSketch: () => {
    set({ activeSketchPath: null, activeSketch: null });
  },

  // ── Storyboard actions ───────────────────────────────

  loadStoryboards: async () => {
    try {
      const storyboards = await invoke<StoryboardSummary[]>("list_storyboards");
      set({ storyboards });
    } catch (err) {
      console.error("Failed to load storyboards:", err);
    }
  },

  createStoryboard: async (title) => {
    try {
      let slug = title.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "");
      if (!slug) slug = `untitled-${Date.now()}`;
      const relativePath = slug + ".sb";
      const storyboard = await invoke<Storyboard>("create_storyboard", { relativePath, title });
      set({
        activeStoryboardPath: relativePath,
        activeStoryboard: storyboard,
        activeSketchPath: null,
        activeSketch: null,
        activeNotePath: null,
        activeNoteContent: null,
        activeNoteLocked: false,
      });
      get().openTab({ type: "storyboard", path: relativePath, title });
      await get().loadStoryboards();
    } catch (err) {
      console.error("Failed to create storyboard:", err);
    }
  },

  openStoryboard: async (storyboardPath) => {
    set({
      activeStoryboardPath: storyboardPath,
      activeStoryboard: null,
      activeSketchPath: null,
      activeSketch: null,
      activeNotePath: null,
      activeNoteContent: null,
      activeNoteLocked: false,
    });
    try {
      const storyboard = await invoke<Storyboard>("get_storyboard", { relativePath: storyboardPath });
      if (get().activeStoryboardPath !== storyboardPath) return;
      set({
        activeStoryboardPath: storyboardPath,
        activeStoryboard: storyboard,
        activeSketchPath: null,
        activeSketch: null,
      });
      get().openTab({ type: "storyboard", path: storyboardPath, title: storyboard.title });
    } catch (err) {
      console.error("Failed to open storyboard:", err);
    }
  },

  updateStoryboard: async (update) => {
    const { activeStoryboardPath } = get();
    if (!activeStoryboardPath) return;
    if (shouldSuppressEditorFlush(activeStoryboardPath)) return;
    try {
      await invoke("update_storyboard", { relativePath: activeStoryboardPath, ...update });
      const storyboard = await invoke<Storyboard>("get_storyboard", { relativePath: activeStoryboardPath });
      if (get().activeStoryboardPath === activeStoryboardPath) {
        set({ activeStoryboard: storyboard });
      }
      await get().loadStoryboards();
      set({ isDirty: true });
      await get().refreshChangedFiles();
    } catch (err) {
      console.error("Failed to update storyboard:", err);
    }
  },

  setStoryboardLocked: async (locked) => {
    const { activeStoryboardPath } = get();
    if (!activeStoryboardPath) return;
    try {
      const storyboard = await invoke<Storyboard>("set_storyboard_lock", { relativePath: activeStoryboardPath, locked });
      if (get().activeStoryboardPath === activeStoryboardPath) {
        set({ activeStoryboard: storyboard });
      }
      await get().loadStoryboards();
      await get().loadSketches();
      const { activeSketchPath, activeStoryboardPath: currentActiveStoryboardPath } = get();
      const sketchPaths = currentActiveStoryboardPath === activeStoryboardPath
        ? getStoryboardSketchPaths(storyboard)
        : [];
      if (activeSketchPath && sketchPaths.includes(activeSketchPath)) {
        await get().openSketch(activeSketchPath);
      }
      window.dispatchEvent(new CustomEvent("cutready:sketch-saved"));
      set({ isDirty: true });
      await get().refreshChangedFiles();
    } catch (err) {
      console.error("Failed to update storyboard lock:", err);
    }
  },

  deleteStoryboard: async (storyboardPath) => {
    try {
      await invoke("delete_storyboard", { relativePath: storyboardPath });
      const { activeStoryboardPath, openTabs } = get();
      if (activeStoryboardPath === storyboardPath) {
        set({ activeStoryboardPath: null, activeStoryboard: null });
      }
      const tab = openTabs.find((t) => t.path === storyboardPath && t.type === "storyboard");
      if (tab) get().closeTab(tab.id);
      get()._removeSplitTabByPath("storyboard", storyboardPath);
      await get().loadStoryboards();
    } catch (err) {
      console.error("Failed to delete storyboard:", err);
    }
  },

  addSketchToStoryboard: async (sketchPath, position) => {
    const { activeStoryboardPath } = get();
    if (!activeStoryboardPath) return;
    try {
      await invoke("add_sketch_to_storyboard", {
        storyboardPath: activeStoryboardPath,
        sketchPath,
        position: position ?? null,
      });
      const storyboard = await invoke<Storyboard>("get_storyboard", { relativePath: activeStoryboardPath });
      set({ activeStoryboard: storyboard });
      await get().loadStoryboards();
      set({ isDirty: true });
      await get().refreshChangedFiles();
    } catch (err) {
      console.error("Failed to add sketch to storyboard:", err);
    }
  },

  removeFromStoryboard: async (position) => {
    const { activeStoryboardPath } = get();
    if (!activeStoryboardPath) return;
    try {
      await invoke("remove_sketch_from_storyboard", {
        storyboardPath: activeStoryboardPath,
        position,
      });
      const storyboard = await invoke<Storyboard>("get_storyboard", { relativePath: activeStoryboardPath });
      set({ activeStoryboard: storyboard });
      await get().loadStoryboards();
      set({ isDirty: true });
      await get().refreshChangedFiles();
    } catch (err) {
      console.error("Failed to remove from storyboard:", err);
    }
  },

  addSectionToStoryboard: async (title, position) => {
    const { activeStoryboardPath } = get();
    if (!activeStoryboardPath) return;
    try {
      await invoke("add_section_to_storyboard", {
        storyboardPath: activeStoryboardPath,
        title,
        description: null,
        position: position ?? null,
      });
      const storyboard = await invoke<Storyboard>("get_storyboard", { relativePath: activeStoryboardPath });
      set({ activeStoryboard: storyboard });
      await get().loadStoryboards();
      set({ isDirty: true });
      await get().refreshChangedFiles();
    } catch (err) {
      console.error("Failed to add section:", err);
    }
  },

  reorderStoryboardItems: async (items) => {
    const { activeStoryboardPath } = get();
    if (!activeStoryboardPath) return;
    try {
      await invoke("reorder_storyboard_items", {
        storyboardPath: activeStoryboardPath,
        items,
      });
      const storyboard = await invoke<Storyboard>("get_storyboard", { relativePath: activeStoryboardPath });
      set({ activeStoryboard: storyboard });
      set({ isDirty: true });
      await get().refreshChangedFiles();
    } catch (err) {
      console.error("Failed to reorder items:", err);
    }
  },

  closeStoryboard: () => {
    set({ activeStoryboardPath: null, activeStoryboard: null, activeSketchPath: null, activeSketch: null });
  },

  // ── Note actions ──────────────────────────────────────────

  loadNotes: async () => {
    try {
      const notes = await invoke<NoteSummary[]>("list_notes");
      set({ notes });
    } catch (err) {
      console.error("Failed to load notes:", err);
    }
  },

  createNote: async (title) => {
    try {
      let slug = title.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "");
      if (!slug) slug = `untitled-${Date.now()}`;
      const relativePath = slug + ".md";
      await invoke("create_note", { relativePath });
      set({
        activeNotePath: relativePath,
        activeNoteContent: "",
        activeNoteLocked: false,
        activeSketchPath: null,
        activeSketch: null,
        activeStoryboardPath: null,
        activeStoryboard: null,
      });
      get().openTab({ type: "note", path: relativePath, title });
      await get().loadNotes();
    } catch (err) {
      console.error("Failed to create note:", err);
    }
  },

  openNote: async (notePath) => {
    set({
      activeNotePath: notePath,
      activeNoteContent: null,
      activeNoteLocked: false,
      activeSketchPath: null,
      activeSketch: null,
      activeStoryboardPath: null,
      activeStoryboard: null,
    });
    try {
      const [content, lock] = await Promise.all([
        invoke<string>("get_note", { relativePath: notePath }),
        invoke<{ locked: boolean }>("get_note_lock", { relativePath: notePath }),
      ]);
      if (get().activeNotePath !== notePath) return;
      const title = notePath.replace(/\.md$/, "").split("/").pop() ?? notePath;
      set({
        activeNotePath: notePath,
        activeNoteContent: content,
        activeNoteLocked: lock.locked,
        activeSketchPath: null,
        activeSketch: null,
        activeStoryboardPath: null,
        activeStoryboard: null,
      });
      get().openTab({ type: "note", path: notePath, title });
    } catch (err) {
      console.error("Failed to open note:", err);
    }
  },

  updateNote: async (content) => {
    const { activeNotePath, activeNoteLocked } = get();
    if (!activeNotePath) return;
    if (shouldSuppressEditorFlush(activeNotePath)) return;
    if (activeNoteLocked) return;
    try {
      await invoke("update_note", { relativePath: activeNotePath, content });
      set({
        ...(get().activeNotePath === activeNotePath ? { activeNoteContent: content } : {}),
        isDirty: true,
      });
      await get().refreshChangedFiles();
    } catch (err) {
      console.error("Failed to update note:", err);
    }
  },

  setNoteLocked: async (notePath, locked) => {
    try {
      const lock = await invoke<{ locked: boolean }>("set_note_lock", { relativePath: notePath, locked });
      if (get().activeNotePath === notePath) {
        set({ activeNoteLocked: lock.locked });
      }
    } catch (err) {
      console.error("Failed to update note lock:", err);
    }
  },

  deleteNote: async (notePath) => {
    try {
      await invoke("delete_note", { relativePath: notePath });
      const { activeNotePath, openTabs } = get();
      if (activeNotePath === notePath) {
        set({ activeNotePath: null, activeNoteContent: null, activeNoteLocked: false });
      }
      const tab = openTabs.find((t) => t.path === notePath && t.type === "note");
      if (tab) get().closeTab(tab.id);
      get()._removeSplitTabByPath("note", notePath);
      get().setNotePreview(notePath, false);
      await get().loadNotes();
    } catch (err) {
      console.error("Failed to delete note:", err);
    }
  },

  closeNote: () => {
    set({ activeNotePath: null, activeNoteContent: null, activeNoteLocked: false });
  },

  setNotePreview: (notePath, preview) => {
    const next = new Set(get().notePreviewPaths);
    if (preview) next.add(notePath);
    else next.delete(notePath);
    set({ notePreviewPaths: next });
  },

  // ── Asset actions ──────────────────────────────────────────

  loadAssets: async () => {
    try {
      const raw = await invoke<{ path: string; size: number; referencedBy: string[]; assetType: string; modifiedAt: number }[]>("list_project_images");
      const assets: AssetInfo[] = raw.map((r) => ({
        path: r.path,
        size: r.size,
        assetType: r.assetType as "screenshot" | "visual",
        referencedBy: r.referencedBy,
        modifiedAt: r.modifiedAt,
      }));
      set({ assets });
    } catch (err) {
      console.error("Failed to load assets:", err);
    }
  },

  loadNarrationAssets: async () => {
    try {
      const narrationAssets = await invoke<NarrationAssetInfo[]>("list_project_narration_assets");
      set({ narrationAssets });
    } catch (err) {
      console.error("Failed to load narration assets:", err);
      set({ narrationAssets: [] });
    }
  },

  openAsset: (path, _assetType) => {
    const filename = path.split("/").pop() ?? path;
    get().openTab({ type: "asset", path, title: filename });
    // Navigate to assets view if not already there
    if (get().view !== "assets" && get().view !== "sketch" && get().view !== "project") {
      set({ view: "assets" });
    }
  },

  openDatabase: (path, tableName) => {
    const filename = path.split("/").pop() ?? path;
    const tabPath = tableName ? `${path}#${encodeURIComponent(tableName)}` : path;
    get().openTab({ type: "database", path: tabPath, title: tableName ? `${tableName} (${filename})` : filename });
  },

  importAsset: async () => {
    try {
      const { open } = await import("@tauri-apps/plugin-dialog");
      const selected = await open({
        multiple: false,
        filters: [{ name: "Images", extensions: ["png", "jpg", "jpeg", "gif", "webp", "svg"] }],
      });
      if (!selected) return;
      const filePath = typeof selected === "string" ? selected : selected;
      await invoke("import_image", { sourcePath: filePath });
      await get().loadAssets();
    } catch (err) {
      console.error("Failed to import asset:", err);
    }
  },

  deleteAsset: async (path) => {
    try {
      await invoke("delete_project_image", { relativePath: path });
      // Close any open tab for this asset
      const { openTabs, activeTabId } = get();
      const tab = openTabs.find((t) => t.type === "asset" && t.path === path);
      if (tab) {
        const filtered = openTabs.filter((t) => t.id !== tab.id);
        set({
          openTabs: filtered,
          activeTabId: activeTabId === tab.id ? (filtered[filtered.length - 1]?.id ?? null) : activeTabId,
        });
      }
      await get().loadAssets();
    } catch (err) {
      console.error("Failed to delete asset:", err);
    }
  },

  deleteUnlinkedAssets: async () => {
    try {
      const candidatePaths = get().assets
        .filter((asset) => asset.referencedBy.length === 0)
        .map((asset) => asset.path);
      const deleted = await invoke<number>("delete_orphaned_images");
      const { openTabs, activeTabId } = get();
      const filtered = openTabs.filter((tab) => tab.type !== "asset" || !candidatePaths.includes(tab.path));
      set({
        openTabs: filtered,
        activeTabId: filtered.some((tab) => tab.id === activeTabId)
          ? activeTabId
          : (filtered[filtered.length - 1]?.id ?? null),
      });
      await get().loadAssets();
      return deleted;
    } catch (err) {
      console.error("Failed to delete unlinked assets:", err);
      throw err;
    }
  },

  deleteUnlinkedNarrationAssets: async () => {
    try {
      const candidatePaths = get().narrationAssets
        .filter((asset) => asset.referencedBy.length === 0 && asset.path.startsWith(".cutready/narration/"))
        .map((asset) => asset.path);
      const deleted = await invoke<number>("delete_orphaned_narration_assets");
      const { openTabs, activeTabId } = get();
      const filtered = openTabs.filter((tab) => tab.type !== "asset" || !candidatePaths.includes(tab.path));
      set({
        openTabs: filtered,
        activeTabId: filtered.some((tab) => tab.id === activeTabId)
          ? activeTabId
          : (filtered[filtered.length - 1]?.id ?? null),
      });
      await get().loadNarrationAssets();
      return deleted;
    } catch (err) {
      console.error("Failed to delete unlinked narration assets:", err);
      throw err;
    }
  },

  // ── Chat actions ──────────────────────────────────────────

  setChatMessages: (messages) => {
    const existingSessionPath = get().chatSessionPath;
    const chatSessionPath = existingSessionPath ?? (messages.length > 0 ? createLocalChatSessionPath() : null);
    set({ chatMessages: messages, chatSessionPath, chatError: null });
    if (chatSessionPath !== existingSessionPath) {
      get()._persistTabs();
    }
    // Auto-save after a short delay
    const state = get();
    if (state.chatSessionPath && messages.length > 0) {
      state.saveChatSession().catch(console.error);
    }
  },

  newChatSession: () => {
    // Archive the previous session if it had messages
    const { chatMessages, chatSessionPath } = get();
    if (chatSessionPath && chatMessages.length > 1) {
      const userMsgs = chatMessages.filter((m) => m.role === "user");
      const summary = userMsgs.map((m) => chatMessagePreviewContent(m).slice(0, 100)).filter(Boolean).join("; ");
      if (summary) {
        invoke("archive_chat_session", {
          sessionId: chatSessionPath,
          summary: `Topics discussed: ${summary}`,
        }).catch(() => {});
      }
    }

    set({
      chatMessages: [],
      chatSessionPath: null,
      chatLoading: false,
      chatError: null,
      chatInputDraft: "",
      activityLog: [],
    });
    get()._persistTabs();
  },

  loadChatSession: async (sessionPath) => {
    try {
      const session = await invoke<{
        title: string;
        messages: ChatMessage[];
        created_at: string;
        updated_at: string;
        author_name?: string | null;
        author_email?: string | null;
      }>(
        "get_chat_session",
        { relativePath: sessionPath },
      );
      set({
        chatMessages: session.messages,
        chatSessionPath: sessionPath,
        chatError: null,
      });
      get()._persistTabs();
    } catch {
      // Session file doesn't exist (e.g., new session with no messages yet) — start fresh
      get().newChatSession();
    }
  },

  saveChatSession: async () => {
    const { chatMessages, chatSessionPath } = get();
    if (!chatSessionPath || chatMessages.length === 0) return;
    // Derive title from first user message
    const firstUser = chatMessages.find((m) => m.role === "user");
    const title = firstUser ? chatMessagePreviewContent(firstUser).slice(0, 80) : "Chat session";
    const now = new Date().toISOString();
    try {
      await invoke("save_chat_session", {
        relativePath: chatSessionPath,
        session: {
          title,
          messages: chatMessages,
          created_at: now,
          updated_at: now,
        },
      });
    } catch (err) {
      console.error("Failed to save chat session:", err);
    }
  },

  setChatLoading: (loading) => set({ chatLoading: loading }),
  setChatError: (error) => set({ chatError: error }),
  setChatInputDraft: (draft) => set({ chatInputDraft: draft }),
  setChatStreamingState: (state) => set(state),
  resetChatStreaming: () => set({
    chatStreamingText: "",
    chatStreamingThinking: "",
    chatStreamingStatus: "",
    chatStreamingDrafts: [],
  }),
  sendChatPrompt: (prompt, opts) => set({ pendingChatPrompt: { text: prompt, silent: opts?.silent, agent: opts?.agent } }),
  setChatFocusMode: (enabled) => set({ chatFocusMode: enabled }),
  setTerminalFocusMode: (enabled) => set({ terminalFocusMode: enabled, outputVisible: true, outputActiveTab: "terminal" }),
  addActivityEntries: (entries) => {
    recordActivityEntries(entries);
    set((s) => ({ activityLog: [...s.activityLog, ...entries] }));
  },
  clearActivityLog: () => set({ activityLog: [] }),
  addDebugEntry: (entry) => set((s) => ({ debugLog: [...s.debugLog.slice(-499), entry] })),
  clearDebugLog: () => set({ debugLog: [] }),

  listChatSessions: async () => {
    try {
      return await invoke<ChatSessionSummary[]>("list_chat_sessions");
    } catch (err) {
      console.error("Failed to list chat sessions:", err);
      return [];
    }
  },

  deleteChatSession: async (sessionPath) => {
    try {
      await invoke("delete_chat_session", { relativePath: sessionPath });
    } catch (err) {
      console.error("Failed to delete chat session:", err);
    }
  },

  // ── Versioning actions ───────────────────────────────────

  loadVersions: async () => {
    try {
      const versions = await listDraftlineVersions();
      set({ versions });
      await get().checkDirty();
    } catch (err) {
      console.error("Failed to load versions:", err);
    }
  },

  checkDirty: async () => {
    try {
      const isDirty = await hasDraftlineChanges();
      set({ isDirty });
      // Also refresh the changed files list
      get().refreshChangedFiles();
    } catch (err) {
      console.error("Failed to check dirty state:", err);
      useToastStore.getState().show(`Could not check project changes: ${err}`, 5000, "error");
    }
  },

  refreshChangedFiles: async () => {
    try {
      const files = await listDraftlineChangedFiles();
      set({ changedFiles: files });
    } catch {
      set({ changedFiles: [] });
    }
  },

  saveVersion: async (label, _forkLabel?) => {
    try {
      await saveDraftlineVersion(label);
      const activeTimeline = get().timelines.find((timeline) => timeline.is_active);
      const startedBranch = get().startedBranchFromSnapshot;
      set({
        isDirty: false,
        isRewound: false,
        changedFiles: [],
        startedBranchFromSnapshot: startedBranch?.branchName === activeTimeline?.name ? null : startedBranch,
      });
      await get().loadVersions();
      await get().loadTimelines();
      await get().loadGraphData();
      await get().checkDirty();
      await get().checkRewound();
      await get().refreshSyncStatus();
    } catch (err) {
      console.error("Failed to save version:", err);
    }
  },

  stashChanges: async () => {
    try {
      await shelveDraftlineChanges();
      set({ hasStash: true });
    } catch (err) {
      console.error("Failed to stash changes:", err);
    }
  },

  discardChanges: async () => {
    const suppressedPaths = Array.from(new Set([
      ...get().openTabs.filter(isDocumentTab).map((tab) => tab.path),
      ...get().splitTabs.filter(isDocumentTab).map((tab) => tab.path),
      get().activeSketchPath,
      get().activeStoryboardPath,
      get().activeNotePath,
    ].filter((path): path is string => !!path)));
    try {
      for (const path of suppressedPaths) suppressEditorFlush(path);
      set({
        activeSketch: null,
        activeSketchPath: null,
        activeStoryboard: null,
        activeStoryboardPath: null,
        activeNotePath: null,
        activeNoteContent: null,
        activeNoteLocked: false,
      });
      await discardDraftlineChanges();
      await get().loadSketches();
      await get().loadStoryboards();
      await get().loadNotes();
      set({
        openTabs: [],
        activeTabId: null,
        splitTabs: [],
        splitActiveTabId: null,
        activeEditorGroup: "main",
        editorReloadPath: null,
      });
      globalThis.setTimeout(() => clearSuppressedEditorFlushes(suppressedPaths), 100);
      await get().checkDirty();
      set({ syncError: null });
    } catch (err) {
      clearSuppressedEditorFlushes(suppressedPaths);
      console.error("Failed to discard changes:", err);
      useToastStore.getState().show(`Discard failed: ${err}`, 5000, "error");
      await get().checkDirty();
    }
  },

  discardFile: async (filePath) => {
    const { repoPath, projectPath } = scopedPathVariants(filePath, get().currentProject);
    const suppressedPaths = Array.from(new Set([filePath, repoPath, projectPath].filter(Boolean)));
    const pathMatchesDiscard = (path: string | null | undefined) => {
      if (!path) return false;
      const normalized = normalizeRelativePath(path);
      return normalized === repoPath || normalized === projectPath;
    };
    try {
      for (const path of suppressedPaths) suppressEditorFlush(path);
      await discardDraftlineFile(repoPath);
      await get().loadSketches();
      await get().loadStoryboards();
      await get().loadNotes();
      const {
        activeSketchPath,
        activeStoryboardPath,
        activeNotePath,
        sketches,
        storyboards,
        notes,
        openTabs,
        activeTabId,
        splitTabs,
        splitActiveTabId,
        activeEditorGroup,
      } = get();
      const fileExistsForTab = (tab: EditorTab) => {
        if (!pathMatchesDiscard(tab.path) || !isDocumentTab(tab)) return true;
        if (tab.type === "sketch") return sketches.some((sketch) => sketch.path === projectPath);
        if (tab.type === "storyboard") return storyboards.some((storyboard) => storyboard.path === projectPath);
        return notes.some((note) => note.path === projectPath);
      };
      const nextOpenTabs = openTabs.filter(fileExistsForTab);
      const nextSplitTabs = splitTabs.filter(fileExistsForTab);
      const nextActiveTabId = nextActiveTabIdAfterFiltering(openTabs, nextOpenTabs, activeTabId);
      const nextSplitActiveTabId = nextActiveTabIdAfterFiltering(splitTabs, nextSplitTabs, splitActiveTabId);
      const fileWasOpen = openTabs.some((tab) => isDocumentTab(tab) && pathMatchesDiscard(tab.path))
        || splitTabs.some((tab) => isDocumentTab(tab) && pathMatchesDiscard(tab.path))
        || pathMatchesDiscard(activeSketchPath)
        || pathMatchesDiscard(activeStoryboardPath)
        || pathMatchesDiscard(activeNotePath);
      set((state) => ({
        openTabs: nextOpenTabs,
        activeTabId: nextActiveTabId,
        splitTabs: nextSplitTabs,
        splitActiveTabId: nextSplitActiveTabId,
        activeEditorGroup: nextSplitTabs.length > 0 ? activeEditorGroup : "main",
        editorReloadKey: fileWasOpen ? state.editorReloadKey + 1 : state.editorReloadKey,
        editorReloadPath: fileWasOpen ? projectPath : state.editorReloadPath,
      }));
      if (pathMatchesDiscard(activeSketchPath)) {
        set({
          activeSketchPath: null,
          activeSketch: null,
        });
        if (sketches.some((sketch) => sketch.path === projectPath)) {
          await get().openSketch(projectPath);
        } else {
          set({ activeSketchPath: null, activeSketch: null });
          if (nextActiveTabId) get().setActiveTab(nextActiveTabId);
        }
      } else if (pathMatchesDiscard(activeStoryboardPath)) {
        set({
          activeStoryboardPath: null,
          activeStoryboard: null,
        });
        if (storyboards.some((storyboard) => storyboard.path === projectPath)) {
          await get().openStoryboard(projectPath);
        } else {
          set({ activeStoryboardPath: null, activeStoryboard: null });
          if (nextActiveTabId) get().setActiveTab(nextActiveTabId);
        }
      } else if (pathMatchesDiscard(activeNotePath)) {
        set({
          activeNotePath: null,
          activeNoteContent: null,
          activeNoteLocked: false,
        });
        if (notes.some((note) => note.path === projectPath)) {
          await get().openNote(projectPath);
        } else {
          set({ activeNotePath: null, activeNoteContent: null, activeNoteLocked: false });
          if (nextActiveTabId) get().setActiveTab(nextActiveTabId);
        }
      } else if (nextActiveTabId !== activeTabId) {
        if (nextActiveTabId) get().setActiveTab(nextActiveTabId);
        else set({
          activeSketchPath: null,
          activeSketch: null,
          activeStoryboardPath: null,
          activeStoryboard: null,
          activeNotePath: null,
          activeNoteContent: null,
          activeNoteLocked: false,
        });
      }
      get()._persistTabs();
      globalThis.setTimeout(() => clearSuppressedEditorFlushes(suppressedPaths), 100);
      await get().checkDirty();
    } catch (err) {
      clearSuppressedEditorFlushes(suppressedPaths);
      console.error("Failed to discard file:", err);
      useToastStore.getState().show(`Discard failed: ${err}`, 5000, "error");
      await get().checkDirty();
    }
  },

  popStash: async () => {
    try {
      const hadStash = await popDraftlineShelf();
      set({ hasStash: false, isDirty: hadStash });
      if (hadStash) {
        await get().loadSketches();
        await get().loadStoryboards();
        const { activeSketchPath } = get();
        if (activeSketchPath) {
          await get().openSketch(activeSketchPath);
        }
      }
    } catch (err) {
      console.error("Failed to pop stash:", err);
    }
  },

  checkStash: async () => {
    try {
      const hasStash = await hasDraftlineShelf();
      set({ hasStash });
    } catch (err) {
      console.error("Failed to check stash:", err);
    }
  },

  checkRewound: async () => {
    set({ isRewound: false });
  },

  navigateToSnapshot: async (commitId) => {
    await get().openSnapshotPreview(commitId);
  },

  openSnapshotPreview: async (commitId) => {
    try {
      const node = get().graphNodes.find((entry) => entry.id === commitId);
      const label = node?.message?.trim() || commitId.slice(0, 7);
      get().openTab({
        type: "snapshot-preview",
        path: `snapshot:${commitId}`,
        title: `Snapshot: ${label}`,
      });
    } catch (err) {
      console.error("Failed to preview snapshot:", err);
      useToastStore.getState().show(`Snapshot preview failed: ${err}`, 5000, "error");
    }
  },

  restoreSnapshotAsNewSave: async (commitId, label) => {
    try {
      await restoreDraftlineVersionAsNewSave(commitId, label);
      set({ diffResult: null, diffSelection: null, isDirty: false, changedFiles: [] });
      await get().loadSketches();
      await get().loadStoryboards();
      await get().loadNotes();
      await get().loadVersions();
      await get().loadTimelines();
      await get().loadGraphData();
      await get().checkDirty();
      useToastStore.getState().show("Restored snapshot as a new save.", 4000, "success");
    } catch (err) {
      console.error("Failed to restore snapshot:", err);
      useToastStore.getState().show(`Restore failed: ${err}`, 5000, "error");
    }
  },

  restoreSnapshotAsNewSaveToVariation: async (commitId, label, target) => {
    try {
      const result = await restoreDraftlineVersionAsNewSaveToVariation(commitId, label, target);
      set({ diffResult: null, diffSelection: null, isDirty: false, changedFiles: [] });
      await get().loadSketches();
      await get().loadStoryboards();
      await get().loadNotes();
      await get().loadVersions();
      await get().loadTimelines();
      await get().loadGraphData();
      await get().checkDirty();
      const targetLabel = result.target_variation.metadata.label ?? result.target_variation.name;
      useToastStore.getState().show(`Restored snapshot on ${targetLabel}.`, 4000, "success");
    } catch (err) {
      console.error("Failed to restore snapshot:", err);
      useToastStore.getState().show(`Restore failed: ${err}`, 5000, "error");
      throw err;
    }
  },

  createTimeline: async (fromCommitId, name) => {
    try {
      await createDraftlineVariation(fromCommitId, name, get().currentRemote?.name ?? null);
      await get().loadTimelines();
      await get().loadVersions();
      await get().loadGraphData();
    } catch (err) {
      console.error("Failed to create timeline:", err);
      if (!isDraftlineVariationCreateConflictError(err)) {
        useToastStore.getState().show(`Branch creation failed: ${err}`, 5000, "error");
      }
      throw err;
    }
  },

  startTimelineFromSnapshot: async (fromCommitId, name) => {
    try {
      await createDraftlineVariation(fromCommitId, name, get().currentRemote?.name ?? null);
      set({ startedBranchFromSnapshot: { branchName: name, snapshotId: fromCommitId } });
      await get().switchTimeline(name);
      useToastStore.getState().show(`Started branch ${name} from the previewed snapshot.`, 4000, "success");
    } catch (err) {
      set((state) => (
        state.startedBranchFromSnapshot?.branchName === name
          ? { startedBranchFromSnapshot: null }
          : {}
      ));
      console.error("Failed to start branch from snapshot:", err);
      if (!isDraftlineVariationCreateConflictError(err)) {
        useToastStore.getState().show(`Start branch failed: ${err}`, 5000, "error");
      }
      throw err;
    }
  },

  loadTimelines: async () => {
    try {
      const timelines = await listDraftlineTimelines();
      set({ timelines });
      await get().loadPendingHistoryCleanup();
    } catch (err) {
      console.error("Failed to load timelines:", err);
    }
  },

  switchTimeline: async (name) => {
    set({ loading: true });
    try {
      const preflight = await preflightDraftlineSwitchVariation(name);
      if (!preflight.can_proceed) {
        const reason = preflight.dirty_files.length > 0
          ? "Save or discard local changes before switching branches."
          : "Branch switch cannot be applied safely right now.";
        useToastStore.getState().show(reason, 5000, "error");
        throw new Error(reason);
      }
      await switchDraftlineVariation(name);
      set(clearActiveDocumentState());
      await get().loadSketches();
      await get().loadStoryboards();
      await get().loadNotes();

      const state = get();
      const openTabs = state.openTabs.filter((tab) => tabExistsInLoadedProject(tab, state));
      const splitTabs = state.splitTabs.filter((tab) => tabExistsInLoadedProject(tab, state));
      const activeTabId = openTabs.some((tab) => tab.id === state.activeTabId)
        ? state.activeTabId
        : openTabs[0]?.id ?? null;
      const splitActiveTabId = splitTabs.some((tab) => tab.id === state.splitActiveTabId)
        ? state.splitActiveTabId
        : splitTabs[0]?.id ?? null;
      const activeEditorGroup = splitTabs.length === 0 && state.activeEditorGroup === "split"
        ? "main"
        : state.activeEditorGroup;
      const activeTab = activeTabId ? openTabs.find((tab) => tab.id === activeTabId) : undefined;

      set({
        openTabs,
        activeTabId,
        splitTabs,
        splitActiveTabId,
        activeEditorGroup,
        ...(activeTab ? loadingDocumentStateForTab(activeTab) : clearActiveDocumentState()),
      });

      if (activeTab?.type === "sketch") {
        await get().openSketch(activeTab.path);
      } else if (activeTab?.type === "storyboard") {
        await get().openStoryboard(activeTab.path);
      } else if (activeTab?.type === "note") {
        await get().openNote(activeTab.path);
      }
      get()._persistTabs();
      await get().loadTimelines();
      await get().loadVersions();
      await get().loadGraphData();
      await get().checkDirty();
    } catch (err) {
      console.error("Failed to switch timeline:", err);
      useToastStore.getState().show(`Switch failed: ${err}`, 5000, "error");
      throw err;
    } finally {
      set({ loading: false });
    }
  },

  renameLegacyMasterTimeline: async () => {
    const timelines = get().timelines;
    const hasMaster = timelines.some((timeline) => timeline.name === "master");
    const hasMain = timelines.some((timeline) => timeline.name === "main");
    if (!hasMaster || hasMain) {
      useToastStore.getState().show("No legacy master branch is available to rename.", 4000, "info");
      return;
    }

    try {
      const preflight = await preflightDraftlineRenameVariation("master", "main");
      await renameDraftlineVariation("master", "main", preflight.token);
      await get().loadTimelines();
      await get().loadVersions();
      await get().loadGraphData();
      await get().checkDirty();
      useToastStore.getState().show("Renamed Draftline branch master to main.", 5000, "success");
    } catch (err) {
      console.error("Failed to rename Draftline branch:", err);
      useToastStore.getState().show(`Rename failed: ${err}`, 5000, "error");
    }
  },

  deleteTimeline: async (name) => {
    try {
      await deleteDraftlineVariation(name);
      set((state) => (
        state.startedBranchFromSnapshot?.branchName === name
          ? { startedBranchFromSnapshot: null }
          : {}
      ));
      await get().loadTimelines();
      await get().loadGraphData();
      await get().loadVersions();
      useToastStore.getState().show("Branch deleted.", 4000, "success");
    } catch (err) {
      console.error("Failed to delete timeline:", err);
      useToastStore.getState().show(`Delete failed: ${err}`, 5000, "error");
    }
  },

  promoteTimeline: async (name) => {
    console.warn("Draftline variation promotion is not available yet:", name);
    useToastStore.getState().show("Draftline does not support promoting variations yet.", 5000, "info");
  },

  loadGraphData: async () => {
    try {
      const graphNodes = await listDraftlineGraphNodes();
      set({ graphNodes });
    } catch (err) {
      console.error("Failed to load graph data:", err);
    }
  },

  toggleSecondaryPanel: () => {
    set((state) => {
      saveLayout({ showSecondaryPanel: !state.showSecondaryPanel });
      return { showSecondaryPanel: !state.showSecondaryPanel };
    });
  },

  quickSave: async () => {
    await get().promptSnapshot();
  },

  promptSnapshot: async () => {
    set({ snapshotPromptOpen: true });
  },

  squashSnapshots: async (oldestCommitId, newestCommitId, label) => {
    try {
      const preview = await get().previewSnapshotCleanup(oldestCommitId, newestCommitId, label);
      await get().applySnapshotCleanup(preview.plan_id);
    } catch (err) {
      console.error("Failed to compact snapshots:", err);
      useToastStore.getState().show(`Compaction failed: ${err}`, 5000, "error");
    }
  },

  findSnapshotCleanupCandidates: async (selectedCommitId) => {
    const { currentRemote, timelines } = get();
    const targetVariation = timelines.find((timeline) => timeline.is_active)?.name ?? null;
    if (!currentRemote) {
      return listDraftlineSnapshotCleanupCandidates(selectedCommitId, targetVariation, null);
    }
    try {
      return await listDraftlineSnapshotCleanupCandidates(selectedCommitId, targetVariation, currentRemote.name);
    } catch (err) {
      if (!errorMessage(err).includes("401")) throw err;
      return listDraftlineSnapshotCleanupCandidates(selectedCommitId, targetVariation, null);
    }
  },

  previewSnapshotCleanup: async (oldestCommitId, newestCommitId, label, selectedRangeCommitIds) => {
    const { currentRemote, graphNodes, timelines } = get();
    const range = cleanupRange(graphNodes, newestCommitId, oldestCommitId);
    if (selectedRangeCommitIds) {
      const selected = new Set(selectedRangeCommitIds);
      const allKnown = selectedRangeCommitIds.every((id) => graphNodes.some((node) => node.id === id));
      const rangeIds = range?.map((node) => node.id) ?? [];
      if (
        selectedRangeCommitIds.length < 2
        || selected.size !== selectedRangeCommitIds.length
        || selectedRangeCommitIds[0] !== newestCommitId
        || selectedRangeCommitIds[selectedRangeCommitIds.length - 1] !== oldestCommitId
        || !allKnown
        || rangeIds.length !== selectedRangeCommitIds.length
        || !rangeIds.every((id, index) => id === selectedRangeCommitIds[index])
      ) {
        throw new Error("Select a contiguous range of snapshots to compact.");
      }
    } else if (!range) {
      throw new Error("Select a contiguous range of snapshots to compact.");
    }
    const targetVariation = timelines.find((timeline) => timeline.is_active)?.name ?? null;
    return previewDraftlineSnapshotCleanup(
      oldestCommitId,
      newestCommitId,
      label,
      targetVariation,
      currentRemote?.name ?? null,
    );
  },

  applySnapshotCleanup: async (planId) => {
    const result = await applyDraftlineSnapshotCleanup(planId);
    set({ diffResult: null, diffSelection: null, isDirty: false, changedFiles: [], lastHistoryCleanup: result });
    await get().loadVersions();
    await get().loadGraphData();
    await get().loadTimelines();
    await get().loadPendingHistoryCleanup();
    await get().checkDirty();
    const mainTabs = rewriteSnapshotPreviewTabs(get().openTabs, result, makeMainTabId);
    const splitTabs = rewriteSnapshotPreviewTabs(get().splitTabs, result, makeSplitTabId);
    if (mainTabs.changed || splitTabs.changed) {
      set((state) => ({
        openTabs: mainTabs.tabs,
        activeTabId: remapActiveTabId(state.activeTabId, mainTabs.tabs, mainTabs.remappedIds),
        splitTabs: splitTabs.tabs,
        splitActiveTabId: remapActiveTabId(state.splitActiveTabId, splitTabs.tabs, splitTabs.remappedIds),
        activeEditorGroup: splitTabs.tabs.length === 0 && state.activeEditorGroup === "split" ? "main" : state.activeEditorGroup,
      }));
      get()._persistTabs();
    }
    const squashed = result.commit_map.filter((entry) => entry.disposition.kind === "squashed_into").length;
    useToastStore.getState().show(
      squashed > 0 ? `History compacted. ${squashed} old snapshots are mapped to the compacted snapshot.` : "History compacted.",
      5000,
      "success",
    );
    return result;
  },

  loadPendingHistoryCleanup: async () => {
    const targetVariation = get().timelines.find((timeline) => timeline.is_active)?.name ?? null;
    try {
      const pending = await listDraftlinePendingSnapshotCleanups(targetVariation);
      const activePending = pending[0] ?? null;
      set({ pendingHistoryCleanup: activePending });
      return activePending;
    } catch (err) {
      if (!errorMessage(err).toLowerCase().includes("no draftline workspace")) {
        console.error("Failed to load pending history cleanup:", err);
      }
      set({ pendingHistoryCleanup: null });
      return null;
    }
  },

  publishSnapshotCleanup: async (planId, remote) => {
    const pendingCleanup = get().pendingHistoryCleanup;
    if (pendingCleanup?.plan_id === planId) {
      const result = await publishDraftlinePendingSnapshotCleanup(planId, remote);
      set({ lastHistoryCleanup: null, pendingHistoryCleanup: null });
      await get().refreshSyncStatus();
      await get().refreshIncomingCommits();
      await get().loadGraphData();
      await get().loadTimelines();
      await get().loadVersions();
      useToastStore.getState().show("Milestone history published safely.", 5000, "success");
      return result;
    }

    const preflight = await preflightDraftlinePublishSnapshotCleanup(planId, remote);
    if (preflight.remote_impact.publish_status === "remote_has_incoming") {
      throw new Error("Remote has new incoming snapshots. Sync before publishing milestone history.");
    }
    if (!preflight.can_publish || !preflight.token) {
      return null;
    }
    const result = await publishDraftlineSnapshotCleanup(preflight.token);
    set({ lastHistoryCleanup: null, pendingHistoryCleanup: null });
    await get().refreshSyncStatus();
    await get().refreshIncomingCommits();
    await get().loadGraphData();
    await get().loadTimelines();
    await get().loadVersions();
    useToastStore.getState().show("Milestone history published safely.", 5000, "success");
    return result;
  },

  undoSnapshotCleanup: async (planId) => {
    const pendingCleanup = get().pendingHistoryCleanup;
    const targetPlanId = planId ?? pendingCleanup?.plan_id ?? get().lastHistoryCleanup?.plan_id;
    if (!targetPlanId) {
      throw new Error("No milestone history backup is available to undo.");
    }
    const result = pendingCleanup?.plan_id === targetPlanId
      ? await undoDraftlinePendingSnapshotCleanup(targetPlanId)
      : await (async () => {
        const preflight = await preflightDraftlineUndoSnapshotCleanup(targetPlanId);
        if (!preflight.can_undo) {
          throw new Error("Draftline cannot undo this cleanup because the current timeline no longer matches the cleanup backup.");
        }
        return undoDraftlineSnapshotCleanup(preflight.token);
      })();
    set({ diffResult: null, diffSelection: null, isDirty: false, changedFiles: [], lastHistoryCleanup: null, pendingHistoryCleanup: null });
    await get().loadVersions();
    await get().loadGraphData();
    await get().loadTimelines();
    await get().checkDirty();
    const mainTabs = rewriteSnapshotPreviewTabs(get().openTabs, result, makeMainTabId);
    const splitTabs = rewriteSnapshotPreviewTabs(get().splitTabs, result, makeSplitTabId);
    if (mainTabs.changed || splitTabs.changed) {
      set((state) => ({
        openTabs: mainTabs.tabs,
        activeTabId: remapActiveTabId(state.activeTabId, mainTabs.tabs, mainTabs.remappedIds),
        splitTabs: splitTabs.tabs,
        splitActiveTabId: remapActiveTabId(state.splitActiveTabId, splitTabs.tabs, splitTabs.remappedIds),
        activeEditorGroup: splitTabs.tabs.length === 0 && state.activeEditorGroup === "split" ? "main" : state.activeEditorGroup,
      }));
      get()._persistTabs();
    }
    useToastStore.getState().show("Milestone history restored from Draftline backup.", 5000, "success");
    return result;
  },

  requestPrePushMilestone: (prompt) => {
    cancelPendingPrePushMilestonePrompt();
    return new Promise<PrePushMilestoneDecision>((resolve) => {
      prePushMilestoneResolve = resolve;
      set({ prePushMilestonePrompt: prompt });
    });
  },

  resolvePrePushMilestone: (decision) => {
    const resolve = prePushMilestoneResolve;
    prePushMilestoneResolve = null;
    set({ prePushMilestonePrompt: null });
    resolve?.(decision);
  },

  // ── Remote sync actions ────────────────────────────────────

  detectRemote: async () => {
    try {
      const remotes = await listDraftlineRemotes();
      const info = remotes[0] ?? null;
      set({
        currentRemote: info ?? null,
        remoteBranches: [],
        remoteBranchesLoading: false,
        syncStatus: null,
        incomingCommits: [],
        syncError: null,
        shareUrl: null,
      });
      if (info) {
        if (!await ensureGitHubRemoteCredential(info)) return;
        await get().refreshSyncStatus();
      }
    } catch {
      set({ currentRemote: null, remoteBranches: [], remoteBranchesLoading: false, syncStatus: null, incomingCommits: [], syncError: null, shareUrl: null });
    }
  },

  fetchFromRemote: async (options = {}) => {
    const { currentRemote } = get();
    if (!currentRemote) return;
    if (!await ensureGitHubRemoteCredential(currentRemote, options.notifyAuthRequired ?? true)) return;
    set({ isSyncing: true, syncError: null });
    try {
      await fetchDraftlineRemote(currentRemote.name);
      await get().refreshSyncStatus();
      await get().refreshIncomingCommits();
      await get().loadGraphData();
      await get().loadTimelines();
      await get().loadVersions();
    } catch (err) {
      if (isDraftlineHistoryCleanupBlockedError(err)) {
        await get().loadPendingHistoryCleanup();
      }
      set({ syncError: remoteSyncErrorMessage(err) });
    } finally {
      set({ isSyncing: false });
    }
  },

  pushToRemote:async () => {
    const { currentRemote, timelines } = get();
    if (!currentRemote) return;
    if (!await ensureGitHubRemoteCredential(currentRemote, true)) return;
    const active = timelines.find((t) => t.is_active);
    if (!active) return;
    set({ isSyncing: true, syncError: null });
    try {
      // Large-file check before push
      const largeFiles = await get().checkLargeFiles();
      if (largeFiles.length > 0) {
        const names = largeFiles
          .map(([p, s]) => s > 0 ? `${p} (${(s / 1024 / 1024).toFixed(1)} MB)` : p)
          .join(", ");
        set({ syncError: `Large files detected: ${names}. Remove or add to .gitignore before pushing.`, isSyncing: false });
        return;
      }
      const pendingCleanup = get().pendingHistoryCleanup;
      if (pendingCleanup) {
        const published = await get().publishSnapshotCleanup(pendingCleanup.plan_id, currentRemote.name);
        if (published) {
          return;
        }
      }
      const milestoneRange = localPrePushMilestoneRange(get().graphNodes, get().syncStatus?.ahead);
      if (milestoneRange && get().syncStatus?.behind === 0) {
        const newest = milestoneRange[0];
        const oldest = milestoneRange[milestoneRange.length - 1];
        const decision = await get().requestPrePushMilestone({
          snapshotCount: milestoneRange.length,
          newestCommitId: newest.id,
          oldestCommitId: oldest.id,
          latestSnapshotLabel: newest.message,
          suggestedLabel: suggestedMilestoneLabel(milestoneRange),
          remoteName: currentRemote.name,
        });
        if (decision.type === "cancel") {
          return;
        }
        if (decision.type === "milestone") {
          const label = decision.label.trim();
          if (!label) {
            throw new Error("Milestone label is required before compacting local snapshots.");
          }
          const preview = await get().previewSnapshotCleanup(
            oldest.id,
            newest.id,
            label,
            milestoneRange.map((node) => node.id),
          );
          await get().applySnapshotCleanup(preview.plan_id);
          const published = await get().publishSnapshotCleanup(preview.plan_id, currentRemote.name);
          if (published) {
            return;
          }
          const pendingAfterCleanup = await get().loadPendingHistoryCleanup();
          if (pendingAfterCleanup) {
            return;
          }
        }
      }
      await publishDraftlineChanges(currentRemote.name);
      await get().refreshSyncStatus();
      await get().checkDirty();
      await get().refreshChangedFiles();
      await get().loadGraphData();
      await get().loadTimelines();
      await get().loadVersions();
    } catch (err) {
      if (isDraftlineHistoryCleanupBlockedError(err)) {
        await get().loadPendingHistoryCleanup();
      }
      set({ syncError: remoteSyncErrorMessage(err) });
    } finally {
      set({ isSyncing: false });
    }
  },

  syncWithRemote: async () => {
    // Fetch first to get latest state
    await get().fetchFromRemote();
    const updated = get().syncStatus;
    if (!updated) return;
    if (get().pendingHistoryCleanup && updated.behind > 0) {
      set({ syncError: PENDING_CLEANUP_INCOMING_MESSAGE });
      return;
    }
    // If behind, pull first
    if (updated.behind > 0) {
      await get().pullFromRemote();
    }
    // If ahead (and not diverged), push
    const afterPull = get().syncStatus;
    if (afterPull && afterPull.ahead > 0 && afterPull.behind === 0) {
      await get().pushToRemote();
    }
  },

  shareChanges: async () => {
    const { currentRemote, timelines } = get();
    if (!currentRemote) return;
    const active = timelines.find((t) => t.is_active);
    if (!active) return;
    await get().pushToRemote();
    const url = buildShareUrl(currentRemote.url, active.name);
    set({ shareUrl: url });
    if (url) {
      try {
        await navigator.clipboard.writeText(url);
        useToastStore.getState().show("Share link copied. Your work is safely published.", 4000, "success");
      } catch {
        useToastStore.getState().show("Your work is safely published.", 4000, "success");
      }
    }
  },

  pullFromRemote: async () => {
    const { currentRemote } = get();
    if (!currentRemote) return;
    if (!await ensureGitHubRemoteCredential(currentRemote, true)) return;
    if (get().pendingHistoryCleanup) {
      set({ syncError: PENDING_CLEANUP_INCOMING_MESSAGE });
      return;
    }
    set({ isSyncing: true, syncError: null });
    try {
      const preflight = await preflightDraftlineIncoming(currentRemote.name);
      if (!preflight.canProceed) {
        const state = preflight.syncStatus.state;
        if (state === "needsMerge" && preflight.dirtyFiles.length === 0) {
          const mergeReport = await preflightDraftlineMergeIncoming(currentRemote.name);
          if (mergeReport.canMergeCleanly && mergeReport.token) {
            await mergeDraftlineIncoming(currentRemote.name, "Merge incoming saves");
            await get().loadSketches();
            await get().loadStoryboards();
            await get().loadNotes();
            await get().refreshSyncStatus();
            await get().refreshIncomingCommits();
            await get().loadVersions();
            await get().loadGraphData();
            await get().loadTimelines();
            await get().checkDirty();
            useToastStore.getState().show("Incoming saves merged.", 4000, "success");
            return;
          }
          if (mergeReport.conflicts.length > 0 && mergeReport.token) {
            set({
              isMerging: true,
              mergeSource: currentRemote.name,
              mergeTarget: "incoming",
              mergeConflicts: mergeReport.conflicts,
              draftlineMergeToken: mergeReport.token,
              draftlineMergeRemote: currentRemote.name,
              syncError: null,
              syncStatus: { ahead: mergeReport.syncStatus.ahead, behind: mergeReport.syncStatus.behind },
            });
            useToastStore.getState().show("Incoming saves need conflict resolution.", 5000, "info");
            return;
          }
          set({
            syncError: "Incoming saves cannot be merged safely right now.",
            syncStatus: { ahead: mergeReport.syncStatus.ahead, behind: mergeReport.syncStatus.behind },
          });
          return;
        }
        const reason = preflight.dirtyFiles.length > 0
          ? "Save or discard local changes before applying incoming saves."
          : "Incoming saves cannot be applied safely right now.";
        set({ syncError: reason, syncStatus: { ahead: preflight.syncStatus.ahead, behind: preflight.syncStatus.behind } });
        return;
      }

      await applyDraftlineIncoming(currentRemote.name);
      await get().loadSketches();
      await get().loadStoryboards();
      await get().loadNotes();
      await get().refreshSyncStatus();
      await get().refreshIncomingCommits();
      await get().loadVersions();
      await get().loadGraphData();
      await get().loadTimelines();
      await get().checkDirty();
      useToastStore.getState().show("Incoming saves applied.", 4000, "success");
    } catch (err) {
      if (isDraftlineHistoryCleanupBlockedError(err)) {
        await get().loadPendingHistoryCleanup();
      }
      set({ syncError: remoteSyncErrorMessage(err) });
    } finally {
      set({ isSyncing: false });
    }
  },

  loadRemoteBranches: async () => {
    const { currentRemote, timelines } = get();
    if (!currentRemote) {
      set({ remoteBranches: [], remoteBranchesLoading: false });
      return [];
    }
    if (!await ensureGitHubRemoteCredential(currentRemote, true)) {
      set({ remoteBranches: [], remoteBranchesLoading: false });
      return [];
    }
    set({ remoteBranchesLoading: true, syncError: null });
    try {
      const localNames = new Set(timelines.map((timeline) => timeline.name));
      const branches = (await listDraftlineRemoteBranches(currentRemote.name))
        .filter((branch) => !localNames.has(branch.id) && !localNames.has(branch.name));
      set({ remoteBranches: branches });
      return branches;
    } catch (err) {
      const message = errorMessage(err);
      set({ remoteBranches: [], syncError: message });
      return [];
    } finally {
      set({ remoteBranchesLoading: false });
    }
  },

  checkoutRemoteTimeline: async (branch: string) => {
    const { currentRemote, isDirty } = get();
    if (!currentRemote) return;
    if (!await ensureGitHubRemoteCredential(currentRemote, true)) return;
    if (isDirty) {
      const reason = "Save or discard local changes before adopting a remote branch.";
      useToastStore.getState().show(reason, 5000, "error");
      throw new Error(reason);
    }
    set({ isSyncing: true, syncError: null });
    try {
      await adoptDraftlineRemoteBranch(currentRemote.name, branch);
      await get().loadTimelines();
      await get().switchTimeline(branch);
      await get().loadRemoteBranches();
      await get().refreshSyncStatus();
      await get().loadGraphData();
      useToastStore.getState().show(`Adopted ${currentRemote.name}/${branch}.`, 4000, "success");
    } catch (err) {
      set({ syncError: errorMessage(err) });
      throw err;
    } finally {
      set({ isSyncing: false });
    }
  },

  publishTimeline: async () => {
    const { currentRemote, timelines } = get();
    if (!currentRemote) return;
    if (!await ensureGitHubRemoteCredential(currentRemote, true)) return;
    const active = timelines.find((t) => t.is_active);
    if (!active) return;
    set({ isSyncing: true, syncError: null });
    try {
      await publishDraftlineChanges(currentRemote.name);
      await get().refreshSyncStatus();
    } catch (err) {
      set({ syncError: errorMessage(err) });
    } finally {
      set({ isSyncing: false });
    }
  },

  refreshSyncStatus: async () => {
    const { currentRemote } = get();
    if (!currentRemote) return;
    if (!await ensureGitHubRemoteCredential(currentRemote)) return;
    try {
      const status = await getDraftlineSyncStatus(currentRemote.name);
      set({ syncStatus: status, syncError: null });
      await get().loadPendingHistoryCleanup();
    } catch {
      set({ syncStatus: null });
    }
  },

  refreshIncomingCommits: async () => {
    const { currentRemote, syncStatus } = get();
    if (!currentRemote || !syncStatus || syncStatus.behind === 0) {
      set({ incomingCommits: [] });
      return;
    }
    if (!await ensureGitHubRemoteCredential(currentRemote)) return;
    try {
      const incoming = await listDraftlineIncomingCommits(currentRemote.name);
      set({ incomingCommits: incoming });
    } catch {
      set({ incomingCommits: [] });
    }
  },

  // ── Diff & bookmarks ──────────────────────────────────────

  diffSnapshots: async (fromCommit, toCommit) => {
    try {
      const entries = await diffDraftlineVersions(fromCommit, toCommit);
      set({ diffResult: entries, diffSelection: { from: fromCommit, to: toCommit } });
      return entries;
    } catch (err) {
      console.error("Failed to diff snapshots:", err);
      set({ diffResult: null, diffSelection: null });
      useToastStore.getState().show(`Could not compare snapshots: ${err}`, 5000, "error");
      return [];
    }
  },

  diffWorkingTree: async () => {
    try {
      const entries = await listDraftlineChangedFiles();
      set({ diffResult: entries, diffSelection: { from: "HEAD", to: "working" } });
      return entries;
    } catch (err) {
      console.error("Failed to diff working tree:", err);
      return [];
    }
  },

  checkLargeFiles: async () => {
    try {
      const paths = await listDraftlineLargeChangedFiles();
      return paths.map((path): [string, number] => [path, 0]);
    } catch {
      return [];
    }
  },

  cloneFromUrl: async (url, destPath) => {
    set({ loading: true });
    try {
      await invoke("clone_from_url", { url, dest: destPath });
      // Open the cloned project
      await get().openProject(destPath);
      return true;
    } catch (err) {
      console.error("Failed to clone:", err);
      set({ error: String(err) });
      return false;
    } finally {
      set({ loading: false });
    }
  },

  // ── Merge actions ─────────────────────────────────────────

  mergeTimelines: async (source, target) => {
    console.warn("Draftline variation merge is not available yet:", source, target);
    useToastStore.getState().show("Draftline does not support merging variations yet.", 5000, "info");
    return { status: "conflicts", conflicts: [] };
  },

  applyMergeResolution: async (resolutions) => {
    const { draftlineMergeToken, draftlineMergeRemote } = get();
    if (!draftlineMergeToken || !draftlineMergeRemote) throw new Error("No Draftline merge in progress");

    const commitId = await mergeDraftlineIncomingWithResolutions(
      draftlineMergeToken,
      "Resolve incoming saves",
      resolutions.map((resolution) => ({
        path: resolution.path,
        field_path: null,
        choice: { kind: "use_content", content: resolution.content },
      })),
      draftlineMergeRemote,
    );
    set({
      isMerging: false,
      mergeSource: null,
      mergeTarget: null,
      mergeConflicts: [],
      draftlineMergeToken: null,
      draftlineMergeRemote: null,
    });
    await get().loadSketches();
    await get().loadStoryboards();
    await get().loadNotes();
    await get().refreshSyncStatus();
    await get().refreshIncomingCommits();
    await get().loadVersions();
    await get().loadGraphData();
    await get().loadTimelines();
    await get().checkDirty();
    useToastStore.getState().show("Incoming saves merged.", 4000, "success");
    return commitId;
  },

  cancelMerge: () => {
    set({
      isMerging: false,
      mergeSource: null,
      mergeTarget: null,
      mergeConflicts: [],
      draftlineMergeToken: null,
      draftlineMergeRemote: null,
    });
  },

  // ── Sidebar order actions ──────────────────────────────────

  loadSidebarOrder: async () => {
    try {
      const order = await invoke<SidebarOrder>("get_sidebar_order");
      set({ sidebarOrder: order });
    } catch {
      set({ sidebarOrder: null });
    }
  },

  saveSidebarOrder: async (order) => {
    set({ sidebarOrder: order });
    try {
      await invoke("set_sidebar_order", { order });
    } catch (err) {
      console.error("Failed to save sidebar order:", err);
    }
  },

  // ── Profile actions ───────────────────────────────────────

  detectProfiles: async () => {
    try {
      const profiles = await invoke<BrowserProfile[]>(
        "detect_browser_profiles"
      );
      const { selectedProfile } = get();
      const newSelected =
        selectedProfile ??
        (profiles.length > 0 ? profiles[0] : null);
      set({ profiles, selectedProfile: newSelected });
    } catch (err) {
      console.error("Failed to detect profiles:", err);
    }
  },

  checkBrowsersRunning: async () => {
    try {
      const status = await invoke<BrowserRunningStatus>(
        "check_browsers_running"
      );
      set({ browserRunning: status });
    } catch (err) {
      console.error("Failed to check browsers:", err);
    }
  },

  setSelectedProfile: (profile) => set({ selectedProfile: profile }),

  // ── Browser actions ───────────────────────────────────────

  prepareBrowser: async () => {
    set({ loading: true, error: null });
    try {
      const { selectedProfile } = get();
      const channel = await invoke<string>("prepare_browser", {
        userDataDir: selectedProfile?.user_data_dir ?? null,
        profileDirectory: selectedProfile?.profile_directory ?? null,
        browserChannel: selectedProfile?.browser ?? null,
      });
      set({
        isBrowserReady: true,
        browserChannel: channel,
        capturedActions: [],
        lastSession: null,
        view: "recording",
      });
    } catch (err) {
      console.error("Failed to prepare browser:", err);
      set({ error: String(err) });
    } finally {
      set({ loading: false });
    }
  },

  disconnectBrowser: async () => {
    set({ loading: true });
    try {
      await invoke("disconnect_browser");
    } catch (err) {
      console.error("Failed to disconnect browser:", err);
    } finally {
      set({
        loading: false,
        isBrowserReady: false,
        browserChannel: null,
        isRecording: false,
        recordingSessionId: null,
        capturedActions: [],
        lastSession: null,
        _activeChannel: null,
      });
    }
  },

  // ── Recording actions ─────────────────────────────────────

  startRecording: async () => {
    set({ loading: true, capturedActions: [], lastSession: null });
    try {
      const channel = new Channel<CapturedAction>();
      channel.onmessage = (action) => {
        set((state) => ({
          capturedActions: [...state.capturedActions, action],
        }));
      };

      const sessionId = await invoke<string>("start_recording_session", {
        onAction: channel,
      });

      set({
        isRecording: true,
        recordingSessionId: sessionId,
        _activeChannel: channel,
      });
    } catch (err) {
      console.error("Failed to start recording:", err);
    } finally {
      set({ loading: false });
    }
  },

  stopRecording: async () => {
    set({ loading: true });
    try {
      const session = await invoke<RecordedSession>("stop_recording_session");
      set({
        isRecording: false,
        recordingSessionId: null,
        lastSession: session,
        _activeChannel: null,
      });
    } catch (err) {
      console.error("Failed to stop recording:", err);
    } finally {
      set({ loading: false });
    }
  },
}));

// Expose store on window in dev mode for Playwright/debugging
if (import.meta.env.DEV) {
  (window as unknown as Record<string, unknown>).__CUTREADY_STORE__ = useAppStore;
}
