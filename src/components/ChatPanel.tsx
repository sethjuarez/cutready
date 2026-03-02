import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { useAppStore } from "../stores/appStore";
import { useSettings } from "../hooks/useSettings";
import { VersionHistory } from "./VersionHistory";

// ── Types ────────────────────────────────────────────────────────

interface ChatMessage {
  role: string;
  content: string | null;
  tool_calls?: ToolCall[];
  tool_call_id?: string;
}

interface ToolCall {
  id: string;
  call_type: string;
  function: { name: string; arguments: string };
}

interface AgentChatResult {
  messages: ChatMessage[];
  response: string;
}

interface FileReference {
  type: "sketch" | "note" | "storyboard";
  path: string;
  title: string;
}

type SecondaryTab = "chat" | "history";

// ── Main Panel ───────────────────────────────────────────────────

export function ChatPanel() {
  const [activeTab, setActiveTab] = useState<SecondaryTab>("chat");

  return (
    <div className="flex flex-col h-full bg-[var(--color-surface)]">
      {/* Tab bar */}
      <div className="flex items-center border-b border-[var(--color-border)] shrink-0">
        <TabButton
          label="💬 Chat"
          active={activeTab === "chat"}
          onClick={() => setActiveTab("chat")}
        />
        <TabButton
          label="📜 History"
          active={activeTab === "history"}
          onClick={() => setActiveTab("history")}
        />
      </div>

      {/* Tab content */}
      <div className="flex-1 min-h-0">
        {activeTab === "chat" ? <ChatTab /> : <VersionHistory />}
      </div>
    </div>
  );
}

function TabButton({
  label,
  active,
  onClick,
}: {
  label: string;
  active: boolean;
  onClick: () => void;
}) {
  return (
    <button
      className={`px-3 py-1.5 text-xs font-medium transition-colors border-b-2 ${
        active
          ? "border-[var(--color-accent)] text-[var(--color-text)]"
          : "border-transparent text-[var(--color-text-secondary)] hover:text-[var(--color-text)]"
      }`}
      onClick={onClick}
    >
      {label}
    </button>
  );
}

// ── Chat Tab ─────────────────────────────────────────────────────

