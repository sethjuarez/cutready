import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { useAppStore, type ActivityEntry } from "../stores/appStore";
import { useSettings, type AgentPreset } from "../hooks/useSettings";
import { VersionHistory } from "./VersionHistory";
import { SketchIcon, StoryboardIcon, NoteIcon } from "./Icons";
import type { ChatMessage, ToolCall } from "../types/sketch";

// ── Types ────────────────────────────────────────────────────────

interface AgentChatResult {
  messages: ChatMessage[];
  response: string;
}

interface FileReference {
  type: "sketch" | "note" | "storyboard" | "web";
  path: string;
  title: string;
  /** Cached web content (only for type: "web"). */
  webContent?: string;
  /** Fetch status for web refs. */
  webStatus?: "loading" | "ready" | "error";
}

type SecondaryTab = "chat" | "history";

// ── Built-in Agent Presets ───────────────────────────────────────

export const BUILT_IN_AGENTS: AgentPreset[] = [
  {
    id: "planner",
    name: "Planner",
    prompt: `You are CutReady AI — Planner mode. You help users plan demo videos from scratch.

## Your Role
Help users create and refine sketches — planning tables with columns:
- **time**: Duration (e.g. "~30s", "1:00")
- **narrative**: Voiceover/narration script
- **demo_actions**: On-screen actions to perform

## How to Think
When the user makes a request, reason step by step:
1. **Understand**: What is the user trying to accomplish? What kind of demo are they building?
2. **Gather**: What project context do you need? Use list_project_files, read_note, read_sketch to understand the current state.
3. **Plan**: Explain your approach briefly before making changes.
4. **Act**: Use set_planning_rows (full generation) or update_planning_row (surgical edit) to make changes.
5. **Verify**: Summarize what you did and suggest next steps.

## Guidelines
- Read referenced files before making suggestions
- When generating sketch rows, aim for clear, actionable demo steps
- Keep narrative concise — these are voiceover bullets, not essays
- Time estimates should be realistic for live demos (~15-60s per row)
- Use markdown formatting in responses`,
  },
  {
    id: "writer",
    name: "Writer",
    prompt: `You are CutReady AI — Writer mode. You specialize in narrative and script refinement.

## Your Role
Help users write compelling voiceover scripts and narratives for their demo recordings. Focus on storytelling, pacing, and audience engagement.

## How to Think
1. **Read**: Review the current sketch and any referenced notes to understand the demo flow.
2. **Analyze**: Consider the audience, tone, and pacing of the existing content.
3. **Improve**: Rewrite narrative text to be more engaging, clear, and natural when spoken aloud.
4. **Explain**: Briefly note what you changed and why.

## Guidelines
- Write for spoken delivery — short sentences, natural rhythm, conversational tone
- Ensure smooth transitions between rows (the narrative should flow as a continuous script)
- Highlight key product features and benefits
- Avoid jargon unless the audience expects it
- Use update_planning_row for targeted narrative edits
- Use markdown formatting in responses`,
  },
  {
    id: "editor",
    name: "Editor",
    prompt: `You are CutReady AI — Editor mode. You make precise, surgical edits to existing sketches.

## Your Role
Make targeted changes to specific cells in the planning table. Be concise and efficient.

## How to Think
1. Read the current sketch to understand context.
2. Make the specific edit requested — no unnecessary changes.
3. Confirm what you changed in one sentence.

## Guidelines
- Use update_planning_row for single-cell changes (preferred)
- Only use set_planning_rows if the user asks to restructure the entire sketch
- Keep responses brief — just confirm the change
- Don't add unsolicited suggestions unless asked`,
  },
];

/** Resolve an agent ID to its prompt text. Checks custom agents first, then built-ins. */
export function resolveAgentPrompt(agentId: string, customAgents: AgentPreset[]): string {
  const custom = customAgents.find((a) => a.id === agentId);
  if (custom) return custom.prompt;
  const builtin = BUILT_IN_AGENTS.find((a) => a.id === agentId);
  return builtin?.prompt ?? BUILT_IN_AGENTS[0].prompt;
}

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

function IconGlobe({ size = 12 }: { size?: number }) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
      <circle cx="12" cy="12" r="10" />
      <path d="M12 2a14.5 14.5 0 0 0 0 20 14.5 14.5 0 0 0 0-20" />
      <path d="M2 12h20" />
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

function IconPaperclip({ size = 14 }: { size?: number }) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
      <path d="m21.44 11.05-9.19 9.19a6 6 0 0 1-8.49-8.49l8.57-8.57A4 4 0 1 1 18 8.84l-8.59 8.57a2 2 0 0 1-2.83-2.83l8.49-8.48" />
    </svg>
  );
}

function IconTool({ size = 14 }: { size?: number }) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
      <path d="M14.7 6.3a1 1 0 0 0 0 1.4l1.6 1.6a1 1 0 0 0 1.4 0l3.77-3.77a6 6 0 0 1-7.94 7.94l-6.91 6.91a2.12 2.12 0 0 1-3-3l6.91-6.91a6 6 0 0 1 7.94-7.94l-3.76 3.76z" />
    </svg>
  );
}

