import { useCallback, useEffect, useRef, useState } from "react";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";
import { useAppStore } from "../stores/appStore";
import { useSettings } from "../hooks/useSettings";
import { MarkdownEditor } from "./MarkdownEditor";
import { invoke, convertFileSrc } from "@tauri-apps/api/core";

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
  const updateNote = useAppStore((s) => s.updateNote);
  const projectRoot = useAppStore((s) => s.currentProject?.root);
  const addActivityEntries = useAppStore((s) => s.addActivityEntries);
  const { settings, updateSetting } = useSettings();
  const [mode, setMode] = useState<"edit" | "preview">("edit");
  const [aiCleaning, setAiCleaning] = useState(false);

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
      pendingContentRef.current = value;
      if (saveTimeoutRef.current) clearTimeout(saveTimeoutRef.current);
      saveTimeoutRef.current = setTimeout(() => {
        pendingContentRef.current = null;
        updateNoteRef.current(value);
      }, 800);
    },
    [],
  );

  // Reset to edit mode when switching notes
  useEffect(() => {
    setMode("edit");
  }, [activeNotePath]);

  // Flush on unmount
  useEffect(() => {
    return () => {
      if (saveTimeoutRef.current) {
        clearTimeout(saveTimeoutRef.current);
        if (pendingContentRef.current !== null) {
          updateNoteRef.current(pendingContentRef.current);
        }
      }
    };
  }, []);

  // AI cleanup — send note content to model for formatting improvements
  const handleAiCleanup = useCallback(async () => {
    if (!activeNoteContent || aiCleaning) return;
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
      const result = await invoke<{ role: string; content: string | null }>("agent_chat", {
        config,
        messages: [
          { role: "system", content: AI_NOTE_CLEANUP_PROMPT },
          { role: "user", content: activeNoteContent },
        ],
      });
      if (result.content && result.content.trim().length > 0) {
        let cleaned = result.content.trim();
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
  }, [activeNoteContent, aiCleaning, getAiConfig, updateNote, addActivityEntries]);

  if (!activeNotePath) return null;

  const displayTitle = activeNotePath.replace(/\.md$/, "").split("/").pop() ?? activeNotePath;

  return (
    <div className="flex flex-col flex-1 overflow-hidden">
      {/* Title bar */}
      <div className="flex items-center gap-2 px-6 py-3 border-b border-[var(--color-border)] shrink-0">
        <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" className="text-[var(--color-text-secondary)] shrink-0">
          <path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z" />
          <polyline points="14 2 14 8 20 8" />
          <line x1="16" y1="13" x2="8" y2="13" />
          <line x1="16" y1="17" x2="8" y2="17" />
        </svg>
        <h1 className="text-lg font-semibold text-[var(--color-text)]">{displayTitle}</h1>
        <span className="text-[10px] text-[var(--color-text-secondary)] px-1.5 py-0.5 rounded bg-[var(--color-surface-alt)]">.md</span>

        <div className="ml-auto flex items-center gap-1">
          {/* AI cleanup sparkle button */}
          <button
            onClick={handleAiCleanup}
            disabled={aiCleaning || !settings.aiModel || !activeNoteContent}
            className="flex items-center justify-center w-7 h-7 rounded-md text-[var(--color-text-secondary)] hover:text-[var(--color-accent)] hover:bg-[var(--color-accent)]/10 transition-colors disabled:opacity-30 disabled:cursor-not-allowed"
            title="Clean up with AI"
          >
            {aiCleaning ? (
              <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" className="animate-spin">
                <path d="M21 12a9 9 0 1 1-6.219-8.56" />
              </svg>
            ) : (
              <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round">
                <path d="M12 3l1.5 4.5L18 9l-4.5 1.5L12 15l-1.5-4.5L6 9l4.5-1.5L12 3z" />
                <path d="M19 14l.9 2.7 2.7.9-2.7.9-.9 2.7-.9-2.7L15.4 17.6l2.7-.9.9-2.7z" />
              </svg>
            )}
          </button>

          <div className="w-px h-4 bg-[var(--color-border)] mx-0.5" />

          {/* Edit / Preview toggle */}
          <div className="flex items-center gap-0.5 bg-[var(--color-surface-alt)] rounded-lg p-0.5">
            <button
              onClick={() => setMode("edit")}
              className={`flex items-center justify-center w-7 h-7 rounded-md transition-colors ${
                mode === "edit"
                  ? "bg-[var(--color-surface)] text-[var(--color-text)] shadow-sm"
                  : "text-[var(--color-text-secondary)] hover:text-[var(--color-text)]"
              }`}
              title="Edit"
            >
              {/* Pencil icon */}
              <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round">
                <path d="M12 20h9" />
                <path d="M16.5 3.5a2.121 2.121 0 0 1 3 3L7 19l-4 1 1-4L16.5 3.5z" />
              </svg>
            </button>
            <button
              onClick={() => setMode("preview")}
              className={`flex items-center justify-center w-7 h-7 rounded-md transition-colors ${
                mode === "preview"
                  ? "bg-[var(--color-surface)] text-[var(--color-text)] shadow-sm"
                  : "text-[var(--color-text-secondary)] hover:text-[var(--color-text)]"
              }`}
              title="Preview"
            >
              {/* Eye icon */}
              <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round">
                <path d="M1 12s4-8 11-8 11 8 11 8-4 8-11 8-11-8-11-8z" />
                <circle cx="12" cy="12" r="3" />
              </svg>
            </button>
          </div>
        </div>
      </div>

      {/* Content */}
      {mode === "edit" ? (
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
            <div className="prose-desc text-sm text-[var(--color-text)] leading-relaxed">
            {activeNoteContent ? (
              <ReactMarkdown
                remarkPlugins={[remarkGfm]}
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
              </ReactMarkdown>
            ) : (
              <p className="text-[var(--color-text-secondary)] italic">Nothing to preview</p>
            )}
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
