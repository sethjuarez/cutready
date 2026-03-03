import { useCallback, useEffect, useRef, useState } from "react";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";
import { useAppStore } from "../stores/appStore";
import { useSettings } from "../hooks/useSettings";
import { MarkdownEditor } from "./MarkdownEditor";
import { invoke } from "@tauri-apps/api/core";

/**
 * NoteEditor — edits .md note files using the reusable MarkdownEditor.
 * Debounced auto-save on content changes.
 */
export function NoteEditor() {
  const activeNotePath = useAppStore((s) => s.activeNotePath);
  const activeNoteContent = useAppStore((s) => s.activeNoteContent);
  const updateNote = useAppStore((s) => s.updateNote);
  const { settings, updateSetting } = useSettings();
  const [mode, setMode] = useState<"edit" | "preview">("edit");

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

        <div className="ml-auto flex items-center gap-0.5 bg-[var(--color-surface-alt)] rounded-lg p-0.5">
          <button
            onClick={() => setMode("edit")}
            className={`px-2.5 py-1 rounded-md text-[11px] font-medium transition-colors ${
              mode === "edit"
                ? "bg-[var(--color-surface)] text-[var(--color-text)] shadow-sm"
                : "text-[var(--color-text-secondary)] hover:text-[var(--color-text)]"
            }`}
          >
            Edit
          </button>
          <button
            onClick={() => setMode("preview")}
            className={`px-2.5 py-1 rounded-md text-[11px] font-medium transition-colors ${
              mode === "preview"
                ? "bg-[var(--color-surface)] text-[var(--color-text)] shadow-sm"
                : "text-[var(--color-text-secondary)] hover:text-[var(--color-text)]"
            }`}
          >
            Preview
          </button>
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
              <ReactMarkdown remarkPlugins={[remarkGfm]}>{activeNoteContent}</ReactMarkdown>
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
