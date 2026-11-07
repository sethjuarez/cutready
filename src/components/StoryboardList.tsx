import { useCallback, useEffect, useRef, useState, type MouseEvent as ReactMouseEvent } from "react";
import {
  DndContext,
  closestCenter,
  PointerSensor,
  useSensor,
  useSensors,
  type DragEndEvent,
} from "@dnd-kit/core";
import { SortableContext, verticalListSortingStrategy } from "@dnd-kit/sortable";
import { Channel, invoke } from "../services/tauri";
import type { TokenResponse } from "../types/auth";
import { ArrowRight, AtSign, Copy, FileInput, FileText, Film, FolderOpen, History, Pencil, SquareTerminal } from "lucide-react";
import { openDocumentHistory } from "../hooks/useVersioningLifecycle";
import {
  clearSuppressedEditorFlush,
  makeMainTabId,
  makeSplitTabId,
  suppressEditorFlush,
  useAppStore,
  type SidebarOrder,
} from "../stores/appStore";
import type { ProjectEntry } from "../types/project";
import { DeleteAssetDialog, TransferConflictDialog, TransferWarningDialog, type PendingDelete, type TransferConflict, type TransferWarning } from "./docTree/ExplorerDialogs";
import { commandErrorText, transferConflictPath } from "../services/commandErrors";
import { documentRenamed, settleBeforeRename } from "../services/documentSaves";
import { SketchIcon, StoryboardIcon, NoteIcon } from "./Icons";
import { ConfirmDialog } from "./ConfirmDialog";
import { ContextMenu, type ContextMenuItem } from "./ContextMenu";
import { useToastStore } from "../stores/toastStore";
import { useStoryboardMembership } from "../hooks/useStoryboardMembership";
import { NavIcon } from "./navIcons";
import { SortableTreeRow, TreeMiniButton, TreeRow, TreeSection, TreeSectionBody } from "./docTree/TreeRow";
import { TreeCreateForm } from "./docTree/TreeCreateForm";
import { useSettings } from "../hooks/useSettings";
import { loadProviderSecrets } from "../hooks/useSecretStore";
import {
  activeProviderInput,
  buildProviderConfig,
  defaultProvider,
  isProviderInputConfigured,
  providerToConfigInput,
} from "../utils/providerConfig";
import { Dialog } from "./Dialog";
import type { NoteSummary, SketchSummary, StoryboardSummary } from "../types/sketch";
import { sketchUsage, usageLabel } from "../utils/navigation";

interface VideoImportProgress {
  phase: string;
  current: number;
  total: number;
  message: string;
}

interface VideoImportPlanningContextReference {
  kind: "sketch" | "storyboard" | "note";
  path: string;
  title: string;
}

interface VideoImportPlanningContext {
  text: string;
  references: VideoImportPlanningContextReference[];
}

type ImportKind = "all" | "video" | "sketch" | "storyboard" | "markdown" | "document";

const importDialogFilters: Record<ImportKind, { name: string; extensions: string[] }[]> = {
  all: [
    { name: "All supported", extensions: ["sk", "sb", "md", "docx", "doc", "pdf", "pptx", "mp4", "mov", "mkv", "webm", "avi", "m4v"] },
    { name: "Videos (.mp4, .mov, .mkv, .webm)", extensions: ["mp4", "mov", "mkv", "webm", "avi", "m4v"] },
    { name: "Sketches (.sk)", extensions: ["sk"] },
    { name: "Storyboards (.sb)", extensions: ["sb"] },
    { name: "Markdown (.md)", extensions: ["md"] },
    { name: "Documents (.docx, .pdf, .pptx)", extensions: ["docx", "doc", "pdf", "pptx"] },
  ],
  video: [{ name: "Videos (.mp4, .mov, .mkv, .webm)", extensions: ["mp4", "mov", "mkv", "webm", "avi", "m4v"] }],
  sketch: [{ name: "Sketches (.sk)", extensions: ["sk"] }],
  storyboard: [{ name: "Storyboards (.sb)", extensions: ["sb"] }],
  markdown: [{ name: "Markdown (.md)", extensions: ["md"] }],
  document: [{ name: "Documents (.docx, .pdf, .pptx)", extensions: ["docx", "doc", "pdf", "pptx"] }],
};

const importDialogTitles: Record<ImportKind, string> = {
  all: "Import Files",
  video: "Import Video as Sketch",
  sketch: "Import Sketch",
  storyboard: "Import Storyboard",
  markdown: "Import Markdown Note",
  document: "Import Document as Note",
};
const VIDEO_IMPORT_MISSING_TRANSCRIPT_PREFIX = "VIDEO_IMPORT_MISSING_TRANSCRIPT:";
const VIDEO_IMPORT_DURATION_LIMIT_PREFIX = "VIDEO_IMPORT_DURATION_LIMIT:";

interface RenameProjectAssetPlan {
  oldPath: string;
  newPath: string;
  updatedReferences: { path: string; count: number }[];
}

interface RenameConfirmation {
  message: string;
  resolve: (confirmed: boolean) => void;
}

const videoImportPhaseDetails: Record<string, string> = {
  preparing: "Getting the importer ready and checking project settings.",
  validating: "Checking the video file and looking for a matching transcript sidecar.",
  transcript: "Reading timestamps so every sketch row can stay tied to the original recording.",
  audio: "Extracting a local audio reference for review and future editing.",
  grouping: "Building a first-pass scene map from pauses, timing, and transcript length.",
  llm: "The Video Import Scene Analyst is reviewing transcript boundaries before screenshots are extracted. Larger transcripts and reasoning models can take a few minutes.",
  screenshots: "Pulling representative frames from the final scene boundaries.",
  saving: "Writing the imported sketch and manifest back into the project.",
  complete: "Sketch import is done. Opening the new editable sketch next.",
  failed: "Import stopped before a sketch could be created.",
};

const videoImportAnalystActivity = [
  "Finding the cuts a demo producer would keep",
  "Matching narration beats to screenshot-worthy moments",
  "Keeping every transcript segment in order",
  "Sharpening the scene boundaries before frames are pulled",
];

function mentionKey(value: string) {
  return value
    .toLowerCase()
    .replace(/\.(sk|sb|md)$/i, "")
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
}

function extractMentionKeys(text: string) {
  const keys = new Set<string>();
  for (const match of text.matchAll(/@([a-zA-Z0-9][a-zA-Z0-9._/-]*)/g)) {
    const key = mentionKey(match[1]);
    if (key) keys.add(key);
  }
  return keys;
}

/** Sort items by manifest order. Items not in the manifest go at the end. */
function applySidebarOrder<T extends { path: string }>(items: T[], order: string[]): T[] {
  if (!order.length) return items;
  const indexMap = new Map(order.map((p, i) => [p, i]));
  return [...items].sort((a, b) => {
    const ai = indexMap.get(a.path) ?? Infinity;
    const bi = indexMap.get(b.path) ?? Infinity;
    return ai - bi;
  });
}