function IconChevronDown({ size = 10 }: { size?: number }) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round">
      <path d="m6 9 6 6 6-6" />
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

function IconCheck({ size = 12 }: { size?: number }) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round" className="ml-auto shrink-0">
      <path d="M20 6 9 17l-5-5" />
    </svg>
  );
}

function IconUser({ size = 12 }: { size?: number }) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
      <path d="M19 21v-2a4 4 0 0 0-4-4H9a4 4 0 0 0-4 4v2" />
      <circle cx="12" cy="7" r="4" />
    </svg>
  );
}

// ── Dropdown height constraint hook ──────────────────────────────
// Measures available viewport space above a trigger element so
// upward-opening dropdowns never extend off-screen.
function useDropdownMaxHeight(
  triggerRef: React.RefObject<HTMLElement | null>,
  isOpen: boolean,
  cap = 260,
): number {
  const [maxH, setMaxH] = useState(cap);
  useLayoutEffect(() => {
    if (!isOpen || !triggerRef.current) return;
    const rect = triggerRef.current.getBoundingClientRect();
    const spaceAbove = rect.top - 8; // 8px viewport padding
    setMaxH(Math.max(120, Math.min(spaceAbove, cap)));
  }, [isOpen, cap]);
  return maxH;
}

// ── Main Panel ───────────────────────────────────────────────────

