import { useEffect, useMemo, useState } from "react";
import { Clock, MessageSquareText } from "lucide-react";
import { invoke } from "../services/tauri";
import { ChatArtifact } from "../contracts/generated/model/chat-artifact";
import type { ChatMessage, ChatToolActivity } from "../types/sketch";
import { MessageRow } from "./ChatPanel";
import { ChatArtifactIcon } from "./Icons";

interface ChatArtifactViewerProps {
  path: string;
}

function formatDate(value: string | undefined): string {
  if (!value) return "Unknown";
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return value;
  return date.toLocaleString();
}

function titleFromPath(path: string): string {
  return (path.split("/").pop() ?? path).replace(/\.cv$/, "");
}

function parseArtifact(content: string): ChatArtifact {
  const raw = JSON.parse(content) as Record<string, unknown>;
  return ChatArtifact.load(raw);
}

function toolArguments(target: string | undefined): string {
  return target ? JSON.stringify({ target }) : "{}";
}

export function ChatArtifactViewer({ path }: ChatArtifactViewerProps) {
  const [artifact, setArtifact] = useState<ChatArtifact | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    setArtifact(null);
    setError(null);
    invoke<string>("get_note", { relativePath: path })
      .then((content) => {
        if (cancelled) return;
        setArtifact(parseArtifact(content));
      })
      .catch((err) => {
        if (!cancelled) setError(err instanceof Error ? err.message : String(err));
      });
    return () => {
      cancelled = true;
    };
  }, [path]);

  const promotedBy = useMemo(() => {
    if (!artifact) return "";
    return artifact.promoted_by?.name || artifact.author?.name || "Unknown";
  }, [artifact]);
  const transcript = useMemo(() => {
    const messages: ChatMessage[] = [];
    const activity: ChatToolActivity[][] = [];
    for (const turn of artifact?.turns ?? []) {
      messages.push({ role: turn.role, content: turn.text });
      activity.push(
        turn.role === "assistant" && turn.tool_uses
          ? turn.tool_uses.map((tool, index) => ({
              id: `${tool.name}:${index}`,
              name: tool.name,
              arguments: toolArguments(tool.target),
            }))
          : [],
      );
    }
    return { messages, activity };
  }, [artifact]);

  if (error) {
    return (
      <div className="flex flex-1 items-center justify-center bg-[rgb(var(--color-surface))] p-6">
        <div className="max-w-md rounded-xl border border-[rgb(var(--color-error))]/30 bg-[rgb(var(--color-error))]/10 p-4 text-sm text-[rgb(var(--color-text))]">
          <div className="font-semibold">Could not open chat</div>
          <div className="mt-1 text-[rgb(var(--color-text-secondary))]">{error}</div>
        </div>
      </div>
    );
  }

  if (!artifact) {
    return (
      <div className="flex flex-1 items-center justify-center bg-[rgb(var(--color-surface))] text-sm text-[rgb(var(--color-text-secondary))]">
        Loading chat...
      </div>
    );
  }

  return (
    <div className="h-full overflow-y-auto bg-[rgb(var(--color-surface))]">
      <div className="mx-auto max-w-5xl px-6 py-8">
        <div className="mb-6 rounded-2xl border border-[rgb(var(--color-border-subtle))] bg-[rgb(var(--color-surface-alt))]/55 p-5 shadow-sm">
          <div className="flex items-start gap-3">
            <span className="flex h-10 w-10 shrink-0 items-center justify-center rounded-2xl border border-[rgb(var(--color-accent))]/25 bg-[rgb(var(--color-accent))]/10 text-[rgb(var(--color-accent))]">
              <ChatArtifactIcon size={20} />
            </span>
            <div className="min-w-0 flex-1">
              <div className="text-[10px] font-semibold uppercase tracking-[0.16em] text-[rgb(var(--color-text-secondary))]">
                Chat
              </div>
              <h1 className="mt-1 truncate text-2xl font-semibold text-[rgb(var(--color-text))]">
                {artifact.title || titleFromPath(path)}
              </h1>
              {artifact.summary && (
                <p className="mt-2 max-w-3xl text-sm leading-relaxed text-[rgb(var(--color-text-secondary))]">
                  {artifact.summary}
                </p>
              )}
              <div className="mt-4 flex flex-wrap gap-2 text-[11px] text-[rgb(var(--color-text-secondary))]">
                <span className="inline-flex items-center gap-1 rounded-full border border-[rgb(var(--color-border-subtle))] bg-[rgb(var(--color-surface))] px-2 py-1">
                  <Clock className="h-3 w-3" />
                  {formatDate(artifact.promoted_at || artifact.updated_at)}
                </span>
                <span className="inline-flex items-center gap-1 rounded-full border border-[rgb(var(--color-border-subtle))] bg-[rgb(var(--color-surface))] px-2 py-1">
                  <MessageSquareText className="h-3 w-3" />
                  {artifact.turns.length} turns
                </span>
                <span className="inline-flex items-center gap-1 rounded-full border border-[rgb(var(--color-border-subtle))] bg-[rgb(var(--color-surface))] px-2 py-1">
                  Promoted by {promotedBy}
                </span>
              </div>
            </div>
          </div>
        </div>

        <div className="space-y-1">
          {transcript.messages.map((message, index) => (
            <MessageRow
              key={`${message.role}:${index}`}
              message={message}
              index={index}
              inlineToolActivity={transcript.activity[index]}
              agentName={artifact.turns[index]?.agent || "Assistant"}
            />
          ))}
        </div>
      </div>
    </div>
  );
}