function VideoImportProgressDialog({
  progress,
  onClose,
}: {
  progress: VideoImportProgress | null;
  onClose: () => void;
}) {
  if (!progress) return null;

  const total = Math.max(1, progress.total);
  const current = Math.min(Math.max(0, progress.current), total);
  const percent = Math.round((current / total) * 100);
  const isLlmPhase = progress.phase === "llm";
  const isComplete = progress.phase === "complete";
  const isFailed = progress.phase === "failed";
  const phaseDetail = videoImportPhaseDetails[progress.phase]
    ?? "CutReady is parsing the transcript, aligning scene ranges, extracting frames, and saving an editable sketch.";

  return (
    <Dialog
      isOpen={progress !== null}
      onClose={isFailed ? onClose : () => {}}
      align="top"
      topOffset="18vh"
      width={`w-full ${isFailed ? "max-w-lg" : "max-w-md"} mx-4`}
      labelledBy="video-import-progress-title"
    >
      <div className="cr-modal-surface overflow-hidden">
        <div className="px-5 py-5">
          <div className="flex items-start gap-3">
            <div className="relative grid h-10 w-10 shrink-0 place-items-center rounded-xl bg-[rgb(var(--color-accent))]/10 text-[rgb(var(--color-accent))]">
              <FileInput className="h-4 w-4" />
              <span className="absolute -right-0.5 -top-0.5 h-2.5 w-2.5 animate-pulse rounded-full bg-[rgb(var(--color-accent))]" />
            </div>
            <div className="min-w-0 flex-1">
              <h2 id="video-import-progress-title" className="text-sm font-semibold text-[rgb(var(--color-text))]">
                {isFailed ? "Video import needs attention" : "Importing demo video"}
              </h2>
              <p className={`mt-1 text-xs leading-5 text-[rgb(var(--color-text-secondary))] ${isFailed ? "whitespace-pre-wrap" : ""}`}>
                {progress.message}
              </p>
            </div>
          </div>

          <div className="mt-5">
            <div className="mb-2 flex items-center justify-between text-xs font-medium uppercase tracking-[0.14em] text-[rgb(var(--color-text-secondary))]">
              <span>{isComplete ? "Wrapping up" : `Step ${current} of ${total}`}</span>
              <span>{percent}%</span>
            </div>
            <div className="h-2 overflow-hidden rounded-full bg-[rgb(var(--color-surface-alt))]">
              <div
                className="h-full rounded-full bg-[rgb(var(--color-accent))] transition-all duration-300 ease-out"
                style={{ width: `${percent}%` }}
              />
            </div>
          </div>

          <div className="mt-4 rounded-xl border border-[rgb(var(--color-border))] bg-[rgb(var(--color-surface-alt))]/60 px-3 py-2 text-xs leading-5 text-[rgb(var(--color-text-secondary))]">
            {phaseDetail}
          </div>

          {isLlmPhase && (
            <div
              className="mt-3 rounded-xl border border-[rgb(var(--color-accent))]/20 bg-[rgb(var(--color-accent))]/[0.06] px-3 py-3"
              aria-live="polite"
            >
              <div className="mb-2 flex items-center justify-between text-2xs font-semibold uppercase tracking-[0.16em] text-[rgb(var(--color-accent))]">
                <span>Analyst scratchpad</span>
                <span className="flex items-center gap-1 text-[rgb(var(--color-text-secondary))]">
                  thinking
                  <span className="h-1 w-1 animate-pulse rounded-full bg-[rgb(var(--color-accent))]" />
                  <span className="h-1 w-1 animate-pulse rounded-full bg-[rgb(var(--color-accent))]" style={{ animationDelay: "180ms" }} />
                  <span className="h-1 w-1 animate-pulse rounded-full bg-[rgb(var(--color-accent))]" style={{ animationDelay: "360ms" }} />
                </span>
              </div>
              <div className="space-y-1.5">
                {videoImportAnalystActivity.map((line, index) => (
                  <div
                    key={line}
                    className="flex items-center gap-2 text-xs leading-4 text-[rgb(var(--color-text-secondary))]"
                    style={{ opacity: 0.72 + (index * 0.07) }}
                  >
                    <span
                      className="h-1.5 w-1.5 shrink-0 animate-pulse rounded-full bg-[rgb(var(--color-accent))]/70"
                      style={{ animationDelay: `${index * 220}ms` }}
                    />
                    <span>{line}</span>
                  </div>
                ))}
              </div>
            </div>
          )}

          {isFailed && (
            <div className="mt-5 flex justify-end">
              <button
                type="button"
                onClick={onClose}
                className="rounded-lg bg-[rgb(var(--color-accent))] px-4 py-2 text-xs font-medium text-accent-fg transition-colors hover:bg-[rgb(var(--color-accent-hover))]"
              >
                Got it
              </button>
            </div>
          )}
        </div>
      </div>
    </Dialog>
  );
}

function VideoImportPlanningContextDialog({
  open,
  value,
  references,
  onChange,
  onInsertMention,
  onContinue,
  onCancel,
}: {
  open: boolean;
  value: string;
  references: VideoImportPlanningContextReference[];
  onChange: (value: string) => void;
  onInsertMention: (reference: VideoImportPlanningContextReference) => void;
  onContinue: () => void;
  onCancel: () => void;
}) {
  if (!open) return null;

  return (
    <Dialog
      isOpen={open}
      onClose={onCancel}
      align="top"
      topOffset="14vh"
      width="w-full max-w-xl mx-4"
      labelledBy="video-import-context-title"
    >
      <div className="cr-modal-surface overflow-hidden">
        <div className="px-5 py-5">
          <div className="flex items-start gap-3">
            <div className="grid h-10 w-10 shrink-0 place-items-center rounded-xl bg-[rgb(var(--color-accent))]/10 text-[rgb(var(--color-accent))]">
              <AtSign className="h-4 w-4" />
            </div>
            <div className="min-w-0 flex-1">
              <h2 id="video-import-context-title" className="text-sm font-semibold text-[rgb(var(--color-text))]">
                Planning context
              </h2>
              <p className="mt-1 text-xs leading-5 text-[rgb(var(--color-text-secondary))]">
                Guide how CutReady splits the video into rows and labels sections. Transcript text stays verbatim, and Actions are not inferred.
              </p>
            </div>
          </div>

          <textarea
            value={value}
            onChange={(event) => onChange(event.target.value)}
            placeholder="Example: This is a launch demo for developers. Keep setup, auth, deployment, and payoff as separate beats. Use @launch-plan for structure."
            className="mt-4 h-32 w-full resize-none rounded-xl border border-[rgb(var(--color-border))] bg-[rgb(var(--color-surface))] px-3 py-2 text-xs leading-5 text-[rgb(var(--color-text))] placeholder:text-[rgb(var(--color-text-secondary))]/60 focus:outline-none focus:ring-1 focus:ring-[rgb(var(--color-accent))]/50"
            autoFocus
          />

          {references.length > 0 && (
            <div className="mt-3">
              <p className="mb-2 text-2xs font-semibold uppercase tracking-[0.16em] text-[rgb(var(--color-text-secondary))]">
                Insert reference
              </p>
              <div className="flex max-h-24 flex-wrap gap-1.5 overflow-y-auto">
                {references.map((reference) => (
                  <button
                    key={`${reference.kind}:${reference.path}`}
                    type="button"
                    onClick={() => onInsertMention(reference)}
                    className="rounded-full border border-[rgb(var(--color-border))] bg-[rgb(var(--color-surface-alt))] px-2 py-1 text-xs text-[rgb(var(--color-text-secondary))] transition-colors hover:border-[rgb(var(--color-accent))]/50 hover:text-[rgb(var(--color-accent))]"
                    title={reference.path}
                  >
                    @{mentionKey(reference.title || reference.path)}
                  </button>
                ))}
              </div>
            </div>
          )}

          <div className="mt-5 flex justify-end gap-2">
            <button
              type="button"
              onClick={onCancel}
              className="rounded-lg border border-[rgb(var(--color-border))] px-4 py-2 text-xs font-medium text-[rgb(var(--color-text-secondary))] transition-colors hover:text-[rgb(var(--color-text))]"
            >
              Cancel
            </button>
            <button
              type="button"
              onClick={onContinue}
              className="rounded-lg bg-[rgb(var(--color-accent))] px-4 py-2 text-xs font-medium text-accent-fg transition-colors hover:bg-[rgb(var(--color-accent-hover))]"
            >
              Continue import
            </button>
          </div>
        </div>
      </div>
    </Dialog>
  );
}