export function ChatPanel() {
  const [activeTab, setActiveTab] = useState<SecondaryTab>("chat");

  return (
    <div className="flex flex-col h-full bg-[var(--color-surface-inset)]">
      {/* Tab bar — underline tabs like VS Code panel tabs */}
      <div className="flex items-stretch border-b border-[var(--color-border)] shrink-0">
        <button
          className={`flex items-center gap-1.5 px-3 py-2 text-[11px] font-medium transition-colors border-b-2 -mb-px ${
            activeTab === "chat"
              ? "border-[var(--color-accent)] text-[var(--color-text)]"
              : "border-transparent text-[var(--color-text-secondary)] hover:text-[var(--color-text)] hover:border-[var(--color-text-secondary)]/30"
          }`}
          onClick={() => setActiveTab("chat")}
        >
          <IconSparkles size={12} />
          Chat
        </button>
        <button
          className={`flex items-center gap-1.5 px-3 py-2 text-[11px] font-medium transition-colors border-b-2 -mb-px ${
            activeTab === "history"
              ? "border-[var(--color-accent)] text-[var(--color-text)]"
              : "border-transparent text-[var(--color-text-secondary)] hover:text-[var(--color-text)] hover:border-[var(--color-text-secondary)]/30"
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
  const { settings, updateSetting } = useSettings();
  const currentProject = useAppStore((s) => s.currentProject);
  const sketches = useAppStore((s) => s.sketches);
  const notes = useAppStore((s) => s.notes);
  const storyboards = useAppStore((s) => s.storyboards);
  const activeSketchPath = useAppStore((s) => s.activeSketchPath);
  const messages = useAppStore((s) => s.chatMessages);
  const setChatMessages = useAppStore((s) => s.setChatMessages);
  const loading = useAppStore((s) => s.chatLoading);
  const setChatLoading = useAppStore((s) => s.setChatLoading);
  const error = useAppStore((s) => s.chatError);
  const setChatError = useAppStore((s) => s.setChatError);
  const addActivityEntries = useAppStore((s) => s.addActivityEntries);
  const chatSessionPath = useAppStore((s) => s.chatSessionPath);
  const newChatSession = useAppStore((s) => s.newChatSession);

  const [input, setInput] = useState("");
  const [references, setReferences] = useState<FileReference[]>([]);
  const [showAutocomplete, setShowAutocomplete] = useState(false);
  const [autocompleteFilter, setAutocompleteFilter] = useState("");
  const [autocompleteIndex, setAutocompleteIndex] = useState(0);
  const [showContextPicker, setShowContextPicker] = useState(false);
  const [contextFilter, setContextFilter] = useState("");
  const [showModelPicker, setShowModelPicker] = useState(false);
  const [showToolsInfo, setShowToolsInfo] = useState(false);
  const [showAgentPicker, setShowAgentPicker] = useState(false);
  const [expandedWebRef, setExpandedWebRef] = useState<string | null>(null);

  // Auto-create a session path on first mount if none exists
  useEffect(() => {
    if (!chatSessionPath) newChatSession();
  }, [chatSessionPath, newChatSession]);

  const messagesEndRef = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLTextAreaElement>(null);
  const autocompleteRef = useRef<HTMLDivElement>(null);
  const contextPickerRef = useRef<HTMLDivElement>(null);
  const modelPickerRef = useRef<HTMLDivElement>(null);
  const toolsInfoRef = useRef<HTMLDivElement>(null);
  const agentPickerRef = useRef<HTMLDivElement>(null);

  // Constrain dropdown heights to available viewport space
  const acMaxH = useDropdownMaxHeight(autocompleteRef, showAutocomplete);
  const ctxMaxH = useDropdownMaxHeight(contextPickerRef, showContextPicker);
  const modelMaxH = useDropdownMaxHeight(modelPickerRef, showModelPicker);
  const toolsMaxH = useDropdownMaxHeight(toolsInfoRef, showToolsInfo);
  const agentMaxH = useDropdownMaxHeight(agentPickerRef, showAgentPicker);

  // All agents: built-ins + custom
  const allAgents = useMemo(() => {
    const custom = settings.aiAgents || [];
    return [...BUILT_IN_AGENTS, ...custom];
  }, [settings.aiAgents]);

  const selectedAgent = useMemo(() => {
    const id = settings.aiSelectedAgent || "planner";
    return allAgents.find((a) => a.id === id) ?? BUILT_IN_AGENTS[0];
  }, [settings.aiSelectedAgent, allAgents]);

  // Auto-scroll to bottom on new messages
  useEffect(() => {
    messagesEndRef.current?.scrollIntoView({ behavior: "smooth" });
  }, [messages]);

  // Click-outside to close pickers
  useEffect(() => {
    if (!showContextPicker && !showModelPicker && !showToolsInfo && !showAgentPicker) return;
    const handle = (e: MouseEvent) => {
      if (showContextPicker && contextPickerRef.current && !contextPickerRef.current.contains(e.target as Node)) setShowContextPicker(false);
      if (showModelPicker && modelPickerRef.current && !modelPickerRef.current.contains(e.target as Node)) setShowModelPicker(false);
      if (showToolsInfo && toolsInfoRef.current && !toolsInfoRef.current.contains(e.target as Node)) setShowToolsInfo(false);
      if (showAgentPicker && agentPickerRef.current && !agentPickerRef.current.contains(e.target as Node)) setShowAgentPicker(false);
    };
    window.addEventListener("mousedown", handle);
    return () => window.removeEventListener("mousedown", handle);
  }, [showContextPicker, showModelPicker, showToolsInfo]);

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

  // Filtered context picker options (for Add Context button)
  const contextPickerOptions = useMemo(() => {
    if (!showContextPicker) return [];
    const q = contextFilter.toLowerCase();
    return allFiles
      .filter((f) => !references.some((r) => r.path === f.path))
      .filter((f) => f.title.toLowerCase().includes(q) || f.path.toLowerCase().includes(q))
      .slice(0, 10);
  }, [showContextPicker, contextFilter, allFiles, references]);

  // Available tools list
  const availableTools = ["list_project_files", "read_note", "read_sketch", "set_planning_rows", "update_planning_row", "delegate_to_agent", "fetch_url"];

  const buildConfig = useCallback(() => ({
    provider: settings.aiProvider,
    endpoint: settings.aiEndpoint,
    api_key: settings.aiApiKey,
    model: settings.aiModel || "unused",
    bearer_token: settings.aiAuthMode === "azure_oauth" ? settings.aiAccessToken : null,
  }), [settings]);

  // Build system prompt from selected agent
  const systemPrompt = useMemo(() => {
    const agentId = settings.aiSelectedAgent || "planner";
    const customAgents = settings.aiAgents || [];
    let prompt = resolveAgentPrompt(agentId, customAgents);
    if (activeSketchPath) {
      prompt += `\n\nThe user is currently editing the sketch at: ${activeSketchPath}`;
    }
    return prompt;
  }, [settings.aiSelectedAgent, settings.aiAgents, activeSketchPath]);

  const handleSend = useCallback(async () => {
    const text = input.trim();
    if (!text) return;

    setInput("");
    setShowAutocomplete(false);

    // If agent is already running, push to pending stack
    if (loading) {
      try {
        await invoke("push_pending_chat_message", { message: text });
        // Show pending message in the chat with a visual marker
        const pendingMsg: ChatMessage = { role: "user", content: `[pending] ${text}` };
        setChatMessages([...messages, pendingMsg]);
      } catch (err) {
        console.error("Failed to push pending message:", err);
      }
      return;
    }

    setChatError(null);

    // Build user message with #references context
    let userContent = text;
    let llmContent: string | null = null;
    if (references.length > 0) {
      const webRefs = references.filter((r) => r.type === "web");
      const fileRefs = references.filter((r) => r.type !== "web");
      const parts: string[] = [];

      if (fileRefs.length > 0) {
        parts.push(`[References: ${fileRefs.map((r) => `#${r.type}:${r.path}`).join(", ")}]`);
      }

      // Display-only: compact web references
      for (const wr of webRefs) {
        parts.push(`[Web: ${wr.path}]`);
      }

      // Build separate LLM parts with full web content
      const llmParts = [...parts];
      for (const wr of webRefs) {
        if (wr.webContent && wr.webStatus === "ready") {
          llmParts.push(`[Web Content: ${wr.path}]\n${wr.webContent}`);
        }
      }

      userContent = `${parts.join("\n\n")}\n\n${text}`;
      llmContent = `${llmParts.join("\n\n")}\n\n${text}`;
    }

    const userMsg: ChatMessage = { role: "user", content: userContent };
    const newMessages = [...messages, userMsg];
    setChatMessages(newMessages);
    setReferences([]);

    // Build full conversation with system prompt — use llmContent for last message so LLM gets web content
    const llmMessages = newMessages.map((m, i) =>
      i === newMessages.length - 1 && llmContent ? { ...m, content: llmContent } : m
    );
    const fullMessages: ChatMessage[] = [
      { role: "system", content: systemPrompt },
      ...llmMessages,
    ];

    setChatLoading(true);
    // Log the send to activity
    addActivityEntries([{
      id: crypto.randomUUID(),
      timestamp: new Date(),
      source: "chat",
      content: `Sent: "${userContent.slice(0, 100)}${userContent.length > 100 ? "…" : ""}"`,
      level: "info",
    }]);
    try {
      // Auto-refresh OAuth token if we have a refresh token
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
          // Refresh failed — will try with existing token
        }
      }

      const config = {
        ...buildConfig(),
        bearer_token: freshBearerToken,
      };

      // Build agent prompts map for sub-agent delegation
      const agentPrompts: Record<string, string> = {};
      for (const a of BUILT_IN_AGENTS) {
        agentPrompts[a.id] = a.prompt;
      }
      for (const a of (settings.aiAgents || [])) {
        agentPrompts[a.id] = a.prompt;
      }

      const result = await invoke<AgentChatResult>("agent_chat_with_tools", {
        config,
        messages: fullMessages,
        agentPrompts,
      });

      // Extract tool calls for transparency
      const toolMessages = result.messages.filter(
        (m) => m.role === "assistant" && m.tool_calls && m.tool_calls.length > 0,
      );
      const toolResultMessages = result.messages.filter((m) => m.role === "tool");

      // Log tool activity to the activity panel
      const activityEntries: ActivityEntry[] = [];
      for (const tm of toolMessages) {
        for (const tc of tm.tool_calls ?? []) {
          const isDelegation = tc.function?.name === "delegate_to_agent";
          activityEntries.push({
            id: tc.id ?? crypto.randomUUID(),
            timestamp: new Date(),
            source: isDelegation ? `delegate ${tc.function?.name}` : tc.function?.name ?? "tool",
            content: isDelegation
              ? `Delegated to agent: ${JSON.parse(tc.function?.arguments ?? "{}").agent_id ?? "unknown"}`
              : `Called with: ${tc.function?.arguments ?? "{}"}`,
            level: "info",
          });
        }
      }
      for (const tr of toolResultMessages) {
        activityEntries.push({
          id: crypto.randomUUID(),
          timestamp: new Date(),
          source: `result ${tr.tool_call_id ?? ""}`.trim(),
          content: (tr.content ?? "").slice(0, 200),
          level: "success",
        });
      }
      if (activityEntries.length > 0) {
        addActivityEntries(activityEntries);
      }

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

      // Log response to activity
      addActivityEntries([{
        id: crypto.randomUUID(),
        timestamp: new Date(),
        source: "response",
        content: `${toolMessages.length > 0 ? `${toolMessages.reduce((n, m) => n + (m.tool_calls?.length ?? 0), 0)} tool call(s) → ` : ""}${(result.response ?? "").slice(0, 120)}${(result.response ?? "").length > 120 ? "…" : ""}`,
        level: "success",
      }]);

      setChatMessages(displayMessages);
    } catch (err) {
      const errMsg = err instanceof Error ? err.message : String(err);
      setChatError(errMsg);
      // Log error to activity
      addActivityEntries([{
        id: crypto.randomUUID(),
        timestamp: new Date(),
        source: "error",
        content: errMsg.slice(0, 200),
        level: "error",
      }]);
      // Keep user message visible
      setChatMessages(newMessages);
    } finally {
      setChatLoading(false);
    }
  }, [input, loading, messages, references, systemPrompt, buildConfig, setChatMessages, setChatLoading, setChatError, addActivityEntries, settings.aiAgents]);

  const handleInputChange = useCallback(
    (e: React.ChangeEvent<HTMLTextAreaElement>) => {
      const val = e.target.value;
      setInput(val);

      // Detect # trigger for references
      const cursorPos = e.target.selectionStart;
      const textBefore = val.slice(0, cursorPos);
      const hashIndex = textBefore.lastIndexOf("#");

      if (hashIndex >= 0 && (hashIndex === 0 || textBefore[hashIndex - 1] === " ")) {
        const query = textBefore.slice(hashIndex + 1);

        // Detect completed #web:URL pattern — triggers when space follows the URL
        const webMatch = val.slice(hashIndex + 1).match(/^web:(https?:\/\/\S+)\s/);
        if (webMatch) {
          const url = webMatch[1];
          setReferences((prev) => {
            if (prev.some((r) => r.path === url)) return prev;
            return [...prev, { type: "web", path: url, title: url, webStatus: "loading" }];
          });
          // Remove #web:URL + trailing space from input
          const before = val.slice(0, hashIndex);
          const after = val.slice(hashIndex + 1 + webMatch[0].length);
          setInput(before + after);
          setShowAutocomplete(false);
          // Fetch content in background
          invoke<string>("fetch_url_content", { url }).then((content) => {
            setReferences((prev) => prev.map((r) =>
              r.path === url ? { ...r, webContent: content, webStatus: "ready" as const } : r
            ));
          }).catch(() => {
            setReferences((prev) => prev.map((r) =>
              r.path === url ? { ...r, webContent: "Failed to fetch", webStatus: "error" as const } : r
            ));
          });
          return;
        }

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
      // Remove the #query from input
      const cursorPos = inputRef.current?.selectionStart ?? input.length;
      const textBefore = input.slice(0, cursorPos);
      const hashIndex = textBefore.lastIndexOf("#");
      const newInput = input.slice(0, hashIndex) + input.slice(cursorPos);
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
    newChatSession();
    setReferences([]);
  }, [newChatSession]);

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
      {/* Top toolbar — session controls */}
      <div className="flex items-center gap-0.5 px-2 h-[30px] border-b border-[var(--color-border)] shrink-0">
        <button
          className="flex items-center justify-center w-[26px] h-[26px] rounded text-[var(--color-text-secondary)] hover:text-[var(--color-text)] hover:bg-[var(--color-surface-toolbar)] transition-colors"
          onClick={clearChat}
          title="New Chat"
        >
          <IconPlus size={14} />
        </button>
        <div className="flex-1" />
        {messages.length > 0 && (
          <button
            className="flex items-center justify-center w-[26px] h-[26px] rounded text-[var(--color-text-secondary)] hover:text-[var(--color-text)] hover:bg-[var(--color-surface-toolbar)] transition-colors"
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
              I can help plan your demo, generate sketches, or refine your script. Use <kbd className="px-1 py-0.5 text-[10px] bg-[var(--color-surface-alt)] rounded border border-[var(--color-border)]">#</kbd> to reference files and websites.
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
          <div className="px-3.5 py-2">
            <span className="text-xs text-[var(--color-text-secondary)] italic">Thinking…</span>
          </div>
        )}

        {error && (
          <div className="mx-3 text-xs text-red-400 bg-red-400/10 rounded-md px-3 py-2 border border-red-400/20">
            {error}
          </div>
        )}

        <div ref={messagesEndRef} />
      </div>

      {/* Input area — VS Code Copilot chat style */}
      <div className="shrink-0 mx-2.5 mb-2.5 rounded-lg border border-[var(--color-border)] bg-[var(--color-surface)] shadow-sm transition-colors focus-within:border-[var(--color-accent)]">
        {/* Reference chips (shown above textarea) */}
        {references.length > 0 && (
          <div className="px-2.5 pt-2 space-y-1">
            <div className="flex flex-wrap gap-1">
              {references.map((ref) => (
                <span
                  key={ref.path}
                  className={`inline-flex items-center gap-1 px-1.5 py-0.5 text-[11px] rounded border transition-colors ${
                    ref.type === "web" && ref.webStatus === "loading"
                      ? "bg-[var(--color-surface)] text-[var(--color-text-secondary)] border-[var(--color-border)] animate-pulse"
                      : ref.type === "web" && ref.webStatus === "error"
                        ? "bg-red-400/10 text-red-400 border-red-400/30"
                        : "bg-[var(--color-surface)] text-[var(--color-text)] border-[var(--color-border)] hover:border-[var(--color-accent)]/40"
                  }`}
                >
                  <FileTypeIcon type={ref.type} />
                  {ref.type === "web" ? (
                    <button
                      className="max-w-[180px] truncate hover:underline"
                      onClick={() => setExpandedWebRef(expandedWebRef === ref.path ? null : ref.path)}
                      title={ref.webStatus === "loading" ? "Fetching…" : "Click to preview"}
                    >
                      {ref.webStatus === "loading" ? "Fetching…" : ref.title}
                    </button>
                  ) : (
                    <span className="max-w-[120px] truncate">{ref.title}</span>
                  )}
                  <button
                    className="text-[var(--color-text-secondary)] hover:text-red-400 transition-colors"
                    onClick={() => { removeReference(ref.path); if (expandedWebRef === ref.path) setExpandedWebRef(null); }}
                    title="Remove"
                  >
                    <svg width="10" height="10" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round">
                      <line x1="18" y1="6" x2="6" y2="18" /><line x1="6" y1="6" x2="18" y2="18" />
                    </svg>
                  </button>
                </span>
              ))}
            </div>
            {/* Web content preview */}
            {expandedWebRef && (() => {
              const ref = references.find((r) => r.path === expandedWebRef);
              if (!ref?.webContent) return null;
              return (
                <div className="rounded border border-[var(--color-border)] bg-[var(--color-surface-alt)] text-[11px] text-[var(--color-text-secondary)] overflow-hidden">
                  <div className="flex items-center justify-between px-2 py-1 border-b border-[var(--color-border)]">
                    <span className="truncate font-medium">{ref.path}</span>
                    <span className="shrink-0 text-[10px] tabular-nums">{ref.webContent.length.toLocaleString()} chars</span>
                  </div>
                  <div className="max-h-[120px] overflow-y-auto px-2 py-1.5 font-mono whitespace-pre-wrap leading-relaxed">
                    {ref.webContent}
                  </div>
                </div>
              );
            })()}
          </div>
        )}

        {/* Textarea with # autocomplete */}
        <div className="relative" ref={autocompleteRef}>
          {showAutocomplete && autocompleteOptions.length > 0 && (
            <div className="absolute bottom-full left-0 right-0 mb-1 bg-[var(--color-surface)] border border-[var(--color-border)] rounded-md shadow-lg overflow-hidden z-10 overflow-y-auto" style={{ maxHeight: acMaxH }}>
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
            style={{ maxHeight: 300 }}
            rows={3}
            placeholder="Ask about your demo plan… (# to reference files)"
            value={input}
            onChange={handleInputChange}
            onKeyDown={handleKeyDown}
            disabled={loading}
          />
        </div>

        {/* Bottom toolbar — Add Context | Model | Tools | Send */}
        <div className="flex items-center gap-0.5 px-1.5 pb-1.5">
          {/* Add Context button + picker */}
          <div className="relative" ref={contextPickerRef}>
            <button
              className={`flex items-center gap-1 px-1.5 h-[26px] rounded text-[11px] transition-colors ${
                showContextPicker
                  ? "bg-[var(--color-surface)] text-[var(--color-text)]"
                  : "text-[var(--color-text-secondary)] hover:text-[var(--color-text)] hover:bg-[var(--color-surface)]"
              }`}
              onClick={() => { setShowContextPicker(!showContextPicker); setContextFilter(""); }}
              title="Add Context (#)"
            >
              <IconPaperclip size={12} />
            </button>
            {showContextPicker && (
              <div className="absolute bottom-full left-0 mb-1 w-[240px] bg-[var(--color-surface)] border border-[var(--color-border)] rounded-lg shadow-lg overflow-hidden z-20 flex flex-col" style={{ maxHeight: ctxMaxH }}>
                <div className="px-2.5 pt-2 pb-1 shrink-0">
                  <input
                    className="w-full px-2 py-1 text-[11px] bg-[var(--color-surface-alt)] border border-[var(--color-border)] rounded text-[var(--color-text)] placeholder-[var(--color-text-secondary)] focus:outline-none focus:border-[var(--color-accent)]"
                    placeholder="Search files…"
                    value={contextFilter}
                    onChange={(e) => setContextFilter(e.target.value)}
                    autoFocus
                  />
                </div>
                <div className="flex-1 overflow-y-auto">
                  {contextPickerOptions.length === 0 ? (
                    <div className="px-3 py-2 text-[11px] text-[var(--color-text-secondary)]">
                      No matching files
                    </div>
                  ) : (
                    contextPickerOptions.map((file) => (
                      <button
                        key={file.path}
                        className="w-full flex items-center gap-2 px-2.5 py-1.5 text-left text-[11px] text-[var(--color-text-secondary)] hover:bg-[var(--color-surface-alt)] hover:text-[var(--color-text)] transition-colors"
                        onClick={() => {
                          setReferences((prev) => [...prev, file]);
                          setShowContextPicker(false);
                          inputRef.current?.focus();
                        }}
                      >
                        <FileTypeIcon type={file.type} />
                        <span className="flex-1 truncate">{file.title}</span>
                        <span className="text-[10px] opacity-40">{file.type}</span>
                      </button>
                    ))
                  )}
                </div>
              </div>
            )}
          </div>

          {/* Agent picker */}
          <div className="relative" ref={agentPickerRef}>
            <button
              className={`flex items-center gap-1 px-1.5 h-[26px] rounded text-[11px] transition-colors ${
                showAgentPicker
                  ? "bg-[var(--color-surface)] text-[var(--color-text)]"
                  : "text-[var(--color-text-secondary)] hover:text-[var(--color-text)] hover:bg-[var(--color-surface)]"
              }`}
              onClick={() => setShowAgentPicker(!showAgentPicker)}
              title="Select Agent"
            >
              <IconSparkles size={11} />
              <span className="max-w-[80px] truncate">{selectedAgent.name}</span>
              <IconChevronDown size={10} />
            </button>
            {showAgentPicker && (
              <div className="absolute bottom-full left-0 mb-1 w-[200px] bg-[var(--color-surface)] border border-[var(--color-border)] rounded-lg shadow-lg overflow-hidden z-20 flex flex-col" style={{ maxHeight: agentMaxH }}>
                {BUILT_IN_AGENTS.length > 0 && (
                  <>
                    <div className="px-3 py-1.5 border-b border-[var(--color-border)] shrink-0">
                      <span className="text-[10px] font-medium text-[var(--color-text-secondary)] uppercase tracking-wider">Built-in</span>
                    </div>
                    <div className="py-0.5">
                      {BUILT_IN_AGENTS.map((agent) => (
                        <button
                          key={agent.id}
                          className={`w-full flex items-center gap-2 px-3 py-1.5 text-[11px] text-left transition-colors ${
                            selectedAgent.id === agent.id
                              ? "bg-[var(--color-accent)]/10 text-[var(--color-text)]"
                              : "text-[var(--color-text-secondary)] hover:bg-[var(--color-surface-alt)] hover:text-[var(--color-text)]"
                          }`}
                          onClick={() => {
                            updateSetting("aiSelectedAgent", agent.id);
                            setShowAgentPicker(false);
                          }}
                        >
                          <IconSparkles size={11} />
                          <span>{agent.name}</span>
                          {selectedAgent.id === agent.id && <IconCheck size={11} />}
                        </button>
                      ))}
                    </div>
                  </>
                )}
                {(settings.aiAgents?.length ?? 0) > 0 && (
                  <>
                    <div className="px-3 py-1.5 border-t border-[var(--color-border)] shrink-0">
                      <span className="text-[10px] font-medium text-[var(--color-text-secondary)] uppercase tracking-wider">Custom</span>
                    </div>
                    <div className="py-0.5 overflow-y-auto">
                      {(settings.aiAgents || []).map((agent) => (
                        <button
                          key={agent.id}
                          className={`w-full flex items-center gap-2 px-3 py-1.5 text-[11px] text-left transition-colors ${
                            selectedAgent.id === agent.id
                              ? "bg-[var(--color-accent)]/10 text-[var(--color-text)]"
                              : "text-[var(--color-text-secondary)] hover:bg-[var(--color-surface-alt)] hover:text-[var(--color-text)]"
                          }`}
                          onClick={() => {
                            updateSetting("aiSelectedAgent", agent.id);
                            setShowAgentPicker(false);
                          }}
                        >
                          <IconUser size={11} />
                          <span className="truncate">{agent.name}</span>
                          {selectedAgent.id === agent.id && <IconCheck size={11} />}
                        </button>
                      ))}
                    </div>
                  </>
                )}
              </div>
            )}
          </div>

          {/* Model picker */}
          <div className="relative" ref={modelPickerRef}>
            <button
              className={`flex items-center gap-1 px-1.5 h-[26px] rounded text-[11px] transition-colors ${
                showModelPicker
                  ? "bg-[var(--color-surface)] text-[var(--color-text)]"
                  : "text-[var(--color-text-secondary)] hover:text-[var(--color-text)] hover:bg-[var(--color-surface)]"
              }`}
              onClick={() => setShowModelPicker(!showModelPicker)}
              title="Select Model"
            >
              <span className="max-w-[100px] truncate">{settings.aiModel || "Model"}</span>
              <IconChevronDown size={10} />
            </button>
            {showModelPicker && (
              <ModelPickerDropdown
                currentModel={settings.aiModel}
                onClose={() => setShowModelPicker(false)}
                maxHeight={modelMaxH}
              />
            )}
          </div>

          {/* Tools info */}
          <div className="relative" ref={toolsInfoRef}>
            <button
              className={`flex items-center gap-1 px-1.5 h-[26px] rounded text-[11px] transition-colors ${
                showToolsInfo
                  ? "bg-[var(--color-surface)] text-[var(--color-text)]"
                  : "text-[var(--color-text-secondary)] hover:text-[var(--color-text)] hover:bg-[var(--color-surface)]"
              }`}
              onClick={() => setShowToolsInfo(!showToolsInfo)}
              title="Available Tools"
            >
              <IconTool size={12} />
              <span>{availableTools.length}</span>
            </button>
            {showToolsInfo && (
              <div className="absolute bottom-full left-0 mb-1 w-[220px] bg-[var(--color-surface)] border border-[var(--color-border)] rounded-lg shadow-lg overflow-hidden z-20 flex flex-col" style={{ maxHeight: toolsMaxH }}>
                <div className="px-3 py-2 border-b border-[var(--color-border)] shrink-0">
                  <span className="text-[10px] font-medium text-[var(--color-text-secondary)] uppercase tracking-wider">Available Tools</span>
                </div>
                <div className="flex-1 overflow-y-auto py-1">
                  {availableTools.map((tool) => (
                    <div key={tool} className="flex items-center gap-2 px-3 py-1.5 text-[11px] text-[var(--color-text-secondary)]">
                      {tool.startsWith("read_") || tool === "list_project_files"
                        ? <IconFile size={11} />
                        : <IconWrench size={11} />}
                      <span>{tool}</span>
                    </div>
                  ))}
                </div>
              </div>
            )}
          </div>

          <div className="flex-1" />

          {/* Send button */}
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
      <div className="px-3.5 py-2">
        <div className="bg-[var(--color-surface-alt)] rounded-lg px-3 py-2 text-[13px] text-[var(--color-text)] whitespace-pre-wrap break-words leading-[1.6]">
          {message.content}
        </div>
      </div>
    );
  }

  if (message.role === "assistant" && message.tool_calls && message.tool_calls.length > 0) {
    return (
      <div className="px-3.5 py-1 space-y-1">
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
      <div className="px-3.5 py-2">
        <div className="text-[13px] text-[var(--color-text)] leading-[1.6]">
          <MarkdownContent content={message.content || ""} />
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

// ── Model list cache (module-level, survives re-renders) ─────────

const modelCache: { key: string; models: string[]; ts: number } = { key: "", models: [], ts: 0 };
const MODEL_CACHE_TTL = 5 * 60 * 1000; // 5 minutes

// ── Model Picker Dropdown ────────────────────────────────────────

function ModelPickerDropdown({
  currentModel,
  onClose,
  maxHeight,
}: {
  currentModel: string;
  onClose: () => void;
  maxHeight: number;
}) {
  const { settings, updateSetting } = useSettings();
  const [models, setModels] = useState<string[]>(modelCache.models);
  const [loadingModels, setLoadingModels] = useState(false);

  useEffect(() => {
    let cancelled = false;
    const cacheKey = `${settings.aiProvider}|${settings.aiEndpoint}|${settings.aiAuthMode}`;

    // Use cache if key matches and not expired
    if (modelCache.key === cacheKey && modelCache.models.length > 0 && Date.now() - modelCache.ts < MODEL_CACHE_TTL) {
      setModels(modelCache.models);
      return;
    }

    async function load() {
      setLoadingModels(true);
      try {
        const config = {
          provider: settings.aiProvider,
          endpoint: settings.aiEndpoint,
          api_key: settings.aiApiKey,
          model: settings.aiModel || "unused",
          bearer_token: settings.aiAuthMode === "azure_oauth" ? settings.aiAccessToken : null,
        };
        const result = await invoke<{ id: string; name: string }[]>("list_models", { config });
        if (!cancelled) {
          const ids = result.map((m) => m.id || m.name);
          modelCache.key = cacheKey;
          modelCache.models = ids;
          modelCache.ts = Date.now();
          setModels(ids);
        }
      } catch {
        if (!cancelled && currentModel) setModels([currentModel]);
      } finally {
        if (!cancelled) setLoadingModels(false);
      }
    }
    load();
    return () => { cancelled = true; };
  }, [settings, currentModel]);

  return (
    <div className="absolute bottom-full left-0 mb-1 w-[200px] bg-[var(--color-surface)] border border-[var(--color-border)] rounded-lg shadow-lg overflow-hidden z-20 flex flex-col" style={{ maxHeight }}>
      <div className="px-3 py-2 border-b border-[var(--color-border)] shrink-0">
        <span className="text-[10px] font-medium text-[var(--color-text-secondary)] uppercase tracking-wider">Model</span>
      </div>
      <div className="flex-1 overflow-y-auto py-1">
        {loadingModels ? (
          <div className="px-3 py-2 text-[11px] text-[var(--color-text-secondary)] italic">Loading…</div>
        ) : (
          models.map((model) => (
            <button
              key={model}
              className={`w-full flex items-center gap-2 px-3 py-1.5 text-left text-[11px] transition-colors ${
                model === currentModel
                  ? "text-[var(--color-accent)] bg-[var(--color-accent)]/5"
                  : "text-[var(--color-text-secondary)] hover:bg-[var(--color-surface-alt)] hover:text-[var(--color-text)]"
              }`}
              onClick={() => {
                updateSetting("aiModel", model);
                onClose();
              }}
            >
              {model === currentModel && (
                <svg width="10" height="10" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="3" strokeLinecap="round" strokeLinejoin="round">
                  <polyline points="20 6 9 17 4 12" />
                </svg>
              )}
              <span className={model === currentModel ? "" : "ml-[18px]"}>{model}</span>
            </button>
          ))
        )}
      </div>
    </div>
  );
}

// ── Helpers ──────────────────────────────────────────────────────

function FileTypeIcon({ type }: { type: string }) {
  const cls = "shrink-0 text-[var(--color-text-secondary)]";
  switch (type) {
    case "sketch":
      return <span className={cls}><SketchIcon size={12} /></span>;
    case "note":
      return <span className={cls}><NoteIcon size={12} /></span>;
    case "storyboard":
      return <span className={cls}><StoryboardIcon size={12} /></span>;
    case "web":
      return <span className={cls}><IconGlobe /></span>;
    default:
      return <span className={cls}><IconFile /></span>;
  }
}
