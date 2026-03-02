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

// ── SVG Icons (matching app's Feather/Lucide style) ──────────────

function IconSparkles({ size = 14 }: { size?: number }) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
      <path d="M9.937 15.5A2 2 0 0 0 8.5 14.063l-6.135-1.582a.5.5 0 0 1 0-.962L8.5 9.936A2 2 0 0 0 9.937 8.5l1.582-6.135a.5.5 0 0 1 .963 0L14.063 8.5A2 2 0 0 0 15.5 9.937l6.135 1.581a.5.5 0 0 1 0 .964L15.5 14.063a2 2 0 0 0-1.437 1.437l-1.582 6.135a.5.5 0 0 1-.963 0z" />
      <path d="M20 3v4" /><path d="M22 5h-4" />
    </svg>
  );
}

function IconHistory({ size = 14 }: { size?: number }) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
      <path d="M3 12a9 9 0 1 0 9-9 9.75 9.75 0 0 0-6.74 2.74L3 8" />
      <path d="M3 3v5h5" /><path d="M12 7v5l4 2" />
    </svg>
  );
}

function IconSend({ size = 14 }: { size?: number }) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
      <path d="M14.536 21.686a.5.5 0 0 0 .937-.024l6.5-19a.496.496 0 0 0-.635-.635l-19 6.5a.5.5 0 0 0-.024.937l7.93 3.18a2 2 0 0 1 1.112 1.11z" />
      <path d="m21.854 2.147-10.94 10.939" />
    </svg>
  );
}

function IconFile({ size = 12 }: { size?: number }) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
      <path d="M15 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V7Z" />
      <path d="M14 2v4a2 2 0 0 0 2 2h4" />
    </svg>
  );
}

function IconWrench({ size = 12 }: { size?: number }) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
      <path d="M14.7 6.3a1 1 0 0 0 0 1.4l1.6 1.6a1 1 0 0 0 1.4 0l3.77-3.77a6 6 0 0 1-7.94 7.94l-6.91 6.91a2.12 2.12 0 0 1-3-3l6.91-6.91a6 6 0 0 1 7.94-7.94l-3.76 3.76z" />
    </svg>
  );
}

function IconZap({ size = 12 }: { size?: number }) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
      <path d="M4 14a1 1 0 0 1-.78-1.63l9.9-10.2a.5.5 0 0 1 .86.46l-1.92 6.02A1 1 0 0 0 13 10h7a1 1 0 0 1 .78 1.63l-9.9 10.2a.5.5 0 0 1-.86-.46l1.92-6.02A1 1 0 0 0 11 14z" />
    </svg>
  );
}

function IconTrash({ size = 12 }: { size?: number }) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
      <path d="M3 6h18" /><path d="M19 6v14c0 1-1 2-2 2H7c-1 0-2-1-2-2V6" />
      <path d="M8 6V4c0-1 1-2 2-2h4c1 0 2 1 2 2v2" />
    </svg>
  );
}

function IconPlus({ size = 14 }: { size?: number }) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
      <path d="M5 12h14" /><path d="M12 5v14" />
    </svg>
  );
}

function IconSketch({ size = 12 }: { size?: number }) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
      <path d="M12 20h9" />
      <path d="M16.5 3.5a2.121 2.121 0 0 1 3 3L7 19l-4 1 1-4L16.5 3.5z" />
    </svg>
  );
}

function IconNote({ size = 12 }: { size?: number }) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
      <path d="M16 3H5a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h14a2 2 0 0 0 2-2V8Z" />
      <path d="M15 3v4a2 2 0 0 0 2 2h4" />
    </svg>
  );
}

function IconStoryboard({ size = 12 }: { size?: number }) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
      <rect x="3" y="3" width="7" height="7" rx="1" /><rect x="14" y="3" width="7" height="7" rx="1" />
      <rect x="3" y="14" width="7" height="7" rx="1" /><rect x="14" y="14" width="7" height="7" rx="1" />
    </svg>
  );
}

