import { memo, useState } from "react";
import { Activity, ChevronDown, Clock, Globe, Menu, Sparkles, Wrench, X } from "lucide-react";
import type { ChatMessage, ChatToolActivity, ChatWorkingNotes } from "../../types/sketch";
import { SafeMarkdown } from "../SafeMarkdown";
import { MarkdownContent } from "./ChatMarkdown";
import { FileTypeIcon, typeColors } from "./chatFileTypes";
import { NO_TOOL_ACTIVITY, fetchWebReferenceContent, formatMaybeJson, formatToolName, textContent, workingNotesPreview } from "./chatText";

// ── User Content — renders [Web: URL] as styled reference chips ──

function UserMarkdownSegment({ text }: { text: string }) {
  return (
    <SafeMarkdown
      components={{
        // Keep user messages compact — render paragraphs inline-ish
        p: ({ children }) => <div className="my-0.5">{children}</div>,
        strong: ({ children }) => <strong className="font-bold text-[rgb(var(--color-text))]">{children}</strong>,
        em: ({ children }) => <em className="italic">{children}</em>,
        code: ({ className, children }) => {
          const isBlock = className?.includes("language-");
          if (isBlock) {
            return (
              <pre className="my-1.5 p-2 rounded bg-[rgb(var(--color-surface-alt))] border border-[rgb(var(--color-border))] overflow-x-auto text-xs leading-relaxed">
                <code>{children}</code>
              </pre>
            );
          }
          return (
            <code className="px-1 py-0.5 bg-[rgb(var(--color-surface-alt))] rounded text-xs border border-[rgb(var(--color-border))]">
              {children}
            </code>
          );
        },
        pre: ({ children }) => <>{children}</>,
        ul: ({ children }) => <ul className="ml-3 my-0.5 list-disc list-outside">{children}</ul>,
        ol: ({ children }) => <ol className="ml-3 my-0.5 list-decimal list-outside">{children}</ol>,
        li: ({ children }) => <li className="my-0.5 pl-0.5">{children}</li>,
        a: ({ href, children }) => (
          <a href={href} className="text-[rgb(var(--color-accent-hover))] underline decoration-[rgb(var(--color-accent-hover))]/40 hover:decoration-current" target="_blank" rel="noopener noreferrer">{children}</a>
        ),
        blockquote: ({ children }) => (
          <div className="border-l-2 border-[rgb(var(--color-accent))] pl-2 my-1 text-[rgb(var(--color-text-secondary))]">{children}</div>
        ),
        h1: ({ children }) => <div className="font-bold text-sm mt-2 mb-1">{children}</div>,
        h2: ({ children }) => <div className="font-semibold text-sm mt-2 mb-0.5">{children}</div>,
        h3: ({ children }) => <div className="font-semibold text-sm mt-2 mb-0.5">{children}</div>,
        hr: () => <div className="border-t border-[rgb(var(--color-border))] my-2" />,
        table: ({ children }) => (
          <div className="my-1.5 overflow-x-auto rounded border border-[rgb(var(--color-border))]">
            <table className="w-full text-xs border-collapse">{children}</table>
          </div>
        ),
        thead: ({ children }) => (
          <thead className="bg-[rgb(var(--color-surface-alt))] text-[rgb(var(--color-text-secondary))]">{children}</thead>
        ),
        th: ({ children }) => (
          <th className="px-2 py-1 text-left font-medium border-b border-[rgb(var(--color-border))]">{children}</th>
        ),
        td: ({ children }) => (
          <td className="px-2 py-1 border-b border-[rgb(var(--color-border))]">{children}</td>
        ),
      }}
    >
      {text}
    </SafeMarkdown>
  );
}

