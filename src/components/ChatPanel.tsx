import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState, type ReactNode, type RefObject, type UIEvent } from "react";
import { commandErrorText, invoke } from "../services/tauri";
import { listenEvent } from "../ipc/events";
import { AgentRunInspector } from "./AgentRunInspector";
import { AgentStateDatabasePanel } from "./AgentStateDatabasePanel";
import { SessionHistoryPanel } from "./SessionHistoryPanel";
import { MessageRow, WorkingNotesInline } from "./chat/ChatMessageRow";
import { FileTypeIcon, typeColors } from "./chat/chatFileTypes";
import { NO_TOOL_ACTIVITY, describeToolCall, fetchWebReferenceContent, textContent } from "./chat/chatText";

import { clearSuppressedEditorFlush, suppressEditorFlush, useAppStore } from "../stores/appStore";
import { useChatStore } from "../stores/chatStore";
import { useVersioningStore } from "../stores/versioningStore";
import { useAiApplyGateStore } from "../stores/aiApplyGateStore";
import { useToastStore } from "../stores/toastStore";
import { loadProviderSecrets } from "../hooks/useSecretStore";
import { getContributorIdentity } from "../services/identity";
import { promoteChatArtifact } from "../contracts/chatPromotion";
import { useSettings, type AgentPreset, type AiReasoningEffort } from "../hooks/useSettings";
import { BUILT_IN_AGENTS, resolveAgentPrompt } from "../agents/builtInAgents";
import {
  activeProviderInput,
  buildProviderConfig,
  isAiProviderConfigured,
  isProviderInputConfigured,
  providerById,
  providerToConfigInput,
  supportedReasoningEfforts,
  supportsAgentReasoningEffort,
  normalizeReasoningEffort,
  filterAgentCompatibleModels,
} from "../utils/providerConfig";
import {
  buildEffectiveProviderInput as buildEffectiveProviderInputShared,
  buildRefreshedProviderInput,
  resolveEffectiveProvider,
  resolveAgentModelOverride,
} from "../utils/agentProvider";
import type { ChatMessage, ChatRunDetails, ChatToolActivity, ChatWorkingNotes } from "../types/sketch";
import {
  Sparkles,
  Brain,
  Clock,
  Send,
  FileText,
  Plus,
  Paperclip,
  ChevronDown,
  Check,
  User,
  X,
  Square,
  Activity,
  CircleHelp,
  Database,
  Maximize2,
  Minimize2,
  Pin,
} from "lucide-react";

export { describeToolCall, fetchWebReferenceContent, workingNotesPreview } from "./chat/chatText";

const CHAT_AUTO_SCROLL_THRESHOLD_PX = 48;
const TOOL_ACTIVITY_PREVIEW_MAX_CHARS = 1_200;

interface AgentContextItem {
  id: string;
  name: string;
  source: "user" | "system" | "tool_result" | "file" | "search" | "checkpoint" | "memory" | "host" | "custom";
  kind: "recent_turn" | "memory_fact" | "reference_doc" | "tool_observation" | "file_excerpt" | "web_excerpt" | "error_trace" | "media_summary" | "other";
  content: string;
  content_type?: string;
  priority?: number;
  origin?: string;
  persist?: boolean;
}

function boundedToolActivityResult(content: string): string {
  if (content.length <= TOOL_ACTIVITY_PREVIEW_MAX_CHARS) return content;
  return `${content.slice(0, TOOL_ACTIVITY_PREVIEW_MAX_CHARS).trimEnd()}\n\n[Tool result preview truncated]`;
}

export function toolResultActivityLevel(
  status: string | undefined,
  resultText: string,
): "success" | "warn" {
  if (status) return status === "success" ? "success" : "warn";
  return resultText.trimStart().startsWith("Error") ? "warn" : "success";
}

function formatContextBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  return `${(bytes / 1024).toFixed(bytes >= 10_240 ? 0 : 1)} KB`;
}

export function chatSessionTitle(messages: ChatMessage[]): string {
  const firstUserMessage = messages.find((message) => message.role === "user");
  const title = firstUserMessage ? textContent(firstUserMessage.content).replace(/\s+/g, " ").trim() : "";
  return title.slice(0, 120) || "Untitled conversation";
}

export async function resolveWebReferenceContent<T extends { path: string }>(
  references: T[],
  fetcher: (referenceUrl: string) => Promise<string> = fetchWebReferenceContent,
): Promise<Array<T & { webContent?: string; webStatus: "ready" | "error" }>> {
  return Promise.all(references.map(async (reference) => {
    try {
      return { ...reference, webContent: await fetcher(reference.path), webStatus: "ready" as const };
    } catch {
      return { ...reference, webStatus: "error" as const };
    }
  }));
}

export function isChatScrolledNearBottom(
  scrollState: Pick<HTMLElement, "scrollHeight" | "scrollTop" | "clientHeight">,
  thresholdPx = CHAT_AUTO_SCROLL_THRESHOLD_PX,
): boolean {
  return scrollState.scrollHeight - scrollState.scrollTop - scrollState.clientHeight <= thresholdPx;
}

export function scrollChatContainerToBottom(
  container: HTMLElement | null,
  endMarker: HTMLElement | null,
  behavior: ScrollBehavior = "auto",
): boolean {
  if (!container || !endMarker) return false;
  container.scrollTop = container.scrollHeight;
  endMarker.scrollIntoView({ behavior });
  return true;
}

export function applyStreamingDeltaReset(state: { buffer: string; visible: string; drafts?: string[] }) {
  const segment = state.buffer.trim();
  const drafts = segment && !state.drafts?.includes(segment)
    ? [...(state.drafts ?? []), segment]
    : (state.drafts ?? []);
  return { ...state, buffer: "", drafts };
}

export function buildChatWorkingNotes(input: { drafts: string[]; thinking: string }): ChatWorkingNotes | undefined {
  const drafts = input.drafts.map((draft) => draft.trim()).filter(Boolean);
  const thinking = input.thinking.trim();
  if (drafts.length === 0 && !thinking) return undefined;
  return {
    ...(drafts.length > 0 ? { drafts } : {}),
    ...(thinking ? { thinking } : {}),
  };
}

export function buildLiveChatWorkingNotes(input: { drafts: string[]; thinking: string; streamingText: string }): ChatWorkingNotes | undefined {
  const liveDrafts = input.streamingText.trim()
    ? [...input.drafts, input.streamingText]
    : input.drafts;
  return buildChatWorkingNotes({ drafts: liveDrafts, thinking: input.thinking });
}

export function extractInlineToolActivity(message: ChatMessage, followingMessages: ChatMessage[]): ChatToolActivity[] {
  const toolCalls = message.tool_calls ?? [];
  if (toolCalls.length === 0) return [];

  const toolResults = new Map<string, string>();
  for (const nextMessage of followingMessages) {
    if (nextMessage.role === "tool" && nextMessage.tool_call_id && !toolResults.has(nextMessage.tool_call_id)) {
      toolResults.set(nextMessage.tool_call_id, textContent(nextMessage.content));
    }
  }

  return toolCalls.map((toolCall) => ({
    id: toolCall.id,
    name: toolCall.function.name,
    arguments: toolCall.function.arguments,
    ...(toolResults.has(toolCall.id) ? { result: toolResults.get(toolCall.id) } : {}),
  }));
}

function hasToolCalls(message: ChatMessage): boolean {
  return (message.tool_calls?.length ?? 0) > 0;
}

/**
 * Inline tool activity for every message in one backward pass — equivalent to
 * calling extractInlineToolActivity(messages[i], messages.slice(i + 1)) per row,
 * without the per-render O(n²) slicing.
 */
export function buildInlineToolActivityIndex(messages: ChatMessage[]): ChatToolActivity[][] {
  const index: ChatToolActivity[][] = new Array(messages.length);
  const following = new Map<string, string>();
  for (let i = messages.length - 1; i >= 0; i -= 1) {
    const message = messages[i];
    index[i] = hasToolCalls(message)
      ? message.tool_calls!.map((toolCall) => ({
        id: toolCall.id,
        name: toolCall.function.name,
        arguments: toolCall.function.arguments,
        ...(following.has(toolCall.id) ? { result: following.get(toolCall.id) } : {}),
      }))
      : NO_TOOL_ACTIVITY;
    if (message.role === "tool" && message.tool_call_id) {
      following.set(message.tool_call_id, textContent(message.content));
    }
  }
  return index;
}

export function shouldRequestChatMutationApproval(applyMode: string): boolean {
  return applyMode === "ask";
}

export function canUseChatMutationTools(applyMode: string, askModeApproved: boolean): boolean {
  if (applyMode === "auto") return true;
  if (applyMode === "ask") return askModeApproved;
  return false;
}

export function askModeApprovedSystemInstruction(): string {
  return "AI apply behavior is set to Ask before applying. The user approved mutation tools for this chat turn, so you may use write or mutation tools when they are the right way to complete the request. The approval only applies to this turn; Settings > AI apply behavior can switch future turns to Auto-apply.";
}

export function askModeCancelledMessage(): string {
  return "Ask Mode is active, so I need approval before applying AI changes. I did not run write or mutation tools. To skip this prompt in future turns, choose Auto-apply from the approval dialog or change Settings > AI apply behavior to Auto-apply AI changes.";
}

export async function cancelAgentChatRun(
  clientRunId: string | number,
  cancel: (clientRunId: string) => Promise<unknown> = (id) =>
    invoke("cancel_agent_chat_run", { clientRunId: id }),
): Promise<void> {
  await cancel(clientRunId.toString());
}

// ── Types ────────────────────────────────────────────────────────

interface AgentChatResult {
  messages: ChatMessage[];
  response: string;
  provider: string;
  model: string;
  execution_engine: string;
  agent_id: string;
  run_id: string;
  elapsed_ms: number;
  reasoning_effort?: string | null;
  usage: {
    prompt_tokens: number;
    completion_tokens: number;
    total_tokens: number;
  };
  /** The user stopped the run; messages and response are empty. */
  cancelled?: boolean;
}

interface AgentModelRoutePreview {
  api_route: string;
  history_strategy: string;
  effective_reasoning_effort?: string | null;
}

export function providerRunLabel(provider: string | undefined): string {
  switch ((provider ?? "").toLowerCase()) {
    case "microsoft_foundry":
      return "Microsoft Foundry";
    case "azure_openai":
      return "Azure OpenAI";
    case "openai":
      return "OpenAI";
    case "anthropic":
      return "Anthropic";
    case "copilot-sdk":
      return "GitHub Copilot";
    default:
      return provider?.trim() || "—";
  }
}

export function harnessRunLabel(harness: string | undefined): string {
  switch ((harness ?? "").toLowerCase()) {
    case "prompty":
      return "Prompty";
    case "agentive":
      return "Agentive";
    case "copilot-sdk":
      return "GitHub Copilot";
    default:
      return harness?.trim() || "—";
  }
}

export function formatRunDuration(ms: number | undefined): string {
  if (typeof ms !== "number" || !Number.isFinite(ms) || ms < 0) return "—";
  if (ms < 1_000) return `${Math.round(ms)}ms`;
  const seconds = ms / 1_000;
  if (seconds < 60) return `${seconds.toFixed(seconds < 10 ? 1 : 0)}s`;
  const minutes = Math.floor(seconds / 60);
  const remainingSeconds = Math.round(seconds % 60);
  return `${minutes}m ${remainingSeconds}s`;
}

export function formatRunTokens(tokens: number | undefined): string {
  if (typeof tokens !== "number" || !Number.isFinite(tokens) || tokens < 0) return "—";
  return Math.round(tokens).toLocaleString();
}

const ROW_TARGETED_SKETCH_MUTATION_TOOLS = new Set([
  "update_planning_row",
  "set_row_visual",
  "design_plan",
  "apply_row_visual_nudge",
  "apply_row_visual_command",
]);
const SKETCH_MUTATION_TOOLS = new Set(["write_sketch", ...ROW_TARGETED_SKETCH_MUTATION_TOOLS]);
const STORYBOARD_MUTATION_TOOLS = new Set(["write_storyboard"]);

function parseNonNegativeInteger(value: unknown): number | null {
  if (typeof value === "number" && Number.isInteger(value) && value >= 0) return value;
  if (typeof value === "string" && /^\d+$/.test(value.trim())) return Number(value);
  return null;
}

function parseRowMutationIndex(args: Record<string, unknown>): number | null {
  const rowNumber = parseNonNegativeInteger(args.row_number);
  const index = parseNonNegativeInteger(args.index);
  if (rowNumber === 0) return null;
  const rowNumberIndex = rowNumber === null ? null : rowNumber - 1;
  if (rowNumberIndex !== null && index !== null && rowNumberIndex !== index) return null;
  return rowNumberIndex ?? index;
}

function consumeQueuedToolArgs(queue: Record<string, string[]>, toolName: string): string {
  const entries = queue[toolName];
  if (!entries || entries.length === 0) return "{}";
  const next = entries.shift() ?? "{}";
  if (entries.length === 0) delete queue[toolName];
  return next;
}

function sketchMutationInfo(toolName: string, argsJson: string, fallbackPath: string | null) {
  if (!SKETCH_MUTATION_TOOLS.has(toolName)) return null;
  try {
    const args = JSON.parse(argsJson || "{}");
    const path = typeof args.path === "string" ? args.path : fallbackPath;
    const changedRows: number[] = [];
    if (ROW_TARGETED_SKETCH_MUTATION_TOOLS.has(toolName)) {
      const idx = parseRowMutationIndex(args);
      if (idx !== null) changedRows.push(idx);
    }
    return { path, rows: changedRows, toolName };
  } catch {
    return { path: fallbackPath, rows: [], toolName };
  }
}