function IconChevron({ size = 10, expanded = false }: { size?: number; expanded?: boolean }) {
  return (
    <svg
      width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round"
      style={{ transform: expanded ? "rotate(90deg)" : "rotate(0deg)", transition: "transform 0.15s" }}
    >
      <path d="m9 18 6-6-6-6" />
    </svg>
  );
}

// ── Main Panel ───────────────────────────────────────────────────

export function ChatPanel() {
  const [activeTab, setActiveTab] = useState<SecondaryTab>("chat");

  return (
    <div className="flex flex-col h-full bg-[var(--color-surface)]">
      {/* Tab bar — toolbar style with icon buttons */}
      <div className="flex items-center gap-0.5 px-2 h-[34px] bg-[var(--color-surface-alt)] border-b border-[var(--color-border)] shrink-0">
        <button
          className={`flex items-center gap-1.5 px-2.5 h-[26px] rounded text-[11px] font-medium transition-all ${
            activeTab === "chat"
              ? "bg-[var(--color-surface)] text-[var(--color-text)] shadow-sm border border-[var(--color-border)]"
              : "text-[var(--color-text-secondary)] hover:text-[var(--color-text)] hover:bg-[var(--color-surface)]/50"
          }`}
          onClick={() => setActiveTab("chat")}
        >
          <IconSparkles size={12} />
          Chat
        </button>
        <button
          className={`flex items-center gap-1.5 px-2.5 h-[26px] rounded text-[11px] font-medium transition-all ${
            activeTab === "history"
              ? "bg-[var(--color-surface)] text-[var(--color-text)] shadow-sm border border-[var(--color-border)]"
              : "text-[var(--color-text-secondary)] hover:text-[var(--color-text)] hover:bg-[var(--color-surface)]/50"
          }`}
          onClick={() => setActiveTab("history")}
        >
          <IconHistory size={12} />
          History
        </button>
      </div>

      {/* Tab content */}
      <div className="flex-1 min-h-0">
        {activeTab === "chat" ? <ChatTab /> : <VersionHistory />}
      </div>
    </div>
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
      {/* Top toolbar — like Confluo/VS Code chat */}
      <div className="flex items-center gap-0.5 px-2 h-[30px] border-b border-[var(--color-border)] shrink-0">
        <button
          className="flex items-center justify-center w-[26px] h-[26px] rounded text-[var(--color-text-secondary)] hover:text-[var(--color-text)] hover:bg-[var(--color-surface-alt)] transition-colors"
          onClick={clearChat}
          title="New Chat"
        >
          <IconPlus size={14} />
        </button>
        <div className="flex-1" />
        <span className="text-[10px] text-[var(--color-text-secondary)] px-1">
          {settings.aiModel || "No model"}
        </span>
        {messages.length > 0 && (
          <button
            className="flex items-center justify-center w-[26px] h-[26px] rounded text-[var(--color-text-secondary)] hover:text-[var(--color-text)] hover:bg-[var(--color-surface-alt)] transition-colors"
            onClick={clearChat}
            title="Clear chat"
          >
            <IconTrash size={12} />
          </button>
        )}
      </div>

      {/* Messages */}
      <div className="flex-1 overflow-y-auto min-h-0 py-2">
        {messages.length === 0 && !loading && (
          <div className="flex flex-col items-center justify-center h-full text-center px-4">
            <div className="w-10 h-10 rounded-full bg-[var(--color-accent)]/10 flex items-center justify-center mb-3 text-[var(--color-accent)]">
              <IconSparkles size={20} />
            </div>
            <p className="text-[13px] font-medium text-[var(--color-text)] mb-1">
              CutReady AI
            </p>
            <p className="text-xs text-[var(--color-text-secondary)] max-w-[220px] leading-relaxed mb-4">
              I can help plan your demo, generate sketches, or refine your script. Use <kbd className="px-1 py-0.5 text-[10px] bg-[var(--color-surface-alt)] rounded border border-[var(--color-border)]">@</kbd> to reference project files.
            </p>
            <div className="flex flex-wrap gap-1.5 justify-center max-w-[260px]">
              {[
                "Plan a demo from my notes",
                "Generate sketch rows",
                "Refine my script timing",
              ].map((suggestion) => (
                <button
                  key={suggestion}
                  className="px-2.5 py-1 text-[11px] rounded-full border border-[var(--color-border)] text-[var(--color-text-secondary)] hover:text-[var(--color-text)] hover:border-[var(--color-accent)] hover:bg-[var(--color-accent)]/5 transition-colors"
                  onClick={() => {
                    setInput(suggestion);
                    inputRef.current?.focus();
                  }}
                >
                  {suggestion}
                </button>
              ))}
            </div>
          </div>
        )}

        {messages.map((msg, i) => (
          <MessageRow key={i} message={msg} />
        ))}

        {loading && (
          <div className="flex gap-2.5 px-3.5 py-2.5">
            <div className="w-6 h-6 rounded-full bg-[var(--color-accent)]/15 flex items-center justify-center shrink-0 mt-0.5 text-[var(--color-accent)]">
              <IconSparkles size={12} />
            </div>
            <div className="flex-1 min-w-0">
              <div className="text-[11px] font-semibold text-[var(--color-text-secondary)] mb-0.5">CutReady</div>
              <span className="text-xs text-[var(--color-text-secondary)] italic">Thinking…</span>
            </div>
          </div>
        )}

        {error && (
          <div className="mx-3 text-xs text-red-400 bg-red-400/10 rounded-md px-3 py-2 border border-red-400/20">
            {error}
          </div>
        )}

        <div ref={messagesEndRef} />
      </div>

      {/* Input area — Confluo-style bordered container */}
      <div className="shrink-0 mx-2.5 mb-2.5 rounded-lg border border-[var(--color-border)] bg-[var(--color-surface-alt)] overflow-hidden transition-colors focus-within:border-[var(--color-accent)]">
        {/* Reference chips */}
        {references.length > 0 && (
          <div className="flex flex-wrap gap-1 px-2.5 pt-2">
            {references.map((ref) => (
              <span
                key={ref.path}
                className="inline-flex items-center gap-1 px-1.5 py-0.5 text-[10px] bg-[var(--color-accent)]/10 text-[var(--color-accent)] rounded border border-[var(--color-accent)]/20"
              >
                <FileTypeIcon type={ref.type} />
                {ref.title}
                <button
                  className="hover:text-red-400 ml-0.5 opacity-60 hover:opacity-100"
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
                  className={`w-full flex items-center gap-2 px-2.5 py-1.5 text-left text-xs transition-colors ${
                    i === autocompleteIndex
                      ? "bg-[var(--color-accent)]/10 text-[var(--color-text)]"
                      : "text-[var(--color-text-secondary)] hover:bg-[var(--color-surface-alt)]"
                  }`}
                  onClick={() => insertReference(file)}
                  onMouseEnter={() => setAutocompleteIndex(i)}
                >
                  <FileTypeIcon type={file.type} />
                  <span className="flex-1 truncate">{file.title}</span>
                  <span className="text-[10px] text-[var(--color-text-secondary)] opacity-50">{file.type}</span>
                </button>
              ))}
            </div>
          )}

          <textarea
            ref={inputRef}
            className="w-full resize-none bg-transparent px-2.5 py-2 text-[13px] text-[var(--color-text)] placeholder-[var(--color-text-secondary)]/60 focus:outline-none leading-[1.5]"
            style={{ maxHeight: 200 }}
            rows={1}
            placeholder="Ask about your demo plan… (@ to reference files)"
            value={input}
            onChange={handleInputChange}
            onKeyDown={handleKeyDown}
            disabled={loading}
          />
        </div>

        {/* Bottom toolbar */}
        <div className="flex items-center gap-0.5 px-1.5 pb-1.5">
          <span className="text-[10px] text-[var(--color-text-secondary)]/50 px-1">
            Enter ↵
          </span>
          <div className="flex-1" />
          <button
            className="flex items-center justify-center w-[26px] h-[26px] rounded text-[var(--color-text-secondary)] hover:text-[var(--color-text)] hover:bg-[var(--color-surface)] transition-colors disabled:opacity-30 disabled:cursor-not-allowed"
            onClick={handleSend}
            disabled={loading || !input.trim()}
            title="Send (Enter)"
          >
            <IconSend size={14} />
          </button>
        </div>
      </div>
    </div>
  );
}