function UserContent({ content }: { content: string }) {
  // Split on [Web: ...], [References: ...], and inline @URL patterns
  const parts: React.ReactNode[] = [];
  let lastIndex = 0;
  const combined = /\[(Web|References):\s*([^\]]+)\]|@(?:web:)?(https?:\/\/\S+)/g;
  let match;
  while ((match = combined.exec(content)) !== null) {
    if (match.index > lastIndex) {
      parts.push(<UserMarkdownSegment key={`md-${lastIndex}`} text={content.slice(lastIndex, match.index)} />);
    }
    if (match[1] === "Web") {
      parts.push(<WebRefChip key={match.index} url={match[2].trim()} />);
    } else if (match[1] === "References") {
      const refStr = match[2].trim();
      const refs = refStr.split(/,\s*/);
      refs.forEach((ref, i) => {
        const refMatch = ref.match(/^@(note|sketch|storyboard|chat-artifact):(.+)$/);
        if (refMatch) {
          const [, type, path] = refMatch;
          const c = typeColors(type);
          const title = path.replace(/\.\w+$/, "").split("/").pop() ?? path;
          parts.push(
            <span
              key={`${match!.index}-${i}`}
              className={`inline-flex items-center gap-1 px-1.5 py-0.5 rounded border text-xs font-mono align-baseline mr-0.5 ${c.bg} ${c.text} ${c.border}`}
            >
              <FileTypeIcon type={type} />
              <span className="max-w-[140px] truncate">{title}</span>
            </span>
          );
        } else {
          parts.push(
            <span
              key={`${match!.index}-${i}`}
              className="inline-flex items-center gap-1 px-1.5 py-0.5 rounded bg-[rgb(var(--color-surface))] border border-[rgb(var(--color-border))] text-xs text-[rgb(var(--color-text-secondary))] font-mono align-baseline mr-0.5"
            >
              <FileTypeIcon type="file" />
              <span className="max-w-[140px] truncate">{ref}</span>
            </span>
          );
        }
      });
    } else if (match[3]) {
      parts.push(
        <span key={match.index} className="text-[rgb(var(--color-accent-hover))] font-mono text-xs">
          @<span className="underline decoration-[rgb(var(--color-accent))]/40">{match[3]}</span>
        </span>
      );
    }
    lastIndex = match.index + match[0].length;
  }
  if (lastIndex < content.length) {
    parts.push(<UserMarkdownSegment key={`md-${lastIndex}`} text={content.slice(lastIndex)} />);
  }
  return <>{parts}</>;
}

function WebRefChip({ url }: { url: string }) {
  const [expanded, setExpanded] = useState(false);
  const [content, setContent] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);

  const handleExpand = async () => {
    if (expanded) { setExpanded(false); return; }
    setExpanded(true);
    if (content) return;
    setLoading(true);
    try {
      const result = await fetchWebReferenceContent(url);
      setContent(result);
    } catch {
      setContent("Failed to fetch content");
    }
    setLoading(false);
  };

  const shortUrl = url.replace(/^https?:\/\//, "");

  return (
    <>
      <button
        onClick={handleExpand}
        className="inline-flex items-center gap-1 px-1.5 py-0.5 rounded bg-[rgb(var(--color-surface))] border border-[rgb(var(--color-border))] text-xs text-[rgb(var(--color-accent))] hover:bg-[rgb(var(--color-surface-toolbar))] transition-colors font-mono align-baseline"
      >
        <Globe className="w-2.5 h-2.5 shrink-0" />
        <span className="max-w-[200px] truncate">{shortUrl}</span>
        <ChevronDown className={`w-2 h-2 shrink-0 transition-transform ${expanded ? "rotate-180" : ""}`} />
      </button>
      {expanded && (
        <span className="block mt-1">
          <span className="block rounded border border-[rgb(var(--color-border))] bg-[rgb(var(--color-surface))] overflow-hidden">
            <span className="flex items-center justify-between px-2 py-1 border-b border-[rgb(var(--color-border))] bg-[rgb(var(--color-surface-toolbar))]">
              <span className="text-xs text-[rgb(var(--color-text-secondary))] font-mono truncate">{url}</span>
              {content && <span className="shrink-0 text-xs text-[rgb(var(--color-text-secondary))] tabular-nums ml-2">{content.length.toLocaleString()} chars</span>}
            </span>
            <span className="block max-h-[150px] overflow-y-auto p-2 text-xs font-mono text-[rgb(var(--color-text-secondary))] whitespace-pre-wrap break-words leading-[1.4]">
              {loading ? "Loading…" : content || "No content"}
            </span>
          </span>
        </span>
      )}
    </>
  );
}

// ── Message Row (VS Code Copilot chat style) ────────────────────