function ChatTab() {
  const { settings } = useSettings();
  const currentProject = useAppStore((s) => s.currentProject);
  const sketches = useAppStore((s) => s.sketches);
  const notes = useAppStore((s) => s.notes);
  const storyboards = useAppStore((s) => s.storyboards);
  const activeSketchPath = useAppStore((s) => s.activeSketchPath);

  const [messages, setMessages] = useState<ChatMessage[]>([]);
  const [input, setInput] = useState("");
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [references, setReferences] = useState<FileReference[]>([]);
  const [showAutocomplete, setShowAutocomplete] = useState(false);
  const [autocompleteFilter, setAutocompleteFilter] = useState("");
  const [autocompleteIndex, setAutocompleteIndex] = useState(0);

  const messagesEndRef = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLTextAreaElement>(null);

  // Auto-scroll to bottom on new messages
  useEffect(() => {
    messagesEndRef.current?.scrollIntoView({ behavior: "smooth" });
  }, [messages]);

  // All referenceable files
  const allFiles = useMemo<FileReference[]>(() => {
    const files: FileReference[] = [];
    for (const s of sketches) files.push({ type: "sketch", path: s.path, title: s.title });
    for (const n of notes) files.push({ type: "note", path: n.path, title: n.title });
    for (const sb of storyboards) files.push({ type: "storyboard", path: sb.path, title: sb.title });
    return files;
  }, [sketches, notes, storyboards]);

  // Filtered autocomplete options
  const autocompleteOptions = useMemo(() => {
    if (!showAutocomplete) return [];
    const q = autocompleteFilter.toLowerCase();
    return allFiles
      .filter((f) => !references.some((r) => r.path === f.path))
      .filter((f) => f.title.toLowerCase().includes(q) || f.path.toLowerCase().includes(q))
      .slice(0, 8);
  }, [showAutocomplete, autocompleteFilter, allFiles, references]);

  const buildConfig = useCallback(() => ({
    provider: settings.aiProvider,
    endpoint: settings.aiEndpoint,
    api_key: settings.aiApiKey,
    model: settings.aiModel || "unused",
    bearer_token: settings.aiAuthMode === "azure_oauth" ? settings.aiAccessToken : null,
  }), [settings]);

  // Build system prompt
  const systemPrompt = useMemo(() => {
    let prompt = `You are CutReady AI, an assistant for demo video production planning. You help users create and refine sketches (planning tables with time, narrative, demo_actions columns) for demo recordings.

When the user references project files, read them with your tools. When they ask you to create or update planning rows, use set_planning_rows or update_planning_row.

Keep responses concise and actionable. Use markdown formatting.`;
    if (activeSketchPath) {
      prompt += `\n\nThe user is currently editing the sketch at: ${activeSketchPath}`;
    }
    return prompt;
  }, [activeSketchPath]);

  const handleSend = useCallback(async () => {
    const text = input.trim();
    if (!text || loading) return;

    setInput("");
    setError(null);
    setShowAutocomplete(false);

    // Build user message with @references context
    let userContent = text;
    if (references.length > 0) {
      const refList = references.map((r) => `@${r.type}:${r.path}`).join(", ");
      userContent = `[References: ${refList}]\n\n${text}`;
    }

    const userMsg: ChatMessage = { role: "user", content: userContent };
    const newMessages = [...messages, userMsg];
    setMessages(newMessages);
    setReferences([]);

    // Build full conversation with system prompt
    const fullMessages: ChatMessage[] = [
      { role: "system", content: systemPrompt },
      ...newMessages,
    ];

    setLoading(true);
    try {
      const result = await invoke<AgentChatResult>("agent_chat_with_tools", {
        config: buildConfig(),
        messages: fullMessages,
      });

      // Extract tool calls for transparency
      const toolMessages = result.messages.filter(
        (m) => m.role === "assistant" && m.tool_calls && m.tool_calls.length > 0,
      );
      const toolResultMessages = result.messages.filter((m) => m.role === "tool");

      // Build the display messages: user msg + any tool transparency + assistant response
      const displayMessages: ChatMessage[] = [...newMessages];

      // Add tool call transparency messages
      for (const tm of toolMessages) {
        displayMessages.push(tm);
      }
      for (const tr of toolResultMessages) {
        displayMessages.push(tr);
      }

      // Add final assistant response
      if (result.response) {
        displayMessages.push({ role: "assistant", content: result.response });
      }

      setMessages(displayMessages);
    } catch (err) {
      const errMsg = err instanceof Error ? err.message : String(err);
      setError(errMsg);
      // Keep user message visible
      setMessages(newMessages);
    } finally {
      setLoading(false);
    }
  }, [input, loading, messages, references, systemPrompt, buildConfig]);

  const handleInputChange = useCallback(
    (e: React.ChangeEvent<HTMLTextAreaElement>) => {
      const val = e.target.value;
      setInput(val);

      // Detect @ trigger
      const cursorPos = e.target.selectionStart;
      const textBefore = val.slice(0, cursorPos);
      const atIndex = textBefore.lastIndexOf("@");

      if (atIndex >= 0 && (atIndex === 0 || textBefore[atIndex - 1] === " ")) {
        const query = textBefore.slice(atIndex + 1);
        if (!query.includes(" ") && !query.includes("\n")) {
          setShowAutocomplete(true);
          setAutocompleteFilter(query);
          setAutocompleteIndex(0);
          return;
        }
      }
      setShowAutocomplete(false);
    },
    [],
  );

  const insertReference = useCallback(
    (file: FileReference) => {
      setReferences((prev) => [...prev, file]);
      // Remove the @query from input
      const cursorPos = inputRef.current?.selectionStart ?? input.length;
      const textBefore = input.slice(0, cursorPos);
      const atIndex = textBefore.lastIndexOf("@");
      const newInput = input.slice(0, atIndex) + input.slice(cursorPos);
      setInput(newInput);
      setShowAutocomplete(false);
      inputRef.current?.focus();
    },
    [input],
  );

  const removeReference = useCallback((path: string) => {
    setReferences((prev) => prev.filter((r) => r.path !== path));
  }, []);

  const handleKeyDown = useCallback(
    (e: React.KeyboardEvent<HTMLTextAreaElement>) => {
      if (showAutocomplete && autocompleteOptions.length > 0) {
        if (e.key === "ArrowDown") {
          e.preventDefault();
          setAutocompleteIndex((i) => Math.min(i + 1, autocompleteOptions.length - 1));
          return;
        }
        if (e.key === "ArrowUp") {
          e.preventDefault();
          setAutocompleteIndex((i) => Math.max(i - 1, 0));
          return;
        }
        if (e.key === "Enter" || e.key === "Tab") {
          e.preventDefault();
          insertReference(autocompleteOptions[autocompleteIndex]);
          return;
        }
        if (e.key === "Escape") {
          e.preventDefault();
          setShowAutocomplete(false);
          return;
        }
      }

      if (e.key === "Enter" && !e.shiftKey) {
        e.preventDefault();
        handleSend();
      }
    },
    [showAutocomplete, autocompleteOptions, autocompleteIndex, insertReference, handleSend],
  );

  const clearChat = useCallback(() => {
    setMessages([]);
    setReferences([]);
    setError(null);
  }, []);

  const isConfigured = settings.aiEndpoint && (settings.aiApiKey || settings.aiAccessToken);

  if (!currentProject) {
    return (
      <div className="flex-1 flex items-center justify-center p-4">
        <p className="text-xs text-[var(--color-text-secondary)] text-center">
          Open a project to start chatting
        </p>
      </div>
    );
  }

  if (!isConfigured) {
    return (
      <div className="flex-1 flex items-center justify-center p-4">
        <div className="text-center">
          <p className="text-xs text-[var(--color-text-secondary)] mb-2">
            Configure an AI provider in Settings to use the assistant
          </p>
          <button
            className="text-xs text-[var(--color-accent)] hover:underline"
            onClick={() => useAppStore.getState().setView("settings")}
          >
            Open Settings →
          </button>
        </div>
      </div>
    );
  }

  return (
    <div className="flex flex-col h-full">
      {/* Header */}
      <div className="flex items-center justify-between px-3 py-1.5 border-b border-[var(--color-border)] shrink-0">
        <span className="text-xs font-medium text-[var(--color-text-secondary)]">
          {settings.aiModel || "No model"}
        </span>
        {messages.length > 0 && (
          <button
            className="text-[10px] text-[var(--color-text-secondary)] hover:text-[var(--color-text)] transition-colors"
            onClick={clearChat}
            title="Clear chat"
          >
            Clear
          </button>
        )}
      </div>

      {/* Messages */}
      <div className="flex-1 overflow-y-auto min-h-0 px-3 py-2 space-y-3">
        {messages.length === 0 && !loading && (
          <div className="flex flex-col items-center justify-center h-full text-center">
            <div className="text-3xl mb-2">✨</div>
            <p className="text-xs text-[var(--color-text-secondary)] max-w-[200px]">
              Ask me to help plan your demo, generate sketches, or refine your script.
              Use <kbd className="px-1 py-0.5 text-[10px] bg-[var(--color-surface-alt)] rounded border border-[var(--color-border)]">@</kbd> to reference files.
            </p>
          </div>
        )}

        {messages.map((msg, i) => (
          <MessageBubble key={i} message={msg} />
        ))}

        {loading && (
          <div className="flex items-start gap-2">
            <div className="w-5 h-5 rounded-full bg-[var(--color-accent)]/20 flex items-center justify-center shrink-0">
              <span className="text-[10px]">✨</span>
            </div>
            <div className="flex items-center gap-1 py-1">
              <span className="w-1.5 h-1.5 rounded-full bg-[var(--color-text-secondary)] animate-bounce" style={{ animationDelay: "0ms" }} />
              <span className="w-1.5 h-1.5 rounded-full bg-[var(--color-text-secondary)] animate-bounce" style={{ animationDelay: "150ms" }} />
              <span className="w-1.5 h-1.5 rounded-full bg-[var(--color-text-secondary)] animate-bounce" style={{ animationDelay: "300ms" }} />
            </div>
          </div>
        )}

        {error && (
          <div className="text-xs text-red-400 bg-red-400/10 rounded-md px-3 py-2 border border-red-400/20">
            {error}
          </div>
        )}

        <div ref={messagesEndRef} />
      </div>

      {/* Input area */}
      <div className="shrink-0 border-t border-[var(--color-border)] px-3 py-2">
        {/* Reference chips */}
        {references.length > 0 && (
          <div className="flex flex-wrap gap-1 mb-1.5">
            {references.map((ref) => (
              <span
                key={ref.path}
                className="inline-flex items-center gap-1 px-1.5 py-0.5 text-[10px] bg-[var(--color-accent)]/15 text-[var(--color-accent)] rounded-md border border-[var(--color-accent)]/30"
              >
                <FileIcon type={ref.type} />
                {ref.title}
                <button
                  className="hover:text-red-400 ml-0.5"
                  onClick={() => removeReference(ref.path)}
                >
                  ×
                </button>
              </span>
            ))}
          </div>
        )}

        {/* Autocomplete dropdown */}
        <div className="relative">
          {showAutocomplete && autocompleteOptions.length > 0 && (
            <div className="absolute bottom-full left-0 right-0 mb-1 bg-[var(--color-surface)] border border-[var(--color-border)] rounded-md shadow-lg overflow-hidden z-10 max-h-[200px] overflow-y-auto">
              {autocompleteOptions.map((file, i) => (
                <button
                  key={file.path}
                  className={`w-full flex items-center gap-2 px-2 py-1.5 text-left text-xs transition-colors ${
                    i === autocompleteIndex
                      ? "bg-[var(--color-accent)]/15 text-[var(--color-text)]"
                      : "text-[var(--color-text-secondary)] hover:bg-[var(--color-surface-alt)]"
                  }`}
                  onClick={() => insertReference(file)}
                  onMouseEnter={() => setAutocompleteIndex(i)}
                >
                  <FileIcon type={file.type} />
                  <span className="flex-1 truncate">{file.title}</span>
                  <span className="text-[10px] text-[var(--color-text-secondary)] opacity-60">{file.type}</span>
                </button>
              ))}
            </div>
          )}

          <textarea
            ref={inputRef}
            className="w-full resize-none rounded-md bg-[var(--color-surface-alt)] border border-[var(--color-border)] px-2.5 py-1.5 text-xs text-[var(--color-text)] placeholder-[var(--color-text-secondary)] focus:outline-none focus:border-[var(--color-accent)] transition-colors"
            rows={2}
            placeholder="Ask about your demo plan… (@ to reference files)"
            value={input}
            onChange={handleInputChange}
            onKeyDown={handleKeyDown}
            disabled={loading}
          />
        </div>

        <div className="flex items-center justify-between mt-1">
          <span className="text-[10px] text-[var(--color-text-secondary)]">
            Enter to send · Shift+Enter for newline
          </span>
          <button
            className="px-2 py-0.5 text-[10px] font-medium rounded bg-[var(--color-accent)] text-white hover:opacity-90 transition-opacity disabled:opacity-40"
            onClick={handleSend}
            disabled={loading || !input.trim()}
          >
            Send
          </button>
        </div>
      </div>
    </div>
  );
}

