import { useCallback, useEffect, useRef, useState } from "react";
import { Sparkles } from "lucide-react";
import { SafeMarkdown } from "./SafeMarkdown";
import { makeMainTabId, makeSplitTabId, shouldSuppressEditorFlush, useAppStore } from "../stores/appStore";
import { useToastStore } from "../stores/toastStore";
import { useSettings } from "../hooks/useSettings";
import { MarkdownEditor } from "./MarkdownEditor";
import { invoke } from "../services/tauri";
import { exportNoteToWord } from "../utils/exportToWord";
import { agentChat } from "../services/agentChat";
import { loadProviderSecrets } from "../hooks/useSecretStore";
import { activeProviderInput, buildProviderConfig, defaultProvider, isProviderInputConfigured, providerToConfigInput } from "../utils/providerConfig";
import { ProjectImage } from "./ProjectImage";
import { projectRelativeScreenshotPath } from "../utils/projectImage";
import { DocumentHeader } from "./DocumentHeader";
import { DocumentToolbar, documentToolbarIcons, type DocumentToolbarAction } from "./DocumentToolbar";
import { NoteIcon } from "./Icons";
import { LockedDocumentBanner } from "./LockedDocumentBanner";

const AI_NOTE_CLEANUP_PROMPT = `You are a document editor. Clean up and improve the following Markdown note.

Rules:
1. Preserve ALL content — do not add, remove, or rephrase anything
2. Fix formatting: proper headings, lists, tables, bold, italic
3. Ensure consistent heading hierarchy
4. Clean up spacing and structure for readability
5. Preserve all image references exactly as they appear
6. Remove garbled formatting artifacts
7. Return ONLY the cleaned Markdown — no explanations or code fences`;

function noteTitleFromPath(path: string | null) {
  return path?.replace(/\.md$/, "").split("/").pop() ?? "";
}

function slugifyNoteTitle(title: string) {
  return title.trim().toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "");
}

/**
 * NoteEditor — edits .md note files using the reusable MarkdownEditor.
 * Debounced auto-save on content changes.
 */