export const MessageRow = memo(function MessageRow({
  message,
  index,
  inlineToolActivity = NO_TOOL_ACTIVITY,
  agentName,
  projectRoot,
  onDelete,
}: {
  message: ChatMessage;
  index: number;
  inlineToolActivity?: ChatToolActivity[];
  agentName: string;
  projectRoot?: string;
  onDelete?: (index: number, message: ChatMessage) => void;
}) {
  if (message.role === "user") {
    return (
      <div className="group flex items-start justify-end gap-1.5 px-4 py-2">
        {onDelete && (
          <button
            onClick={() => onDelete(index, message)}
            className="mt-1.5 shrink-0 rounded-control p-1 text-[rgb(var(--color-text-secondary))] opacity-0 transition-all hover:bg-error/10 hover:text-error focus-visible:opacity-100 group-hover:opacity-100 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[rgb(var(--color-accent))]"
            aria-label="Remove message"
            title="Remove message"
          >
            <X className="w-3 h-3" />
          </button>
        )}
        <div className="flex max-w-[88%] flex-col items-end">
          <span className="sr-only">You said:</span>
          <div className={`rounded-card px-3 py-2 text-sm leading-5 text-[rgb(var(--color-text))] break-words ${
          message.pending
            ? "border border-dashed border-[rgb(var(--color-border))] bg-[rgb(var(--color-surface-alt))] opacity-70"
            : "bg-[rgb(var(--color-accent))]/[0.08]"
        }`}>
            {message.pending && (
              <span className="mb-1 inline-flex items-center gap-1 text-xs text-[rgb(var(--color-text-secondary))]">
                <Clock className="w-2.5 h-2.5" />
                Pending
              </span>
            )}
            <UserContent content={textContent(message.content)} />
          </div>
        </div>
      </div>
    );
  }

  if (message.role === "tool") {
    return null;
  }

  // Compaction / system events — rendered like a tool-call pill
  if (message.role === "system" && message.content) {
    return (
      <div className="px-4 py-1">
        <div className="inline-flex max-w-full items-center gap-2 text-[13px] text-[rgb(var(--color-text-secondary))]">
          <Menu className="w-3 h-3 opacity-70 shrink-0" />
          <span className="truncate">{textContent(message.content)}</span>
        </div>
      </div>
    );
  }

  if (message.role === "assistant") {
    const assistantText = textContent(message.content).trim();
    const workingNotes = message.cutready?.workingNotes;
    if (!assistantText && inlineToolActivity.length === 0 && !workingNotes) return null;

    return (
      <div className="px-4 py-2">
        <div className="w-full max-w-[70ch] min-w-0">
          {workingNotes && (
            <div className={assistantText || inlineToolActivity.length > 0 ? "mb-2" : ""}>
              <WorkingNotesInline notes={workingNotes} />
            </div>
          )}
          {assistantText && (
            <>
              <div className="mb-1.5 flex items-center gap-2 text-[13px] font-semibold text-[rgb(var(--color-text))]">
                <span className="flex h-[22px] w-[22px] items-center justify-center rounded-full bg-[rgb(var(--color-accent))]/10 text-[rgb(var(--color-accent))]" aria-hidden="true">
                  <Sparkles width={12} height={12} />
                </span>
                {agentName}
              </div>
              <div className="text-sm leading-[1.65] text-[rgb(var(--color-text))]">
                <MarkdownContent content={assistantText} projectRoot={projectRoot} />
              </div>
            </>
          )}
          {inlineToolActivity.length > 0 && (
            <div className={assistantText ? "mt-2" : ""}>
              <ToolActivityTimeline activity={inlineToolActivity} />
            </div>
          )}
        </div>
      </div>
    );
  }

  return null;
});

export function WorkingNotesInline({ notes, defaultOpen = false, live = false }: { notes: ChatWorkingNotes; defaultOpen?: boolean; live?: boolean }) {
  const [expanded, setExpanded] = useState(defaultOpen);
  const drafts = notes.drafts ?? [];
  const itemCount = drafts.length + (notes.thinking ? 1 : 0);
  const preview = workingNotesPreview(notes);
  if (itemCount === 0) return null;

  return (
    <div>
      <button
        type="button"
        aria-expanded={expanded}
        onClick={() => setExpanded((value) => !value)}
        className="inline-flex max-w-full cursor-pointer select-none items-center gap-2 rounded-control px-2 py-1 -ml-2 text-left text-[13px] text-[rgb(var(--color-text-secondary))] transition-colors duration-fast ease-fluent hover:bg-fill-hover focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[rgb(var(--color-accent))]"
      >
        <span className="shrink-0 text-[rgb(var(--color-text-secondary))]" aria-hidden="true">
          <Activity className="h-3.5 w-3.5" />
        </span>
        <span>{live ? "Thinking…" : "Working notes"}</span>
        <span className="tabular-nums text-[rgb(var(--color-text-secondary))]">
          {itemCount}
        </span>
        {preview && (
          <span className="min-w-0 flex-1 truncate text-[rgb(var(--color-text-secondary))]">
            {preview}
          </span>
        )}
        <ChevronDown aria-hidden="true" className={`h-3 w-3 shrink-0 transition-transform ${expanded ? "rotate-180" : ""}`} />
      </button>
      {expanded && <div className="mt-1 space-y-3 rounded-card border border-[rgb(var(--color-border-subtle))] bg-[rgb(var(--color-surface))] p-3">
        {drafts.length > 0 && (
          <div className="rounded-control border border-[rgb(var(--color-border-subtle))] bg-[rgb(var(--color-surface-alt))]/50">
            <div className="border-b border-[rgb(var(--color-border-subtle))] px-3 py-2 text-xs font-medium text-[rgb(var(--color-text-secondary))]">
              Drafts before tool rounds
            </div>
            <div className="divide-y divide-[rgb(var(--color-border-subtle))]">
              {drafts.map((draft, index) => (
                <div key={`${index}-${draft.slice(0, 24)}`} className="px-3 py-2.5">
                  <div className="mb-1 text-xs font-medium text-[rgb(var(--color-text-secondary))]">
                    Draft {index + 1}
                  </div>
                  <div className="text-xs leading-[1.6] text-[rgb(var(--color-text-secondary))]">
                    <MarkdownContent content={draft} />
                  </div>
                </div>
              ))}
            </div>
          </div>
        )}
        {notes.thinking && (
          <div className="rounded-control border border-[rgb(var(--color-border-subtle))] bg-[rgb(var(--color-surface-alt))]/50">
            <div className="border-b border-[rgb(var(--color-border-subtle))] px-3 py-2 text-xs font-medium text-[rgb(var(--color-text-secondary))]">
              Thinking stream
            </div>
            <pre className="max-h-56 overflow-auto whitespace-pre-wrap px-3 py-2.5 text-xs leading-[1.55] text-[rgb(var(--color-text-secondary))]">
              {notes.thinking}
            </pre>
          </div>
        )}
      </div>}
    </div>
  );
}