// ── Message Row (VS Code Copilot chat style) ────────────────────

function MessageRow({ message }: { message: ChatMessage }) {
  if (message.role === "user") {
    return (
      <div className="flex gap-2.5 px-3.5 py-2.5 hover:bg-[var(--color-surface-alt)]/50 transition-colors">
        <div className="w-6 h-6 rounded-full bg-[var(--color-surface-alt)] flex items-center justify-center shrink-0 mt-0.5 text-[var(--color-text-secondary)]">
          <span className="text-[10px] font-bold">U</span>
        </div>
        <div className="flex-1 min-w-0">
          <div className="text-[11px] font-semibold text-[var(--color-text-secondary)] mb-0.5">You</div>
          <div className="text-[13px] text-[var(--color-text)] whitespace-pre-wrap break-words leading-[1.6]">{message.content}</div>
        </div>
      </div>
    );
  }

  if (message.role === "assistant" && message.tool_calls && message.tool_calls.length > 0) {
    return (
      <div className="px-3.5 py-1 ml-[34px] space-y-1">
        {message.tool_calls.map((tc) => (
          <ToolCallRow key={tc.id} toolCall={tc} />
        ))}
      </div>
    );
  }

  if (message.role === "tool") {
    return null;
  }

  if (message.role === "assistant") {
    return (
      <div className="flex gap-2.5 px-3.5 py-2.5 hover:bg-[var(--color-surface-alt)]/50 transition-colors">
        <div className="w-6 h-6 rounded-full bg-[var(--color-accent)]/15 flex items-center justify-center shrink-0 mt-0.5 text-[var(--color-accent)]">
          <IconSparkles size={12} />
        </div>
        <div className="flex-1 min-w-0">
          <div className="text-[11px] font-semibold text-[var(--color-text-secondary)] mb-0.5">CutReady</div>
          <div className="text-[13px] text-[var(--color-text)] leading-[1.6]">
            <MarkdownContent content={message.content || ""} />
          </div>
        </div>
      </div>
    );
  }

  return null;
}