// ── Message Bubble ───────────────────────────────────────────────

function MessageBubble({ message }: { message: ChatMessage }) {
  if (message.role === "user") {
    return (
      <div className="flex justify-end">
        <div className="max-w-[85%] rounded-lg px-3 py-1.5 text-xs bg-[var(--color-accent)]/15 text-[var(--color-text)] border border-[var(--color-accent)]/20">
          <div className="whitespace-pre-wrap break-words">{message.content}</div>
        </div>
      </div>
    );
  }

  if (message.role === "assistant" && message.tool_calls && message.tool_calls.length > 0) {
    return (
      <div className="space-y-1">
        {message.tool_calls.map((tc) => (
          <ToolCallBadge key={tc.id} toolCall={tc} />
        ))}
      </div>
    );
  }

  if (message.role === "tool") {
    return null; // Tool results are shown inline with tool calls
  }

  if (message.role === "assistant") {
    return (
      <div className="flex items-start gap-2">
        <div className="w-5 h-5 rounded-full bg-[var(--color-accent)]/20 flex items-center justify-center shrink-0 mt-0.5">
          <span className="text-[10px]">✨</span>
        </div>
        <div className="flex-1 min-w-0 text-xs text-[var(--color-text)] leading-relaxed">
          <MarkdownContent content={message.content || ""} />
        </div>
      </div>
    );
  }

  return null;
}

