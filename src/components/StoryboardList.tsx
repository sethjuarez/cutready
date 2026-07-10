import { useCallback, useEffect, useRef, useState, type CSSProperties, type MouseEvent as ReactMouseEvent } from "react";
import {
  DndContext,
  closestCenter,
  PointerSensor,
  useSensor,
  useSensors,
  type DragEndEvent,
} from "@dnd-kit/core";
import {
  SortableContext,
  useSortable,
  verticalListSortingStrategy,
} from "@dnd-kit/sortable";
import { CSS } from "@dnd-kit/utilities";
import { Channel, invoke } from "../services/tauri";
import { ArrowRight, ChevronDown, ChevronRight, Copy, FileInput, FileText, Film, FolderOpen, Plus, SquareTerminal, Trash2 } from "lucide-react";
import { useAppStore, type SidebarOrder } from "../stores/appStore";
import type { ProjectEntry } from "../types/project";
import { SketchIcon, StoryboardIcon, NoteIcon } from "./Icons";
import { ConfirmDialog } from "./ConfirmDialog";
import { ContextMenu, type ContextMenuItem } from "./ContextMenu";
import { useToastStore } from "../stores/toastStore";
import { contentTypeTones, type ContentTypeTone } from "../utils/contentTypeTheme";
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

interface VideoImportProgress {
  phase: string;
  current: number;
  total: number;
  message: string;
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

function sectionBodyStyle(
  mode: "storyboards" | "sketches" | "notes" | "all",
  weight: number,
  itemCount: number,
  expandedCount: number,
  itemHeight = 34,
): CSSProperties {
  if (mode !== "all" || expandedCount === 1) return { flex: "1 1 0%", minHeight: 0 };

  const estimatedHeight = Math.min(220, Math.max(56, itemCount * itemHeight + 8));
  return {
    flex: `${weight} 1 ${estimatedHeight}px`,
    minHeight: 0,
  };
}

function documentItemClass(active: boolean, tone: ContentTypeTone) {
  return `group/item relative flex w-full cursor-pointer items-center gap-2 px-3 py-1.5 text-left text-[12px] outline-none transition-colors focus-visible:bg-[rgb(var(--color-surface-alt))] ${
    active
      ? `${tone.activeBg} ${tone.text}`
      : `text-[rgb(var(--color-text))] ${tone.hoverBg}`
  }`;
}

function documentItemMetaClass(active: boolean, tone: ContentTypeTone) {
  return active ? tone.metaText : "text-[rgb(var(--color-text-secondary))]/80";
}

function ActiveDocumentMarker({ active, tone }: { active: boolean; tone: ContentTypeTone }) {
  if (!active) return null;
  return <span className={`absolute left-0 top-1 bottom-1 w-0.5 rounded-r ${tone.bg}`} />;
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
      <div className="cr-modal-surface overflow-hidden rounded-2xl">
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
            <div className="mb-2 flex items-center justify-between text-[11px] font-medium uppercase tracking-[0.14em] text-[rgb(var(--color-text-secondary))]">
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
              <div className="mb-2 flex items-center justify-between text-[10px] font-semibold uppercase tracking-[0.16em] text-[rgb(var(--color-accent))]">
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
                    className="flex items-center gap-2 text-[11px] leading-4 text-[rgb(var(--color-text-secondary))]"
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

function DocumentItemText({ title, meta, active, tone }: { title: string; meta?: string; active: boolean; tone: ContentTypeTone }) {
  return (
    <div className="min-w-0 flex-1 py-0.5 leading-tight">
      <div className="truncate text-[12px] font-medium leading-4" title={title}>{title}</div>
      {meta && (
        <div className={`mt-0.5 truncate text-[10px] leading-3 ${documentItemMetaClass(active, tone)}`} title={meta}>
          {meta}
        </div>
      )}
    </div>
  );
}

/** Wrapper that makes a sidebar list item draggable. */
function SortableSidebarItem({ id, children }: { id: string; children: React.ReactNode }) {
  const { attributes, listeners, setNodeRef, transform, transition, isDragging } = useSortable({ id });
  const style = {
    transform: CSS.Transform.toString(transform),
    transition,
    opacity: isDragging ? 0.4 : 1,
  };
  return (
    <div ref={setNodeRef} style={style} {...attributes} className="group/item">
      <div className="flex items-center">
        {/* Drag handle */}
        <div
          {...listeners}
          className="shrink-0 w-4 flex items-center justify-center cursor-grab opacity-0 group-hover/item:opacity-50 hover:!opacity-100 transition-opacity"
          title="Drag to reorder"
        >
          <svg width="8" height="14" viewBox="0 0 8 14" fill="currentColor" className="text-[rgb(var(--color-text-secondary))]">
            <circle cx="2" cy="2" r="1.2" />
            <circle cx="6" cy="2" r="1.2" />
            <circle cx="2" cy="7" r="1.2" />
            <circle cx="6" cy="7" r="1.2" />
            <circle cx="2" cy="12" r="1.2" />
            <circle cx="6" cy="12" r="1.2" />
          </svg>
        </div>
        <div className="flex-1 min-w-0">{children}</div>
      </div>
    </div>
  );
}

function SidebarSectionHeader({
  title,
  count,
  expanded,
  onToggle,
  actions,
  tone,
}: {
  title: string;
  count: number;
  expanded: boolean;
  onToggle: () => void;
  actions?: React.ReactNode;
  tone: ContentTypeTone;
}) {
  return (
    <div className="flex h-8 min-w-0 shrink-0 items-center justify-between gap-2 border-b border-[rgb(var(--color-border))] px-3">
      <button
        onClick={onToggle}
        className={`flex min-w-0 flex-1 items-center gap-1 text-[11px] font-semibold uppercase tracking-wider text-[rgb(var(--color-text-secondary))] transition-colors ${tone.hoverText}`}
      >
        {expanded ? <ChevronDown className="h-3 w-3 shrink-0" /> : <ChevronRight className="h-3 w-3 shrink-0" />}
        <span className="truncate">{title}</span>
        {count > 0 && (
          <span className={`ml-1 rounded-full border px-1 py-0 text-[9px] font-medium ${tone.activeBg} ${tone.text} ${tone.border}`}>
            {count}
          </span>
        )}
      </button>
      <div className="flex shrink-0 items-center gap-1">{actions}</div>
    </div>
  );
}

/**
 * StoryboardList — Documents pane: Storyboards, Sketches, and Notes.
 * Pass `mode` to optionally focus a single section.
 */
export function StoryboardList({ mode }: { mode?: "storyboards" | "sketches" | "notes" | "all" }) {
  const resolvedMode = mode ?? "all";
  const storyboards = useAppStore((s) => s.storyboards);
  const sketches = useAppStore((s) => s.sketches);
  const notes = useAppStore((s) => s.notes);
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
  const loadStoryboards = useAppStore((s) => s.loadStoryboards);
  const loadSketches = useAppStore((s) => s.loadSketches);
  const loadNotes = useAppStore((s) => s.loadNotes);
  const loadAssets = useAppStore((s) => s.loadAssets);
  const createStoryboard = useAppStore((s) => s.createStoryboard);
  const openStoryboard = useAppStore((s) => s.openStoryboard);
  const deleteStoryboard = useAppStore((s) => s.deleteStoryboard);
  const createSketch = useAppStore((s) => s.createSketch);
  const openSketch = useAppStore((s) => s.openSketch);
  const deleteSketch = useAppStore((s) => s.deleteSketch);
  const createNote = useAppStore((s) => s.createNote);
  const openNote = useAppStore((s) => s.openNote);
  const deleteNote = useAppStore((s) => s.deleteNote);
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
  const [storyboardsExpanded, setStoryboardsExpanded] = useState(true);
  const [sketchesExpanded, setSketchesExpanded] = useState(true);
  const [notesExpanded, setNotesExpanded] = useState(true);
  const [pendingDelete, setPendingDelete] = useState<{ type: "storyboard" | "sketch" | "note"; path: string; title: string; usedBy?: string[] } | null>(null);
  const [drmConfirm, setDrmConfirm] = useState<{ resolve: (ok: boolean) => void } | null>(null);
  const [importing, setImporting] = useState(false);
  const [importMenu, setImportMenu] = useState<{ x: number; y: number } | null>(null);
  const [videoImportProgress, setVideoImportProgress] = useState<VideoImportProgress | null>(null);
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

  const [transferWarning, setTransferWarning] = useState<{
    action: "move" | "copy";
    type: "sketch" | "note" | "storyboard";
    sourcePath: string;
    sourceTitle: string;
    destProject: ProjectEntry;
    usedBy: string[];
  } | null>(null);

  const [transferConflict, setTransferConflict] = useState<{
    action: "move" | "copy";
    type: "sketch" | "note" | "storyboard";
    sourcePath: string;
    sourceTitle: string;
    destProject: ProjectEntry;
    ext: string;
  } | null>(null);
  const [conflictName, setConflictName] = useState("");
  const conflictInputRef = useRef<HTMLInputElement>(null);
  const { settings, updateSetting, loaded: settingsLoaded } = useSettings();

  useEffect(() => {
    if (transferConflict) requestAnimationFrame(() => conflictInputRef.current?.select());
  }, [transferConflict]);

  // ── Inline rename state ──────────────────────────────────────────
  const [renamingItem, setRenamingItem] = useState<{ type: "storyboard" | "sketch" | "note"; path: string } | null>(null);
  const [renameValue, setRenameValue] = useState("");
  const renameInputRef = useRef<HTMLInputElement>(null);

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
        const tokenResult = await invoke<{ access_token: string; refresh_token?: string }>(
          "azure_token_refresh",
          {
            tenantId: settings.aiTenantId || "",
            refreshToken: settings.aiRefreshToken,
            clientId: settings.aiClientId || null,
          },
        );
        if (tokenResult.access_token) {
          freshBearerToken = tokenResult.access_token;
          await updateSetting("aiAccessToken", tokenResult.access_token);
          if (tokenResult.refresh_token) {
            await updateSetting("aiRefreshToken", tokenResult.refresh_token);
          }
        }
      } catch {
        // The import request below will surface any auth failure with the current token.
      }
    }