// ── Tool Call Row ────────────────────────────────────────────────

function ToolCallRow({ toolCall }: { toolCall: ToolCall }) {
  const [expanded, setExpanded] = useState(false);
  const name = toolCall.function.name;

  const icon = name.startsWith("read_") || name === "list_project_files"
    ? <IconFile size={11} />
    : name.startsWith("set_") || name.startsWith("update_")
    ? <IconWrench size={11} />
    : <IconZap size={11} />;

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
    <div>
      <button
        className="inline-flex items-center gap-1.5 px-2 py-1 text-[11px] rounded bg-[var(--color-surface-alt)] text-[var(--color-text-secondary)] border border-[var(--color-border)] hover:text-[var(--color-text)] hover:bg-[var(--color-surface-alt)] transition-colors"
        onClick={() => setExpanded(!expanded)}
      >
        <span className="opacity-70">{icon}</span>
        <span className="font-medium">{label}</span>
        {argsSummary && <span className="opacity-50 font-normal">{argsSummary}</span>}
        <IconChevron size={9} expanded={expanded} />
      </button>
      {expanded && (
        <pre className="mt-1 p-2 text-[11px] rounded bg-[var(--color-surface-alt)] border border-[var(--color-border)] overflow-x-auto text-[var(--color-text-secondary)] leading-relaxed">
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

function FileTypeIcon({ type }: { type: string }) {
  const cls = "shrink-0 text-[var(--color-text-secondary)]";
  switch (type) {
    case "sketch":
      return <span className={cls}><IconSketch /></span>;
    case "note":
      return <span className={cls}><IconNote /></span>;
    case "storyboard":
      return <span className={cls}><IconStoryboard /></span>;
    default:
      return <span className={cls}><IconFile /></span>;
  }
}