export function ToolActivityTimeline({ activity }: { activity: ChatToolActivity[] }) {
  const [expanded, setExpanded] = useState(false);
  if (activity.length === 0) return null;

  return (
    <div>
      <button
        type="button"
        aria-expanded={expanded}
        onClick={() => setExpanded((value) => !value)}
        className="inline-flex max-w-full cursor-pointer select-none items-center gap-2 rounded-control px-2 py-1 -ml-2 text-left text-[13px] text-[rgb(var(--color-text-secondary))] transition-colors duration-fast ease-fluent hover:bg-fill-hover focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[rgb(var(--color-accent))]"
      >
        <span className="shrink-0 text-[rgb(var(--color-text-secondary))]" aria-hidden="true">
          <Wrench className="h-3.5 w-3.5" />
        </span>
        <span>{activity.length === 1 ? "Used a tool" : "Used tools"}</span>
        <span className="tabular-nums text-[rgb(var(--color-text-secondary))]">
          {activity.length}
        </span>
        <span className="min-w-0 flex-1 truncate text-[rgb(var(--color-text-secondary))]">
          {activity.map((item) => formatToolName(item.name)).join(" · ")}
        </span>
        <ChevronDown aria-hidden="true" className={`h-3 w-3 shrink-0 transition-transform ${expanded ? "rotate-180" : ""}`} />
      </button>
      {expanded && (
        <div className="mt-1 space-y-2 rounded-card border border-[rgb(var(--color-border-subtle))] bg-[rgb(var(--color-surface))] p-3">
          {activity.map((item) => (
            <div key={item.id} className="rounded-control border border-[rgb(var(--color-border-subtle))] bg-[rgb(var(--color-surface-alt))]/50">
              <div className="flex items-center gap-2 border-b border-[rgb(var(--color-border-subtle))] px-3 py-2 text-xs font-medium text-[rgb(var(--color-text-secondary))]">
                <span className="truncate">{formatToolName(item.name)}</span>
                {item.result !== undefined && (
                  <span className="ml-auto text-xs font-normal text-[rgb(var(--color-text-secondary))]">
                    completed
                  </span>
                )}
              </div>
              <div className="space-y-2 px-3 py-2.5">
                <ToolJsonBlock label="Args" value={item.arguments} />
                {item.result !== undefined && <ToolJsonBlock label="Result" value={item.result} />}
              </div>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

function ToolJsonBlock({ label, value }: { label: string; value: string }) {
  const formatted = formatMaybeJson(value);
  return (
    <div>
      <div className="mb-1 text-xs font-medium text-[rgb(var(--color-text-secondary))]">{label}</div>
      <pre className="max-h-48 overflow-auto whitespace-pre-wrap rounded-control border border-[rgb(var(--color-border-subtle))] bg-[rgb(var(--color-surface-inset))] p-2.5 text-xs leading-relaxed text-[rgb(var(--color-text-secondary))]">
        {formatted}
      </pre>
    </div>
  );
}