    const config = buildProviderConfig(providerInput);
    if (freshBearerToken && selectedProvider?.id === settings.aiActiveProviderId) {
      config.bearer_token = freshBearerToken;
    }
    return config;
  }, [settings, settingsLoaded, updateSetting]);

  /** Enter rename mode for a sidebar item. */
  const startRename = useCallback((type: "storyboard" | "sketch" | "note", path: string) => {
    // Extract current stem from the path for the initial value
    const filename = path.split("/").pop() ?? path;
    const stem = filename.replace(/\.(sk|sb|md)$/, "");
    setRenamingItem({ type, path });
    setRenameValue(stem);
  }, []);

  /** Commit the rename — call backend, update tabs, reload lists. */
  const commitRename = useCallback(async () => {
    if (!renamingItem) return;
    const newStem = renameValue.trim();
    if (!newStem) { setRenamingItem(null); return; }

    const slug = slugify(newStem);
    if (!slug) { setRenamingItem(null); return; }

    const { type, path: oldPath } = renamingItem;
    const ext = type === "sketch" ? ".sk" : type === "storyboard" ? ".sb" : ".md";
    const dir = oldPath.includes("/") ? oldPath.substring(0, oldPath.lastIndexOf("/") + 1) : "";
    const newPath = `${dir}${slug}${ext}`;

    if (newPath === oldPath) { setRenamingItem(null); return; }

    try {
      const cmd = type === "sketch" ? "rename_sketch" : type === "storyboard" ? "rename_storyboard" : "rename_note";
      await invoke(cmd, { oldPath, newPath });

      // Update any open tab that references the old path
      const store = useAppStore.getState();
      const updatedTabs = store.openTabs.map((t) =>
        t.path === oldPath ? { ...t, path: newPath, id: `${t.type}:${newPath}` } : t,
      );
      const updatedActive = store.activeTabId === `${type}:${oldPath}` ? `${type}:${newPath}` : store.activeTabId;
      useAppStore.setState({ openTabs: updatedTabs, activeTabId: updatedActive });

      // Reload file lists
      if (type === "storyboard") await loadStoryboards();
      else if (type === "sketch") await loadSketches();
      else await loadNotes();
    } catch (err) {
      showToast(`Rename failed: ${err}`, 4000, "error");
    }
    setRenamingItem(null);
  }, [renamingItem, renameValue, loadStoryboards, loadSketches, loadNotes, showToast]);

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

  const requestDelete = useCallback(async (type: "storyboard" | "sketch" | "note", path: string, title: string) => {
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
      const errMsg = String(err);
      if (errMsg.startsWith("FILE_EXISTS:")) {
        const destRelExisting = errMsg.replace("FILE_EXISTS:", "");
        const filename = destRelExisting.split("/").pop() ?? sourceTitle;
        const dotIdx = filename.lastIndexOf(".");
        const ext = dotIdx >= 0 ? filename.slice(dotIdx) : "";
        const stem = dotIdx >= 0 ? filename.slice(0, dotIdx) : filename;
        setTransferConflict({ action, type, sourcePath, sourceTitle, destProject, ext });
        setConflictName(stem);
      } else {
        showToast(`Failed to ${action}: ${errMsg}`, 4000, "error");
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
    const items: ContextMenuItem[] = [];

    if (currentProject) {
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
  }, [currentProject, isMultiProject, otherProjects, handleTransfer]);

  useEffect(() => {
    loadStoryboards();
    loadSketches();
    loadNotes();
  }, [loadStoryboards, loadSketches, loadNotes]);

  // Apply sidebar order
  const orderedStoryboards = applySidebarOrder(storyboards, sidebarOrder?.storyboards ?? []);
  const orderedSketches = applySidebarOrder(sketches, sidebarOrder?.sketches ?? []);
  const orderedNotes = applySidebarOrder(notes, sidebarOrder?.notes ?? []);
  const sectionBodyClass = "min-h-0 overflow-y-auto py-1";
  const expandedSectionCount = [storyboardsExpanded, sketchesExpanded, notesExpanded].filter(Boolean).length;
  const storyboardsBodyStyle = sectionBodyStyle(resolvedMode, 0.75, orderedStoryboards.length, expandedSectionCount, 42);
  const sketchesBodyStyle = sectionBodyStyle(resolvedMode, 1.25, orderedSketches.length, expandedSectionCount, 42);
  const notesBodyStyle = sectionBodyStyle(resolvedMode, 2, orderedNotes.length, expandedSectionCount, 30);
  const storyboardTone = contentTypeTones.storyboard;
  const sketchTone = contentTypeTones.sketch;
  const noteTone = contentTypeTones.note;

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

  const handleImport = useCallback(async (kind: ImportKind = "all") => {
    try {
      const { open: openDialog, message: showMessage } = await import("@tauri-apps/plugin-dialog");
      const selected = await openDialog({
        title: importDialogTitles[kind],
        multiple: true,
        filters: importDialogFilters[kind],
      });
      if (!selected) return;
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
              `"${existing}" already exists in this workspace.\n\nOverwrite will replace the file and its images.`,
              {
                title: "File Already Exists",
                buttons: { yes: "Overwrite", no: "Keep Both", cancel: "Cancel" },
              },
            );
            if (result === "Yes") {
              return await invoke<T>(command, { filePath, conflict: "overwrite", ...extraArgs });
            } else if (result === "No") {
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

      const paths = Array.isArray(selected) ? selected : [selected];
      const videoImportLlmConfig = await buildVideoImportLlmConfig();
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
            row_count: number;
            llm_refined: boolean;
            llm_refinement_status?: string | null;
          }>(
            "import_video_with_progress",
            filePath,
            {
              ...(videoImportLlmConfig ? { llmConfig: videoImportLlmConfig } : {}),
              onProgress: progressChannel,
            },
          );
          if (result && typeof result !== "string") {
            importedSketch = result.sketch_path;
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
                ? `Imported analyzer-assisted video sketch with ${result.row_count} rows`
                : `Imported video sketch with ${result.row_count} heuristic scenes`,
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
      else if (importedNote) openNote(importedNote);
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
              await invoke("create_note", { relativePath: notePath });
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
  }, [buildVideoImportLlmConfig, loadSketches, loadStoryboards, loadNotes, loadAssets, openSketch, openNote, showDrmConfirm, showToast]);

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

  const importButton = (
    <button
      onClick={handleOpenImportMenu}
      className="inline-flex items-center gap-1 rounded-md border border-[rgb(var(--color-border))] bg-[rgb(var(--color-surface))]/80 px-2 py-1 text-[11px] font-medium text-[rgb(var(--color-text-secondary))] shadow-sm transition-colors hover:border-[rgb(var(--color-accent))]/50 hover:bg-[rgb(var(--color-accent))]/10 hover:text-[rgb(var(--color-accent))] disabled:pointer-events-none disabled:opacity-50"
      title="Import..."
      disabled={importing}
      aria-haspopup="menu"
      aria-expanded={importMenu !== null}
    >
      {importing ? (
        <svg className="w-3 h-3 animate-spin text-[rgb(var(--color-text-secondary))]" viewBox="0 0 24 24" fill="none">
          <circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="3" />
          <path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4z" />
        </svg>
      ) : (
        <>
          <FileInput className="w-3 h-3" />
          <span>Import</span>
          <ChevronDown className="w-3 h-3 opacity-70" />
        </>
      )}
    </button>
  );

  return (
    <div
      className="flex flex-col h-full bg-[rgb(var(--color-surface-inset))]"
    >
      {/* ── Documents header (all-mode only) ──────────────────────────────── */}
      {resolvedMode === "all" && (
        <div className="flex h-8 shrink-0 items-center justify-between border-b border-[rgb(var(--color-border))] px-3">
          <span className="text-[11px] font-semibold uppercase tracking-wider text-[rgb(var(--color-text-secondary))]">
            Documents
          </span>
          <div className="flex items-center gap-1">
            {importButton}
          </div>
        </div>
      )}

      {/* ── Storyboards section ────────────────────────── */}
      {(resolvedMode === "all" || resolvedMode === "storyboards") && (
        <>
          <SidebarSectionHeader
            title="Storyboards"
            count={orderedStoryboards.length}
            expanded={storyboardsExpanded}
            onToggle={() => setStoryboardsExpanded(!storyboardsExpanded)}
            tone={storyboardTone}
            actions={
              <>
              {resolvedMode === "storyboards" && (
                importButton
              )}
              <button
                onClick={() => { setStoryboardsExpanded(true); setIsCreatingSb(true); }}
                className="p-1 rounded-md text-[rgb(var(--color-text-secondary))] hover:text-[rgb(var(--color-accent))] hover:bg-[rgb(var(--color-accent))]/10 transition-colors"
                title="New storyboard"
              >
                <Plus className="w-3.5 h-3.5" />
              </button>
              </>
            }
          />

          {storyboardsExpanded && isCreatingSb && (
            <div className="px-3 py-2 border-b border-[rgb(var(--color-border))]">
              <input
                type="text"
                value={newSbTitle}
                onChange={(e) => setNewSbTitle(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === "Enter") handleCreateSb();
                  if (e.key === "Escape") { setIsCreatingSb(false); setNewSbTitle(""); }
                }}
                placeholder="Storyboard name..."
                autoFocus
                className="w-full px-2 py-1.5 rounded-md bg-[rgb(var(--color-surface))] border border-[rgb(var(--color-border))] text-xs text-[rgb(var(--color-text))] placeholder:text-[rgb(var(--color-text-secondary))]/50 focus:outline-none focus:ring-1 focus:ring-[rgb(var(--color-accent))]/40"
              />
            </div>
          )}

          {storyboardsExpanded && <div className={sectionBodyClass} style={storyboardsBodyStyle}>
            {orderedStoryboards.length === 0 && !isCreatingSb ? (
              <button
                onClick={() => { setStoryboardsExpanded(true); setIsCreatingSb(true); }}
                className="w-full px-3 py-4 text-xs text-[rgb(var(--color-text-secondary))] hover:text-[rgb(var(--color-accent))] transition-colors"
              >
                + New storyboard
              </button>
            ) : (
              <DndContext sensors={sensors} collisionDetection={closestCenter} onDragEnd={handleDragEnd("storyboards")}>
                <SortableContext items={orderedStoryboards.map((sb) => sb.path)} strategy={verticalListSortingStrategy}>
                  {orderedStoryboards.map((sb) => (
                    <SortableSidebarItem key={sb.path} id={sb.path}>
                      <div
                        role="button"
                        tabIndex={0}
                        onClick={() => { if (!renamingItem) openStoryboard(sb.path); }}
                        onDoubleClick={(e) => { e.stopPropagation(); startRename("storyboard", sb.path); }}
                        onContextMenu={(e) => {
                          const items = buildContextMenuItems("storyboard", sb.path, sb.title);
                          if (items.length > 0) { e.preventDefault(); setContextMenu({ type: "storyboard", path: sb.path, title: sb.title, x: e.clientX, y: e.clientY }); }
                        }}
                        onKeyDown={(e) => {
                          if (e.key === "F2") { e.preventDefault(); startRename("storyboard", sb.path); }
                          else if (e.key === "Enter" || e.key === " ") { if (!renamingItem) openStoryboard(sb.path); }
                        }}
                        className={documentItemClass(sb.path === activeStoryboardPath, storyboardTone)}
                      >
                        <ActiveDocumentMarker active={sb.path === activeStoryboardPath} tone={storyboardTone} />
                        <StoryboardIcon className={`shrink-0 opacity-90 ${storyboardTone.text}`} />
                        <div className="min-w-0 flex-1">
                          {renamingItem?.path === sb.path ? (
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
                              className="w-full px-1 py-0.5 text-xs font-medium bg-[rgb(var(--color-surface))] border border-[rgb(var(--color-accent))]/40 rounded focus:outline-none focus:ring-1 focus:ring-[rgb(var(--color-accent))]/40 text-[rgb(var(--color-text))]"
                            />
                          ) : (
                            <DocumentItemText
                              title={sb.title}
                              meta={`${sb.sketch_count} ${sb.sketch_count === 1 ? "sketch" : "sketches"}`}
                              active={sb.path === activeStoryboardPath}
                              tone={storyboardTone}
                            />
                          )}
                        </div>
                        {renamingItem?.path !== sb.path && (
                          <button
                            onClick={(e) => {
                              e.stopPropagation();
                              requestDelete("storyboard", sb.path, sb.title);
                            }}
                            className="shrink-0 rounded p-0.5 text-[rgb(var(--color-text-secondary))] opacity-0 transition-all hover:text-[rgb(var(--color-text))] focus-visible:opacity-100 group-hover/item:opacity-100"
                            title="Delete storyboard"
                          >
                            <Trash2 className="w-3 h-3" />
                          </button>
                        )}
                      </div>
                    </SortableSidebarItem>
                  ))}
                </SortableContext>
              </DndContext>
            )}
          </div>}
        </>
      )}

      {/* ── Sketches section──────────────────────────── */}
      {(resolvedMode === "all" || resolvedMode === "sketches") && (
        <>
          <SidebarSectionHeader
            title="Sketches"
            count={orderedSketches.length}
            expanded={sketchesExpanded}
            onToggle={() => setSketchesExpanded(!sketchesExpanded)}
            tone={sketchTone}
            actions={
              <>
              {resolvedMode === "sketches" && (
                importButton
              )}
              <button
                onClick={() => { setSketchesExpanded(true); setIsCreatingSk(true); }}
                className="p-1 rounded-md text-[rgb(var(--color-text-secondary))] hover:text-[rgb(var(--color-accent))] hover:bg-[rgb(var(--color-accent))]/10 transition-colors"
                title="New sketch"
              >
                <Plus className="w-3.5 h-3.5" />
              </button>
              </>
            }
          />

          {sketchesExpanded && isCreatingSk && (
            <div className="px-3 py-2 border-b border-[rgb(var(--color-border))]">
              <input
                type="text"
                value={newSkTitle}
                onChange={(e) => setNewSkTitle(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === "Enter") handleCreateSk();
                  if (e.key === "Escape") { setIsCreatingSk(false); setNewSkTitle(""); }
                }}
                placeholder="Sketch name..."
                autoFocus
                className="w-full px-2 py-1.5 rounded-md bg-[rgb(var(--color-surface))] border border-[rgb(var(--color-border))] text-xs text-[rgb(var(--color-text))] placeholder:text-[rgb(var(--color-text-secondary))]/50 focus:outline-none focus:ring-1 focus:ring-[rgb(var(--color-accent))]/40"
              />
            </div>
          )}

          {sketchesExpanded && <div className={sectionBodyClass} style={sketchesBodyStyle}>
            {orderedSketches.length === 0 && !isCreatingSk ? (
              <button
                onClick={() => { setSketchesExpanded(true); setIsCreatingSk(true); }}
                className="w-full px-3 py-4 text-xs text-[rgb(var(--color-text-secondary))] hover:text-[rgb(var(--color-accent))] transition-colors"
              >
                + New sketch
              </button>
            ) : (
              <DndContext sensors={sensors} collisionDetection={closestCenter} onDragEnd={handleDragEnd("sketches")}>
                <SortableContext items={orderedSketches.map((sk) => sk.path)} strategy={verticalListSortingStrategy}>
                  {orderedSketches.map((sk) => (
                    <SortableSidebarItem key={sk.path} id={sk.path}>
                      <div
                        role="button"
                        tabIndex={0}
                        onClick={() => { if (!renamingItem) handleOpenSketchStandalone(sk.path); }}
                        onDoubleClick={(e) => { e.stopPropagation(); startRename("sketch", sk.path); }}
                        onContextMenu={(e) => {
                          const items = buildContextMenuItems("sketch", sk.path, sk.title);
                          if (items.length > 0) { e.preventDefault(); setContextMenu({ type: "sketch", path: sk.path, title: sk.title, x: e.clientX, y: e.clientY }); }
                        }}
                        onKeyDown={(e) => {
                          if (e.key === "F2") { e.preventDefault(); startRename("sketch", sk.path); }
                          else if (e.key === "Enter" || e.key === " ") { if (!renamingItem) handleOpenSketchStandalone(sk.path); }
                        }}
                        className={documentItemClass(sk.path === activeSketchPath, sketchTone)}
                      >
                        <ActiveDocumentMarker active={sk.path === activeSketchPath} tone={sketchTone} />
                        <SketchIcon className={`shrink-0 opacity-90 ${sketchTone.text}`} />
                        <div className="min-w-0 flex-1">
                          {renamingItem?.path === sk.path ? (
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
                              className="w-full px-1 py-0.5 text-xs font-medium bg-[rgb(var(--color-surface))] border border-[rgb(var(--color-accent))]/40 rounded focus:outline-none focus:ring-1 focus:ring-[rgb(var(--color-accent))]/40 text-[rgb(var(--color-text))]"
                            />
                          ) : (
                            <DocumentItemText
                              title={sk.title}
                              meta={`${sk.row_count} ${sk.row_count === 1 ? "row" : "rows"}`}
                              active={sk.path === activeSketchPath}
                              tone={sketchTone}
                            />
                          )}
                        </div>
                        {renamingItem?.path !== sk.path && (
                          <button
                            onClick={(e) => {
                              e.stopPropagation();
                              requestDelete("sketch", sk.path, sk.title);
                            }}
                            className="shrink-0 rounded p-0.5 text-[rgb(var(--color-text-secondary))] opacity-0 transition-all hover:text-[rgb(var(--color-text))] focus-visible:opacity-100 group-hover/item:opacity-100"
                            title="Delete sketch"
                          >
                            <Trash2 className="w-3 h-3" />
                          </button>
                        )}
                      </div>
                    </SortableSidebarItem>
                  ))}
                </SortableContext>
              </DndContext>
            )}
          </div>}
        </>
      )}

      {/* ── Notes section─────────────────────────────── */}
      {(resolvedMode === "all" || resolvedMode === "notes") && (
        <>
          <SidebarSectionHeader
            title="Notes"
            count={orderedNotes.length}
            expanded={notesExpanded}
            onToggle={() => setNotesExpanded(!notesExpanded)}
            tone={noteTone}
            actions={
              <>
              {resolvedMode === "notes" && (
                importButton
              )}
              <button
                onClick={() => { setNotesExpanded(true); setIsCreatingNote(true); }}
                className="p-1 rounded-md text-[rgb(var(--color-text-secondary))] hover:text-[rgb(var(--color-accent))] hover:bg-[rgb(var(--color-accent))]/10 transition-colors"
                title="New note"
              >
                <Plus className="w-3.5 h-3.5" />
              </button>
              </>
            }
          />

          {notesExpanded && isCreatingNote && (
            <div className="px-3 py-2 border-b border-[rgb(var(--color-border))]">
              <input
                type="text"
                value={newNoteTitle}
                onChange={(e) => setNewNoteTitle(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === "Enter") handleCreateNote();
                  if (e.key === "Escape") { setIsCreatingNote(false); setNewNoteTitle(""); }
                }}
                placeholder="Note name..."
                autoFocus
                className="w-full px-2 py-1.5 rounded-md bg-[rgb(var(--color-surface))] border border-[rgb(var(--color-border))] text-xs text-[rgb(var(--color-text))] placeholder:text-[rgb(var(--color-text-secondary))]/50 focus:outline-none focus:ring-1 focus:ring-[rgb(var(--color-accent))]/40"
              />
            </div>
          )}

          {notesExpanded && <div className={sectionBodyClass} style={notesBodyStyle}>
            {orderedNotes.length === 0 && !isCreatingNote ? (
              <div className="flex flex-col items-center justify-center py-8 px-4 text-center">
                <p className="text-xs text-[rgb(var(--color-text-secondary))] mb-3 leading-relaxed">
                  Import a document or create a new note
                </p>
                <div className="flex gap-2">
                  <button
                    onClick={() => { setNotesExpanded(true); setIsCreatingNote(true); }}
                    className="px-3 py-1.5 text-[11px] rounded-lg border border-[rgb(var(--color-border))] text-[rgb(var(--color-text-secondary))] hover:text-[rgb(var(--color-text))] hover:border-[rgb(var(--color-accent))] transition-colors"
                  >
                    + New note
                  </button>
                  <button
                    onClick={handleOpenImportMenu}
                    className="inline-flex items-center gap-1.5 rounded-lg border border-[rgb(var(--color-border))] px-3 py-1.5 text-[11px] text-[rgb(var(--color-text-secondary))] transition-colors hover:border-[rgb(var(--color-accent))] hover:text-[rgb(var(--color-text))]"
                    aria-haspopup="menu"
                    aria-expanded={importMenu !== null}
                  >
                    <FileInput className="w-3 h-3" />
                    <span>Import</span>
                    <ChevronDown className="w-3 h-3 opacity-70" />
                  </button>
                </div>
              </div>
            ) : (
              <DndContext sensors={sensors} collisionDetection={closestCenter} onDragEnd={handleDragEnd("notes")}>
                <SortableContext items={orderedNotes.map((n) => n.path)} strategy={verticalListSortingStrategy}>
                  {orderedNotes.map((note) => (
                    <SortableSidebarItem key={note.path} id={note.path}>
                      <div
                        role="button"
                        tabIndex={0}
                        onClick={() => { if (!renamingItem) openNote(note.path); }}
                        onDoubleClick={(e) => { e.stopPropagation(); startRename("note", note.path); }}
                        onContextMenu={(e) => {
                          const items = buildContextMenuItems("note", note.path, note.title);
                          if (items.length > 0) { e.preventDefault(); setContextMenu({ type: "note", path: note.path, title: note.title, x: e.clientX, y: e.clientY }); }
                        }}
                        onKeyDown={(e) => {
                          if (e.key === "F2") { e.preventDefault(); startRename("note", note.path); }
                          else if (e.key === "Enter" || e.key === " ") { if (!renamingItem) openNote(note.path); }
                        }}
                        className={documentItemClass(note.path === activeNotePath, noteTone)}
                      >
                        <ActiveDocumentMarker active={note.path === activeNotePath} tone={noteTone} />
                        <NoteIcon className={`shrink-0 opacity-90 ${noteTone.text}`} />
                        <div className="min-w-0 flex-1">
                          {renamingItem?.path === note.path ? (
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
                              className="w-full px-1 py-0.5 text-xs font-medium bg-[rgb(var(--color-surface))] border border-[rgb(var(--color-accent))]/40 rounded focus:outline-none focus:ring-1 focus:ring-[rgb(var(--color-accent))]/40 text-[rgb(var(--color-text))]"
                            />
                          ) : (
                            <DocumentItemText title={note.title} meta={note.path} active={note.path === activeNotePath} tone={noteTone} />
                          )}
                        </div>
                        {renamingItem?.path !== note.path && (
                          <button
                            onClick={(e) => {
                              e.stopPropagation();
                              requestDelete("note", note.path, note.title);
                            }}
                            className="shrink-0 rounded p-0.5 text-[rgb(var(--color-text-secondary))] opacity-0 transition-all hover:text-[rgb(var(--color-text))] focus-visible:opacity-100 group-hover/item:opacity-100"
                            title="Delete note"
                          >
                            <Trash2 className="w-3 h-3" />
                          </button>
                        )}
                      </div>
                    </SortableSidebarItem>
                  ))}
                </SortableContext>
              </DndContext>
            )}
          </div>}
        </>
      )}

      {/* Delete confirmation overlay */}
      {pendingDelete && (
        <div className="cr-modal-backdrop fixed inset-0 z-modal flex items-center justify-center">
          <div className="cr-modal-surface rounded-xl p-5 max-w-sm mx-4">
            <p className="text-sm text-[rgb(var(--color-text))] mb-1 font-medium">Delete {pendingDelete.type}?</p>
            <p className="text-xs text-[rgb(var(--color-text-secondary))] mb-2">
              "{pendingDelete.title}" will be permanently deleted.
            </p>
            {pendingDelete.usedBy && pendingDelete.usedBy.length > 0 && (
              <div className="mb-3 px-3 py-2 rounded-lg bg-warning/10 border border-warning/30">
                <p className="text-xs text-warning font-medium mb-1">⚠ Used in {pendingDelete.usedBy.length === 1 ? "a storyboard" : `${pendingDelete.usedBy.length} storyboards`}:</p>
                <ul className="text-[11px] text-amber-300/80 list-disc list-inside">
                  {pendingDelete.usedBy.map((t) => <li key={t}>{t}</li>)}
                </ul>
                <p className="text-[11px] text-amber-300/80 mt-1">Deleting will leave broken references.</p>
              </div>
            )}
            <div className="flex gap-2 justify-end">
              <button
                onClick={() => setPendingDelete(null)}
                className="px-3 py-1.5 text-xs rounded-lg border border-[rgb(var(--color-border))] text-[rgb(var(--color-text-secondary))] hover:text-[rgb(var(--color-text))] transition-colors"
              >
                Cancel
              </button>
              <button
                onClick={() => {
                  const { type, path } = pendingDelete;
                  setPendingDelete(null);
                  if (type === "sketch") deleteSketch(path);
                  else if (type === "storyboard") deleteStoryboard(path);
                  else deleteNote(path);
                }}
                className="px-3 py-1.5 text-xs rounded-lg bg-error text-accent-fg hover:bg-error/80 transition-colors"
              >
                Delete
              </button>
            </div>
          </div>
        </div>
      )}

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
      <VideoImportProgressDialog
        progress={videoImportProgress}
        onClose={() => setVideoImportProgress(null)}
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

      {/* Transfer warning: moving a sketch used by storyboards */}
      {transferWarning && (
        <div className="cr-modal-backdrop fixed inset-0 z-modal flex items-center justify-center">
          <div className="cr-modal-surface rounded-xl p-5 max-w-sm mx-4">
            <p className="text-sm text-[rgb(var(--color-text))] mb-2 font-medium">
              Move "{transferWarning.sourceTitle}"?
            </p>
            <div className="mb-3 px-3 py-2 rounded-lg bg-warning/10 border border-warning/30">
              <p className="text-xs text-warning font-medium mb-1">
                ⚠ Used in {transferWarning.usedBy.length === 1 ? "a storyboard" : `${transferWarning.usedBy.length} storyboards`}:
              </p>
              <ul className="text-[11px] text-amber-300/80 list-disc list-inside">
                {transferWarning.usedBy.map((t) => <li key={t}>{t}</li>)}
              </ul>
              <p className="text-[11px] text-amber-300/80 mt-1">Moving will leave broken references in this project.</p>
            </div>
            <div className="flex gap-2 justify-end">
              <button
                onClick={() => setTransferWarning(null)}
                className="px-3 py-1.5 text-xs rounded-lg border border-[rgb(var(--color-border))] text-[rgb(var(--color-text-secondary))] hover:text-[rgb(var(--color-text))] transition-colors"
              >
                Cancel
              </button>
              <button
                onClick={() => {
                  const { action, type, sourcePath, sourceTitle, destProject } = transferWarning;
                  setTransferWarning(null);
                  doTransfer(action, type, sourcePath, sourceTitle, destProject, sourcePath);
                }}
                className="px-3 py-1.5 text-xs rounded-lg bg-warning text-[rgb(var(--color-accent-fg))] hover:bg-warning/80 transition-colors"
              >
                Move anyway
              </button>
            </div>
          </div>
        </div>
      )}

      {/* Transfer conflict: file already exists at destination */}
      {transferConflict && (
        <div className="cr-modal-backdrop fixed inset-0 z-modal flex items-center justify-center">
          <div className="cr-modal-surface rounded-xl p-5 max-w-sm mx-4">
            <p className="text-sm text-[rgb(var(--color-text))] mb-1 font-medium">File already exists</p>
            <p className="text-xs text-[rgb(var(--color-text-secondary))] mb-3">
              A file with this name already exists in "{transferConflict.destProject.name}". Enter a new name:
            </p>
            <input
              ref={conflictInputRef}
              value={conflictName}
              onChange={(e) => setConflictName(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === "Enter") {
                  const stem = conflictName.trim();
                  if (!stem) return;
                  const { action, type, sourcePath, sourceTitle, destProject, ext } = transferConflict;
                  setTransferConflict(null);
                  const dir = sourcePath.includes("/") ? sourcePath.substring(0, sourcePath.lastIndexOf("/") + 1) : "";
                  doTransfer(action, type, sourcePath, sourceTitle, destProject, `${dir}${stem}${ext}`);
                }
                if (e.key === "Escape") setTransferConflict(null);
              }}
              placeholder="new-name"
              className="w-full px-3 py-2 text-xs rounded-lg bg-[rgb(var(--color-surface-alt))] border border-[rgb(var(--color-border))] text-[rgb(var(--color-text))] focus:outline-none focus:ring-1 focus:ring-[rgb(var(--color-accent))]/40 mb-3"
            />
            <div className="flex gap-2 justify-end">
              <button
                onClick={() => setTransferConflict(null)}
                className="px-3 py-1.5 text-xs rounded-lg border border-[rgb(var(--color-border))] text-[rgb(var(--color-text-secondary))] hover:text-[rgb(var(--color-text))] transition-colors"
              >
                Cancel
              </button>
              <button
                onClick={() => {
                  const stem = conflictName.trim();
                  if (!stem) return;
                  const { action, type, sourcePath, sourceTitle, destProject, ext } = transferConflict;
                  setTransferConflict(null);
                  const dir = sourcePath.includes("/") ? sourcePath.substring(0, sourcePath.lastIndexOf("/") + 1) : "";
                  doTransfer(action, type, sourcePath, sourceTitle, destProject, `${dir}${stem}${ext}`);
                }}
                className="px-3 py-1.5 text-xs rounded-lg bg-[rgb(var(--color-accent))] text-[rgb(var(--color-accent-fg))] hover:bg-[rgb(var(--color-accent-hover))] transition-colors"
              >
                {transferConflict.action === "move" ? "Move As" : "Copy As"}
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