// ── Tool Call Badge ──────────────────────────────────────────────

function ToolCallBadge({ toolCall }: { toolCall: ToolCall }) {
  const [expanded, setExpanded] = useState(false);
  const name = toolCall.function.name;

  const icon = name.startsWith("read_") || name === "list_project_files"
    ? "📄"
    : name.startsWith("set_") || name.startsWith("update_")
    ? "🔧"
    : "⚡";

  const label = name
    .replace(/_/g, " ")
    .replace(/\b\w/g, (c) => c.toUpperCase());

  let argsSummary = "";
  try {
    const args = JSON.parse(toolCall.function.arguments);
    if (args.path) argsSummary = args.path;
    else if (args.index !== undefined) argsSummary = `row ${args.index}`;
  } catch {
    // ignore
  }

  return (
    <div className="ml-7">
      <button
        className="inline-flex items-center gap-1 px-2 py-0.5 text-[10px] rounded-full bg-[var(--color-surface-alt)] text-[var(--color-text-secondary)] border border-[var(--color-border)] hover:text-[var(--color-text)] transition-colors"
        onClick={() => setExpanded(!expanded)}
      >
        <span>{icon}</span>
        <span>{label}</span>
        {argsSummary && <span className="opacity-60">({argsSummary})</span>}
        <span className="ml-0.5 text-[8px]">{expanded ? "▼" : "▶"}</span>
      </button>
      {expanded && (
        <pre className="mt-1 p-2 text-[10px] rounded bg-[var(--color-surface-alt)] border border-[var(--color-border)] overflow-x-auto text-[var(--color-text-secondary)]">
          {JSON.stringify(JSON.parse(toolCall.function.arguments), null, 2)}
        </pre>
      )}
    </div>
  );
}