export function NoteEditor() {
  const activeNotePath = useAppStore((s) => s.activeNotePath);
  const activeNoteContent = useAppStore((s) => s.activeNoteContent);
  const activeNoteLocked = useAppStore((s) => s.activeNoteLocked);
  const updateNote = useAppStore((s) => s.updateNote);
  const openNote = useAppStore((s) => s.openNote);
  const setNoteLocked = useAppStore((s) => s.setNoteLocked);
  const loadNotes = useAppStore((s) => s.loadNotes);
  const projectRoot = useAppStore((s) => s.currentProject?.root);
  const addActivityEntries = useAppStore((s) => s.addActivityEntries);
  const setNotePreview = useAppStore((s) => s.setNotePreview);
  const showToast = useToastStore((s) => s.show);
  const noteTitle = noteTitleFromPath(activeNotePath);
  const [draftTitle, setDraftTitle] = useState(noteTitle);
  const cancelTitleCommitRef = useRef(false);
  // Read initial mode from persisted store, but keep it as local state so
  // multiple instances of NoteEditor (split pane) can be controlled independently.
  const persistedIsPreview = useAppStore((s) => activeNotePath ? s.notePreviewPaths.has(activeNotePath) : false);
  const [mode, setModeLocal] = useState<"edit" | "preview">(persistedIsPreview ? "preview" : "edit");

  // Re-initialise mode when switching to a different note tab.
  useEffect(() => {
    setModeLocal(persistedIsPreview ? "preview" : "edit");
    setDraftTitle(noteTitleFromPath(activeNotePath));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [activeNotePath]);

  const setMode = useCallback((m: "edit" | "preview") => {
    setModeLocal(m);
    if (activeNotePath) setNotePreview(activeNotePath, m === "preview");
  }, [activeNotePath, setNotePreview]);
  const { settings, updateSetting } = useSettings();
  const [aiCleaning, setAiCleaning] = useState(false);
  const [aiUpdatedFlash, setAiUpdatedFlash] = useState(false);
  const [richPasteBusy, setRichPasteBusy] = useState(false);
  const [exporting, setExporting] = useState(false);

  // Listen for AI note updates and refresh the visible editor unless local edits are pending.
  useEffect(() => {
    const handler = (event: Event) => {
      const updatedPath = (event as CustomEvent<{ path?: string | null }>).detail?.path;
      if (updatedPath && updatedPath !== activeNotePath) return;
      setAiUpdatedFlash(true);
      setTimeout(() => setAiUpdatedFlash(false), 3000);
      if (!activeNotePath) return;
      if (pendingContentRef.current !== null) {
        addActivityEntries([{
          id: `note-refresh-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`,
          timestamp: new Date(),
          source: "note",
          content: "AI updated this note, but local unsaved edits were preserved. Reopen the note after saving to refresh.",
          level: "warn",
        }]);
        return;
      }
      openNote(activeNotePath);
    };
    window.addEventListener("cutready:ai-note-updated", handler);
    return () => window.removeEventListener("cutready:ai-note-updated", handler);
  }, [activeNotePath, addActivityEntries, openNote]);

  // Listen for rich paste busy state
  useEffect(() => {
    const handler = (e: Event) => {
      setRichPasteBusy((e as CustomEvent).detail === true);
    };
    window.addEventListener("cutready:rich-paste-busy", handler);
    return () => window.removeEventListener("cutready:rich-paste-busy", handler);
  }, []);

  // Async getter for AI config — refreshes OAuth token on demand
  const getAiConfig = useCallback(async () => {
    const selectedProvider = defaultProvider(settings);
    const providerInput = selectedProvider
      ? providerToConfigInput(selectedProvider, settings, selectedProvider.id === settings.aiActiveProviderId
        ? { apiKey: settings.aiApiKey, accessToken: settings.aiAccessToken }
        : await loadProviderSecrets(selectedProvider.id))
      : activeProviderInput(settings);
    if (!isProviderInputConfigured(providerInput)) return undefined;

    let bearerToken = settings.aiAuthMode === "azure_oauth" ? settings.aiAccessToken : null;

    // Auto-refresh OAuth token if we have a refresh token
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
          bearerToken = tokenResult.access_token;
          await updateSetting("aiAccessToken", tokenResult.access_token);
          if (tokenResult.refresh_token) {
            await updateSetting("aiRefreshToken", tokenResult.refresh_token);
          }
        }
      } catch {
        // Token refresh failed — use existing token (may be stale)
      }
    }

    const config = buildProviderConfig(providerInput);
    if (bearerToken) config.bearer_token = bearerToken;
    return config;
  }, [settings, updateSetting]);

  const saveTimeoutRef= useRef<ReturnType<typeof setTimeout> | null>(null);
  const pendingContentRef = useRef<string | null>(null);
  const updateNoteRef = useRef(updateNote);
  updateNoteRef.current = updateNote;

  const handleChange = useCallback(
    (value: string) => {
      if (activeNoteLocked) return;
      pendingContentRef.current = value;
      if (saveTimeoutRef.current) clearTimeout(saveTimeoutRef.current);
      saveTimeoutRef.current = setTimeout(() => {
        pendingContentRef.current = null;
        if (shouldSuppressEditorFlush(activeNotePath)) return;
        updateNoteRef.current(value);
      }, 800);
    },
    [activeNoteLocked, activeNotePath],
  );

  // Flush on unmount
  useEffect(() => {
    return () => {
      if (saveTimeoutRef.current) {
        clearTimeout(saveTimeoutRef.current);
        if (pendingContentRef.current !== null && !shouldSuppressEditorFlush(activeNotePath)) {
          updateNoteRef.current(pendingContentRef.current);
        }
      }
    };
  }, []);

  const commitNoteRename = useCallback(async () => {
    if (cancelTitleCommitRef.current) {
      cancelTitleCommitRef.current = false;
      return;
    }
    if (!activeNotePath || activeNoteLocked) {
      setDraftTitle(noteTitleFromPath(activeNotePath));
      return;
    }

    const slug = slugifyNoteTitle(draftTitle);
    if (!slug) {
      setDraftTitle(noteTitleFromPath(activeNotePath));
      return;
    }

    const dir = activeNotePath.includes("/") ? activeNotePath.substring(0, activeNotePath.lastIndexOf("/") + 1) : "";
    const newPath = `${dir}${slug}.md`;
    if (newPath === activeNotePath) {
      setDraftTitle(noteTitleFromPath(activeNotePath));
      return;
    }

    if (saveTimeoutRef.current) {
      clearTimeout(saveTimeoutRef.current);
      saveTimeoutRef.current = null;
    }
    if (pendingContentRef.current !== null && !shouldSuppressEditorFlush(activeNotePath)) {
      await updateNoteRef.current(pendingContentRef.current);
      pendingContentRef.current = null;
    }

    try {
      await invoke("rename_note", { oldPath: activeNotePath, newPath });
      const oldMainId = makeMainTabId("note", activeNotePath);
      const newMainId = makeMainTabId("note", newPath);
      const oldSplitId = makeSplitTabId("note", activeNotePath);
      const newSplitId = makeSplitTabId("note", newPath);
      const nextTitle = noteTitleFromPath(newPath);
      const store = useAppStore.getState();

      useAppStore.setState({
        activeNotePath: newPath,
        openTabs: store.openTabs.map((tab) =>
          tab.type === "note" && tab.path === activeNotePath
            ? { ...tab, id: newMainId, path: newPath, title: nextTitle }
            : tab,
        ),
        activeTabId: store.activeTabId === oldMainId ? newMainId : store.activeTabId,
        splitTabs: store.splitTabs.map((tab) =>
          tab.type === "note" && tab.path === activeNotePath
            ? { ...tab, id: newSplitId, path: newPath, title: nextTitle }
            : tab,
        ),
        splitActiveTabId: store.splitActiveTabId === oldSplitId ? newSplitId : store.splitActiveTabId,
      });
      setNotePreview(activeNotePath, false);
      setNotePreview(newPath, mode === "preview");
      setDraftTitle(nextTitle);
      await loadNotes();
      useAppStore.getState()._persistTabs();
    } catch (err) {
      setDraftTitle(noteTitleFromPath(activeNotePath));
      showToast(`Rename failed: ${err}`, 4000, "error");
    }
  }, [activeNoteLocked, activeNotePath, draftTitle, loadNotes, mode, setNotePreview, showToast]);

  // AI cleanup — send note content to model for formatting improvements
  const handleAiCleanup = useCallback(async () => {
    if (!activeNoteContent || aiCleaning || activeNoteLocked) return;
    const config = await getAiConfig();
    if (!config) return;

    setAiCleaning(true);
    const logEntry = (msg: string, level: "info" | "warn" | "success") =>
      addActivityEntries([{
        id: `ai-clean-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`,
        timestamp: new Date(),
        source: "AI Cleanup",
        content: msg,
        level,
      }]);

    logEntry("Cleaning up note with AI…", "info");
    try {
      let cleaned: string | null = null;

      const result = await agentChat(
        config,
        [
          { role: "system", content: AI_NOTE_CLEANUP_PROMPT },
          { role: "user", content: activeNoteContent },
        ],
      );
      if (result.content && result.content.trim().length > 0) cleaned = result.content.trim();

      if (cleaned) {
        // Strip code fence wrapper
        if (cleaned.startsWith("```markdown")) cleaned = cleaned.slice("```markdown".length);
        else if (cleaned.startsWith("```md")) cleaned = cleaned.slice("```md".length);
        else if (cleaned.startsWith("```")) cleaned = cleaned.slice(3);
        if (cleaned.endsWith("```")) cleaned = cleaned.slice(0, -3);
        cleaned = cleaned.trim();
        updateNote(cleaned);
        logEntry("Note cleaned up ✓", "success");
      }
    } catch (e) {
      logEntry(`AI cleanup failed: ${e}`, "warn");
    } finally {
      setAiCleaning(false);
    }
  }, [activeNoteContent, aiCleaning, activeNoteLocked, getAiConfig, updateNote, addActivityEntries]);

  if (!activeNotePath) return null;

  const contentWidthStyle = { maxWidth: "var(--editor-max-width, 56rem)" };

  // Export note to Word
  const handleExportToWord = async (orientation: "portrait" | "landscape") => {
    if (!activeNoteContent || exporting) return;
    setExporting(true);
    try {
      await exportNoteToWord(draftTitle || noteTitleFromPath(activeNotePath), activeNoteContent, projectRoot ?? "", orientation);
    } catch (e) {
      console.error("[NoteEditor] Export to Word failed:", e);
    } finally {
      setExporting(false);
    }
  };
  const modeActions: DocumentToolbarAction[] = [
    {
      id: "edit",
      label: "Edit",
      icon: documentToolbarIcons.pencil,
      selected: mode === "edit",
      disabled: activeNoteLocked,
      title: activeNoteLocked ? "Unlock note to edit" : "Edit",
      onSelect: () => setMode("edit"),
    },
    {
      id: "preview",
      label: "Preview",
      icon: documentToolbarIcons.eye,
      selected: mode === "preview",
      onSelect: () => setMode("preview"),
    },
  ];
  const aiActions: DocumentToolbarAction[] = [
    {
      id: "cleanup-note",
      label: aiCleaning ? "Cleaning..." : "Clean up note",
      icon: documentToolbarIcons.sparkles,
      disabled: aiCleaning || activeNoteLocked || !settings.aiModel || !activeNoteContent,
      title: "Clean up with AI",
      onSelect: handleAiCleanup,
    },
  ];
  const exportActions: DocumentToolbarAction[] = [
    {
      id: "word-portrait",
      label: "Word - Portrait",
      icon: documentToolbarIcons.fileText,
      disabled: exporting || !activeNoteContent,
      onSelect: () => handleExportToWord("portrait"),
    },
    {
      id: "word-landscape",
      label: "Word - Landscape",
      icon: documentToolbarIcons.fileText,
      disabled: exporting || !activeNoteContent,
      onSelect: () => handleExportToWord("landscape"),
    },
  ];

  return (
    <div className="flex-1 overflow-y-auto">
      <div className="mx-auto px-6 py-8" style={contentWidthStyle}>
        <DocumentHeader
          icon={<NoteIcon size={20} />}
          title={
            <input
              type="text"
              value={draftTitle}
              onChange={(event) => setDraftTitle(event.target.value)}
              onBlur={() => void commitNoteRename()}
              onKeyDown={(event) => {
                if (event.key === "Enter") event.currentTarget.blur();
                if (event.key === "Escape") {
                  cancelTitleCommitRef.current = true;
                  setDraftTitle(noteTitleFromPath(activeNotePath));
                  event.currentTarget.blur();
                }
              }}
              readOnly={activeNoteLocked}
              title={draftTitle}
              className={`min-w-0 w-full truncate border-none bg-transparent text-2xl font-semibold text-[rgb(var(--color-text))] outline-none placeholder:text-[rgb(var(--color-text-secondary))]/40 ${activeNoteLocked ? "cursor-default" : ""}`}
              placeholder="Note title..."
            />
          }
          badge={<span className="rounded bg-[rgb(var(--color-surface-alt))] px-1.5 py-0.5 text-[10px] text-[rgb(var(--color-text-secondary))]">.md</span>}
          toolbar={
            <DocumentToolbar
              canRecord={false}
              onRecord={() => {}}
              showRecord={false}
              presentActions={[]}
              modeActions={modeActions}
              aiActions={aiActions}
              exportActions={exportActions}
              locked={activeNoteLocked}
              onToggleLock={() => setNoteLocked(activeNotePath, !activeNoteLocked)}
              lockLabel="Lock note"
              unlockLabel="Unlock note"
            />
          }
        />

        {/* AI updated indicator */}
        {aiUpdatedFlash && (
          <div className="mb-2 flex items-center gap-2 px-3 py-1.5 rounded-lg bg-[rgb(var(--color-accent))]/10 border border-[rgb(var(--color-accent))]/20 text-xs text-[rgb(var(--color-accent))] animate-pulse">
            <Sparkles className="w-3 h-3" />
            Updated by AI
          </div>
        )}

        {/* Rich paste busy indicator */}
        {richPasteBusy && (
          <div className="mb-2 flex items-center gap-2 px-3 py-1.5 rounded-lg bg-warning/10 border border-warning/20 text-xs text-warning">
            <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" className="animate-spin">
              <circle cx="12" cy="12" r="10" strokeDasharray="31.4 31.4" strokeLinecap="round" />
            </svg>
            Converting pasted content…
          </div>
        )}

        {activeNoteLocked && (
          <LockedDocumentBanner message="Note is locked. Unlock it to edit, rename, or use AI cleanup." />
        )}

        {/* Content */}
        {mode === "edit" && !activeNoteLocked ? (
          <MarkdownEditor
            editorKey={activeNotePath}
            value={activeNoteContent ?? ""}
            onChange={handleChange}
            placeholder="Write your notes here..."
            getAiConfig={getAiConfig}
          />
        ) : (
          <div className="py-6">
            <div className="prose-desc text-sm text-[rgb(var(--color-text))] leading-relaxed">
              {activeNoteContent ? (
                <SafeMarkdown
                  components={{
                    img: ({ src, alt, ...props }) => {
                      let resolvedSrc = src ?? "";
                      const relativePath = projectRelativeScreenshotPath(resolvedSrc);
                      if (projectRoot && relativePath) {
                        return <ProjectImage relativePath={relativePath} projectRoot={projectRoot} alt={alt ?? ""} {...props} className="max-w-full rounded" />;
                      }
                      return <img src={resolvedSrc} alt={alt ?? ""} {...props} className="max-w-full rounded" />;
                    },
                  }}
                >
                  {activeNoteContent}
                </SafeMarkdown>
              ) : (
                <p className="text-[rgb(var(--color-text-secondary))] italic">Nothing to preview</p>
              )}
            </div>
          </div>
        )}
      </div>
    </div>
  );
}
