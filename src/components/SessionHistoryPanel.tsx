import { useCallback, useEffect, useState } from "react";
import { History, MessageSquare, MoreHorizontal, RefreshCw, Sparkles, Trash2 } from "lucide-react";
import { invoke } from "../services/tauri";
import { useAppStore } from "../stores/appStore";
import { useToastStore } from "../stores/toastStore";
import { getContributorIdentity } from "../services/identity";
import { promoteChatArtifact } from "../contracts/chatPromotion";
import { useConfirmDialog } from "./ConfirmDialog";
import type { ChatMessage } from "../types/sketch";

interface ChatSessionSummary {
  session_id: string;
  title: string;
  preview: string;
  message_count: number;
  source: string;
  source_path: string | null;
  created_at: string;
  updated_at: string;
}

interface ChatSessionPage {
  sessions: ChatSessionSummary[];
  has_more: boolean;
}

interface ChatSessionRecord extends ChatSessionSummary {
  messages: ChatMessage[];
  metadata: Record<string, unknown>;
}

export function sessionSourceLabel(source: string): string {
  return source === "legacy_import" ? "Imported chat" : "Chat";
}

export function sessionSourcePathLabel(sourcePath: string): string {
  return sourcePath.replace(/^\.git\/cutready\/legacy-chats\//, "Archived chats/");
}

export function SessionHistoryPanel({ onOpenChat }: { onOpenChat: () => void }) {
  const restoreChatSession = useAppStore((state) => state.restoreChatSession);
  const newChatSession = useAppStore((state) => state.newChatSession);
  const loadChatArtifacts = useAppStore((state) => state.loadChatArtifacts);
  const openChatArtifact = useAppStore((state) => state.openChatArtifact);
  const refreshChangedFiles = useAppStore((state) => state.refreshChangedFiles);
  const showToast = useToastStore((state) => state.show);
  const { confirm, confirmationDialog } = useConfirmDialog();
  const [sessions, setSessions] = useState<ChatSessionSummary[]>([]);
  const [loading, setLoading] = useState(true);
  const [loadingMore, setLoadingMore] = useState(false);
  const [openingId, setOpeningId] = useState<string | null>(null);
  const [workingId, setWorkingId] = useState<string | null>(null);
  const [hasMore, setHasMore] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async (offset = 0) => {
    if (offset === 0) {
      setLoading(true);
      setError(null);
    } else {
      setLoadingMore(true);
    }
    try {
      const page = await invoke<ChatSessionPage>("list_chat_sessions", { limit: 25, offset });
      setSessions((current) => offset === 0 ? page.sessions : [...current, ...page.sessions]);
      setHasMore(page.has_more);
    } catch (err) {
      setError(String(err));
    } finally {
      setLoading(false);
      setLoadingMore(false);
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  useEffect(() => {
    const refresh = () => void load();
    window.addEventListener("cutready:chat-sessions-updated", refresh);
    return () => window.removeEventListener("cutready:chat-sessions-updated", refresh);
  }, [load]);

  const openSession = useCallback(async (sessionId: string) => {
    setOpeningId(sessionId);
    try {
      const session = await invoke<ChatSessionRecord | null>("get_chat_session", { sessionId });
      if (!session) {
        setError("This conversation is no longer available.");
        return;
      }
      restoreChatSession(session.session_id, session.messages);
      onOpenChat();
    } catch (err) {
      setError(`Could not open conversation: ${String(err)}`);
    } finally {
      setOpeningId(null);
    }
  }, [onOpenChat, restoreChatSession]);

  const removeSession = useCallback(async (sessionId: string) => {
    const session = sessions.find((candidate) => candidate.session_id === sessionId);
    const confirmed = await confirm({
      title: "Delete conversation?",
      message: `"${session?.title || "Untitled conversation"}" will be removed from session history.`,
      confirmLabel: "Delete",
      variant: "error",
    });
    if (!confirmed) return;

    setWorkingId(sessionId);
    try {
      await invoke("delete_chat_session", { sessionId });
      setSessions((current) => current.filter((candidate) => candidate.session_id !== sessionId));
      if (useAppStore.getState().chatSessionPath === sessionId) {
        newChatSession();
      }
      window.dispatchEvent(new CustomEvent("cutready:chat-sessions-updated"));
      showToast("Conversation deleted.", 3000, "success");
    } catch (err) {
      showToast(`Could not delete conversation: ${String(err)}`, 5000, "error");
    } finally {
      setWorkingId(null);
    }
  }, [confirm, newChatSession, sessions, showToast]);

  const promoteSession = useCallback(async (sessionId: string) => {
    setWorkingId(sessionId);
    try {
      const session = await invoke<ChatSessionRecord | null>("get_chat_session", { sessionId });
      if (!session) {
        setError("This conversation is no longer available.");
        return;
      }

      let identity = {
        name: "CutReady User",
        email: null as string | null,
      };
      try {
        identity = await getContributorIdentity();
      } catch (identityError) {
        console.warn("Could not resolve contributor identity for chat promotion:", identityError);
      }

      const promotedAt = new Date().toISOString();
      const title = session.title || "Untitled conversation";
      const slug = title
        .toLowerCase()
        .replace(/[^a-z0-9]+/g, "-")
        .replace(/^-+|-+$/g, "")
        .slice(0, 64) || "chat";
      const stamp = promotedAt.replace(/\D/g, "").slice(0, 14);
      const relativePath = `chat-artifacts/${slug}-${stamp}.cv`;
      const participant = {
        name: identity.name || "CutReady User",
        ...(identity.email ? { email: identity.email } : {}),
      };
      const artifact = promoteChatArtifact(
        {
          session_id: session.session_id,
          created_at: session.created_at,
          messages: session.messages,
        },
        {
          title,
          author: participant,
          promoted_by: participant,
          promoted_at: promotedAt,
        },
      );

      await invoke("update_note", { relativePath, content: `${JSON.stringify(artifact, null, 2)}\n` });
      await invoke("delete_chat_session", { sessionId });
      setSessions((current) => current.filter((candidate) => candidate.session_id !== sessionId));
      if (useAppStore.getState().chatSessionPath === sessionId) {
        newChatSession();
      }
      await loadChatArtifacts();
      await refreshChangedFiles();
      await openChatArtifact(relativePath);
      window.dispatchEvent(new CustomEvent("cutready:chat-sessions-updated"));
      showToast(`Promoted chat to ${relativePath}`, 5000, "success");
    } catch (err) {
      showToast(`Could not promote conversation: ${String(err)}`, 7000, "error");
    } finally {
      setWorkingId(null);
    }
  }, [loadChatArtifacts, newChatSession, openChatArtifact, refreshChangedFiles, showToast]);

  return (
    <div className="flex h-full min-h-0 flex-col bg-[rgb(var(--color-surface))]">
      {confirmationDialog}
      <div className="flex h-[38px] items-center gap-2 border-b border-[rgb(var(--color-border))] px-3">
        <History className="h-3.5 w-3.5 text-[rgb(var(--color-accent))]" />
        <span className="min-w-0 flex-1 truncate text-[11px] font-semibold uppercase tracking-[0.14em] text-[rgb(var(--color-text-secondary))]">
          Session history
        </span>
        <button
          className="flex h-6 w-6 items-center justify-center rounded-md text-[rgb(var(--color-text-secondary))] transition-colors hover:bg-[rgb(var(--color-surface-alt))] hover:text-[rgb(var(--color-text))]"
          onClick={() => void load()}
          title="Refresh session history"
          aria-label="Refresh session history"
        >
          <RefreshCw className={`h-3.5 w-3.5 ${loading ? "animate-spin" : ""}`} />
        </button>
      </div>

      <div className="flex-1 overflow-y-auto py-1">
        {error ? (
          <StateMessage label="Could not load session history" detail={error} />
        ) : loading ? (
          <StateMessage label="Loading conversations..." />
        ) : sessions.length === 0 ? (
          <StateMessage label="No conversations yet" detail="Chat conversations and imported chats appear here." />
        ) : (
          <>
            {sessions.map((session) => (
              <div
                key={session.session_id}
                role="button"
                tabIndex={0}
                className="group flex w-full items-start gap-2 border-l-2 border-transparent px-3 py-2.5 text-left transition-colors hover:border-[rgb(var(--color-accent))] hover:bg-[rgb(var(--color-surface-alt))]"
                onClick={() => {
                  if (openingId === null && workingId === null) void openSession(session.session_id);
                }}
                onKeyDown={(event) => {
                  if (event.key !== "Enter" && event.key !== " ") return;
                  event.preventDefault();
                  if (openingId === null && workingId === null) void openSession(session.session_id);
                }}
                aria-disabled={openingId !== null || workingId !== null}
              >
                <span className="mt-0.5 flex h-5 w-5 shrink-0 items-center justify-center rounded-full bg-[rgb(var(--color-accent))]/10 text-[rgb(var(--color-accent))]">
                  <MessageSquare className="h-3 w-3" />
                </span>
                <span className="min-w-0 flex-1">
                  <span className="flex items-center gap-2">
                    <span className="min-w-0 flex-1 truncate text-[12px] font-medium text-[rgb(var(--color-text))]">
                      {session.title || "Untitled conversation"}
                    </span>
                    <span className="shrink-0 text-[10px] text-[rgb(var(--color-text-secondary))]">
                      {formatSessionDate(session.updated_at)}
                    </span>
                  </span>
                  <span className="mt-1 flex items-center gap-1.5 text-[10px] text-[rgb(var(--color-text-secondary))]">
                    <span>{sessionSourceLabel(session.source)}</span>
                    <span className="opacity-50">·</span>
                    <span>{session.message_count} message{session.message_count === 1 ? "" : "s"}</span>
                  </span>
                  {session.source_path && (
                    <span className="mt-1 block truncate font-mono text-[10px] text-[rgb(var(--color-text-secondary))]" title={sessionSourcePathLabel(session.source_path)}>
                      {sessionSourcePathLabel(session.source_path)}
                    </span>
                  )}
                  <span className="mt-1 block truncate text-[11px] leading-5 text-[rgb(var(--color-text-secondary))]" title={session.preview}>
                    {openingId === session.session_id ? "Opening transcript…" : workingId === session.session_id ? "Working…" : session.preview}
                  </span>
                </span>
                <span className="flex shrink-0 items-center gap-0.5 opacity-0 transition-opacity group-hover:opacity-100 group-focus-within:opacity-100">
                  <span
                    role="button"
                    tabIndex={0}
                    className="flex h-6 w-6 items-center justify-center rounded-md text-[rgb(var(--color-text-secondary))] transition-colors hover:bg-[rgb(var(--color-accent))]/10 hover:text-[rgb(var(--color-accent))]"
                    title="Promote conversation"
                    aria-label={`Promote ${session.title || "conversation"}`}
                    onClick={(event) => {
                      event.stopPropagation();
                      void promoteSession(session.session_id);
                    }}
                    onKeyDown={(event) => {
                      if (event.key !== "Enter" && event.key !== " ") return;
                      event.preventDefault();
                      event.stopPropagation();
                      void promoteSession(session.session_id);
                    }}
                  >
                    <Sparkles className="h-3.5 w-3.5" />
                  </span>
                  <span
                    role="button"
                    tabIndex={0}
                    className="flex h-6 w-6 items-center justify-center rounded-md text-[rgb(var(--color-text-secondary))] transition-colors hover:bg-[rgb(var(--color-error))]/10 hover:text-[rgb(var(--color-error))]"
                    title="Delete conversation"
                    aria-label={`Delete ${session.title || "conversation"}`}
                    onClick={(event) => {
                      event.stopPropagation();
                      void removeSession(session.session_id);
                    }}
                    onKeyDown={(event) => {
                      if (event.key !== "Enter" && event.key !== " ") return;
                      event.preventDefault();
                      event.stopPropagation();
                      void removeSession(session.session_id);
                    }}
                  >
                    <Trash2 className="h-3.5 w-3.5" />
                  </span>
                </span>
              </div>
            ))}
            {hasMore && (
              <button
                className="mx-3 my-2 flex w-[calc(100%-1.5rem)] items-center justify-center gap-1 rounded-lg border border-[rgb(var(--color-border))] px-2 py-2 text-[11px] text-[rgb(var(--color-text-secondary))] transition-colors hover:bg-[rgb(var(--color-surface-alt))] hover:text-[rgb(var(--color-text))] disabled:opacity-50"
                onClick={() => void load(sessions.length)}
                disabled={loadingMore}
              >
                <MoreHorizontal className="h-3.5 w-3.5" />
                {loadingMore ? "Loading…" : "Load more"}
              </button>
            )}
          </>
        )}
      </div>
    </div>
  );
}

function StateMessage({ label, detail }: { label: string; detail?: string }) {
  return (
    <div className="flex h-full min-h-[180px] flex-col items-center justify-center px-6 text-center">
      <MessageSquare className="mb-3 h-5 w-5 text-[rgb(var(--color-text-secondary))]" />
      <p className="text-[12px] font-medium text-[rgb(var(--color-text))]">{label}</p>
      {detail && <p className="mt-1 max-w-xs text-[11px] leading-5 text-[rgb(var(--color-text-secondary))]">{detail}</p>}
    </div>
  );
}

function formatSessionDate(value: string): string {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return "";
  return new Intl.DateTimeFormat(undefined, { month: "short", day: "numeric" }).format(date);
}