// ── Simple Markdown Renderer ─────────────────────────────────────

function MarkdownContent({ content }: { content: string }) {
  // Minimal markdown: bold, italic, inline code, code blocks, headers, lists
  const lines = content.split("\n");
  const elements: React.ReactNode[] = [];
  let i = 0;

  while (i < lines.length) {
    const line = lines[i];

    // Code block
    if (line.startsWith("```")) {
      const codeLines: string[] = [];
      i++;
      while (i < lines.length && !lines[i].startsWith("```")) {
        codeLines.push(lines[i]);
        i++;
      }
      i++; // skip closing ```
      elements.push(
        <pre key={elements.length} className="my-1.5 p-2 rounded bg-[var(--color-surface-alt)] border border-[var(--color-border)] overflow-x-auto text-[10px] leading-relaxed">
          {codeLines.join("\n")}
        </pre>,
      );
      continue;
    }

    // Header
    if (line.startsWith("### ")) {
      elements.push(
        <div key={elements.length} className="font-semibold text-[11px] mt-2 mb-0.5">
          {renderInline(line.slice(4))}
        </div>,
      );
      i++;
      continue;
    }
    if (line.startsWith("## ")) {
      elements.push(
        <div key={elements.length} className="font-semibold text-[11px] mt-2 mb-0.5">
          {renderInline(line.slice(3))}
        </div>,
      );
      i++;
      continue;
    }

    // List item
    if (line.match(/^[-*] /)) {
      elements.push(
        <div key={elements.length} className="flex gap-1.5 ml-1">
          <span className="text-[var(--color-text-secondary)]">•</span>
          <span>{renderInline(line.slice(2))}</span>
        </div>,
      );
      i++;
      continue;
    }

    // Numbered list
    const numMatch = line.match(/^(\d+)\.\s/);
    if (numMatch) {
      elements.push(
        <div key={elements.length} className="flex gap-1.5 ml-1">
          <span className="text-[var(--color-text-secondary)] min-w-[12px]">{numMatch[1]}.</span>
          <span>{renderInline(line.slice(numMatch[0].length))}</span>
        </div>,
      );
      i++;
      continue;
    }

    // Empty line
    if (!line.trim()) {
      elements.push(<div key={elements.length} className="h-1.5" />);
      i++;
      continue;
    }

    // Regular paragraph
    elements.push(
      <div key={elements.length}>{renderInline(line)}</div>,
    );
    i++;
  }

  return <>{elements}</>;
}

