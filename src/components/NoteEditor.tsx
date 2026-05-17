import { useCallback, useEffect, useRef, useState } from "react";
import { FileText, Sparkles, Pencil, Eye, Lock, Unlock } from "lucide-react";
import { SafeMarkdown } from "./SafeMarkdown";
import { shouldSuppressEditorFlush, useAppStore } from "../stores/appStore";
import { useSettings } from "../hooks/useSettings";
import { MarkdownEditor } from "./MarkdownEditor";
import { invoke, convertFileSrc } from "@tauri-apps/api/core";
import { exportNoteToWord } from "../utils/exportToWord";
import { ExportWordButton } from "./ExportWordButton";
import { agentChat } from "../services/agentChat";

const AI_NOTE_CLEANUP_PROMPT = `You are a document editor. Clean up and improve the following Markdown note.

Rules:
1. Preserve ALL content — do not add, remove, or rephrase anything
2. Fix formatting: proper headings, lists, tables, bold, italic
3. Ensure consistent heading hierarchy
4. Clean up spacing and structure for readability
5. Preserve all image references exactly as they appear
6. Remove garbled formatting artifacts
7. Return ONLY the cleaned Markdown — no explanations or code fences`;

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
  const projectRoot = useAppStore((s) => s.currentProject?.root);
  const addActivityEntries = useAppStore((s) => s.addActivityEntries);
  const setNotePreview = useAppStore((s) => s.setNotePreview);
  // Read initial mode from persisted store, but keep it as local state so
  // multiple instances of NoteEditor (split pane) can be controlled independently.
  const persistedIsPreview = useAppStore((s) => activeNotePath ? s.notePreviewPaths.has(activeNotePath) : false);
  const [mode, setModeLocal] = useState<"edit" | "preview">(persistedIsPreview ? "preview" : "edit");

  // Re-initialise mode when switching to a different note tab.
  useEffect(() => {
    setModeLocal(persistedIsPreview ? "preview" : "edit");
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
    if (!settings.aiModel || !settings.aiEndpoint) return undefined;

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

    return {
      provider: settings.aiProvider,
      endpoint: settings.aiEndpoint,
      api_key: settings.aiApiKey,
      model: settings.aiModel,
      bearer_token: bearerToken,
    };
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

  const displayTitle = activeNotePath.replace(/\.md$/, "").split("/").pop() ?? activeNotePath;

  // Export note to Word
  const handleExportToWord = async (orientation: "portrait" | "landscape") => {
    if (!activeNoteContent || exporting) return;
    setExporting(true);
    try {
      await exportNoteToWord(displayTitle, activeNoteContent, projectRoot ?? "", orientation);
    } catch (e) {
      console.error("[NoteEditor] Export to Word failed:", e);
    } finally {
      setExporting(false);
    }
  };

  return (
    <div className="flex flex-col flex-1 overflow-hidden">
      {/* Title bar */}
      <div className="flex items-center gap-2 px-6 py-3 border-b border-[rgb(var(--color-border))] shrink-0">
        <FileText className="w-5 h-5 text-[rgb(var(--color-text-secondary))] shrink-0" />
        <h1 className="text-lg font-semibold text-[rgb(var(--color-text))]">{displayTitle}</h1>
        <span className="text-[10px] text-[rgb(var(--color-text-secondary))] px-1.5 py-0.5 rounded bg-[rgb(var(--color-surface-alt))]">.md</span>

        <div className="ml-auto flex items-center gap-1">
          <button
            onClick={() => setNoteLocked(activeNotePath, !activeNoteLocked)}
            className={`flex items-center justify-center w-7 h-7 rounded-md transition-colors ${
              activeNoteLocked
                ? "text-[rgb(var(--color-warning))] bg-[rgb(var(--color-warning))]/10 hover:bg-[rgb(var(--color-warning))]/15"
                : "text-[rgb(var(--color-text-secondary))] hover:text-[rgb(var(--color-text))] hover:bg-[rgb(var(--color-surface-alt))]"
            }`}
            title={activeNoteLocked ? "Unlock note" : "Lock note"}
          >
            {activeNoteLocked ? <Lock className="w-3.5 h-3.5" /> : <Unlock className="w-3.5 h-3.5" />}
          </button>

          {/* Export to Word */}
          <ExportWordButton
            onExport={handleExportToWord}
            disabled={exporting || !activeNoteContent}
            defaultOrientation="portrait"
            className="flex items-center justify-center w-7 h-7 rounded-md text-[rgb(var(--color-text-secondary))] hover:text-[rgb(var(--color-accent))] hover:bg-[rgb(var(--color-accent))]/10 transition-colors disabled:opacity-30 disabled:cursor-not-allowed"
          />

          {/* AI cleanup sparkle button */}
          <button
            onClick={handleAiCleanup}
            disabled={aiCleaning || activeNoteLocked || !settings.aiModel || !activeNoteContent}
            className="flex items-center justify-center w-7 h-7 rounded-md text-[rgb(var(--color-text-secondary))] hover:text-[rgb(var(--color-accent))] hover:bg-[rgb(var(--color-accent))]/10 transition-colors disabled:opacity-30 disabled:cursor-not-allowed"
            title="Clean up with AI"
          >
            {aiCleaning ? (
              <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" className="animate-spin">
                <path d="M21 12a9 9 0 1 1-6.219-8.56" />
              </svg>
            ) : (
              <Sparkles className="w-3.5 h-3.5" />
            )}
          </button>

          <div className="w-px h-4 bg-[rgb(var(--color-border))] mx-0.5" />

          {/* Edit / Preview toggle */}
          <div className="flex items-center gap-0.5 bg-[rgb(var(--color-surface-alt))] rounded-lg p-0.5">
            <button
              onClick={() => { if (!activeNoteLocked) setMode("edit"); }}
              className={`flex items-center justify-center w-7 h-7 rounded-md transition-colors ${
                mode === "edit"
                  ? "bg-[rgb(var(--color-surface))] text-[rgb(var(--color-text))] shadow-sm"
                  : "text-[rgb(var(--color-text-secondary))] hover:text-[rgb(var(--color-text))]"
              }`}
              title={activeNoteLocked ? "Unlock note to edit" : "Edit"}
            >
              {/* Pencil icon */}
              <Pencil className="w-3.5 h-3.5" />
            </button>
            <button
              onClick={() => setMode("preview")}
              className={`flex items-center justify-center w-7 h-7 rounded-md transition-colors ${
                mode === "preview"
                  ? "bg-[rgb(var(--color-surface))] text-[rgb(var(--color-text))] shadow-sm"
                  : "text-[rgb(var(--color-text-secondary))] hover:text-[rgb(var(--color-text))]"
              }`}
              title="Preview"
            >
              {/* Eye icon */}
              <Eye className="w-3.5 h-3.5" />
            </button>
          </div>
        </div>
      </div>

      {/* AI updated indicator */}
      {aiUpdatedFlash && (
        <div className="mx-6 mb-2 flex items-center gap-2 px-3 py-1.5 rounded-lg bg-[rgb(var(--color-accent))]/10 border border-[rgb(var(--color-accent))]/20 text-xs text-[rgb(var(--color-accent))] animate-pulse">
          <Sparkles className="w-3 h-3" />
          Updated by AI
        </div>
      )}

      {/* Rich paste busy indicator */}
      {richPasteBusy && (
        <div className="mx-6 mb-2 flex items-center gap-2 px-3 py-1.5 rounded-lg bg-warning/10 border border-warning/20 text-xs text-warning">
          <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" className="animate-spin">
            <circle cx="12" cy="12" r="10" strokeDasharray="31.4 31.4" strokeLinecap="round" />
          </svg>
          Converting pasted content…
        </div>
      )}

      {activeNoteLocked && (
        <div className="mx-6 mb-2 flex items-center gap-2 px-3 py-1.5 rounded-lg bg-[rgb(var(--color-warning))]/10 border border-[rgb(var(--color-warning))]/20 text-xs text-[rgb(var(--color-warning))]">
          <Lock className="w-3 h-3" />
          Note is locked. Unlock it to edit or use AI cleanup.
        </div>
      )}

      {/* Content */}
      {mode === "edit" && !activeNoteLocked ? (
        <div className="flex-1 overflow-auto px-6">
          <div className="max-w-3xl mx-auto">
            <MarkdownEditor
              editorKey={activeNotePath}
              value={activeNoteContent ?? ""}
              onChange={handleChange}
              placeholder="Write your notes here..."
              getAiConfig={getAiConfig}
            />
          </div>
        </div>
      ) : (
        <div className="flex-1 overflow-auto px-6">
          <div className="max-w-3xl mx-auto py-6">
            <div className="prose-desc text-sm text-[rgb(var(--color-text))] leading-relaxed">
            {activeNoteContent ? (
              <SafeMarkdown
                components={{
                  img: ({ src, alt, ...props }) => {
                    let resolvedSrc = src ?? "";
                    if (projectRoot && resolvedSrc.includes(".cutready/screenshots/")) {
                      resolvedSrc = convertFileSrc(`${projectRoot}/${resolvedSrc}`);
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
        </div>
      )}
    </div>
  );
}