function extractSketchMutationsFromMessages(messages: ChatMessage[], fallbackPath: string | null) {
  const mutations: Array<{ path: string | null; rows: number[]; toolName: string }> = [];
  for (const message of messages) {
    for (const toolCall of message.tool_calls ?? []) {
      const info = sketchMutationInfo(toolCall.function.name, toolCall.function.arguments, fallbackPath);
      if (info) mutations.push(info);
    }
  }
  return mutations;
}

function sketchMutationKey(mutation: { path: string | null; rows: number[]; toolName: string }): string {
  const path = mutation.path?.trim().replace(/\\/g, "/") ?? "";
  const rows = mutation.rows.length > 0 ? [...mutation.rows].sort((a, b) => a - b).join(",") : "*";
  return `${mutation.toolName}:${path}:${rows}`;
}

function recordSketchMutation(
  counts: Map<string, number>,
  mutation: { path: string | null; rows: number[]; toolName: string },
) {
  const key = sketchMutationKey(mutation);
  counts.set(key, (counts.get(key) ?? 0) + 1);
}

function consumeRecordedSketchMutation(
  counts: Map<string, number>,
  mutation: { path: string | null; rows: number[]; toolName: string },
): boolean {
  const key = sketchMutationKey(mutation);
  const count = counts.get(key) ?? 0;
  if (count <= 0) return false;
  if (count === 1) counts.delete(key);
  else counts.set(key, count - 1);
  return true;
}

function normalizeStoryboardPath(path: string): string {
  const trimmed = path.trim().replace(/\\/g, "/");
  return trimmed.endsWith(".sb") ? trimmed : `${trimmed}.sb`;
}

function normalizeMutationPath(path: string | null | undefined): string | null {
  const normalized = path?.trim().replace(/\\/g, "/").replace(/^\.\/+/, "").replace(/^\/+/, "").replace(/\/+$/, "");
  return normalized || null;
}

function storyboardMutationInfo(toolName: string, argsJson: string, fallbackPath: string | null) {
  if (!STORYBOARD_MUTATION_TOOLS.has(toolName)) return null;
  try {
    const args = JSON.parse(argsJson || "{}");
    const path = typeof args.path === "string" ? normalizeStoryboardPath(args.path) : fallbackPath;
    return { path, toolName };
  } catch {
    return { path: fallbackPath, toolName };
  }
}

function extractStoryboardMutationsFromMessages(messages: ChatMessage[], fallbackPath: string | null) {
  const mutations: Array<{ path: string | null; toolName: string }> = [];
  for (const message of messages) {
    for (const toolCall of message.tool_calls ?? []) {
      const info = storyboardMutationInfo(toolCall.function.name, toolCall.function.arguments, fallbackPath);
      if (info) mutations.push(info);
    }
  }
  return mutations;
}