/** Render inline markdown: **bold**, *italic*, `code` */
function renderInline(text: string): React.ReactNode {
  const parts: React.ReactNode[] = [];
  let remaining = text;
  let key = 0;

  while (remaining.length > 0) {
    // Bold
    const boldMatch = remaining.match(/\*\*(.+?)\*\*/);
    // Inline code
    const codeMatch = remaining.match(/`(.+?)`/);
    // Italic
    const italicMatch = remaining.match(/(?<!\*)\*(?!\*)(.+?)(?<!\*)\*(?!\*)/);

    // Find earliest match
    const matches = [
      boldMatch && { type: "bold", match: boldMatch },
      codeMatch && { type: "code", match: codeMatch },
      italicMatch && { type: "italic", match: italicMatch },
    ].filter(Boolean) as { type: string; match: RegExpMatchArray }[];

    if (matches.length === 0) {
      parts.push(remaining);
      break;
    }

    const earliest = matches.sort(
      (a, b) => (a.match.index ?? 0) - (b.match.index ?? 0),
    )[0];
    const idx = earliest.match.index ?? 0;

    if (idx > 0) parts.push(remaining.slice(0, idx));

    if (earliest.type === "bold") {
      parts.push(<strong key={key++}>{earliest.match[1]}</strong>);
    } else if (earliest.type === "code") {
      parts.push(
        <code key={key++} className="px-1 py-0.5 bg-[var(--color-surface-alt)] rounded text-[10px] border border-[var(--color-border)]">
          {earliest.match[1]}
        </code>,
      );
    } else {
      parts.push(<em key={key++}>{earliest.match[1]}</em>);
    }

    remaining = remaining.slice(idx + earliest.match[0].length);
  }

  return parts.length === 1 ? parts[0] : <>{parts}</>;
}

// ── Helpers ──────────────────────────────────────────────────────

function FileIcon({ type }: { type: string }) {
  switch (type) {
    case "sketch":
      return <span className="text-[10px]">🎬</span>;
    case "note":
      return <span className="text-[10px]">📝</span>;
    case "storyboard":
      return <span className="text-[10px]">📋</span>;
    default:
      return <span className="text-[10px]">📄</span>;
  }
}