/** StoryboardList: the Documents tree (storyboards with their sketches, loose sketches, notes, chats). */
export function StoryboardList() {
  const storyboards = useAppStore((s) => s.storyboards);
  const sketches = useAppStore((s) => s.sketches);
  const notes = useAppStore((s) => s.notes);
  const chatArtifacts = useAppStore((s) => s.chatArtifacts);
  const activeStoryboardPath = useAppStore((s) => {
    const tab = s.openTabs.find((t) => t.id === s.activeTabId);
    return tab?.type === "storyboard" ? tab.path : null;
  });
  const activeSketchPath = useAppStore((s) => {
    const tab = s.openTabs.find((t) => t.id === s.activeTabId);
    return tab?.type === "sketch" ? tab.path : null;
  });
  const activeNotePath = useAppStore((s) => {
    const tab = s.openTabs.find((t) => t.id === s.activeTabId);
    return tab?.type === "note" ? tab.path : null;
  });
  const activeChatArtifactPath = useAppStore((s) => {
    const tab = s.openTabs.find((t) => t.id === s.activeTabId);
    return tab?.type === "chat-artifact" ? tab.path : null;
  });
  const loadStoryboards = useAppStore((s) => s.loadStoryboards);
  const loadSketches = useAppStore((s) => s.loadSketches);
  const loadNotes = useAppStore((s) => s.loadNotes);
  const loadChatArtifacts = useAppStore((s) => s.loadChatArtifacts);
  const loadAssets = useAppStore((s) => s.loadAssets);
  const createStoryboard = useAppStore((s) => s.createStoryboard);
  const openStoryboard = useAppStore((s) => s.openStoryboard);
  const deleteStoryboard = useAppStore((s) => s.deleteStoryboard);
  const createSketch = useAppStore((s) => s.createSketch);
  const openSketch = useAppStore((s) => s.openSketch);
  const deleteSketch = useAppStore((s) => s.deleteSketch);
  const createNote = useAppStore((s) => s.createNote);
  const openNote = useAppStore((s) => s.openNote);
  const openChatArtifact = useAppStore((s) => s.openChatArtifact);
  const deleteNote = useAppStore((s) => s.deleteNote);
  const deleteChatArtifact = useAppStore((s) => s.deleteChatArtifact);
  const closeStoryboard = useAppStore((s) => s.closeStoryboard);
  const sidebarOrder = useAppStore((s) => s.sidebarOrder);
  const saveSidebarOrder = useAppStore((s) => s.saveSidebarOrder);
  const projects = useAppStore((s) => s.projects);
  const isMultiProject = useAppStore((s) => s.isMultiProject);
  const currentProject = useAppStore((s) => s.currentProject);
  const closeTab = useAppStore((s) => s.closeTab);

  // Derive the current project's manifest key to filter it from the "move to" list
  const currentProjectEntryPath = currentProject
    ? (currentProject.root.replace(/\\/g, "/") === currentProject.repo_root.replace(/\\/g, "/")
        ? "."
        : currentProject.root.replace(/\\/g, "/").replace(currentProject.repo_root.replace(/\\/g, "/") + "/", ""))
    : null;
  const otherProjects = projects.filter((p) => p.path !== currentProjectEntryPath);

  const [isCreatingSb, setIsCreatingSb] = useState(false);
  const [newSbTitle, setNewSbTitle] = useState("");
  const [isCreatingSk, setIsCreatingSk] = useState(false);
  const [newSkTitle, setNewSkTitle] = useState("");
  const [isCreatingNote, setIsCreatingNote] = useState(false);
  const [newNoteTitle, setNewNoteTitle] = useState("");
  const [collapsedSections, setCollapsedSections] = useState<Set<string>>(() => new Set());
  const [pendingDelete, setPendingDelete] = useState<PendingDelete | null>(null);
  const [drmConfirm, setDrmConfirm] = useState<{ resolve: (ok: boolean) => void } | null>(null);
  const [renameConfirm, setRenameConfirm] = useState<RenameConfirmation | null>(null);
  const [importing, setImporting] = useState(false);
  const [importMenu, setImportMenu] = useState<{ x: number; y: number } | null>(null);
  const [videoImportProgress, setVideoImportProgress] = useState<VideoImportProgress | null>(null);
  const [videoImportContextOpen, setVideoImportContextOpen] = useState(false);
  const [videoImportContextText, setVideoImportContextText] = useState("");
  const videoImportContextResolverRef = useRef<((value: VideoImportPlanningContext | null) => void) | null>(null);
  const keepVideoImportProgressRef = useRef(false);
  const showToast = useToastStore((s) => s.show);

  // ── Transfer (move/copy to project) state ───────────────────────
  const [contextMenu, setContextMenu] = useState<{
    type: "sketch" | "note" | "storyboard";
    path: string;
    title: string;
    x: number;
    y: number;
  } | null>(null);

  const [transferWarning, setTransferWarning] = useState<TransferWarning | null>(null);
  const [transferConflict, setTransferConflict] = useState<TransferConflict | null>(null);
  const { settings, updateSetting, loaded: settingsLoaded } = useSettings();

  // ── Inline rename state ──────────────────────────────────────────
  const [renamingItem, setRenamingItem] = useState<{ type: "storyboard" | "sketch" | "note" | "chat-artifact"; path: string } | null>(null);
  const [renameValue, setRenameValue] = useState("");
  const renameInputRef = useRef<HTMLInputElement>(null);
  const renameInFlightRef = useRef(false);

  /** Derive a safe filename from user-entered text. */
  const slugify = (text: string) => text.trim().toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "");

  const buildVideoImportLlmConfig = useCallback(async () => {
    if (!settingsLoaded) return null;
    const selectedProvider = defaultProvider(settings);
    const providerInput = selectedProvider
      ? providerToConfigInput(
          selectedProvider,
          settings,
          selectedProvider.id === settings.aiActiveProviderId
            ? { apiKey: settings.aiApiKey, accessToken: settings.aiAccessToken }
            : await loadProviderSecrets(selectedProvider.id),
        )
      : activeProviderInput(settings);

    if (!isProviderInputConfigured(providerInput)) return null;

    let freshBearerToken = settings.aiAuthMode === "azure_oauth" ? settings.aiAccessToken : null;
    if (settings.aiAuthMode === "azure_oauth" && settings.aiRefreshToken) {
      try {
        const tokenResult = await invoke<TokenResponse>(
          "azure_token_refresh",
          {
            tenantId: settings.aiTenantId || "",
            refreshToken: settings.aiRefreshToken,
            clientId: settings.aiClientId || null,
          },
        );
        if (tokenResult.accessToken) {
          freshBearerToken = tokenResult.accessToken;
          await updateSetting("aiAccessToken", tokenResult.accessToken);
          if (tokenResult.refreshToken) {
            await updateSetting("aiRefreshToken", tokenResult.refreshToken);
          }
        }
      } catch {
        console.warn("[auth] Video import OAuth refresh failed; trying cached credentials.");
      }
    }

    const config = buildProviderConfig(providerInput);
    if (freshBearerToken && selectedProvider?.id === settings.aiActiveProviderId) {
      config.bearer_token = freshBearerToken;
    }
    return config;
  }, [settings, settingsLoaded, updateSetting]);

  /** Enter rename mode for a sidebar item. */
  const startRename = useCallback((type: "storyboard" | "sketch" | "note" | "chat-artifact", path: string) => {
    // Extract current stem from the path for the initial value
    const filename = path.split("/").pop() ?? path;
    const stem = filename.replace(/\.(sk|sb|md|cv)$/, "");
    setRenamingItem({ type, path });
    setRenameValue(stem);
  }, []);

  /** Commit the rename — call backend, update tabs, reload lists. */
  const commitRename = useCallback(async () => {
    if (!renamingItem) return;
    if (renameInFlightRef.current) return;
    renameInFlightRef.current = true;
    const newStem = renameValue.trim();
    const slug = newStem ? slugify(newStem) : "";
    if (!slug) {
      renameInFlightRef.current = false;
      setRenamingItem(null);
      return;
    }

    const { type, path: oldPath } = renamingItem;
    const ext = type === "sketch" ? ".sk" : type === "storyboard" ? ".sb" : type === "chat-artifact" ? ".cv" : ".md";
    const dir = oldPath.includes("/") ? oldPath.substring(0, oldPath.lastIndexOf("/") + 1) : "";
    const newPath = `${dir}${slug}${ext}`;

    if (newPath === oldPath) {
      renameInFlightRef.current = false;
      setRenamingItem(null);
      return;
    }

    let suppressedPaths = Array.from(new Set([oldPath, newPath]));
    try {
      // Pending edits reach the old file before it moves; editors stay quiet until the rename lands.
      await settleBeforeRename();
      for (const path of suppressedPaths) suppressEditorFlush(path);
      const preview = await invoke<RenameProjectAssetPlan>("preview_rename_project_asset", { oldPath, newPath });
      suppressedPaths = Array.from(new Set([...suppressedPaths, ...preview.updatedReferences.map((ref) => ref.path)]));
      for (const path of suppressedPaths) suppressEditorFlush(path);
      const referenceCount = preview.updatedReferences.reduce((sum, ref) => sum + ref.count, 0);
      if (referenceCount > 0) {
        const fileCount = preview.updatedReferences.length;
        const confirmed = await new Promise<boolean>((resolve) => {
          setRenameConfirm({
            message: `Rename ${oldPath.split("/").pop() ?? oldPath} to ${newPath.split("/").pop() ?? newPath}?\n\nThis will update ${referenceCount} reference${referenceCount === 1 ? "" : "s"} in ${fileCount} file${fileCount === 1 ? "" : "s"}.`,
            resolve,
          });
        });
        if (!confirmed) return;
      }

      const result = await invoke<RenameProjectAssetPlan>("rename_project_asset", { oldPath, newPath });
      documentRenamed(result.oldPath, result.newPath);
      suppressedPaths = Array.from(new Set([...suppressedPaths, ...result.updatedReferences.map((ref) => ref.path)]));
      for (const path of suppressedPaths) suppressEditorFlush(path);

      // Update any open tab that references the old path
      const store = useAppStore.getState();
      const oldMainId = makeMainTabId(type, oldPath);
      const newMainId = makeMainTabId(type, newPath);
      const oldSplitId = makeSplitTabId(type, oldPath);
      const newSplitId = makeSplitTabId(type, newPath);
      const updatedTabs = store.openTabs.map((t) =>
        t.type === type && t.path === oldPath ? { ...t, path: newPath, id: newMainId } : t,
      );
      const updatedSplitTabs = store.splitTabs.map((t) =>
        t.type === type && t.path === oldPath ? { ...t, path: newPath, id: newSplitId } : t,
      );
      useAppStore.setState({
        openTabs: updatedTabs,
        activeTabId: store.activeTabId === oldMainId ? newMainId : store.activeTabId,
        splitTabs: updatedSplitTabs,
        splitActiveTabId: store.splitActiveTabId === oldSplitId ? newSplitId : store.splitActiveTabId,
        ...(type === "chat-artifact" && store.activeChatArtifactPath === oldPath ? { activeChatArtifactPath: newPath } : {}),
      });

      // Reload file lists
      if (type === "storyboard") await loadStoryboards();
      else if (type === "sketch") {
        await loadSketches();
        if (result.updatedReferences.length > 0) await loadStoryboards();
      }
      else if (type === "chat-artifact") await loadChatArtifacts();
      else await loadNotes();

      const updated = result.updatedReferences.reduce((sum, ref) => sum + ref.count, 0);
      showToast(
        updated > 0
          ? `Renamed and updated ${updated} reference${updated === 1 ? "" : "s"}.`
          : "Renamed file.",
        3500,
        "success",
      );
    } catch (err) {
      showToast(`Rename failed: ${commandErrorText(err)}`, 4000, "error");
    } finally {
      renameInFlightRef.current = false;
      window.setTimeout(() => suppressedPaths.forEach(clearSuppressedEditorFlush), 150);
      setRenamingItem(null);
    }
  }, [renamingItem, renameValue, loadStoryboards, loadSketches, loadNotes, loadChatArtifacts, showToast]);

  const cancelRename = useCallback(() => setRenamingItem(null), []);

  // Auto-focus rename input when entering rename mode
  useEffect(() => {
    if (renamingItem) {
      requestAnimationFrame(() => renameInputRef.current?.select());
    }
  }, [renamingItem]);

  const showDrmConfirm = useCallback(() => {
    return new Promise<boolean>((resolve) => {
      setDrmConfirm({ resolve });
    });
  }, []);

  // Global Escape to cancel any active creation
  useEffect(() => {
    const anyCreating = isCreatingSb || isCreatingSk || isCreatingNote;
    if (!anyCreating) return;
    const handleEsc = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        setIsCreatingSb(false); setNewSbTitle("");
        setIsCreatingSk(false); setNewSkTitle("");
        setIsCreatingNote(false); setNewNoteTitle("");
      }
    };
    window.addEventListener("keydown", handleEsc);
    return () => window.removeEventListener("keydown", handleEsc);
  }, [isCreatingSb, isCreatingSk, isCreatingNote]);

  const requestDelete = useCallback(async (type: "storyboard" | "sketch" | "note" | "chat-artifact", path: string, title: string) => {
    let usedBy: string[] | undefined;
    if (type === "sketch") {
      try {
        usedBy = await invoke<string[]>("sketch_used_by_storyboards", { relativePath: path });
      } catch { /* ignore */ }
    }
    setPendingDelete({ type, path, title, usedBy });
  }, []);

  const doTransfer = useCallback(async (
    action: "move" | "copy",
    type: "sketch" | "note" | "storyboard",
    sourcePath: string,
    sourceTitle: string,
    destProject: ProjectEntry,
    destRel: string,
  ) => {
    try {
      await invoke("transfer_asset", {
        sourceRel: sourcePath,
        destProjectPath: destProject.path,
        destRel,
        removeSource: action === "move",
      });
      await Promise.all([loadSketches(), loadNotes(), loadStoryboards()]);
      if (action === "move") {
        const tab = useAppStore.getState().openTabs.find((t) => t.path === sourcePath);
        if (tab) closeTab(tab.id);
      }
      showToast(`${action === "move" ? "Moved" : "Copied"} "${sourceTitle}" to ${destProject.name}`, 3000, "success");
    } catch (err) {
      const destRelExisting = transferConflictPath(err);
      if (destRelExisting !== null) {
        const filename = destRelExisting.split("/").pop() ?? sourceTitle;
        const dotIdx = filename.lastIndexOf(".");
        const ext = dotIdx >= 0 ? filename.slice(dotIdx) : "";
        const stem = dotIdx >= 0 ? filename.slice(0, dotIdx) : filename;
        setTransferConflict({ action, type, sourcePath, sourceTitle, destProject, ext, stem });
      } else {
        showToast(`Failed to ${action}: ${commandErrorText(err)}`, 4000, "error");
      }
    }
  }, [loadSketches, loadNotes, loadStoryboards, closeTab, showToast]);

  const handleTransfer = useCallback(async (
    action: "move" | "copy",
    type: "sketch" | "note" | "storyboard",
    path: string,
    title: string,
    destProject: ProjectEntry,
  ) => {
    // Warn if moving a sketch that's referenced by storyboards
    if (action === "move" && type === "sketch") {
      let usedBy: string[] = [];
      try { usedBy = await invoke<string[]>("sketch_used_by_storyboards", { relativePath: path }); } catch { /* ignore */ }
      if (usedBy.length > 0) {
        setTransferWarning({ action, type, sourcePath: path, sourceTitle: title, destProject, usedBy });
        return;
      }
    }
    doTransfer(action, type, path, title, destProject, path);
  }, [doTransfer]);

  const buildContextMenuItems = useCallback((
    type: "sketch" | "note" | "storyboard",
    path: string,
    title: string,
  ): ContextMenuItem[] => {
    const items: ContextMenuItem[] = [
      { label: "Rename File...", icon: <Pencil className="w-3.5 h-3.5" />, action: () => startRename(type, path) },
      { label: "View history", icon: <History className="w-3.5 h-3.5" />, action: () => openDocumentHistory(path, title) },
    ];

    if (currentProject) {
      items.push({ separator: true });
      items.push({
        label: "Open in Terminal",
        icon: <SquareTerminal className="w-3.5 h-3.5" />,
        action: () => invoke("open_in_terminal", { path: currentProject.root }),
      });
    }

    if (isMultiProject && otherProjects.length > 0) {
      if (items.length > 0) items.push({ separator: true });
      const projectItems = (action: "move" | "copy"): ContextMenuItem[] =>
        otherProjects.map((p) => ({
          label: p.name,
          icon: <FolderOpen className="w-3.5 h-3.5" />,
          action: () => handleTransfer(action, type, path, title, p),
        }));
      items.push(
        { label: "Move to", icon: <ArrowRight className="w-3.5 h-3.5" />, submenu: projectItems("move") },
        { label: "Copy to", icon: <Copy className="w-3.5 h-3.5" />, submenu: projectItems("copy") },
      );
    }

    return items;
  }, [currentProject, isMultiProject, otherProjects, handleTransfer, startRename]);

  useEffect(() => {
    loadStoryboards();
    loadSketches();
    loadNotes();
    loadChatArtifacts();
  }, [loadStoryboards, loadSketches, loadNotes, loadChatArtifacts]);

  // Apply sidebar order
  const orderedStoryboards = applySidebarOrder(storyboards, sidebarOrder?.storyboards ?? []);
  const orderedSketches = applySidebarOrder(sketches, sidebarOrder?.sketches ?? []);
  const orderedNotes = applySidebarOrder(notes, sidebarOrder?.notes ?? []);
  const membership = useStoryboardMembership(orderedStoryboards);
  const videoImportReferenceOptions: VideoImportPlanningContextReference[] = [
    ...orderedStoryboards.map((storyboard: StoryboardSummary) => ({
      kind: "storyboard" as const,
      path: storyboard.path,
      title: storyboard.title,
    })),
    ...orderedSketches.map((sketch: SketchSummary) => ({
      kind: "sketch" as const,
      path: sketch.path,
      title: sketch.title,
    })),
    ...orderedNotes.map((note: NoteSummary) => ({
      kind: "note" as const,
      path: note.path,
      title: note.title,
    })),
  ];

  // DnD sensors — require 5px movement to start drag (avoids accidental drags on click)
  const sensors = useSensors(useSensor(PointerSensor, { activationConstraint: { distance: 5 } }));

  const handleDragEnd = useCallback(
    (category: "storyboards" | "sketches" | "notes") =>
      (event: DragEndEvent) => {
        const { active, over } = event;
        if (!over || active.id === over.id) return;

        const items =
          category === "storyboards" ? orderedStoryboards :
          category === "sketches" ? orderedSketches : orderedNotes;

        const oldIdx = items.findIndex((i) => i.path === active.id);
        const newIdx = items.findIndex((i) => i.path === over.id);
        if (oldIdx < 0 || newIdx < 0) return;

        const reordered = [...items];
        const [moved] = reordered.splice(oldIdx, 1);
        reordered.splice(newIdx, 0, moved);

        const newOrder: SidebarOrder = {
          storyboards: sidebarOrder?.storyboards ?? storyboards.map((s) => s.path),
          sketches: sidebarOrder?.sketches ?? sketches.map((s) => s.path),
          notes: sidebarOrder?.notes ?? notes.map((n) => n.path),
          [category]: reordered.map((i) => i.path),
        };
        saveSidebarOrder(newOrder);
      },
    [orderedStoryboards, orderedSketches, orderedNotes, sidebarOrder, storyboards, sketches, notes, saveSidebarOrder],
  );

  const handleCreateSb = useCallback(async () => {
    const title = newSbTitle.trim();
    if (!title) return;
    await createStoryboard(title);
    setNewSbTitle("");
    setIsCreatingSb(false);
  }, [newSbTitle, createStoryboard]);

  const handleCreateSk = useCallback(async () => {
    const title = newSkTitle.trim();
    if (!title) return;
    // Clear storyboard context so we edit the sketch standalone
    closeStoryboard();
    await createSketch(title);
    setNewSkTitle("");
    setIsCreatingSk(false);
  }, [newSkTitle, createSketch, closeStoryboard]);

  const handleOpenSketchStandalone = useCallback(
    async (sketchPath: string) => {
      closeStoryboard();
      await openSketch(sketchPath);
    },
    [closeStoryboard, openSketch],
  );

  const handleCreateNote = useCallback(async () => {
    const title = newNoteTitle.trim();
    if (!title) return;
    await createNote(title);
    setNewNoteTitle("");
    setIsCreatingNote(false);
  }, [newNoteTitle, createNote]);

  const handleOpenImportMenu = useCallback((event: ReactMouseEvent<HTMLButtonElement>) => {
    event.stopPropagation();
    if (importing) return;
    const rect = event.currentTarget.getBoundingClientRect();
    setContextMenu(null);
    setImportMenu({ x: rect.left, y: rect.bottom + 6 });
  }, [importing]);

  const resolveVideoImportContext = useCallback(() => {
    const mentionKeys = extractMentionKeys(videoImportContextText);
    const references = videoImportReferenceOptions.filter((reference) => {
      const keys = [
        mentionKey(reference.title),
        mentionKey(reference.path),
        mentionKey(reference.path.split("/").pop() ?? reference.path),
      ];
      return keys.some((key) => key && mentionKeys.has(key));
    });
    return {
      text: videoImportContextText.trim(),
      references,
    };
  }, [videoImportContextText, videoImportReferenceOptions]);

  const requestVideoImportContext = useCallback(() => {
    setVideoImportContextOpen(true);
    return new Promise<VideoImportPlanningContext | null>((resolve) => {
      videoImportContextResolverRef.current = resolve;
    });
  }, []);

  const cancelVideoImportContext = useCallback(() => {
    videoImportContextResolverRef.current?.(null);
    videoImportContextResolverRef.current = null;
    setVideoImportContextText("");
    setVideoImportContextOpen(false);
  }, []);

  const continueVideoImportContext = useCallback(() => {
    const context = resolveVideoImportContext();
    videoImportContextResolverRef.current?.(context);
    videoImportContextResolverRef.current = null;
    setVideoImportContextText("");
    setVideoImportContextOpen(false);
  }, [resolveVideoImportContext]);

  const insertVideoImportMention = useCallback((reference: VideoImportPlanningContextReference) => {
    const mention = `@${mentionKey(reference.title || reference.path)}`;
    setVideoImportContextText((current) => {
      if (current.includes(mention)) return current;
      const prefix = current.trimEnd();
      return `${prefix}${prefix ? " " : ""}${mention} `;
    });
  }, []);

  const handleImport = useCallback(async (kind: ImportKind = "all") => {
    try {
      const { open: openDialog, message: showMessage } = await import("../dialogs");
      const selected = await openDialog({
        title: importDialogTitles[kind],
        multiple: true,
        filters: importDialogFilters[kind],
      });
      if (!selected) return;
      const paths = Array.isArray(selected) ? selected : [selected];
      const containsVideo = paths.some((raw) => {
        const filePath = typeof raw === "string" ? raw : String(raw);
        const ext = filePath.split(".").pop()?.toLowerCase();
        return !!ext && ["mp4", "mov", "mkv", "webm", "avi", "m4v"].includes(ext);
      });
      const planningContext = containsVideo ? await requestVideoImportContext() : null;
      if (containsVideo && planningContext === null) return;
      setImporting(true);

      // Helper: invoke an import command, handling file-exists conflicts.
      async function importWithConflict<T = string>(
        command: string,
        filePath: string,
        extraArgs: Record<string, unknown> = {},
      ): Promise<T | ""> {
        try {
          return await invoke<T>(command, { filePath, ...extraArgs });
        } catch (err) {
          const msg = err instanceof Error ? err.message : String(err);
          if (msg.startsWith("FILE_EXISTS:")) {
            const existing = msg.slice("FILE_EXISTS:".length);
            const result = await showMessage(
              `"${existing}" already exists in this workspace.\n\nOverwrite will replace the existing import output and its images.`,
              {
                title: existing.includes(" and ") ? "Files Already Exist" : "File Already Exists",
                buttons: { yes: "Overwrite", no: "Keep Both", cancel: "Cancel" },
              },
            );
            // Custom buttons resolve to their label (the plugin returns "Yes"/"No" only for default buttons).
            if (result === "Overwrite" || result === "Yes") {
              return await invoke<T>(command, { filePath, conflict: "overwrite", ...extraArgs });
            } else if (result === "Keep Both" || result === "No") {
              return await invoke<T>(command, { filePath, conflict: "rename", ...extraArgs });
            }
            return ""; // Cancel
          }
          if (msg.startsWith(VIDEO_IMPORT_MISSING_TRANSCRIPT_PREFIX)) {
            keepVideoImportProgressRef.current = true;
            setVideoImportProgress({
              phase: "failed",
              current: 0,
              total: 1,
              message: msg.slice(VIDEO_IMPORT_MISSING_TRANSCRIPT_PREFIX.length),
            });
            return "";
          }
          if (msg.startsWith(VIDEO_IMPORT_DURATION_LIMIT_PREFIX)) {
            keepVideoImportProgressRef.current = true;
            setVideoImportProgress({
              phase: "failed",
              current: 0,
              total: 1,
              message: msg.slice(VIDEO_IMPORT_DURATION_LIMIT_PREFIX.length),
            });
            return "";
          }
          throw err;
        }
      }

      const videoImportLlmConfig = containsVideo ? await buildVideoImportLlmConfig() : null;
      let importedNote = "";
      let importedSketch = "";
      for (const raw of paths) {
        const filePath = typeof raw === "string" ? raw : String(raw);
        const ext = filePath.split(".").pop()?.toLowerCase();
        if (ext === "sk") {
          await importWithConflict("import_sketch", filePath);
        } else if (ext === "sb") {
          await importWithConflict("import_storyboard", filePath);
        } else if (ext === "md") {
          const result = await importWithConflict("import_markdown", filePath);
          if (result) importedNote = result;
        } else if (ext === "docx" || ext === "doc") {
          const result = await importWithConflict("import_docx", filePath);
          if (result) importedNote = result;
        } else if (ext === "pdf") {
          const result = await importWithConflict("import_pdf", filePath);
          if (result) importedNote = result;
        } else if (ext === "pptx") {
          const result = await importWithConflict("import_pptx", filePath);
          if (result) importedNote = result;
        } else if (ext && ["mp4", "mov", "mkv", "webm", "avi", "m4v"].includes(ext)) {
          const progressChannel = new Channel<VideoImportProgress>();
          progressChannel.onmessage = (progress) => {
            setVideoImportProgress(progress);
          };
          setVideoImportProgress({
            phase: "preparing",
            current: 0,
            total: 7,
            message: "Preparing demo video import",
          });
          const result = await importWithConflict<{
            sketch_path: string;
            note_path?: string;
            row_count: number;
            llm_refined: boolean;
            llm_refinement_status?: string | null;
          }>(
            "import_video_with_progress",
            filePath,
            {
              ...(videoImportLlmConfig ? { llmConfig: videoImportLlmConfig } : {}),
              ...(planningContext && (planningContext.text || planningContext.references.length) ? { planningContext } : {}),
              onProgress: progressChannel,
            },
          );
          if (result && typeof result !== "string") {
            importedSketch = result.sketch_path;
            if (result.note_path) importedNote = result.note_path;
            setVideoImportProgress({
              phase: "complete",
              current: 7,
              total: 7,
              message: result.llm_refined
                ? "Analyzer-assisted video import complete"
                : "Heuristic video import complete",
            });
            showToast(
              result.llm_refined
                ? `Imported analyzer-assisted video sketch with ${result.row_count} rows and a summary note`
                : `Imported video sketch with ${result.row_count} heuristic scenes and a summary note`,
              4000,
              "success",
            );
          }
        }
      }
      await loadSketches();
      await loadStoryboards();
      await loadNotes();
      await loadAssets();
      if (importedSketch) await openSketch(importedSketch);
      if (importedNote) await openNote(importedNote);
    } catch (err) {
      const errMsg = err instanceof Error ? err.message : String(err);
      console.error("[import] Import failed:", errMsg);

      // DRM-protected document? Offer clipboard fallback
      if (errMsg.includes("DRM-protected") || errMsg.includes("protected or encrypted")) {
        const ok = await showDrmConfirm();
        if (ok) {
          try {
            const text = await navigator.clipboard.readText();
            if (text && text.trim().length > 0) {
              const notePath = "imported-clipboard.md";
                      await invoke("update_note", { relativePath: notePath, content: text.trim() });
              await loadNotes();
              openNote(notePath);
            } else {
              showToast("Clipboard is empty — please copy the text from Word first", 5000, "warning");
            }
          } catch {
            showToast("Could not read clipboard — please make sure you copied text from Word", 5000, "warning");
          }
        }
      }
    } finally {
      setImporting(false);
      if (keepVideoImportProgressRef.current) {
        keepVideoImportProgressRef.current = false;
      } else {
        window.setTimeout(() => setVideoImportProgress(null), 700);
      }
    }
  }, [buildVideoImportLlmConfig, loadSketches, loadStoryboards, loadNotes, loadAssets, openSketch, openNote, requestVideoImportContext, showDrmConfirm, showToast]);

  const buildImportMenuItems = useCallback((): ContextMenuItem[] => [
    {
      label: "Video to sketch...",
      icon: <Film className="w-3.5 h-3.5" />,
      action: () => handleImport("video"),
    },
    {
      label: "Sketch...",
      icon: <SketchIcon className="w-3.5 h-3.5" />,
      action: () => handleImport("sketch"),
    },
    {
      label: "Storyboard...",
      icon: <StoryboardIcon className="w-3.5 h-3.5" />,
      action: () => handleImport("storyboard"),
    },
    {
      label: "Markdown note...",
      icon: <NoteIcon className="w-3.5 h-3.5" />,
      action: () => handleImport("markdown"),
    },
    {
      label: "Document to note...",
      icon: <FileText className="w-3.5 h-3.5" />,
      action: () => handleImport("document"),
    },
    { separator: true },
    {
      label: "Auto-detect file type...",
      icon: <FileInput className="w-3.5 h-3.5" />,
      action: () => handleImport("all"),
    },
  ], [handleImport]);

  const renameInput = (label: string) => (
    <input
      ref={renameInputRef}
      value={renameValue}
      onChange={(e) => setRenameValue(e.target.value)}
      onKeyDown={(e) => {
        e.stopPropagation();
        if (e.key === "Enter") commitRename();
        if (e.key === "Escape") cancelRename();
      }}
      onBlur={commitRename}
      onClick={(e) => e.stopPropagation()}
      aria-label={label}
      title="Rename file. Spaces become hyphens."
      className="rename"
    />
  );

  const openContextMenu = (type: "storyboard" | "sketch" | "note", path: string, title: string) =>
    (e: ReactMouseEvent<HTMLDivElement>) => {
      if (buildContextMenuItems(type, path, title).length === 0) return;
      e.preventDefault();
      setContextMenu({ type, path, title, x: e.clientX, y: e.clientY });
    };

  const isRenaming = (path: string) => renamingItem?.path === path;
  const usage = sketchUsage(membership);

  const sectionOpen = (id: string) => !collapsedSections.has(id);
  const setSectionOpen = (id: string, open: boolean) =>
    setCollapsedSections((current) => {
      const next = new Set(current);
      if (open) next.delete(id);
      else next.add(id);
      return next;
    });
  const section = (id: string, label: string) => ({
    label,
    collapsed: !sectionOpen(id),
    onToggle: () => setSectionOpen(id, !sectionOpen(id)),
  });

  return (
    <div className="cr-tree" role="group" aria-label="Documents">
      <div className="cr-sec">
      <TreeSection {...section("storyboards", "Storyboards")}>
        <TreeMiniButton
          label="Import..."
          testId="explorer-import-menu"
          disabled={importing}
          ariaHasPopup="menu"
          ariaExpanded={importMenu !== null}
          onClick={handleOpenImportMenu}
        >
          <NavIcon name="import" size={16} className={importing ? "animate-pulse" : undefined} />
        </TreeMiniButton>
        <TreeMiniButton label="New storyboard" onClick={() => { setSectionOpen("storyboards", true); setIsCreatingSb(true); }} />
      </TreeSection>
      <TreeSectionBody open={sectionOpen("storyboards")}>
      {isCreatingSb && (
        <TreeCreateForm
          id="new-storyboard-title"
          label="Storyboard name"
          value={newSbTitle}
          onChange={setNewSbTitle}
          onCreate={() => void handleCreateSb()}
          onCancel={() => { setIsCreatingSb(false); setNewSbTitle(""); }}
        />
      )}
      {orderedStoryboards.length === 0 && !isCreatingSb && <div className="cr-tempty">No storyboards yet</div>}
      <DndContext sensors={sensors} collisionDetection={closestCenter} onDragEnd={handleDragEnd("storyboards")}>
        <SortableContext items={orderedStoryboards.map((sb) => sb.path)} strategy={verticalListSortingStrategy}>
          {orderedStoryboards.map((sb) => (
            <SortableTreeRow
              key={sb.path}
              id={sb.path}
              icon="clapper"
              label={sb.title}
              kind="storyboard"
              selected={sb.path === activeStoryboardPath}
              onOpen={() => openStoryboard(sb.path)}
              onRename={() => startRename("storyboard", sb.path)}
              onDelete={() => requestDelete("storyboard", sb.path, sb.title)}
              onContextMenu={openContextMenu("storyboard", sb.path, sb.title)}
              renameInput={isRenaming(sb.path) ? renameInput("Rename storyboard file") : undefined}
              testId={`explorer-item-${sb.path}`}
            />
          ))}
        </SortableContext>
      </DndContext>

      </TreeSectionBody>
      </div>

      <div className="cr-sec">
      <TreeSection {...section("sketches", "Sketches")}>
        <TreeMiniButton label="New sketch" onClick={() => { setSectionOpen("sketches", true); setIsCreatingSk(true); }} />
      </TreeSection>
      <TreeSectionBody open={sectionOpen("sketches")}>
      {isCreatingSk && (
        <TreeCreateForm
          id="new-sketch-title"
          label="Sketch name"
          value={newSkTitle}
          onChange={setNewSkTitle}
          onCreate={() => void handleCreateSk()}
          onCancel={() => { setIsCreatingSk(false); setNewSkTitle(""); }}
        />
      )}
      {orderedSketches.length === 0 && !isCreatingSk && <div className="cr-tempty">No sketches yet</div>}
      <DndContext sensors={sensors} collisionDetection={closestCenter} onDragEnd={handleDragEnd("sketches")}>
        <SortableContext items={orderedSketches.map((sk) => sk.path)} strategy={verticalListSortingStrategy}>
          {orderedSketches.map((sk) => (
            <SortableTreeRow
              key={sk.path}
              id={sk.path}
              icon="sketch"
              label={sk.title}
              kind="sketch"
              selected={sk.path === activeSketchPath}
              meta={usageLabel(usage.get(sk.path) ?? 0)}
              onOpen={() => void handleOpenSketchStandalone(sk.path)}
              onRename={() => startRename("sketch", sk.path)}
              onDelete={() => requestDelete("sketch", sk.path, sk.title)}
              onContextMenu={openContextMenu("sketch", sk.path, sk.title)}
              renameInput={isRenaming(sk.path) ? renameInput("Rename sketch file") : undefined}
              testId={`explorer-item-${sk.path}`}
            />
          ))}
        </SortableContext>
      </DndContext>

      </TreeSectionBody>
      </div>

      <div className="cr-sec">
      <TreeSection {...section("notes", "Notes")}>
        <TreeMiniButton label="New note" onClick={() => { setSectionOpen("notes", true); setIsCreatingNote(true); }} />
      </TreeSection>
      <TreeSectionBody open={sectionOpen("notes")}>
      {isCreatingNote && (
        <TreeCreateForm
          id="new-note-title"
          label="Note name"
          value={newNoteTitle}
          onChange={setNewNoteTitle}
          onCreate={() => void handleCreateNote()}
          onCancel={() => { setIsCreatingNote(false); setNewNoteTitle(""); }}
        />
      )}
      {orderedNotes.length === 0 && !isCreatingNote && <div className="cr-tempty">No notes yet</div>}
      <DndContext sensors={sensors} collisionDetection={closestCenter} onDragEnd={handleDragEnd("notes")}>
        <SortableContext items={orderedNotes.map((n) => n.path)} strategy={verticalListSortingStrategy}>
          {orderedNotes.map((note) => (
            <SortableTreeRow
              key={note.path}
              id={note.path}
              icon="note"
              label={note.title}
              kind="note"
              selected={note.path === activeNotePath}
              onOpen={() => openNote(note.path)}
              onRename={() => startRename("note", note.path)}
              onDelete={() => requestDelete("note", note.path, note.title)}
              onContextMenu={openContextMenu("note", note.path, note.title)}
              renameInput={isRenaming(note.path) ? renameInput("Rename note file") : undefined}
              testId={`explorer-item-${note.path}`}
            />
          ))}
        </SortableContext>
      </DndContext>

      </TreeSectionBody>
      </div>

      {chatArtifacts.length > 0 && (
        <div className="cr-sec">
          <TreeSection {...section("chats", "Promoted chats")} />
          <TreeSectionBody open={sectionOpen("chats")}>
          {chatArtifacts.map((artifact) => (
            <TreeRow
              key={artifact.path}
              icon="chat"
              label={artifact.title}
              kind="chat"
              selected={artifact.path === activeChatArtifactPath}
              onOpen={() => openChatArtifact(artifact.path)}
              onRename={() => startRename("chat-artifact", artifact.path)}
              onDelete={() => requestDelete("chat-artifact", artifact.path, artifact.title)}
              renameInput={isRenaming(artifact.path) ? renameInput("Rename chat") : undefined}
            />
          ))}
          </TreeSectionBody>
        </div>
      )}

      <DeleteAssetDialog
        pending={pendingDelete}
        onCancel={() => setPendingDelete(null)}
        onConfirm={({ type, path }) => {
          setPendingDelete(null);
          if (type === "sketch") deleteSketch(path);
          else if (type === "storyboard") deleteStoryboard(path);
          else if (type === "chat-artifact") deleteChatArtifact(path);
          else deleteNote(path);
        }}
      />

      <ConfirmDialog
        open={!!drmConfirm}
        title="Protected Document"
        message={"This document is protected. To import it:\n\n1. Open the file in Word\n2. Select all text (Ctrl+A)\n3. Copy it (Ctrl+C)\n4. Click Import below\n\nThe note will be created from your clipboard."}
        confirmLabel="Import from Clipboard"
        cancelLabel="Cancel"
        variant="warning"
        onConfirm={() => { drmConfirm?.resolve(true); setDrmConfirm(null); }}
        onCancel={() => { drmConfirm?.resolve(false); setDrmConfirm(null); }}
      />
      <ConfirmDialog
        open={!!renameConfirm}
        title="Rename and update references?"
        message={renameConfirm?.message ?? ""}
        confirmLabel="Rename and update"
        cancelLabel="Cancel"
        variant="warning"
        onConfirm={() => { renameConfirm?.resolve(true); setRenameConfirm(null); }}
        onCancel={() => { renameConfirm?.resolve(false); setRenameConfirm(null); }}
      />
      <VideoImportProgressDialog
        progress={videoImportProgress}
        onClose={() => setVideoImportProgress(null)}
      />
      <VideoImportPlanningContextDialog
        open={videoImportContextOpen}
        value={videoImportContextText}
        references={videoImportReferenceOptions}
        onChange={setVideoImportContextText}
        onInsertMention={insertVideoImportMention}
        onContinue={continueVideoImportContext}
        onCancel={cancelVideoImportContext}
      />
      {importMenu && (
        <ContextMenu
          position={{ x: importMenu.x, y: importMenu.y }}
          items={buildImportMenuItems()}
          onClose={() => setImportMenu(null)}
        />
      )}

      {/* Context menu (portal — rendered above DnD layer) */}
      {contextMenu && (
        <ContextMenu
          position={{ x: contextMenu.x, y: contextMenu.y }}
          items={buildContextMenuItems(contextMenu.type, contextMenu.path, contextMenu.title)}
          onClose={() => setContextMenu(null)}
        />
      )}

      <TransferWarningDialog
        warning={transferWarning}
        onCancel={() => setTransferWarning(null)}
        onConfirm={({ action, type, sourcePath, sourceTitle, destProject }) => {
          setTransferWarning(null);
          doTransfer(action, type, sourcePath, sourceTitle, destProject, sourcePath);
        }}
      />
      <TransferConflictDialog
        conflict={transferConflict}
        onCancel={() => setTransferConflict(null)}
        onSubmit={({ action, type, sourcePath, sourceTitle, destProject }, destRel) => {
          setTransferConflict(null);
          doTransfer(action, type, sourcePath, sourceTitle, destProject, destRel);
        }}
      />
    </div>
  );
}