const REFERENCED_DOCUMENT_RE = /<referenced_document\b[^>]*>[\s\S]*?<\/referenced_document>/gi;
const WEB_CONTENT_RE = /\[Web Content:[^\]]+\][\s\S]*?(?=\n\[(?:Web|References):|\n{2,}\S|$)/gi;
const TRUNCATED_MARKER_RE = /\[Truncated at \d+ chars\]/gi;

function hasLlmOnlyReferencePayload(text: string): boolean {
  return /<\/?referenced_document\b/i.test(text)
    || /\[Web Content:/i.test(text)
    || /\[Truncated at \d+ chars\]/i.test(text);
}

function sanitizeUserDisplayContent(content: ChatMessage["content"]): ChatMessage["content"] {
  if (typeof content !== "string") return content;
  return content
    .replace(REFERENCED_DOCUMENT_RE, "")
    .replace(WEB_CONTENT_RE, "")
    .replace(TRUNCATED_MARKER_RE, "")
    .trim();
}

export function reconcileMessagesForDisplay(
  backendMessages: ChatMessage[],
  displayMessages: ChatMessage[],
  options: {
    silent?: boolean;
    assistantResponse?: string;
    logger?: (message: string, details: Record<string, unknown>) => void;
  } = {},
): ChatMessage[] {
  const nonSystemMessages = backendMessages.filter((m) => m.role !== "system");
  const displayNonSystemMessages = displayMessages.filter((m) => m.role !== "system");
  const displayUsers = displayMessages.filter((m) => m.role === "user");
  const lastUserMsgIdx = nonSystemMessages.reduce((idx, m, i) => m.role === "user" ? i : idx, -1);
  let userOrdinal = 0;

  const assistantResponse = options.assistantResponse?.trim();

  return nonSystemMessages
    .map((message, index) => {
      if (options.silent && index === lastUserMsgIdx) return null;
      const displayMessage = displayNonSystemMessages[index];
      if (message.role !== "user") {
        if (displayMessage?.role === message.role && displayMessage.cutready) {
          return { ...message, cutready: displayMessage.cutready };
        }
        return message;
      }

      const displayUser = displayUsers[userOrdinal++];
      const backendText = textContent(message.content);
      if (!displayUser && assistantResponse && backendText.trim() === assistantResponse) {
        options.logger?.("Dropped backend user message that duplicated assistant response", {
          index,
          userOrdinal,
          backendChars: backendText.length,
        });
        return null;
      }

      const restoredContent = displayUser?.content ?? sanitizeUserDisplayContent(message.content);
      const restoredText = textContent(restoredContent);
      const leakedReferencePayload = hasLlmOnlyReferencePayload(backendText);
      const changedContent = restoredText !== backendText;

      if (!displayUser || leakedReferencePayload || changedContent) {
        options.logger?.("Restored display-safe user chat content", {
          index,
          userOrdinal,
          leakedReferencePayload,
          hadDisplayUser: Boolean(displayUser),
          backendChars: backendText.length,
          restoredChars: restoredText.length,
        });
      }

      return { ...message, content: restoredContent, cutready: displayUser?.cutready };
    })
    .filter((message): message is ChatMessage => message !== null);
}

export interface FileReference {
  type: "sketch" | "note" | "storyboard" | "chat-artifact" | "web";
  path: string;
  title: string;
  /** Cached web content (only for type: "web"). */
  webContent?: string;
  /** Fetch status for web refs. */
  webStatus?: "queued" | "loading" | "ready" | "error";
  /** Keep a locally fetched web snapshot available to future project chats. */
  persist?: boolean;
}

const FILE_REFERENCE_ALIASES: Record<string, Exclude<FileReference["type"], "web">> = {
  chat: "chat-artifact",
  "chat-artifact": "chat-artifact",
  note: "note",
  sketch: "sketch",
  storyboard: "storyboard",
};

function normalizeMentionToken(value: string): string {
  return value.trim().replace(/[),.;!?]+$/g, "");
}

function pathBaseName(path: string): string {
  const name = path.split(/[\\/]/).pop() ?? path;
  return name.replace(/\.[^.]+$/, "");
}

function referenceTypeLabel(type: FileReference["type"] | string): string {
  return type === "chat-artifact" ? "chat" : type;
}

function sameReference(a: Pick<FileReference, "type" | "path">, b: Pick<FileReference, "type" | "path">): boolean {
  return a.type === b.type && a.path === b.path;
}

function findMentionFileReference(token: string, files: FileReference[]): FileReference | null {
  const prefixed = token.match(/^([^:]+):(.+)$/i);
  const requestedType = prefixed
    ? FILE_REFERENCE_ALIASES[prefixed[1].toLowerCase()]
    : undefined;
  const query = normalizeMentionToken(prefixed?.[2] ?? token).toLowerCase();
  if (!query) return null;

  return files.find((file) => {
    if (requestedType && file.type !== requestedType) return false;
    const title = file.title.toLowerCase();
    const path = file.path.toLowerCase();
    return title === query || path === query || pathBaseName(path) === query;
  }) ?? null;
}

export function extractMentionReferences(
  text: string,
  files: FileReference[],
  existing: FileReference[] = [],
): FileReference[] {
  const found: FileReference[] = [];
  const addReference = (reference: FileReference) => {
    if (existing.some((item) => sameReference(item, reference))) return;
    if (found.some((item) => sameReference(item, reference))) return;
    found.push(reference);
  };

  for (const match of text.matchAll(/@(?:web:)?(https?:\/\/[^\s<>"']+)/gi)) {
    const url = normalizeMentionToken(match[1]);
    addReference({ type: "web", path: url, title: url, webStatus: "queued" });
  }

  for (const match of text.matchAll(/@(?:"([^"]+)"|([^\s,;!?)\]}]+))/g)) {
    const token = normalizeMentionToken(match[1] ?? match[2] ?? "");
    if (!token || /^(?:web:)?https?:\/\//i.test(token)) continue;
    const prefix = token.match(/^([^:]+):/)?.[1].toLowerCase();
    if (prefix && !FILE_REFERENCE_ALIASES[prefix]) continue;
    const file = findMentionFileReference(token, files);
    if (file) addReference(file);
  }

  return found;
}

type SecondaryTab = "chat" | "sessions" | "runs" | "database";

// ── SVG Icons (using Heroicons) ──────────────────────────────────

function IconSparkles({ size = 14 }: { size?: number }) {
  return <Sparkles width={size} height={size} />;
}

function IconRuns({ size = 14 }: { size?: number }) {
  return <Activity width={size} height={size} />;
}

function IconSessions({ size = 14 }: { size?: number }) {
  return <Clock width={size} height={size} />;
}

function IconDatabase({ size = 14 }: { size?: number }) {
  return <Database width={size} height={size} />;
}

function IconSend({ size = 14 }: { size?: number }) {
  return <Send width={size} height={size} />;
}

function IconPlus({ size = 14 }: { size?: number }) {
  return <Plus width={size} height={size} />;
}


function IconPaperclip({ size = 14 }: { size?: number }) {
  return <Paperclip width={size} height={size} />;
}

function IconChevronDown({ size = 10 }: { size?: number }) {
  return <ChevronDown width={size} height={size} />;
}

function IconCheck({ size = 12 }: { size?: number }) {
  return <Check width={size} height={size} className="ml-auto shrink-0" />;
}

function IconUser({ size = 12 }: { size?: number }) {
  return <User width={size} height={size} />;
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

export function ChatPanel({ focusMode = false }: { focusMode?: boolean }) {
  const [activeTab, setActiveTab] = useState<SecondaryTab>("chat");
  const tabs: Array<{ id: SecondaryTab; label: string; icon: ReactNode }> = [
    { id: "chat", label: "Chat", icon: <IconSparkles size={13} /> },
    { id: "sessions", label: "Session History", icon: <IconSessions size={13} /> },
    { id: "runs", label: "Runs", icon: <IconRuns size={13} /> },
    { id: "database", label: "Database", icon: <IconDatabase size={13} /> },
  ];
  const rail = (
    <nav className="no-select flex w-12 shrink-0 flex-col items-center gap-1.5 border-l border-[rgb(var(--color-border))] bg-[rgb(var(--color-surface))] py-3">
      {tabs.map((tab) => {
        const isActive = activeTab === tab.id;
        return (
          <button
            key={tab.id}
            onClick={() => setActiveTab(tab.id)}
            className={`relative flex h-10 w-10 items-center justify-center rounded-lg transition-colors ${
              isActive
                ? "bg-[rgb(var(--color-accent))]/15 text-[rgb(var(--color-accent))]"
                : "text-[rgb(var(--color-text-secondary))] hover:bg-[rgb(var(--color-surface-alt))] hover:text-[rgb(var(--color-text))]"
            }`}
            title={tab.label}
            aria-label={tab.label}
            aria-pressed={isActive}
          >
            {tab.icon}
            {isActive && (
              <span className="absolute right-[-6px] top-1/4 h-1/2 w-[2px] rounded-full bg-[rgb(var(--color-accent))]" />
            )}
          </button>
        );
      })}
    </nav>
  );

  if (focusMode) {
    return (
      <div className="flex h-full bg-[rgb(var(--color-surface-inset))]">
        <div className="flex-1 min-w-0 min-h-0">
          <ChatTab focusMode />
        </div>
      </div>
    );
  }

  return (
    <div className="flex h-full bg-[rgb(var(--color-surface-inset))]">
      {/* Tab content */}
      <div className="flex-1 min-w-0 min-h-0">
        {activeTab === "chat" && <ChatTab />}
        {activeTab === "sessions" && <SessionHistoryPanel onOpenChat={() => setActiveTab("chat")} />}
        {activeTab === "runs" && <AgentRunInspector />}
        {activeTab === "database" && <AgentStateDatabasePanel />}
      </div>

      {rail}
    </div>
  );
}

// ── Chat Tab ─────────────────────────────────────────────────────

function ChatTab({ focusMode = false }: { focusMode?: boolean }) {
  const { settings, updateSetting, loaded: settingsLoaded, oauthRefreshPending } = useSettings();
  const chatFocusMode = useChatStore((s) => s.chatFocusMode);
  const setChatFocusMode = useChatStore((s) => s.setChatFocusMode);
  const currentProject = useAppStore((s) => s.currentProject);
  const sketches = useAppStore((s) => s.sketches);
  const notes = useAppStore((s) => s.notes);
  const storyboards = useAppStore((s) => s.storyboards);
  const chatArtifacts = useAppStore((s) => s.chatArtifacts);
  const activeSketchPath = useAppStore((s) => s.activeSketchPath);
  const activeStoryboardPath = useAppStore((s) => s.activeStoryboardPath);
  const activeNotePath = useAppStore((s) => s.activeNotePath);
  const messages = useChatStore((s) => s.chatMessages);
  const setChatMessages = useChatStore((s) => s.setChatMessages);
  const inlineToolActivity = useMemo(() => buildInlineToolActivityIndex(messages), [messages]);
  const deleteMessage = useCallback((index: number, message: ChatMessage) => {
    const current = useChatStore.getState().chatMessages;
    // The row's index can go stale if history changed after render; fall back to identity.
    const target = current[index] === message ? index : current.indexOf(message);
    if (target < 0) return;
    setChatMessages(current.filter((_, idx) => idx !== target));
  }, [setChatMessages]);
  const loading = useChatStore((s) => s.chatLoading);
  const setChatLoading = useChatStore((s) => s.setChatLoading);
  const error = useChatStore((s) => s.chatError);
  const setChatError = useChatStore((s) => s.setChatError);
  const input = useChatStore((s) => s.chatInputDraft);
  const setInput = useChatStore((s) => s.setChatInputDraft);
  const addActivityEntries = useAppStore((s) => s.addActivityEntries);
  const chatSessionPath = useChatStore((s) => s.chatSessionPath);
  const newChatSession = useChatStore((s) => s.newChatSession);
  const loadSketches = useAppStore((s) => s.loadSketches);
  const loadNotes = useAppStore((s) => s.loadNotes);
  const loadChatArtifacts = useAppStore((s) => s.loadChatArtifacts);
  const loadStoryboards = useAppStore((s) => s.loadStoryboards);
  const checkDirty = useVersioningStore((s) => s.checkDirty);
  const refreshChangedFiles = useVersioningStore((s) => s.refreshChangedFiles);
  const openSketch = useAppStore((s) => s.openSketch);
  const openNote = useAppStore((s) => s.openNote);
  const openChatArtifact = useAppStore((s) => s.openChatArtifact);
  const openStoryboard = useAppStore((s) => s.openStoryboard);
  const pendingChatPrompt = useChatStore((s) => s.pendingChatPrompt);
  const showToast = useToastStore((s) => s.show);

  const [references, setReferences] = useState<FileReference[]>([]);
  const [showAutocomplete, setShowAutocomplete] = useState(false);
  const [autocompleteFilter, setAutocompleteFilter] = useState("");
  const [autocompleteIndex, setAutocompleteIndex] = useState(0);
  const [showContextPicker, setShowContextPicker] = useState(false);
  const [contextFilter, setContextFilter] = useState("");
  const [showModelPicker, setShowModelPicker] = useState(false);
  const [showReasoningPicker, setShowReasoningPicker] = useState(false);
  const [showAgentPicker, setShowAgentPicker] = useState(false);
  const [promotingChat, setPromotingChat] = useState(false);
  const [expandedWebRef, setExpandedWebRef] = useState<string | null>(null);
  const streamingText = useChatStore((s) => s.chatStreamingText);
  const streamingThinking = useChatStore((s) => s.chatStreamingThinking);
  const streamingStatus = useChatStore((s) => s.chatStreamingStatus);
  const streamingDrafts = useChatStore((s) => s.chatStreamingDrafts);
  const setChatStreamingState = useChatStore((s) => s.setChatStreamingState);
  const resetChatStreaming = useChatStore((s) => s.resetChatStreaming);

  // Listen for streaming agent events from the backend
  const streamingRef = useRef("");
  const thinkingRef = useRef("");
  const workingDraftsRef = useRef<string[]>([]);
  const abortedRef = useRef(false);
  // Globally-unique run id (UUID) rather than a component-local counter, so
  // concurrent chat panels can't mint colliding ids and steer each other's runs.
  const activePreflightSendIdRef = useRef<string | null>(null);
  const pendingToolArgsRef = useRef<Record<string, string[]>>({});
  const handledSketchMutationsRef = useRef<Map<string, number>>(new Map());

  useEffect(() => {
    streamingRef.current = streamingText;
    thinkingRef.current = streamingThinking;
    workingDraftsRef.current = streamingDrafts;
  }, [streamingDrafts, streamingText, streamingThinking]);
  const liveWorkingNotes = useMemo(
    () => buildLiveChatWorkingNotes({
      drafts: streamingDrafts,
      thinking: streamingThinking,
      streamingText,
    }),
    [streamingDrafts, streamingText, streamingThinking],
  );
  const refreshSketchAfterMutation = useCallback((mutation: { path: string | null; rows: number[]; toolName: string }) => {
    const mutationPath = normalizeMutationPath(mutation.path);
    const fallbackPath = normalizeMutationPath(useAppStore.getState().activeSketchPath);
    const affectedPath = mutationPath ?? fallbackPath;
    if (affectedPath) suppressEditorFlush(affectedPath);
    void loadSketches();
    window.dispatchEvent(new CustomEvent("cutready:ai-sketch-updated", { detail: mutation }));
    const reload = mutationPath ? openSketch(mutationPath) : Promise.resolve();
    void reload.finally(() => {
      if (affectedPath) {
        globalThis.setTimeout(() => clearSuppressedEditorFlush(affectedPath), 100);
      }
    });
    void checkDirty();
    void refreshChangedFiles();
  }, [checkDirty, loadSketches, openSketch, refreshChangedFiles]);
  const refreshStoryboardAfterMutation = useCallback((mutation: { path: string | null; toolName: string }) => {
    const mutationPath = normalizeMutationPath(mutation.path);
    if (mutationPath) suppressEditorFlush(mutationPath);
    void loadStoryboards();
    window.dispatchEvent(new CustomEvent("cutready:ai-storyboard-updated", { detail: mutation }));
    const reload = mutationPath ? openStoryboard(mutationPath) : Promise.resolve();
    void reload.finally(() => {
      if (mutationPath) {
        globalThis.setTimeout(() => clearSuppressedEditorFlush(mutationPath), 100);
      }
    });
    void checkDirty();
    void refreshChangedFiles();
  }, [checkDirty, loadStoryboards, openStoryboard, refreshChangedFiles]);
  useEffect(() => {
    const shouldListen = focusMode || !chatFocusMode;
    if (!shouldListen) return;
    const unlisten = listenEvent("agent-event", (event) => {
      const ev = event.payload;
      if (
        ev.client_run_id
        && ev.client_run_id !== activePreflightSendIdRef.current?.toString()
      ) {
        return;
      }
      switch (ev.type) {
        case "delta":
          streamingRef.current += ev.content ?? "";
          setChatStreamingState({ chatStreamingText: streamingRef.current });
          break;
        case "delta_reset":
          // Anthropic can stream pre-tool prose, then reset for a new tool round.
          // Keep the visible draft stable while clearing only the next-token buffer.
          const resetState = applyStreamingDeltaReset({
            buffer: streamingRef.current,
            visible: "",
            drafts: workingDraftsRef.current,
          });
          streamingRef.current = resetState.buffer;
          workingDraftsRef.current = resetState.drafts;
          setChatStreamingState({
            chatStreamingText: resetState.buffer,
            chatStreamingDrafts: resetState.drafts,
          });
          break;
        case "thinking":
          thinkingRef.current += ev.content ?? "";
          setChatStreamingState({ chatStreamingThinking: thinkingRef.current });
          break;
        case "status":
          setChatStreamingState({ chatStreamingStatus: ev.message ?? "" });
          // Compaction status events get injected as visible system messages in chat
          if (ev.message && ev.message.startsWith("Compacting context")) {
            setChatMessages([...useChatStore.getState().chatMessages, { role: "system", content: ev.message! }]);
          }
          addActivityEntries([{
            id: crypto.randomUUID(),
            timestamp: new Date(),
            source: "status",
            content: ev.message ?? "",
            level: ev.message?.startsWith("Dropped packed context") ? "warn" : "info",
          }]);
          break;
        case "context_prepared": {
          const selected = ev.selected_count ?? 0;
          const dropped = ev.dropped_count ?? 0;
          const content = `Context prepared: ${selected} item${selected === 1 ? "" : "s"} · ${formatContextBytes(ev.total_bytes ?? 0)}${dropped > 0 ? ` · ${dropped} omitted` : ""}`;
          setChatStreamingState({ chatStreamingStatus: content });
          addActivityEntries([{
            id: crypto.randomUUID(),
            timestamp: new Date(),
            source: "context",
            content,
            level: "info",
          }]);
          break;
        }
        case "context_sent": {
          const content = `Context sent to provider${ev.attempt ? ` · retry ${ev.attempt}` : ""}`;
          setChatStreamingState({ chatStreamingStatus: content });
          addActivityEntries([{
            id: crypto.randomUUID(),
            timestamp: new Date(),
            source: "context",
            content,
            level: "info",
          }]);
          break;
        }
        case "tool_call":
          if (streamingRef.current.trim()) {
            const resetState = applyStreamingDeltaReset({
              buffer: streamingRef.current,
              visible: "",
              drafts: workingDraftsRef.current,
            });
            streamingRef.current = resetState.buffer;
            workingDraftsRef.current = resetState.drafts;
            setChatStreamingState({
              chatStreamingText: resetState.buffer,
              chatStreamingDrafts: resetState.drafts,
            });
          }
          // Stash args so tool_result can use them (e.g. to extract path)
          if (ev.name) {
            const queue = pendingToolArgsRef.current[ev.name] ?? [];
            queue.push(ev.arguments ?? "{}");
            pendingToolArgsRef.current[ev.name] = queue;
          }
          addActivityEntries([{
            id: crypto.randomUUID(),
            timestamp: new Date(),
            source: ev.name ?? "tool",
            content: describeToolCall(ev.name ?? "tool", ev.arguments ?? "{}"),
            level: "info",
          }]);
          break;
        case "tool_result": {
          const toolName = ev.name ?? "";
          const resultText = ev.result ?? "";
          // Prefer the explicit host-owned outcome; fall back to text inspection
          // only for historical events that predate the status field.
          const level = toolResultActivityLevel(ev.status, resultText);
          const isSuccess = level === "success";
          addActivityEntries([{
            id: crypto.randomUUID(),
            timestamp: new Date(),
            source: `result ${ev.name ?? ""}`.trim(),
            content: boundedToolActivityResult(resultText),
            level,
          }]);
          // Auto-refresh sidebar and open sketches after tool mutations
          if (isSuccess && SKETCH_MUTATION_TOOLS.has(toolName)) {
            const argsJson = consumeQueuedToolArgs(pendingToolArgsRef.current, toolName);
            const mutation = sketchMutationInfo(toolName, argsJson, useAppStore.getState().activeSketchPath);
            if (mutation) {
              recordSketchMutation(handledSketchMutationsRef.current, mutation);
              refreshSketchAfterMutation(mutation);
            }
          }
          if (isSuccess && toolName === "write_note") {
            loadNotes();
            let notePath: string | null = null;
            try {
              const args = JSON.parse(consumeQueuedToolArgs(pendingToolArgsRef.current, toolName));
              notePath = typeof args.path === "string" ? args.path : null;
              if (notePath && notePath !== useAppStore.getState().activeNotePath) {
                openNote(notePath);
              }
            } catch { /* ignore parse errors */ }
            window.dispatchEvent(new CustomEvent("cutready:ai-note-updated", { detail: { path: notePath } }));
          }
          if (isSuccess && toolName === "write_storyboard") {
            const argsJson = consumeQueuedToolArgs(pendingToolArgsRef.current, toolName);
            const mutation = storyboardMutationInfo(toolName, argsJson, useAppStore.getState().activeStoryboardPath);
            if (mutation) refreshStoryboardAfterMutation(mutation);
          }
          break;
        }
        case "agent_start":
          addActivityEntries([{
            id: crypto.randomUUID(),
            timestamp: new Date(),
            source: `delegate:${ev.agent_id ?? "agent"}`,
            content: `🤖 Agent "${ev.agent_id}" started: ${ev.task ?? ""}`,
            level: "info",
          }]);
          setChatStreamingState({ chatStreamingStatus: `Agent "${ev.agent_id}" working…` });
          break;
        case "agent_done":
          addActivityEntries([{
            id: crypto.randomUUID(),
            timestamp: new Date(),
            source: `delegate:${ev.agent_id ?? "agent"}`,
            content: `✓ Agent "${ev.agent_id}" finished`,
            level: "success",
          }]);
          break;
        case "done":
          // Final response handled by the invoke return
          break;
        case "error":
          addActivityEntries([{
            id: crypto.randomUUID(),
            timestamp: new Date(),
            source: "error",
            content: ev.message ?? "",
            level: "error",
          }]);
          break;
      }
    });
    return () => { unlisten.then((f) => f()); };
  }, [addActivityEntries, chatFocusMode, focusMode, loadNotes, openNote, refreshSketchAfterMutation, refreshStoryboardAfterMutation, setChatStreamingState]);

  const messagesContainerRef = useRef<HTMLDivElement>(null);
  const messagesEndRef = useRef<HTMLDivElement>(null);
  const shouldStickToBottomRef = useRef(true);
  const initiallyScrolledSessionRef = useRef<string | null>(null);
  const inputRef = useRef<HTMLTextAreaElement>(null);
  const autocompleteRef = useRef<HTMLDivElement>(null);
  const contextPickerRef = useRef<HTMLDivElement>(null);
  const modelPickerRef = useRef<HTMLDivElement>(null);
  const reasoningPickerRef = useRef<HTMLDivElement>(null);
  const agentPickerRef = useRef<HTMLDivElement>(null);

  // Constrain dropdown heights to available viewport space
  const acMaxH = useDropdownMaxHeight(autocompleteRef, showAutocomplete);
  const ctxMaxH = useDropdownMaxHeight(contextPickerRef, showContextPicker);
  const modelMaxH = useDropdownMaxHeight(modelPickerRef, showModelPicker);
  const agentMaxH= useDropdownMaxHeight(agentPickerRef, showAgentPicker);

  // All agents: built-ins + custom
  const allAgents = useMemo(() => {
    const custom = settings.aiAgents || [];
    return [...BUILT_IN_AGENTS, ...custom];
  }, [settings.aiAgents]);

  const selectedAgent = useMemo(() => {
    const id = settings.aiSelectedAgent || "planner";
    return allAgents.find((a) => a.id === id) ?? BUILT_IN_AGENTS[0];
  }, [settings.aiSelectedAgent, allAgents]);
  const effectiveProvider = useMemo(
    () => resolveEffectiveProvider(settings, selectedAgent),
    [settings, selectedAgent],
  );
  const selectedAgentModelOverride = useMemo(
    () => resolveAgentModelOverride(selectedAgent, settings.aiAgentModelOverrides),
    [selectedAgent, settings.aiAgentModelOverrides],
  );
  const selectedAgentModelOverrideMetadata = selectedAgentModelOverride
    ? settings.aiAgentModelOverrideMetadata?.[selectedAgent.id]
    : undefined;
  const matchingSelectedAgentModelOverrideMetadata =
    selectedAgentModelOverrideMetadata?.model && selectedAgentModelOverrideMetadata.model !== selectedAgentModelOverride
      ? undefined
      : selectedAgentModelOverrideMetadata;
  const effectiveModel = selectedAgentModelOverride || effectiveProvider?.model || settings.aiModel || "";
  const effectiveModelReasoningEfforts = selectedAgentModelOverride ? matchingSelectedAgentModelOverrideMetadata?.modelReasoningEfforts ?? "" : settings.aiModelReasoningEfforts;
  const effectiveModelBaseModel = selectedAgentModelOverride ? matchingSelectedAgentModelOverrideMetadata?.modelBaseModel ?? "" : (effectiveProvider?.modelBaseModel || settings.aiModelBaseModel || "");
  const reasoningEfforts = useMemo(
    () => {
      if (settings.aiAgentExecutionEngine === "copilot-sdk") {
        return [];
      }
      if (!supportsAgentReasoningEffort(effectiveModel, effectiveModelBaseModel)) {
        return [];
      }
      return supportedReasoningEfforts(effectiveProvider?.provider, effectiveModel, effectiveModelReasoningEfforts, effectiveModelBaseModel);
    },
    [effectiveModel, effectiveModelBaseModel, effectiveModelReasoningEfforts, effectiveProvider?.provider, settings.aiAgentExecutionEngine],
  );
  const effectiveReasoningEffort = useMemo(
    () => settings.aiAgentExecutionEngine === "copilot-sdk"
      ? ""
      : normalizeReasoningEffort(settings.aiReasoningEffort, effectiveProvider?.provider, effectiveModel, effectiveModelReasoningEfforts, effectiveModelBaseModel),
    [effectiveModel, effectiveModelBaseModel, effectiveModelReasoningEfforts, effectiveProvider?.provider, settings.aiAgentExecutionEngine, settings.aiReasoningEffort],
  );
  const latestRunDetails = useMemo(() => {
    for (let i = messages.length - 1; i >= 0; i -= 1) {
      const runDetails = messages[i].cutready?.runDetails;
      if (runDetails) return runDetails;
    }
    return null;
  }, [messages]);
  const visibleRunDetails = useMemo<ChatRunDetails>(() => latestRunDetails ?? {
    provider: effectiveProvider?.provider ?? "",
    model: effectiveModel,
    execution_engine: settings.aiAgentExecutionEngine || "prompty",
    agent_id: selectedAgent.id,
    reasoning_effort: effectiveReasoningEffort || null,
  }, [effectiveModel, effectiveProvider?.provider, effectiveReasoningEffort, latestRunDetails, selectedAgent.id, settings.aiAgentExecutionEngine]);
  const [providerConfigured, setProviderConfigured] = useState<boolean | null>(null);

  const handleMessagesScroll = useCallback((event: UIEvent<HTMLDivElement>) => {
    shouldStickToBottomRef.current = isChatScrolledNearBottom(event.currentTarget);
  }, []);

  const scrollMessagesToBottom = useCallback((behavior: ScrollBehavior = "auto") => {
    return scrollChatContainerToBottom(messagesContainerRef.current, messagesEndRef.current, behavior);
  }, []);

  useLayoutEffect(() => {
    if (!currentProject || providerConfigured !== true) return;
    if (messages.length === 0) return;
    const sessionKey = chatSessionPath ?? "__local__";
    if (initiallyScrolledSessionRef.current === sessionKey) return;
    if (!scrollMessagesToBottom("auto")) return;
    requestAnimationFrame(() => scrollMessagesToBottom("auto"));
    shouldStickToBottomRef.current = true;
    initiallyScrolledSessionRef.current = sessionKey;
  }, [chatSessionPath, currentProject, messages.length, providerConfigured, scrollMessagesToBottom]);

  // Auto-scroll only while the user is already following the bottom of the chat.
  useEffect(() => {
    if (!shouldStickToBottomRef.current) return;
    scrollMessagesToBottom("auto");
  }, [messages, scrollMessagesToBottom, streamingStatus, streamingText, streamingThinking]);

  // Click-outside to close pickers
  useEffect(() => {
    if (!showContextPicker && !showModelPicker && !showReasoningPicker && !showAgentPicker) return;
    const handle = (e: MouseEvent) => {
      if (showContextPicker && contextPickerRef.current && !contextPickerRef.current.contains(e.target as Node)) setShowContextPicker(false);
      if (showModelPicker && modelPickerRef.current && !modelPickerRef.current.contains(e.target as Node)) setShowModelPicker(false);
      if (showReasoningPicker && reasoningPickerRef.current && !reasoningPickerRef.current.contains(e.target as Node)) setShowReasoningPicker(false);
      if (showAgentPicker && agentPickerRef.current && !agentPickerRef.current.contains(e.target as Node)) setShowAgentPicker(false);
    };
    window.addEventListener("mousedown", handle);
    return () => window.removeEventListener("mousedown", handle);
  }, [showContextPicker, showModelPicker, showReasoningPicker, showAgentPicker]);

  // All referenceable files
  const allFiles = useMemo<FileReference[]>(() => {
    const files: FileReference[] = [];
    for (const s of sketches) files.push({ type: "sketch", path: s.path, title: s.title });
    for (const n of notes) files.push({ type: "note", path: n.path, title: n.title });
    for (const sb of storyboards) files.push({ type: "storyboard", path: sb.path, title: sb.title });
    for (const chat of chatArtifacts) files.push({ type: "chat-artifact", path: chat.path, title: chat.title });
    return files;
  }, [sketches, notes, storyboards, chatArtifacts]);

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

  const buildEffectiveProviderInput = useCallback(
    (agent: AgentPreset) => buildEffectiveProviderInputShared(settings, agent),
    [settings],
  );

  useEffect(() => {
    if (!settingsLoaded) {
      setProviderConfigured(null);
      return;
    }

    let cancelled = false;
    setProviderConfigured(null);
    void buildEffectiveProviderInput(selectedAgent)
      .then((input) => {
        if (!cancelled) setProviderConfigured(isProviderInputConfigured(input));
      })
      .catch(() => {
        if (!cancelled) {
          setProviderConfigured(
            isAiProviderConfigured(settings) || isProviderInputConfigured(activeProviderInput(settings)),
          );
        }
      });

    return () => {
      cancelled = true;
    };
  }, [buildEffectiveProviderInput, selectedAgent, settings, settingsLoaded]);

  // Build system prompt from selected agent
  const [memoryContext, setMemoryContext] = useState("");

  // Load memory context when project opens
  useEffect(() => {
    invoke<string>("get_memory_context")
      .then(setMemoryContext)
      .catch(() => setMemoryContext(""));
  }, [activeSketchPath]);

  const persistChatSession = useCallback(async (sessionId: string, transcript: ChatMessage[]) => {
    if (!currentProject || transcript.length === 0) return;
    await invoke("save_chat_session", {
      sessionId,
      title: chatSessionTitle(transcript),
      messages: transcript,
      metadata: {
        source: "chat_panel",
        transcript_format: 1,
      },
    });
    window.dispatchEvent(new CustomEvent("cutready:chat-sessions-updated"));
  }, [currentProject]);

  // Keep Rust-side chat summary in sync so window close can archive reliably.
  // Updates whenever messages change (debounced by React's batching). The
  // originating project is captured synchronously here (from the same committed
  // render as the messages) and passed to Rust, so a project switch that races
  // this async invoke cannot rebind the summary to the wrong project.
  useEffect(() => {
    if (messages.length > 1 && chatSessionPath) {
      const userMsgs = messages.filter((m) => m.role === "user");
      const summary = userMsgs.map((m) => textContent(m.content).slice(0, 100)).filter(Boolean).join("; ");
      if (summary) {
        invoke("update_chat_summary", {
          sessionId: chatSessionPath,
          summary: `Topics discussed: ${summary}`,
          originRepoRoot: currentProject?.repo_root,
          originRoot: currentProject?.root,
        }).catch(() => {});
      }
    }
  }, [messages, chatSessionPath, currentProject]);

  const systemPrompt = useMemo(() => {
    const agentId = settings.aiSelectedAgent || "planner";
    const customAgents = settings.aiAgents || [];
    let prompt = resolveAgentPrompt(agentId, customAgents);
    if (memoryContext) {
      prompt += `\n${memoryContext}`;
    }
    if (activeSketchPath) {
      prompt += `\n\nThe user is currently editing the sketch at: ${activeSketchPath}`;
    }
    if (activeStoryboardPath) {
      prompt += `\n\nThe user is currently editing the storyboard at: ${activeStoryboardPath}. Use the read_storyboard tool with this path to see its sequence and description before making suggestions.`;
    }
    if (activeNotePath) {
      prompt += `\n\nThe user is currently editing the note at: ${activeNotePath}. Use the read_note tool with this path to see its contents before making suggestions.`;
    }
    return prompt;
  }, [settings.aiSelectedAgent, settings.aiAgents, activeSketchPath, activeStoryboardPath, activeNotePath, memoryContext]);

  const handleSend = useCallback(async (overrideText?: string, opts?: { silent?: boolean; agent?: string }) => {
    const text = (overrideText ?? input).trim().replace(/\r\n/g, "\n");
    if (!text) return;
    const silent = opts?.silent ?? false;
    const agentOverride = opts?.agent;
    shouldStickToBottomRef.current = true;

    if (loading && activePreflightSendIdRef.current !== null) return;

    setInput("");
    setShowAutocomplete(false);
    setShowContextPicker(false);

    // If agent is already running, push to the run's steering queue.
    if (loading) {
      try {
        const delivered = await invoke<boolean>("push_pending_chat_message", {
          message: text,
          runId: activePreflightSendIdRef.current ?? undefined,
        });
        if (delivered) {
          // Show pending message with a queued marker (rendered specially by MessageRow)
          const pendingMsg: ChatMessage = { role: "user", content: text, pending: true };
          setChatMessages([...messages, pendingMsg]);
          requestAnimationFrame(() => scrollMessagesToBottom());
        } else {
          // No active run received the message — it targets a run owned by
          // another panel, or the run just ended. Don't show a misleading
          // "queued" bubble; restore the text so it isn't silently lost.
          setInput(text);
        }
      } catch (err) {
        console.error("Failed to push pending message:", err);
        setInput(text);
      }
      return;
    }

    setChatError(null);
    const sendId = crypto.randomUUID();
    activePreflightSendIdRef.current = sendId;
    abortedRef.current = false;
    const turnReferences = [
      ...references,
      ...extractMentionReferences(text, allFiles, references),
    ];

    const webReferences = turnReferences.filter((reference) => reference.type === "web");
    let resolvedWebReferences = webReferences;
    if (webReferences.length > 0) {
      setChatLoading(true);
      setChatStreamingState({ chatStreamingStatus: "Fetching attached references…" });
      setReferences((previous) => previous.map((reference) => (
        reference.type === "web" && webReferences.some((webReference) => webReference.path === reference.path)
          ? { ...reference, webStatus: "loading" as const }
          : reference
      )));
      resolvedWebReferences = await resolveWebReferenceContent(webReferences);
      if (abortedRef.current || activePreflightSendIdRef.current !== sendId) {
        if (activePreflightSendIdRef.current !== sendId) return;
        setReferences((previous) => previous.map((reference) => (
          reference.type === "web" && reference.webStatus === "loading"
            ? { ...reference, webStatus: "queued" as const }
            : reference
        )));
        return;
      }
      const failedReferences = resolvedWebReferences.filter((reference) => reference.webStatus === "error");
      if (failedReferences.length > 0) {
        addActivityEntries(failedReferences.map((reference) => ({
          id: crypto.randomUUID(),
          timestamp: new Date(),
          source: "context",
          content: `Could not fetch attached reference: ${reference.path}`,
          level: "warn" as const,
        })));
      }
    }

    // Build user message with @references context (agentive protocol)
    let userContent = text;
    const contextItems: AgentContextItem[] = [];
    if (turnReferences.length > 0) {
      const webRefs = resolvedWebReferences;
      const fileRefs = turnReferences.filter((r) => r.type !== "web");
      const parts: string[] = [];

      if (fileRefs.length > 0) {
        parts.push(`[References: ${fileRefs.map((r) => `@${r.type}:${r.path}`).join(", ")}]`);
      }

      // Web refs shown as compact footnotes after the message text
      const webTags = webRefs.map((wr) => `[Web: ${wr.path}]`).join(" ");

      for (const wr of webRefs) {
        if (wr.webContent && wr.webStatus === "ready") {
          contextItems.push({
            id: `web:${wr.path}`,
            name: wr.title || wr.path,
            source: "search",
            kind: "web_excerpt",
            content: wr.webContent,
            content_type: "text/plain",
            priority: 90,
            origin: wr.path,
            persist: wr.persist ?? false,
          });
        }
      }

      // File refs + web refs shown as footnotes after the message text
      const footnote = parts.length > 0 ? `\n${parts.join(" · ")}` : "";
      userContent = `${text}${footnote}${webTags ? `\n${webTags}` : ""}`;
    }

    const userMsg: ChatMessage = { role: "user", content: userContent };
    const newMessages = [...messages, userMsg];
    const sessionId = chatSessionPath ?? crypto.randomUUID();
    if (!chatSessionPath) {
      useChatStore.setState({ chatSessionPath: sessionId });
    }
    // For silent sends, don't update the displayed chat with the user message
    if (!silent) {
      setChatMessages(newMessages);
      void persistChatSession(sessionId, newMessages).catch((persistError) => {
        console.warn("Could not save chat session:", persistError);
      });
      requestAnimationFrame(() => scrollMessagesToBottom());
    }
    setReferences([]);

    let askModeApproved = false;
    if (shouldRequestChatMutationApproval(settings.aiApplyMode)) {
      const approval = await useAiApplyGateStore.getState().requestApproval("This chat turn");
      if (abortedRef.current || activePreflightSendIdRef.current !== sendId) return;
      if (approval === "cancel") {
        const notice: ChatMessage = { role: "assistant", content: askModeCancelledMessage() };
        setChatMessages(silent ? [...messages, notice] : [...newMessages, notice]);
        activePreflightSendIdRef.current = null;
        setChatLoading(false);
        resetChatStreaming();
        addActivityEntries([{
          id: crypto.randomUUID(),
          timestamp: new Date(),
          source: "chat",
          content: "Ask Mode blocked AI mutation tools until approval",
          level: "info",
        }]);
        return;
      }
      askModeApproved = true;
    }

    // Build full conversation with system prompt. Large reference/web payloads are sent
    // separately as transient Agentive context items so they do not persist in chat history.
    const llmMessages = newMessages;
    // If an agent override was requested (e.g. from ✨ buttons), use that agent's prompt
    let effectiveSystemPrompt = systemPrompt;
    if (agentOverride) {
      const customAgents = settings.aiAgents || [];
      let overridePrompt = resolveAgentPrompt(agentOverride, customAgents);
      if (memoryContext) overridePrompt += `\n${memoryContext}`;
      if (activeSketchPath) overridePrompt += `\n\nThe user is currently editing the sketch at: ${activeSketchPath}`;
      if (activeStoryboardPath) overridePrompt += `\n\nThe user is currently editing the storyboard at: ${activeStoryboardPath}. Use the read_storyboard tool with this path to see its sequence and description before making suggestions.`;
      if (activeNotePath) overridePrompt += `\n\nThe user is currently editing the note at: ${activeNotePath}`;
      effectiveSystemPrompt = overridePrompt;
    }
    const allowMutationTools = canUseChatMutationTools(settings.aiApplyMode, askModeApproved);
    if (settings.aiApplyMode === "ask" && askModeApproved) {
      effectiveSystemPrompt += `\n\n${askModeApprovedSystemInstruction()}`;
    } else if (!allowMutationTools) {
      effectiveSystemPrompt += "\n\nWrite and mutation tools are disabled for this chat turn. Read project context as needed, then describe the edits you would apply instead of changing project files.";
    }
    const fullMessages: ChatMessage[] = [
      { role: "system", content: effectiveSystemPrompt },
      ...llmMessages,
    ];

    setChatLoading(true);
    handledSketchMutationsRef.current.clear();
    streamingRef.current = "";
    thinkingRef.current = "";
    workingDraftsRef.current = [];
    resetChatStreaming();
    setChatStreamingState({ chatStreamingStatus: "Connecting…" });
    // Log the send to activity
    addActivityEntries([{
      id: crypto.randomUUID(),
      timestamp: new Date(),
      source: "chat",
      content: silent ? `✨ ${userContent.slice(0, 60)}…` : `Sent: "${userContent}"`,
      level: "info",
    }]);
    try {
      // Resolve the effective agent — override agent (from ✨ buttons) takes priority
      const effectiveAgent = agentOverride
        ? [...BUILT_IN_AGENTS, ...(settings.aiAgents || [])].find(a => a.id === agentOverride) ?? selectedAgent
        : selectedAgent;
      const modelOverride = resolveAgentModelOverride(effectiveAgent, settings.aiAgentModelOverrides);
      // Resolve the effective connection first, then refresh ITS credentials (#262).
      const effectiveProviderInput = await buildRefreshedProviderInput(settings, effectiveAgent, updateSetting);
      const providerConfig = buildProviderConfig(
        effectiveProviderInput,
        settings.aiAgentExecutionEngine || "prompty",
      );
      const modelOverrideMetadata = modelOverride
        ? settings.aiAgentModelOverrideMetadata?.[effectiveAgent.id]
        : undefined;
      const matchingModelOverrideMetadata =
        modelOverrideMetadata?.model && modelOverrideMetadata.model !== modelOverride
          ? undefined
          : modelOverrideMetadata;
      const modelOverrideVision = matchingModelOverrideMetadata?.modelSupportsVision;
      const config = {
        ...providerConfig,
        // Apply per-agent model override when configured; otherwise use the provider model.
        ...(modelOverride ? {
          model: modelOverride,
          model_base_model: matchingModelOverrideMetadata?.modelBaseModel || null,
          model_reasoning_efforts: matchingModelOverrideMetadata?.modelReasoningEfforts || null,
          context_length: matchingModelOverrideMetadata?.contextLength || null,
          model_supports_vision:
            modelOverrideVision === undefined || modelOverrideVision === ""
              ? null
              : modelOverrideVision === "true",
        } : {}),
      };
      config.reasoning_effort = normalizeReasoningEffort(
        settings.aiReasoningEffort,
        config.provider,
        config.model,
        config.model_reasoning_efforts ?? "",
        config.model_base_model ?? "",
      ) || null;
      const routePreview = await invoke<AgentModelRoutePreview | null>("preview_agent_model_route", {
        config: {
          ...config,
          api_key: "",
          bearer_token: null,
        },
      });
      if (routePreview) {
        config.reasoning_effort = normalizeReasoningEffort(
          routePreview.effective_reasoning_effort || "",
          config.provider,
          config.model,
          config.model_reasoning_efforts ?? "",
          config.model_base_model ?? "",
        ) || null;
      } else {
        config.reasoning_effort = null;
      }

      // Build agent prompts map for sub-agent delegation
      const agentPrompts: Record<string, string> = {};
      for (const a of BUILT_IN_AGENTS) {
        agentPrompts[a.id] = a.prompt;
      }
      for (const a of (settings.aiAgents || [])) {
        agentPrompts[a.id] = a.prompt;
      }

      // Route to the backend agent command
      if (abortedRef.current || activePreflightSendIdRef.current !== sendId) return;
      const result = await invoke<AgentChatResult>("agent_chat_with_tools", {
            config,
            messages: fullMessages,
            contextItems,
            agentPrompts,
            agentId: effectiveAgent.id,
            allowMutationTools,
            clientRunId: sendId,
          });

      // Activity logging now handled by real-time agent-event listener
      if (abortedRef.current || activePreflightSendIdRef.current !== sendId) return;
      if (result.cancelled) {
        if (!silent) {
          setChatMessages(newMessages);
          void persistChatSession(sessionId, newMessages).catch((persistError) => {
            console.warn("Could not save chat session:", persistError);
          });
        }
        return;
      }

      // Use the backend's full conversation (with correct tool_call/tool_result ordering)
      // but restore display-friendly user messages. The backend/reference resolver may
      // inject <referenced_document> XML or web scrape content into any user turn for
      // the LLM; none of that should become visible chat bubble content.
      const backendMessages = reconcileMessagesForDisplay(result.messages, newMessages, {
        silent,
        assistantResponse: result.response,
        logger: (message, details) => console.warn(`[chat] ${message}`, details),
      });
      const toolCallCount = backendMessages.filter(
        (m) => m.role === "assistant" && m.tool_calls && m.tool_calls.length > 0,
      ).reduce((n, m) => n + (m.tool_calls?.length ?? 0), 0);
      const workingNotes = buildChatWorkingNotes({
        drafts: workingDraftsRef.current,
        thinking: thinkingRef.current,
      });
      if (workingNotes) {
        const finalAssistantIndex = (() => {
          for (let i = backendMessages.length - 1; i >= 0; i -= 1) {
            if (backendMessages[i].role === "assistant" && textContent(backendMessages[i].content).trim() === result.response.trim()) {
              return i;
            }
          }
          return -1;
        })();
        if (finalAssistantIndex >= 0) {
          const finalAssistant = backendMessages[finalAssistantIndex];
          backendMessages[finalAssistantIndex] = {
            ...finalAssistant,
            cutready: {
              ...finalAssistant.cutready,
              workingNotes,
            },
          };
        }
      }
      const finalAssistantIndex = (() => {
        for (let i = backendMessages.length - 1; i >= 0; i -= 1) {
          if (backendMessages[i].role === "assistant" && textContent(backendMessages[i].content).trim() === result.response.trim()) {
            return i;
          }
        }
        return -1;
      })();
      if (finalAssistantIndex >= 0) {
        const finalAssistant = backendMessages[finalAssistantIndex];
        backendMessages[finalAssistantIndex] = {
          ...finalAssistant,
          cutready: {
            ...finalAssistant.cutready,
            runDetails: {
              provider: result.provider,
              model: result.model,
              execution_engine: result.execution_engine,
              agent_id: result.agent_id,
              run_id: result.run_id,
              elapsed_ms: result.elapsed_ms,
              reasoning_effort: result.reasoning_effort,
              tool_calls: toolCallCount,
              usage: result.usage,
            },
          },
        };
      }

      // Log response to activity
      addActivityEntries([{
        id: crypto.randomUUID(),
        timestamp: new Date(),
        source: "response",
        content: `${toolCallCount > 0 ? `${toolCallCount} tool call(s) → ` : ""}${result.response ?? ""}`,
        level: "success",
      }]);

      // If the user stopped generation, discard the result
      if (abortedRef.current || activePreflightSendIdRef.current !== sendId) return;

      // Tool-result events are used for immediate refresh, but they are best-effort
      // UI events. Reconcile from the returned conversation as well so open sketches
      // update even if an event was missed or multiple same-name tool calls raced.
      for (const mutation of extractSketchMutationsFromMessages(
        result.messages.slice(fullMessages.length),
        useAppStore.getState().activeSketchPath,
      )) {
        if (consumeRecordedSketchMutation(handledSketchMutationsRef.current, mutation)) continue;
        refreshSketchAfterMutation(mutation);
      }
      for (const mutation of extractStoryboardMutationsFromMessages(
        result.messages.slice(fullMessages.length),
        useAppStore.getState().activeStoryboardPath,
      )) {
        refreshStoryboardAfterMutation(mutation);
      }

      setChatMessages(backendMessages);
      void persistChatSession(sessionId, backendMessages).catch((persistError) => {
        console.warn("Could not save chat session:", persistError);
      });
    } catch (err) {
      if (abortedRef.current || activePreflightSendIdRef.current !== sendId) return;
      const errMsg = err instanceof Error ? err.message : commandErrorText(err);
      setChatError(errMsg);
      // Log error to activity
      addActivityEntries([{
        id: crypto.randomUUID(),
        timestamp: new Date(),
        source: "error",
        content: errMsg,
        level: "error",
      }]);
      // Keep user message visible (unless silent)
      if (!silent) {
        setChatMessages(newMessages);
        void persistChatSession(sessionId, newMessages).catch((persistError) => {
          console.warn("Could not save chat session:", persistError);
        });
      }
    } finally {
      if (activePreflightSendIdRef.current !== sendId) return;
      activePreflightSendIdRef.current = null;
      setChatLoading(false);
      resetChatStreaming();
      streamingRef.current = "";
      thinkingRef.current = "";
      workingDraftsRef.current = [];
    }
  }, [input, loading, messages, references, allFiles, systemPrompt, buildEffectiveProviderInput, setChatMessages, setChatLoading, setChatError, addActivityEntries, settings, selectedAgent, memoryContext, activeSketchPath, activeStoryboardPath, activeNotePath, chatSessionPath, persistChatSession, refreshSketchAfterMutation, refreshStoryboardAfterMutation, resetChatStreaming, scrollMessagesToBottom, setChatStreamingState, updateSetting]);

  // Pick up prompts queued from outside the chat (e.g. sparkle buttons)
  const handleSendRef = useRef(handleSend);
  handleSendRef.current = handleSend;
  useEffect(() => {
    if (pendingChatPrompt) {
      const { text, silent, agent } = pendingChatPrompt;
      useChatStore.setState({ pendingChatPrompt: null });
      handleSendRef.current(text, { silent, agent });
    }
  }, [pendingChatPrompt]);

  const handleStop = useCallback(() => {
    const clientRunId = activePreflightSendIdRef.current;
    if (clientRunId !== null) {
      void cancelAgentChatRun(clientRunId).catch((error) => {
        console.warn("Failed to cancel chat run:", error);
      });
    }
    abortedRef.current = true;
    activePreflightSendIdRef.current = null;
    setReferences((previous) => previous.map((reference) => (
      reference.type === "web" && reference.webStatus === "loading"
        ? { ...reference, webStatus: "queued" as const }
        : reference
    )));
    setChatLoading(false);
    resetChatStreaming();
    streamingRef.current = "";
    thinkingRef.current = "";
    workingDraftsRef.current = [];
  }, [resetChatStreaming, setChatLoading]);

  const handleRetry = useCallback(() => {
    // Find the last user message text and re-send it
    const lastUser = [...messages].reverse().find((m) => m.role === "user");
    if (lastUser) {
      setChatError(null);
      const text = textContent(lastUser.content);
      // Remove the last user message + any trailing assistant/error messages
      const lastIdx = messages.lastIndexOf(lastUser);
      setChatMessages(messages.slice(0, lastIdx));
      // Defer the send so the store update is picked up
      setTimeout(() => handleSendRef.current(text), 0);
    }
  }, [messages, setChatError, setChatMessages]);

  const handleInputChange = useCallback(
    (e: React.ChangeEvent<HTMLTextAreaElement>) => {
      const val = e.target.value;
      setInput(val);
      if (loading) {
        setShowAutocomplete(false);
        return;
      }

      // Detect @ trigger for references (agentive protocol)
      const cursorPos = e.target.selectionStart;
      const textBefore = val.slice(0, cursorPos);
      const atIndex = textBefore.lastIndexOf("@");

      if (atIndex >= 0 && (atIndex === 0 || textBefore[atIndex - 1] === " ")) {
        const query = textBefore.slice(atIndex + 1);

        // Detect completed @URL pattern — triggers when space follows the URL
        const webMatch = val.slice(atIndex + 1).match(/^(?:web:)?(https?:\/\/\S+)\s/);
        if (webMatch) {
          const url = webMatch[1];
          setReferences((prev) => {
            if (prev.some((r) => r.path === url)) return prev;
            return [...prev, { type: "web", path: url, title: url, webStatus: "queued" }];
          });
          // Keep @URL text in the input — just close autocomplete
          setShowAutocomplete(false);
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
    [loading],
  );

  const handleInputPaste = useCallback(
    (e: React.ClipboardEvent<HTMLTextAreaElement>) => {
      if (loading) return;
      const pastedText = e.clipboardData.getData("text/plain");
      if (!pastedText.includes("@")) return;

      const target = e.currentTarget;
      const start = target.selectionStart ?? input.length;
      const end = target.selectionEnd ?? start;
      const nextInput = `${input.slice(0, start)}${pastedText}${input.slice(end)}`;
      const pastedReferences = extractMentionReferences(nextInput, allFiles, references);
      if (pastedReferences.length === 0) return;

      setReferences((previous) => [
        ...previous,
        ...pastedReferences.filter((reference) => !previous.some((item) => sameReference(item, reference))),
      ]);
    },
    [allFiles, input, loading, references],
  );

  const insertReference = useCallback(
    (file: FileReference) => {
      if (loading) return;
      setReferences((prev) => [...prev, file]);
      // Replace the @query with a clean @mention (quoted if title has spaces)
      const cursorPos = inputRef.current?.selectionStart ?? input.length;
      const textBefore = input.slice(0, cursorPos);
      const atIndex = textBefore.lastIndexOf("@");
      const needsQuotes = /\s/.test(file.title);
      const mention = needsQuotes ? `@"${file.title}" ` : `@${file.title} `;
      const newInput = input.slice(0, atIndex) + mention + input.slice(cursorPos);
      setInput(newInput);
      setShowAutocomplete(false);
      // Move cursor after the inserted mention
      setTimeout(() => {
        const pos = atIndex + mention.length;
        inputRef.current?.setSelectionRange(pos, pos);
        inputRef.current?.focus();
      }, 0);
    },
    [input, loading],
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
          e.stopPropagation();
          setShowAutocomplete(false);
          return;
        }
      }

      if (e.key === "Escape" && chatFocusMode) {
        e.preventDefault();
        e.stopPropagation();
        setChatFocusMode(false);
        return;
      }

      if (e.key === "Enter" && !e.shiftKey) {
        e.preventDefault();
        handleSend();
      }
    },
    [
      showAutocomplete,
      autocompleteOptions,
      autocompleteIndex,
      insertReference,
      handleSend,
      chatFocusMode,
      setChatFocusMode,
    ],
  );

  const clearChat = useCallback(() => {
    newChatSession();
    setReferences([]);
  }, [newChatSession]);

  const promoteCurrentChat = useCallback(async () => {
    if (promotingChat || messages.length === 0) return;
    setPromotingChat(true);
    try {
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
      const title = chatSessionTitle(messages);
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
          session_id: chatSessionPath ?? `chat-${stamp}`,
          messages,
        },
        {
          title,
          author: participant,
          promoted_by: participant,
          promoted_at: promotedAt,
        },
      );
      const content = `${JSON.stringify(artifact, null, 2)}\n`;

      await invoke("update_note", { relativePath, content });
      await loadChatArtifacts();
      await refreshChangedFiles();
      await openChatArtifact(relativePath);
      if (chatSessionPath) {
        await invoke("delete_chat_session", { sessionId: chatSessionPath });
        window.dispatchEvent(new CustomEvent("cutready:chat-sessions-updated"));
      }
      newChatSession();
      addActivityEntries([{
        id: crypto.randomUUID(),
        timestamp: new Date(),
        source: "chat",
        content: `Promoted chat to ${relativePath}`,
        level: "success",
      }]);
      showToast(`Promoted chat to ${relativePath}`, 5000, "success");
    } catch (error) {
      const message = error instanceof Error ? error.message : commandErrorText(error);
      addActivityEntries([{
        id: crypto.randomUUID(),
        timestamp: new Date(),
        source: "chat",
        content: `Could not promote chat: ${message}`,
        level: "error",
      }]);
      showToast(`Could not promote chat: ${message}`, 7000, "error");
    } finally {
      setPromotingChat(false);
    }
  }, [addActivityEntries, chatSessionPath, loadChatArtifacts, messages, newChatSession, openChatArtifact, promotingChat, refreshChangedFiles, showToast]);

  const isConfigured = providerConfigured === true;

  if (!currentProject) {
    return (
      <div className="flex-1 flex items-center justify-center p-4">
        <p className="text-xs text-[rgb(var(--color-text-secondary))] text-center">
          Open a workspace to start chatting
        </p>
      </div>
    );
  }

  if (providerConfigured === null || (!isConfigured && oauthRefreshPending)) {
    return (
      <div className="flex-1 flex items-center justify-center p-4">
        <p className="text-xs text-[rgb(var(--color-text-secondary))] text-center">
          Loading Connections settings…
        </p>
      </div>
    );
  }

  if (!isConfigured) {
    return (
      <div className="flex-1 flex items-center justify-center p-4">
        <div className="text-center">
          <p className="text-xs text-[rgb(var(--color-text-secondary))] mb-2">
            Configure a Connection and model in Settings to use the assistant
          </p>
          <button
            className="show-underlines-target text-xs text-[rgb(var(--color-accent))] hover:underline"
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
      <div
        className={`h-9 border-b border-[rgb(var(--color-border-subtle))] shrink-0 ${
          chatFocusMode ? "px-4" : "px-2"
        }`}
      >
        <div className={`flex h-full items-center gap-1 ${chatFocusMode ? "mx-auto w-full max-w-5xl" : ""}`}>
          <div className="flex min-w-0 items-center gap-2 pr-2">
            <span className="flex h-5 w-5 items-center justify-center rounded-md bg-[rgb(var(--color-accent))]/10 text-[rgb(var(--color-accent))]">
              <IconSparkles size={12} />
            </span>
            <div className="min-w-0">
              <p className="truncate text-xs font-medium leading-none text-[rgb(var(--color-text))]">
                {chatFocusMode ? "Chat - Focus mode" : "Chat"}
              </p>
              {chatFocusMode && (
                <p className="mt-0.5 text-2xs leading-none text-[rgb(var(--color-text-secondary))]">
                  Esc exits focus mode
                </p>
              )}
            </div>
          </div>
          <button
            disabled={loading}
            className="flex h-[26px] w-[26px] items-center justify-center rounded text-[rgb(var(--color-text-secondary))] transition-colors hover:bg-[rgb(var(--color-surface-toolbar))] hover:text-[rgb(var(--color-text))] disabled:cursor-not-allowed disabled:opacity-50"
            onClick={clearChat}
            title={loading ? "Wait for the current message to finish" : "New Chat"}
            aria-label="New Chat"
          >
            <IconPlus size={14} />
          </button>
          <div className="flex-1" />
          <button
            disabled={loading || promotingChat || messages.length === 0}
            className="flex h-[26px] items-center justify-center gap-1.5 rounded px-2 text-xs text-[rgb(var(--color-text-secondary))] transition-colors hover:bg-[rgb(var(--color-surface-toolbar))] hover:text-[rgb(var(--color-text))] disabled:cursor-not-allowed disabled:opacity-50"
            onClick={promoteCurrentChat}
            title={messages.length === 0 ? "Start a chat before promoting it" : "Promote this chat into a project chat document"}
            aria-label="Promote chat"
          >
            <FileText className="h-3.5 w-3.5" />
            <span>{promotingChat ? "Promoting..." : "Promote"}</span>
          </button>
          <button
            className={`flex h-[26px] items-center justify-center rounded transition-colors ${
              chatFocusMode
                ? "gap-1.5 px-2 text-xs font-medium text-[rgb(var(--color-accent))] hover:bg-[rgb(var(--color-accent))]/10"
                : "gap-1.5 px-2 text-xs text-[rgb(var(--color-text-secondary))] hover:bg-[rgb(var(--color-surface-toolbar))] hover:text-[rgb(var(--color-text))]"
            }`}
            onClick={() => setChatFocusMode(!chatFocusMode)}
            title={chatFocusMode ? "Exit focus mode (Esc)" : "Expand chat to focus mode"}
            aria-label={chatFocusMode ? "Exit focus mode" : "Expand chat to focus mode"}
          >
            {chatFocusMode ? (
              <>
                <Minimize2 className="h-3.5 w-3.5" />
                <span>Exit focus</span>
              </>
            ) : (
              <>
                <Maximize2 className="h-3.5 w-3.5" />
                <span>Focus</span>
              </>
            )}
          </button>
        </div>
      </div>

      {/* Messages */}
      <div
        ref={messagesContainerRef}
        data-testid="chat-messages-scroll"
        className={`flex-1 overflow-y-auto min-h-0 py-2 ${
          chatFocusMode ? "px-4" : ""
        }`}
        style={{ fontSize: "var(--chat-font-size, 13px)" }}
        onScroll={handleMessagesScroll}
      >
        {messages.length === 0 && !loading && (
          <div className="mx-auto flex h-full max-w-3xl flex-col items-center justify-center px-4 text-center">
            <div className="w-10 h-10 rounded-full bg-[rgb(var(--color-accent))]/10 flex items-center justify-center mb-3 text-[rgb(var(--color-accent))]">
              <IconSparkles size={20} />
            </div>
            <p className="text-[13px] font-medium text-[rgb(var(--color-text))] mb-1">
              CutReady AI
            </p>
            <p
              className={`text-xs text-[rgb(var(--color-text-secondary))] leading-relaxed mb-4 ${
                chatFocusMode ? "max-w-sm" : "max-w-[220px]"
              }`}
            >
              I can help plan your demo, generate sketches, or refine your script. Use <kbd className="px-1 py-0.5 text-2xs bg-[rgb(var(--color-surface-alt))] rounded border border-[rgb(var(--color-border))]">@</kbd> to reference project documents and websites.
            </p>
            <div className="flex flex-wrap gap-1.5 justify-center max-w-[260px]">
              {(() => {
                const suggestions = activeNotePath
                  ? [
                      "Improve this note",
                      "Generate sketch from my notes",
                      "Refine my script timing",
                    ]
                  : [
                      "Plan a demo from my notes",
                      "Generate sketch rows",
                      "Refine my script timing",
                    ];
                return suggestions.map((suggestion) => (
                  <button
                    key={suggestion}
                    className="px-2.5 py-1 text-xs rounded-full border border-[rgb(var(--color-border))] text-[rgb(var(--color-text-secondary))] hover:text-[rgb(var(--color-text))] hover:border-[rgb(var(--color-accent))] hover:bg-[rgb(var(--color-accent))]/5 transition-colors"
                    onClick={() => {
                      // Auto-add active note as reference for note-specific suggestions
                      if (activeNotePath && suggestion === "Improve this note") {
                        const noteTitle = activeNotePath.replace(/\.md$/, "").split("/").pop() ?? activeNotePath;
                        setReferences([{ type: "note", path: activeNotePath, title: noteTitle }]);
                      }
                      setInput(suggestion);
                      inputRef.current?.focus();
                    }}
                  >
                    {suggestion}
                  </button>
                ));
              })()}
            </div>
          </div>
        )}

        {messages.map((msg, i) => (
          <div key={i} className={chatFocusMode ? "mx-auto w-full max-w-5xl" : undefined}>
            <MessageRow
              message={msg}
              index={i}
              inlineToolActivity={inlineToolActivity[i]}
              agentName={selectedAgent.name}
              projectRoot={currentProject?.root}
              onDelete={msg.role === "user" ? deleteMessage : undefined}
            />
          </div>
        ))}

        {loading && (
          <div className={chatFocusMode ? "mx-auto w-full max-w-5xl px-3.5 py-2" : "px-3.5 py-2"}>
            {liveWorkingNotes ? (
              <div className="w-full max-w-[70ch]">
                <WorkingNotesInline
                  notes={liveWorkingNotes}
                  live
                />
              </div>
            ) : (
              <span className="text-xs text-[rgb(var(--color-text-secondary))] italic">{streamingStatus || "Thinking…"}</span>
            )}
          </div>
        )}

        {error && (
          <ChatErrorCard error={error} onRetry={handleRetry} onDismiss={() => setChatError(null)} />
        )}

        <div ref={messagesEndRef} />
      </div>

      {/* Input area — VS Code Copilot chat style */}
      <div
        className={`shrink-0 mb-2.5 rounded-lg border border-[rgb(var(--color-border))] bg-[rgb(var(--color-surface))] shadow-sm transition-colors focus-within:border-[rgb(var(--color-accent))] ${
          chatFocusMode ? "mx-auto w-[calc(100%-2rem)] max-w-5xl" : "mx-2.5"
        }`}
      >
        {/* Reference chips (shown above textarea) */}
        {references.length > 0 && (
          <div className="px-2.5 pt-2 space-y-1">
            <div className="flex flex-wrap gap-1">
              {references.map((ref) => {
                const c = typeColors(ref.type);
                return (
                <span
                  key={ref.path}
                  className={`inline-flex items-center gap-1 px-1.5 py-0.5 text-xs rounded border transition-colors ${
                    ref.type === "web" && ref.webStatus === "loading"
                      ? `${c.bg} ${c.text} ${c.border} animate-pulse`
                      : ref.type === "web" && ref.webStatus === "error"
                        ? "bg-error/10 text-error border-error/30"
                        : `${c.bg} ${c.text} ${c.border}`
                  }`}
                >
                  <FileTypeIcon type={ref.type} />
                  {ref.type === "web" ? (
                    <button
                      className="show-underlines-target max-w-[180px] truncate hover:underline"
                      onClick={() => setExpandedWebRef(expandedWebRef === ref.path ? null : ref.path)}
                      title={ref.webStatus === "queued" ? "Fetched when you send" : ref.webStatus === "loading" ? "Fetching…" : "Click to preview"}
                    >
                      {ref.webStatus === "queued" ? "Ready to fetch" : ref.webStatus === "loading" ? "Fetching…" : ref.title}
                    </button>
                  ) : (
                    <span className="max-w-[120px] truncate">{ref.title}</span>
                  )}
                  {ref.type === "web" && ref.webStatus !== "error" && (
                    <button
                      disabled={loading}
                      className={`transition-colors disabled:cursor-not-allowed disabled:opacity-50 ${ref.persist ? "text-[rgb(var(--color-accent))]" : "text-[rgb(var(--color-text-secondary))] hover:text-[rgb(var(--color-text))]"}`}
                      onClick={() => setReferences((previous) => previous.map((item) => (
                        item.path === ref.path ? { ...item, persist: !item.persist } : item
                      )))}
                      title={loading ? "References are locked while this message is sending" : ref.persist ? "Store the fetched snapshot for future project chats" : "Keep the fetched snapshot available to future project chats"}
                    >
                      <Pin className="w-2.5 h-2.5" />
                    </button>
                  )}
                  <button
                    disabled={loading}
                    className="text-[rgb(var(--color-text-secondary))] hover:text-error transition-colors disabled:cursor-not-allowed disabled:opacity-50"
                    onClick={() => { removeReference(ref.path); if (expandedWebRef === ref.path) setExpandedWebRef(null); }}
                    title={loading ? "References are locked while this message is sending" : "Remove"}
                  >
                    <X className="w-2.5 h-2.5" />
                  </button>
                </span>
                );
              })}
            </div>
            {/* Web content preview */}
            {expandedWebRef && (() => {
              const ref = references.find((r) => r.path === expandedWebRef);
              if (!ref?.webContent) return null;
              return (
                <div className="rounded border border-[rgb(var(--color-border))] bg-[rgb(var(--color-surface-alt))] text-xs text-[rgb(var(--color-text-secondary))] overflow-hidden">
                  <div className="flex items-center justify-between px-2 py-1 border-b border-[rgb(var(--color-border))]">
                    <span className="truncate font-medium">{ref.path}</span>
                    <span className="shrink-0 text-2xs tabular-nums">{ref.webContent.length.toLocaleString()} chars</span>
                  </div>
                  <div className="max-h-[120px] overflow-y-auto px-2 py-1.5 font-mono whitespace-pre-wrap leading-relaxed">
                    {ref.webContent}
                  </div>
                </div>
              );
            })()}
          </div>
        )}

        {/* Textarea with @ autocomplete */}
        <div className="relative" ref={autocompleteRef}>
          {showAutocomplete && autocompleteOptions.length > 0 && (
            <div className="absolute bottom-full left-0 right-0 mb-1 bg-[rgb(var(--color-surface))] border border-[rgb(var(--color-border))] rounded-md shadow-lg overflow-hidden z-10 overflow-y-auto" style={{ maxHeight: acMaxH }}>
              {autocompleteOptions.map((file, i) => (
                <button
                  key={file.path}
                  className={`w-full flex items-center gap-2 px-2.5 py-1.5 text-left text-xs transition-colors ${
                    i === autocompleteIndex
                      ? "bg-[rgb(var(--color-accent))]/10 text-[rgb(var(--color-text))]"
                      : "text-[rgb(var(--color-text-secondary))] hover:bg-[rgb(var(--color-surface-alt))]"
                  }`}
                  onClick={() => insertReference(file)}
                  onMouseEnter={() => setAutocompleteIndex(i)}
                >
                  <FileTypeIcon type={file.type} />
                  <span className="flex-1 truncate">{file.title}</span>
                  <span className="text-2xs text-[rgb(var(--color-text-secondary))] opacity-50">{referenceTypeLabel(file.type)}</span>
                </button>
              ))}
            </div>
          )}

          <textarea
            ref={inputRef} aria-describedby="chat-input-hint"
            className="w-full resize-none bg-transparent px-2.5 py-2 text-[13px] text-[rgb(var(--color-text))] placeholder-[rgb(var(--color-text-secondary))]/60 focus:outline-none leading-[1.5]"
            style={{ maxHeight: 300 }}
            rows={3}
            placeholder={loading ? "Add guidance for the current response..." : "Ask about your demo plan… (@ to reference documents)"}
            value={input}
            onChange={handleInputChange}
            onKeyDown={handleKeyDown}
            onPaste={handleInputPaste}
          />
        </div>

        {/* Bottom toolbar — Add Context | Model | Tools | Send */}
        <div className="flex items-center gap-0.5 px-1.5 pb-1.5">
          {/* Add Context button + picker */}
          <div className="relative" ref={contextPickerRef}>
            <button
              disabled={loading}
              className={`flex items-center gap-1 px-1.5 h-[26px] rounded text-xs transition-colors ${
                showContextPicker
                  ? "bg-[rgb(var(--color-surface))] text-[rgb(var(--color-text))]"
                  : "text-[rgb(var(--color-text-secondary))] hover:text-[rgb(var(--color-text))] hover:bg-[rgb(var(--color-surface))]"
              } disabled:cursor-not-allowed disabled:opacity-50`}
              onClick={() => { setShowContextPicker(!showContextPicker); setContextFilter(""); }}
              title="Add Context (@)"
            >
              <IconPaperclip size={12} />
            </button>
            {showContextPicker && (
              <div className="absolute bottom-full left-0 mb-1 w-[240px] bg-[rgb(var(--color-surface))] border border-[rgb(var(--color-border))] rounded-lg shadow-lg overflow-hidden z-20 flex flex-col" style={{ maxHeight: ctxMaxH }}>
                <div className="px-2.5 pt-2 pb-1 shrink-0">
                  <input
                    className="w-full px-2 py-1 text-xs bg-[rgb(var(--color-surface-alt))] border border-[rgb(var(--color-border))] rounded text-[rgb(var(--color-text))] placeholder-[rgb(var(--color-text-secondary))] focus:outline-none focus:border-[rgb(var(--color-accent))]"
                    placeholder="Search documents…"
                    value={contextFilter}
                    onChange={(e) => setContextFilter(e.target.value)}
                    autoFocus
                  />
                </div>
                <div className="flex-1 overflow-y-auto">
                  {contextPickerOptions.length === 0 ? (
                    <div className="px-3 py-2 text-xs text-[rgb(var(--color-text-secondary))]">
                      No matching documents
                    </div>
                  ) : (
                    contextPickerOptions.map((file) => (
                      <button
                        key={file.path}
                        className="w-full flex items-center gap-2 px-2.5 py-1.5 text-left text-xs text-[rgb(var(--color-text-secondary))] hover:bg-[rgb(var(--color-surface-alt))] hover:text-[rgb(var(--color-text))] transition-colors"
                        onClick={() => {
                          setReferences((prev) => [...prev, file]);
                          setShowContextPicker(false);
                          inputRef.current?.focus();
                        }}
                      >
                        <FileTypeIcon type={file.type} />
                        <span className="flex-1 truncate">{file.title}</span>
                        <span className="text-2xs opacity-40">{referenceTypeLabel(file.type)}</span>
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
              className={`flex items-center gap-1 px-1.5 h-[26px] rounded text-xs transition-colors ${
                showAgentPicker
                  ? "bg-[rgb(var(--color-surface))] text-[rgb(var(--color-text))]"
                  : "text-[rgb(var(--color-text-secondary))] hover:text-[rgb(var(--color-text))] hover:bg-[rgb(var(--color-surface))]"
              }`}
              onClick={() => setShowAgentPicker(!showAgentPicker)}
              title="Select Agent"
            >
              <IconSparkles size={11} />
              <span className="max-w-[80px] truncate">{selectedAgent.name}</span>
              <IconChevronDown size={10} />
            </button>
            {showAgentPicker && (
              <div className="absolute bottom-full left-0 mb-1 w-[240px] bg-[rgb(var(--color-surface))] border border-[rgb(var(--color-border))] rounded-lg shadow-lg overflow-hidden z-20 flex flex-col" style={{ maxHeight: agentMaxH }}>
                {BUILT_IN_AGENTS.length > 0 && (
                  <>
                    <div className="px-3 py-1.5 border-b border-[rgb(var(--color-border))] shrink-0">
                      <span className="text-2xs font-medium text-[rgb(var(--color-text-secondary))] uppercase tracking-wider">Built-in</span>
                    </div>
                    <div className="py-0.5">
                      {BUILT_IN_AGENTS.map((agent) => {
                        const modelOverride = resolveAgentModelOverride(agent, settings.aiAgentModelOverrides);
                        return (
                        <button
                          key={agent.id}
                          className={`w-full flex items-center gap-2 px-3 py-1.5 text-xs text-left transition-colors ${
                            selectedAgent.id === agent.id
                              ? "bg-[rgb(var(--color-accent))]/10 text-[rgb(var(--color-text))]"
                              : "text-[rgb(var(--color-text-secondary))] hover:bg-[rgb(var(--color-surface-alt))] hover:text-[rgb(var(--color-text))]"
                          }`}
                          onClick={() => {
                            updateSetting("aiSelectedAgent", agent.id);
                            setShowAgentPicker(false);
                          }}
                        >
                          <IconSparkles size={11} />
                          <div className="flex-1 min-w-0">
                            <div className="flex items-center gap-1">
                              <span>{agent.name}</span>
                              {modelOverride && (
                                <span className="text-2xs text-[rgb(var(--color-text-secondary))] opacity-60">{modelOverride}</span>
                              )}
                            </div>
                            {agent.description && (
                              <div className="text-2xs text-[rgb(var(--color-text-secondary))] opacity-70 truncate">{agent.description}</div>
                            )}
                          </div>
                          {selectedAgent.id === agent.id && <IconCheck size={11} />}
                        </button>
                        );
                      })}
                    </div>
                  </>
                )}
                {(settings.aiAgents?.length ?? 0) > 0 && (
                  <>
                    <div className="px-3 py-1.5 border-t border-[rgb(var(--color-border))] shrink-0">
                      <span className="text-2xs font-medium text-[rgb(var(--color-text-secondary))] uppercase tracking-wider">Custom</span>
                    </div>
                    <div className="py-0.5 overflow-y-auto">
                      {(settings.aiAgents || []).map((agent) => {
                        const modelOverride = resolveAgentModelOverride(agent, settings.aiAgentModelOverrides);
                        return (
                        <button
                          key={agent.id}
                          className={`w-full flex items-center gap-2 px-3 py-1.5 text-xs text-left transition-colors ${
                            selectedAgent.id === agent.id
                              ? "bg-[rgb(var(--color-accent))]/10 text-[rgb(var(--color-text))]"
                              : "text-[rgb(var(--color-text-secondary))] hover:bg-[rgb(var(--color-surface-alt))] hover:text-[rgb(var(--color-text))]"
                          }`}
                          onClick={() => {
                            updateSetting("aiSelectedAgent", agent.id);
                            setShowAgentPicker(false);
                          }}
                        >
                          <IconUser size={11} />
                          <span className="truncate">{agent.name}</span>
                          {modelOverride && (
                            <span className="text-2xs text-[rgb(var(--color-text-secondary))] opacity-60 truncate">{modelOverride}</span>
                          )}
                          {selectedAgent.id === agent.id && <IconCheck size={11} />}
                        </button>
                        );
                      })}
                    </div>
                  </>
                )}
              </div>
            )}
          </div>

          {/* Model picker */}
          <div className="relative flex items-center gap-1" ref={modelPickerRef}>
            <button
              className={`flex items-center gap-1 px-1.5 h-[26px] rounded text-xs transition-colors ${
                showModelPicker
                  ? "bg-[rgb(var(--color-surface))] text-[rgb(var(--color-text))]"
                  : "text-[rgb(var(--color-text-secondary))] hover:text-[rgb(var(--color-text))] hover:bg-[rgb(var(--color-surface))]"
              }`}
              onClick={() => setShowModelPicker(!showModelPicker)}
              title={effectiveProvider?.name ? `Select Model (${effectiveProvider.name})` : "Select Model"}
            >
              <span className="max-w-[100px] truncate">{effectiveModel || "Model"}</span>
              <IconChevronDown size={10} />
            </button>
            <RunDetailsPopover
              details={visibleRunDetails}
              status={latestRunDetails ? "Completed" : "Configured"}
            />
            {reasoningEfforts.length > 0 && (
              <ReasoningEffortPicker
                value={effectiveReasoningEffort}
                efforts={reasoningEfforts}
                open={showReasoningPicker}
                pickerRef={reasoningPickerRef}
                onToggle={() => setShowReasoningPicker((value) => !value)}
                onChange={(next) => {
                  void updateSetting("aiReasoningEffort", next);
                  setShowReasoningPicker(false);
                }}
              />
            )}
            {showModelPicker && (
              <ModelPickerDropdown
                currentModel={effectiveModel}
                providerId={effectiveProvider?.id}
                onClose={() => setShowModelPicker(false)}
                maxHeight={modelMaxH}
              />
            )}
          </div>

          <div className="flex-1" />

          {/* Send / Stop button */}
          {loading ? (
            <button
              className="flex items-center justify-center w-[26px] h-[26px] rounded text-error hover:bg-error/10 transition-colors"
              onClick={handleStop}
              title="Stop generation"
            >
              <Square width={14} height={14} />
            </button>
          ) : (
            <button
              className="flex items-center justify-center w-[26px] h-[26px] rounded text-[rgb(var(--color-text-secondary))] hover:text-[rgb(var(--color-text))] hover:bg-[rgb(var(--color-surface))] transition-colors disabled:opacity-30 disabled:cursor-not-allowed"
              onClick={() => handleSend()}
              disabled={!input.trim()}
              title="Send (Enter)"
            >
              <IconSend size={14} />
            </button>
          )}
        </div>
      </div>
    </div>
  );
}

function RunDetailsPopover({
  details,
  toolCount = 0,
  status = "Completed",
}: {
  details: ChatRunDetails;
  toolCount?: number;
  status?: "Completed" | "Configured";
}) {
  const [open, setOpen] = useState(false);
  const usage = details.usage;
  const effectiveToolCount = details.tool_calls ?? toolCount;
  const rows = [
    ["Harness", harnessRunLabel(details.execution_engine)],
    ["Provider", providerRunLabel(details.provider)],
    ["Model", details.model || "—"],
    ["Reasoning", reasoningEffortLabel(details.reasoning_effort ?? "")],
    ["Agent", details.agent_id || "—"],
    ["Duration", formatRunDuration(details.elapsed_ms)],
    ["Tools", `${effectiveToolCount} call${effectiveToolCount === 1 ? "" : "s"}`],
    ["Tokens", usage ? `${formatRunTokens(usage.prompt_tokens)} in / ${formatRunTokens(usage.completion_tokens)} out` : "—"],
  ];

  return (
    <span className="relative inline-flex items-center">
      <button
        type="button"
        aria-label="Show run details"
        aria-expanded={open}
        onClick={() => setOpen((value) => !value)}
        onKeyDown={(event) => {
          if (event.key === "Escape") {
            setOpen(false);
            event.currentTarget.blur();
          }
        }}
        className="inline-flex h-5 w-5 items-center justify-center rounded-full border border-[rgb(var(--color-border-subtle))] bg-[rgb(var(--color-surface-alt))]/50 text-[rgb(var(--color-text-secondary))]/70 transition-colors hover:border-[rgb(var(--color-accent))]/45 hover:bg-[rgb(var(--color-accent))]/10 hover:text-[rgb(var(--color-accent))] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[rgb(var(--color-accent))]/35"
        title="Show run details"
      >
        <CircleHelp className="h-3.5 w-3.5" />
      </button>
      {open && (
        <span
          role="dialog"
          aria-label="Run details"
          className="absolute bottom-7 right-0 z-[100] block w-72 rounded-2xl border border-[rgb(var(--color-border-subtle))] bg-[rgb(var(--color-surface))] p-3 text-left normal-case tracking-normal text-[rgb(var(--color-text))] shadow-xl"
        >
          <span className="mb-2 flex items-center justify-between">
            <span className="text-xs font-semibold uppercase tracking-[0.14em] text-[rgb(var(--color-text-secondary))]">
              Run details
            </span>
            <span className="rounded-full bg-[rgb(var(--color-accent))]/10 px-2 py-0.5 text-2xs font-medium text-[rgb(var(--color-accent))]">
              {status}
            </span>
          </span>
          <span className="grid grid-cols-[5.75rem_minmax(0,1fr)] gap-x-3 gap-y-1.5">
            {rows.map(([label, value]) => (
              <span key={label} className="contents">
                <span className="text-2xs font-medium uppercase tracking-[0.12em] text-[rgb(var(--color-text-secondary))]/75">
                  {label}
                </span>
                <span className="truncate font-mono text-xs normal-case tracking-normal text-[rgb(var(--color-text))]/90">
                  {value}
                </span>
              </span>
            ))}
          </span>
          {details.run_id && (
            <span className="mt-2 block truncate border-t border-[rgb(var(--color-border-subtle))] pt-2 font-mono text-2xs normal-case tracking-normal text-[rgb(var(--color-text-secondary))]/70">
              {details.run_id}
            </span>
          )}
        </span>
      )}
    </span>
  );
}

function reasoningEffortLabel(effort: string | undefined): string {
  if (!effort) return "Default";
  return effort === "xhigh" ? "X-high" : effort[0].toUpperCase() + effort.slice(1);
}

function ReasoningEffortPicker({
  value,
  efforts,
  open,
  pickerRef,
  onToggle,
  onChange,
}: {
  value: string;
  efforts: string[];
  open: boolean;
  pickerRef: RefObject<HTMLDivElement | null>;
  onToggle: () => void;
  onChange: (value: AiReasoningEffort) => void;
}) {
  const currentLabel = reasoningEffortLabel(value);
  const options = ["", ...efforts] as AiReasoningEffort[];

  return (
    <div className="relative" ref={pickerRef}>
      <button
        type="button"
        aria-label="Set reasoning effort"
        aria-expanded={open}
        onClick={onToggle}
        className={`flex h-[26px] items-center gap-1 rounded-full border px-2 text-xs transition-colors ${
          open
            ? "border-[rgb(var(--color-accent))]/45 bg-[rgb(var(--color-accent))]/10 text-[rgb(var(--color-accent))]"
            : "border-[rgb(var(--color-border-subtle))] bg-[rgb(var(--color-surface-alt))]/35 text-[rgb(var(--color-text-secondary))] hover:border-[rgb(var(--color-accent))]/45 hover:text-[rgb(var(--color-text))]"
        }`}
        title="Set reasoning effort"
      >
        <Brain className="h-3.5 w-3.5" />
        <span className="max-w-[82px] truncate">{currentLabel}</span>
        <IconChevronDown size={10} />
      </button>
      {open && (
        <div className="absolute bottom-full right-0 z-[100] mb-1 w-44 overflow-hidden rounded-xl border border-[rgb(var(--color-border))] bg-[rgb(var(--color-surface))] py-1 shadow-xl">
          <div className="border-b border-[rgb(var(--color-border-subtle))] px-3 py-1.5 text-2xs font-medium uppercase tracking-[0.14em] text-[rgb(var(--color-text-secondary))]/80">
            Reasoning
          </div>
          {options.map((option) => {
            const selected = option === value;
            return (
              <button
                key={option || "default"}
                type="button"
                onClick={() => onChange(option)}
                className={`flex w-full items-center justify-between gap-2 px-3 py-1.5 text-left text-xs transition-colors ${
                  selected
                    ? "bg-[rgb(var(--color-accent))]/10 text-[rgb(var(--color-text))]"
                    : "text-[rgb(var(--color-text-secondary))] hover:bg-[rgb(var(--color-surface-alt))] hover:text-[rgb(var(--color-text))]"
                }`}
              >
                <span>{reasoningEffortLabel(option)}</span>
                {selected && <IconCheck size={11} />}
              </button>
            );
          })}
        </div>
      )}
    </div>
  );
}

// ── Model list cache (module-level, survives re-renders) ─────────

const modelCache: { key: string; models: string[]; ts: number } = { key: "", models: [], ts: 0 };
const MODEL_CACHE_TTL = 5 * 60 * 1000; // 5 minutes

// ── Model Picker Dropdown ────────────────────────────────────────

function ModelPickerDropdown({
  currentModel,
  providerId,
  onClose,
  maxHeight,
}: {
  currentModel: string;
  providerId?: string;
  onClose: () => void;
  maxHeight: number;
}) {
  const { settings, updateSetting } = useSettings();
  const [models, setModels] = useState<string[]>(modelCache.models);
  const [loadingModels, setLoadingModels] = useState(false);
  const provider = providerId ? providerById(settings, providerId) : null;

  useEffect(() => {
    let cancelled = false;
    const cacheKey = provider
      ? `${provider.id}|${provider.provider}|${provider.endpoint}|${provider.authMode}`
      : `${settings.aiProvider}|${settings.aiEndpoint}|${settings.aiAuthMode}`;

    // Use cache if key matches and not expired
    if (modelCache.key === cacheKey && modelCache.models.length > 0 && Date.now() - modelCache.ts < MODEL_CACHE_TTL) {
      setModels(modelCache.models);
      return;
    }

    async function load() {
      setLoadingModels(true);
      try {
        const secrets = provider && provider.id !== settings.aiActiveProviderId
          ? await loadProviderSecrets(provider.id)
          : { apiKey: settings.aiApiKey, accessToken: settings.aiAccessToken };
        const providerInput = provider
          ? providerToConfigInput(provider, settings, {
              apiKey: secrets.apiKey,
              accessToken: secrets.accessToken,
            })
          : activeProviderInput(settings);
        const config = buildProviderConfig(
          providerInput,
          settings.aiAgentExecutionEngine || "prompty",
        );
        const result = await invoke<{ id: string; name: string; owned_by?: string; capabilities?: Record<string, string>; context_length?: number }[]>("list_models", { config });
        if (!cancelled) {
          const ids = filterAgentCompatibleModels(result, config.provider).map((m) => m.id || m.name);
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
  }, [settings, currentModel, provider]);

  return (
    <div className="absolute bottom-full left-0 mb-1 w-[200px] bg-[rgb(var(--color-surface))] border border-[rgb(var(--color-border))] rounded-lg shadow-lg overflow-hidden z-20 flex flex-col" style={{ maxHeight }}>
      <div className="px-3 py-2 border-b border-[rgb(var(--color-border))] shrink-0">
        <span className="text-2xs font-medium text-[rgb(var(--color-text-secondary))] uppercase tracking-wider">Model</span>
      </div>
      <div className="flex-1 overflow-y-auto py-1">
        {loadingModels ? (
          <div className="px-3 py-2 text-xs text-[rgb(var(--color-text-secondary))] italic">Loading…</div>
        ) : (
          models.map((model) => (
            <button
              key={model}
              className={`w-full flex items-center gap-2 px-3 py-1.5 text-left text-xs transition-colors ${
                model === currentModel
                  ? "text-[rgb(var(--color-accent))] bg-[rgb(var(--color-accent))]/5"
                  : "text-[rgb(var(--color-text-secondary))] hover:bg-[rgb(var(--color-surface-alt))] hover:text-[rgb(var(--color-text))]"
              }`}
              onClick={() => {
                if (provider?.id && settings.aiProviders?.some((candidate) => candidate.id === provider.id)) {
                  updateSetting("aiProviders", settings.aiProviders.map((candidate) =>
                    candidate.id === provider.id ? { ...candidate, model } : candidate,
                  ));
                } else {
                  updateSetting("aiModel", model);
                }
                onClose();
              }}
            >
              {model === currentModel && (
                <Check className="w-2.5 h-2.5" />
              )}
              <span className={model === currentModel ? "" : "ml-[18px]"}>{model}</span>
            </button>
          ))
        )}
      </div>
    </div>
  );
}

// ── Friendly Error Display ────────────────────────────────────────

export function classifyError(error: string): { title: string; suggestion: string } {
  const lower = error.toLowerCase();
  // Distinguish an expired Entra/Foundry OAuth session from a plain API-key
  // problem so the suggestion points at the correct remedy. These markers can
  // appear without an explicit "401" (e.g. an AADSTS refresh-token failure).
  const looksLikeEntra =
    lower.includes("aadsts") ||
    lower.includes("audience") ||
    lower.includes("ai.azure.com") ||
    lower.includes("services.ai.azure.com") ||
    lower.includes("entra") ||
    lower.includes("token is expired") ||
    lower.includes("expired token") ||
    (lower.includes("refresh token") && lower.includes("expired"));
  const looksLikeAuth =
    lower.includes("401") || lower.includes("unauthorized") || lower.includes("authentication");
  if (looksLikeAuth || looksLikeEntra) {
    if (looksLikeEntra)
      return {
        title: "Azure sign-in expired",
        suggestion: "Your Microsoft sign-in has expired. Sign out and sign in again in Settings → AI → Connections.",
      };
    return { title: "Authentication failed", suggestion: "Check your API key or refresh your login in Settings." };
  }
  if (lower.includes("403") || lower.includes("forbidden"))
    return { title: "Access denied", suggestion: "Your account may not have access to this model or endpoint." };
  if (lower.includes("429") || lower.includes("rate limit") || lower.includes("too many"))
    return { title: "Rate limit reached", suggestion: "Wait a moment and try again, or switch to a different model." };
  if (lower.includes("timeout") || lower.includes("timed out"))
    return { title: "Request timed out", suggestion: "The AI took too long to respond. Try a shorter message or simpler request." };
  if (lower.includes("json") || lower.includes("parse") || lower.includes("body"))
    return { title: "Response error", suggestion: "The conversation may be too long. Try starting a new chat." };
  if (lower.includes("network") || lower.includes("connect") || lower.includes("fetch"))
    return { title: "Connection failed", suggestion: "Check your internet connection and endpoint URL in Settings." };
  return { title: "Something went wrong", suggestion: "Try again, or start a new chat if the problem persists." };
}

function ChatErrorCard({ error, onRetry, onDismiss }: { error: string; onRetry: () => void; onDismiss: () => void }) {
  const [showRaw, setShowRaw] = useState(false);
  const { title, suggestion } = classifyError(error);

  return (
    <div className="mx-3 rounded-lg border border-error/20 bg-error/5 overflow-hidden">
      <div className="px-3 py-2.5">
        <div className="text-xs font-medium text-error mb-0.5">{title}</div>
        <div className="text-xs text-[rgb(var(--color-text-secondary))] leading-relaxed">{suggestion}</div>
      </div>
      <div className="flex items-center gap-2 px-3 pb-2">
        <button
          onClick={onRetry}
          className="show-underlines-target text-xs font-medium text-[rgb(var(--color-accent))] hover:underline"
        >
          Try again
        </button>
        <button
          onClick={() => setShowRaw(!showRaw)}
          className="text-xs text-[rgb(var(--color-text-secondary))] hover:text-[rgb(var(--color-text))] transition-colors"
        >
          {showRaw ? "Hide details" : "Show details"}
        </button>
        <div className="flex-1" />
        <button
          onClick={onDismiss}
          className="text-xs text-[rgb(var(--color-text-secondary))] hover:text-[rgb(var(--color-text))] transition-colors"
        >
          Dismiss
        </button>
      </div>
      {showRaw && (
        <div className="px-3 pb-2.5">
          <div className="text-2xs font-mono text-error/80 bg-error/5 rounded px-2 py-1.5 max-h-[100px] overflow-y-auto break-all leading-relaxed">
            {error}
          </div>
        </div>
      )}
    </div>
  );
}
