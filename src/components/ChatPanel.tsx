import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import { invoke, convertFileSrc } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { SafeMarkdown } from "./SafeMarkdown";

import { useAppStore } from "../stores/appStore";
import { useSettings, type AgentPreset } from "../hooks/useSettings";
import { VersionHistory } from "./VersionHistory";
import { SketchIcon, StoryboardIcon, NoteIcon } from "./Icons";
import type { ChatMessage, ChatSessionSummary, ToolCall } from "../types/sketch";
import {
  SparklesIcon,
  ClockIcon,
  PaperAirplaneIcon,
  DocumentIcon,
  GlobeAltIcon,
  WrenchIcon,
  TrashIcon,
  PlusIcon,
  ArrowDownTrayIcon,
  PaperClipIcon,
  ChevronDownIcon,
  ChevronRightIcon,
  CheckIcon,
  UserIcon,
  XMarkIcon,
  Bars3Icon,
  StopIcon,
  ChevronLeftIcon,
  EllipsisVerticalIcon,
} from "@heroicons/react/24/outline";

// ── Helpers ──────────────────────────────────────────────────────

/**
 * Safely extract text from a ChatMessage content field.
 * The backend may return content as a plain string OR as an array of
 * ContentPart objects ({type: "text", text: "..."} / {type: "image_url", ...}).
 * This normalizes both to a plain string for rendering.
 */
function textContent(content: ChatMessage["content"]): string {
  if (content == null) return "";
  if (typeof content === "string") return content;
  // Array of content parts — extract text parts
  if (Array.isArray(content)) {
    return (content as Array<{ type: string; text?: string }>)
      .filter((p) => p.type === "text" && p.text)
      .map((p) => p.text!)
      .join("\n");
  }
  // Unknown shape — coerce to string as last resort
  return String(content);
}

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

type SecondaryTab = "chat" | "sessions" | "snapshots";

// ── Built-in Agent Presets ───────────────────────────────────────

export const BUILT_IN_AGENTS: AgentPreset[] = [
  {
    id: "planner",
    name: "Planner",
    description: "Analyzes your project and recommends a plan — never edits directly",
    prompt: `You are CutReady AI — Planner mode. You help users plan demo videos by **recommending** changes, not making them directly.

## Your Role
Analyze the current project and suggest a plan for creating or improving sketches. You gather context, think through structure, and present your recommendations in chat — but you **never** call set_planning_rows or update_planning_row yourself.

## How to Think
1. **Understand**: What is the user trying to accomplish? What kind of demo are they building?
2. **Gather**: Use list_project_files, read_note, read_sketch to understand the current state.
3. **Plan**: Present a clear, structured plan in chat using markdown.

## Output Format
Present your plan as a markdown table so the user can review before asking the Writer or Editor to execute:

| Time | Narrative | Demo Actions |
|------|-----------|--------------|
| ~30s | Introduce the feature… | Open the dashboard… |

## Guidelines
- Read referenced files before making suggestions
- **Do NOT call set_planning_rows or update_planning_row** — present your plan in chat text only
- The user will hand off to the Writer or Editor agent to apply your plan
- Keep narrative concise — these are voiceover bullets, not essays
- Time estimates should be realistic for live demos (~15-60s per row)
- If revising an existing sketch, show what you'd change and why
- Use markdown formatting in responses
- **Never use em-dash (—) or en-dash (–) in any text content.** Use -- or - instead.`,
  },
  {
    id: "writer",
    name: "Writer",
    description: "Rewrites narrative and scripts for natural spoken delivery",
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
- **Always apply changes via update_planning_row or set_planning_rows** — don't paste revised content as text in chat
- Use update_planning_row for targeted narrative edits
- Use markdown formatting in responses
- **Never use em-dash (—) or en-dash (–) in any text content.** Use -- or - instead.

## Framing Visuals (elucim)
You can create animated framing visuals for any row using \`set_row_visual\`. These are diagrams, charts, or animated explanations that replace a screenshot. Use them for:
- Concept diagrams (architecture, data flow, relationships)
- Step-by-step reveals (progressive build-up of an idea)
- Math/formulas (LaTeX equations), charts (barChart), graphs (axes + function plots)
- Annotated illustrations

The visual uses the elucim DSL — a JSON document with \`version: "1.0"\` and a \`root\` node (scene or player).
Available node types: circle, rect, line, arrow, text, group, polygon, image, axes, latex, graph, matrix, barChart.
Animations: fadeIn, fadeOut, draw (for lines/arrows), easing, rotation, scale, translate.
Example scene: \`{ "version": "1.0", "root": { "type": "scene", "width": 800, "height": 450, "background": "#1a1a2e", "children": [{ "type": "text", "text": "Hello", "x": 400, "y": 225, "fontSize": 48, "fill": "#e0e0e0", "textAnchor": "middle", "fadeIn": 30 }] } }\``,
  },
  {
    id: "editor",
    name: "Editor",
    description: "Makes precise, targeted edits to specific cells in your sketch",
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
- **Always apply edits via tools** — don't paste revised content as text in chat
- Keep responses brief — just confirm the change
- Don't add unsolicited suggestions unless asked
- Use \`set_row_visual\` to add/update animated visuals on rows. Pass \`null\` to remove a visual.
- **Never use em-dash (—) or en-dash (–) in any text content.** Use -- or - instead.`,
  },
  {
    id: "designer",
    name: "Designer",
    description: "Creates animated visuals and diagrams using the elucim DSL",
    prompt: `You are CutReady AI — Designer mode. You create rich, polished animated visuals for demo sketch rows using the elucim DSL.

## IMPORTANT: User Instructions
When the user message includes "USER INSTRUCTIONS" — those take **absolute priority**. Your visual must follow them exactly. Use design_plan and set_row_visual to realize the user's vision, not your own defaults.

## Workflow

1. **Read** the full sketch with \`read_sketch\` to understand the overall flow.
2. **Call \`design_plan\`** with a detailed English description covering:
   - **Elements:** shapes, text, icons, groups
   - **Layout:** where each element sits on the 960×540 canvas
   - **Colors:** which accent family (blue/purple/green/rose/amber)
   - **Animation:** how elements appear — stagger, timing
   If the row already has a design_plan, use it as a starting point.
3. **Generate DSL JSON** following the canvas rules and reference below.
4. **Call \`set_row_visual\`** — it auto-validates structure and auto-critiques layout. If it returns errors, fix them and call again.

That's it — two tool calls: \`design_plan\` then \`set_row_visual\`. No need to call validate or critique separately.

## Canvas
960×540 player (16:9, HD). Always specify width/height explicitly:
\`\`\`json
{ "type": "player", "width": 960, "height": 540, "fps": 30, "durationInFrames": 90, "background": "$background", "children": [...] }
\`\`\`

**CRITICAL:** The root \`background\` fills the ENTIRE canvas. Set it to \`"$background"\`. NEVER add an extra background rectangle. All content floats directly over this background.

## DSL Quick Reference
Root: \`{ "version": "1.0", "root": { "type": "player", "width": 960, "height": 540, ... } }\`

Nodes: \`text\` (content, x, y, fontSize, fill, fontWeight, textAnchor), \`rect\` (x, y, width, height, fill, stroke, rx), \`circle\` (cx, cy, r, fill, stroke), \`line\` (x1, y1, x2, y2, stroke), \`arrow\` (x1, y1, x2, y2, stroke, headSize), \`group\` (x, y, children), \`polygon\` (points, fill)

Text uses \`content\` not \`text\`: \`{ "type": "text", "content": "Hello", ... }\`

**NEVER use em-dash (—) or en-dash (–) in text content strings.** Use -- or - instead. Non-ASCII dashes cause rendering issues.

Animations: \`fadeIn: <frame>\` (must be ≥ 1), \`draw: <frame>\`, \`fadeOut: <frame>\`. Duration: 60-120 frames at 30fps.

## Layout & Readability Rules

1. **Fill the canvas edge-to-edge.** Use the FULL 960×540 area. No inner "card" rect with margins.
2. **Minimum font sizes:** titles ≥ 32px, labels ≥ 18px, annotations ≥ 14px.
3. **No overlapping.** Every element must have clear space.
4. **Text safe area:** keep text ≥30px from edges. Shapes CAN extend to edges.
5. **Spacing:** ≥20px between elements, ≥40px between groups.
6. **One key concept per visual** — illustrated richly.
7. **Text inside containers:** Approximate text width as \`chars × fontSize × 0.55\`.

## Color Rules — Semantic Tokens REQUIRED

\`$token\` syntax resolves to CSS variables for dark/light theme support.

**MANDATORY tokens:**
- \`$background\` — root background only
- \`$foreground\` — titles and primary text
- \`$muted\` — subtitles, annotations
- \`$surface\` — card/container fills
- \`$border\` — outlines, dividers

**Accent colors** (pick ONE family):
- Blue: \`#38bdf8\`, \`rgba(56,189,248,0.12)\`
- Purple: \`#a78bfa\`, \`rgba(167,139,250,0.12)\`
- Green: \`#22c55e\`, \`rgba(34,197,94,0.08)\`
- Rose: \`#fb7185\`, \`rgba(251,113,133,0.12)\`
- Amber: \`#fbbf24\`, \`rgba(251,191,36,0.10)\`

Pattern: accent hex for strokes/labels, semi-transparent rgba for fills. Max 2-3 accents.

## Example
\`\`\`json
{
  "version": "1.0",
  "root": {
    "type": "player", "width": 960, "height": 540, "fps": 30, "durationInFrames": 90,
    "background": "$background",
    "children": [
      { "type": "text", "content": "Microsoft Foundry", "x": 480, "y": 68, "fontSize": 38, "fill": "$foreground", "fontWeight": "900", "textAnchor": "middle", "fadeIn": 4 },
      { "type": "text", "content": "from models to production agents", "x": 480, "y": 104, "fontSize": 18, "fill": "$muted", "fontWeight": "600", "textAnchor": "middle", "fadeIn": 8 },
      { "type": "line", "x1": 0, "y1": 130, "x2": 960, "y2": 130, "stroke": "$border", "strokeWidth": 1, "fadeIn": 10 },
      { "type": "rect", "x": 40, "y": 170, "width": 240, "height": 120, "fill": "rgba(167,139,250,0.10)", "stroke": "#a78bfa", "strokeWidth": 2, "rx": 14, "fadeIn": 14 },
      { "type": "text", "content": "Models", "x": 160, "y": 220, "fontSize": 22, "fill": "#a78bfa", "fontWeight": "700", "textAnchor": "middle", "fadeIn": 16 },
      { "type": "arrow", "x1": 300, "y1": 230, "x2": 370, "y2": 230, "stroke": "#38bdf8", "strokeWidth": 2, "headSize": 10, "draw": 24 },
      { "type": "rect", "x": 380, "y": 160, "width": 280, "height": 140, "fill": "rgba(34,197,94,0.08)", "stroke": "#22c55e", "strokeWidth": 2, "rx": 14, "fadeIn": 30 },
      { "type": "text", "content": "Foundry", "x": 520, "y": 216, "fontSize": 26, "fill": "#22c55e", "fontWeight": "800", "textAnchor": "middle", "fadeIn": 32 },
      { "type": "arrow", "x1": 680, "y1": 230, "x2": 740, "y2": 230, "stroke": "#38bdf8", "strokeWidth": 2, "headSize": 10, "draw": 42 },
      { "type": "rect", "x": 750, "y": 180, "width": 170, "height": 100, "fill": "$surface", "stroke": "$border", "rx": 14, "fadeIn": 48 },
      { "type": "text", "content": "Production Agent", "x": 835, "y": 235, "fontSize": 18, "fill": "$foreground", "fontWeight": "700", "textAnchor": "middle", "fadeIn": 50 }
    ]
  }
}
\`\`\`

## Common Mistakes — DO NOT
- ❌ Add a background rect that fills the canvas — root \`background\` does this
- ❌ Add an inner "card" rect with margins — use the full canvas
- ❌ Use fontSize below 14
- ❌ Overlap text — check y coordinates have enough spacing
- ❌ Put long text in a small box — text will overflow
- ❌ Forget \`$background\` on root
- ❌ Use only hex for text — use \`$foreground\`/\`$muted\` tokens
- ❌ Use \`"preset": "card"\` — always use explicit width/height`,
    modelOverride: "gpt-5.1-codex",
  },
];

/** Resolve an agent ID to its prompt text. Checks custom agents first, then built-ins. */
export function resolveAgentPrompt(agentId: string, customAgents: AgentPreset[]): string {
  const custom = customAgents.find((a) => a.id === agentId);
  if (custom) return custom.prompt;
  const builtin = BUILT_IN_AGENTS.find((a) => a.id === agentId);
  return builtin?.prompt ?? BUILT_IN_AGENTS[0].prompt;
}

// ── SVG Icons (using Heroicons) ──────────────────────────────────

function IconSparkles({ size = 14 }: { size?: number }) {
  return <SparklesIcon width={size} height={size} />;
}

function IconHistory({ size = 14 }: { size?: number }) {
  return <ClockIcon width={size} height={size} />;
}

function IconSend({ size = 14 }: { size?: number }) {
  return <PaperAirplaneIcon width={size} height={size} />;
}

function IconFile({ size = 12 }: { size?: number }) {
  return <DocumentIcon width={size} height={size} />;
}

function IconGlobe({ size = 12 }: { size?: number }) {
  return <GlobeAltIcon width={size} height={size} />;
}

function IconWrench({ size = 12 }: { size?: number }) {
  return <WrenchIcon width={size} height={size} />;
}

function IconTrash({ size = 12 }: { size?: number }) {
  return <TrashIcon width={size} height={size} />;
}

function IconPlus({ size = 14 }: { size?: number }) {
  return <PlusIcon width={size} height={size} />;
}

function IconSave({ size = 14 }: { size?: number }) {
  return <ArrowDownTrayIcon width={size} height={size} />;
}

function IconPaperclip({ size = 14 }: { size?: number }) {
  return <PaperClipIcon width={size} height={size} />;
}

function IconChevronDown({ size = 10 }: { size?: number }) {
  return <ChevronDownIcon width={size} height={size} />;
}

function IconChevron({ size = 10, expanded = false }: { size?: number; expanded?: boolean }) {
  return (
    <ChevronRightIcon
      width={size}
      height={size}
      style={{ transform: expanded ? "rotate(90deg)" : "rotate(0deg)", transition: "transform 0.15s" }}
    />
  );
}

function IconCheck({ size = 12 }: { size?: number }) {
  return <CheckIcon width={size} height={size} className="ml-auto shrink-0" />;
}

function IconUser({ size = 12 }: { size?: number }) {
  return <UserIcon width={size} height={size} />;
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
  const [showMenu, setShowMenu] = useState(false);
  const menuRef = useRef<HTMLDivElement>(null);

  // Close dropdown on outside click
  useEffect(() => {
    if (!showMenu) return;
    function handleClick(e: MouseEvent) {
      if (menuRef.current && !menuRef.current.contains(e.target as Node)) {
        setShowMenu(false);
      }
    }
    document.addEventListener("mousedown", handleClick);
    return () => document.removeEventListener("mousedown", handleClick);
  }, [showMenu]);

  return (
    <div className="flex flex-col h-full bg-[rgb(var(--color-surface-inset))]">
      {/* Header with back navigation / overflow menu */}
      <div className="flex items-center justify-between px-3 h-10 border-b border-[rgb(var(--color-border))] shrink-0">
        {activeTab === "chat" ? (
          <span className="text-[13px] font-medium text-[rgb(var(--color-text))]">Chat</span>
        ) : (
          <button
            onClick={() => setActiveTab("chat")}
            className="flex items-center gap-1.5 text-[13px] font-medium text-[rgb(var(--color-text-secondary))] hover:text-[rgb(var(--color-text))] transition-colors"
          >
            <ChevronLeftIcon className="w-3.5 h-3.5" />
            {activeTab === "sessions" ? "Sessions" : "Snapshots"}
          </button>
        )}
        {activeTab === "chat" && (
          <div className="relative" ref={menuRef}>
            <button
              onClick={() => setShowMenu(!showMenu)}
              className="p-1 rounded-md text-[rgb(var(--color-text-secondary))] hover:text-[rgb(var(--color-text))] hover:bg-[rgb(var(--color-surface-alt))] transition-colors"
              title="More options"
            >
              <EllipsisVerticalIcon className="w-4 h-4" />
            </button>
            {showMenu && (
              <div className="absolute right-0 top-full mt-1 z-20 w-[180px] py-1 bg-[rgb(var(--color-surface))] border border-[rgb(var(--color-border))] rounded-lg shadow-lg">
                <button
                  onClick={() => { setActiveTab("sessions"); setShowMenu(false); }}
                  className="w-full px-3 py-2 text-left text-[12px] text-[rgb(var(--color-text))] hover:bg-[rgb(var(--color-surface-alt))] transition-colors flex items-center gap-2"
                >
                  <IconHistory size={14} />
                  Session History
                </button>
                <button
                  onClick={() => { setActiveTab("snapshots"); setShowMenu(false); }}
                  className="w-full px-3 py-2 text-left text-[12px] text-[rgb(var(--color-text))] hover:bg-[rgb(var(--color-surface-alt))] transition-colors flex items-center gap-2"
                >
                  <IconSave size={14} />
                  Snapshots
                </button>
              </div>
            )}
          </div>
        )}
      </div>

      {/* Tab content */}
      <div className="flex-1 min-h-0">
        {activeTab === "chat" && <ChatTab />}
        {activeTab === "sessions" && <ChatHistory onOpenSession={() => setActiveTab("chat")} />}
        {activeTab === "snapshots" && <VersionHistory />}
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
  const activeNotePath = useAppStore((s) => s.activeNotePath);
  const messages = useAppStore((s) => s.chatMessages);
  const setChatMessages = useAppStore((s) => s.setChatMessages);
  const loading = useAppStore((s) => s.chatLoading);
  const setChatLoading = useAppStore((s) => s.setChatLoading);
  const error = useAppStore((s) => s.chatError);
  const setChatError = useAppStore((s) => s.setChatError);
  const addActivityEntries = useAppStore((s) => s.addActivityEntries);
  const chatSessionPath = useAppStore((s) => s.chatSessionPath);
  const newChatSession = useAppStore((s) => s.newChatSession);
  const loadSketches = useAppStore((s) => s.loadSketches);
  const loadNotes = useAppStore((s) => s.loadNotes);
  const loadStoryboards = useAppStore((s) => s.loadStoryboards);
  const openSketch = useAppStore((s) => s.openSketch);
  const openNote = useAppStore((s) => s.openNote);
  const openStoryboard = useAppStore((s) => s.openStoryboard);
  const pendingChatPrompt = useAppStore((s) => s.pendingChatPrompt);

  const [input, setInput] = useState("");
  const [references, setReferences] = useState<FileReference[]>([]);
  const [showAutocomplete, setShowAutocomplete] = useState(false);
  const [autocompleteFilter, setAutocompleteFilter] = useState("");
  const [autocompleteIndex, setAutocompleteIndex] = useState(0);
  const [showContextPicker, setShowContextPicker] = useState(false);
  const [contextFilter, setContextFilter] = useState("");
  const [showModelPicker, setShowModelPicker] = useState(false);
  const [showAgentPicker, setShowAgentPicker] = useState(false);
  const [toolbarExpanded, setToolbarExpanded] = useState(() => {
    return localStorage.getItem("cutready:chat-toolbar-expanded") === "true";
  });
  const [expandedWebRef, setExpandedWebRef] = useState<string | null>(null);
  const [streamingText, setStreamingText] = useState<string>("");
  const [streamingThinking, setStreamingThinking] = useState<string>("");
  const [streamingStatus, setStreamingStatus] = useState<string>("");

  // Auto-create a session path on first mount if none exists
  useEffect(() => {
    if (!chatSessionPath) newChatSession();
  }, [chatSessionPath, newChatSession]);

  // Listen for streaming agent events from the backend
  const streamingRef = useRef("");
  const thinkingRef = useRef("");
  const abortedRef = useRef(false);
  const pendingToolArgsRef = useRef<Record<string, string>>({});
  useEffect(() => {
    const unlisten = listen<{ type: string; content?: string; message?: string; name?: string; arguments?: string; result?: string; response?: string; agent_id?: string; task?: string }>("agent-event", (event) => {
      const ev = event.payload;
      switch (ev.type) {
        case "delta":
          streamingRef.current += ev.content ?? "";
          setStreamingText(streamingRef.current);
          break;
        case "delta_reset":
          streamingRef.current = "";
          setStreamingText("");
          break;
        case "thinking":
          thinkingRef.current += ev.content ?? "";
          setStreamingThinking(thinkingRef.current);
          break;
        case "status":
          setStreamingStatus(ev.message ?? "");
          // Compaction status events get injected as visible system messages in chat
          if (ev.message && ev.message.startsWith("Compacting context")) {
            setChatMessages([...messages, { role: "system", content: ev.message! }]);
          }
          addActivityEntries([{
            id: crypto.randomUUID(),
            timestamp: new Date(),
            source: "status",
            content: ev.message ?? "",
            level: "info",
          }]);
          break;
        case "tool_call":
          // Stash args so tool_result can use them (e.g. to extract path)
          if (ev.name) pendingToolArgsRef.current[ev.name] = ev.arguments ?? "{}";
          addActivityEntries([{
            id: crypto.randomUUID(),
            timestamp: new Date(),
            source: ev.name ?? "tool",
            content: `Called with: ${ev.arguments ?? "{}"}`,
            level: "info",
          }]);
          break;
        case "tool_result": {
          addActivityEntries([{
            id: crypto.randomUUID(),
            timestamp: new Date(),
            source: `result ${ev.name ?? ""}`.trim(),
            content: ev.result ?? "",
            level: "success",
          }]);
          // Auto-refresh sidebar and open sketches after tool mutations
          const toolName = ev.name ?? "";
          const resultText = ev.result ?? "";
          const isSuccess = !resultText.startsWith("Error");
          if (isSuccess && (toolName === "set_planning_rows" || toolName === "update_planning_row" || toolName === "set_row_visual" || toolName === "design_plan")) {
            loadSketches();
            try {
              const args = JSON.parse(pendingToolArgsRef.current[toolName] ?? "{}");
              const sketchPath = args.path ?? useAppStore.getState().activeSketchPath;
              // Extract changed row indices for highlighting
              const changedRows: number[] = [];
              if (toolName === "update_planning_row" || toolName === "set_row_visual" || toolName === "design_plan") {
                const idx = typeof args.index === "number" ? args.index : parseInt(args.index, 10);
                if (!isNaN(idx)) changedRows.push(idx);
              }
              // set_planning_rows: leave changedRows empty → highlights all
              const detail = { rows: changedRows, toolName };
              if (sketchPath) {
                // Dispatch BEFORE openSketch so SketchForm can snapshot current state
                window.dispatchEvent(new CustomEvent("cutready:ai-sketch-updated", { detail }));
                openSketch(sketchPath);
              } else {
                window.dispatchEvent(new CustomEvent("cutready:ai-sketch-updated", { detail }));
              }
            } catch {
              window.dispatchEvent(new CustomEvent("cutready:ai-sketch-updated", { detail: { rows: [], toolName } }));
            }
          }
          if (isSuccess && toolName === "update_note") {
            loadNotes();
            try {
              const args = JSON.parse(pendingToolArgsRef.current[toolName] ?? "{}");
              if (args.path) openNote(args.path);
            } catch { /* ignore parse errors */ }
            // Signal that AI edited a note so UI can show feedback
            window.dispatchEvent(new CustomEvent("cutready:ai-note-updated"));
          }
          if (isSuccess && toolName === "update_storyboard") {
            loadStoryboards();
            try {
              const args = JSON.parse(pendingToolArgsRef.current[toolName] ?? "{}");
              if (args.path) openStoryboard(args.path);
            } catch { /* ignore parse errors */ }
          }
          if (isSuccess && toolName === "create_note") {
            loadNotes();
            try {
              const args = JSON.parse(pendingToolArgsRef.current[toolName] ?? "{}");
              const filename = args.filename?.trim()?.replace(/[/\\]/g, "-");
              const safeName = filename?.endsWith(".md") ? filename : `${filename}.md`;
              if (safeName) openNote(safeName);
            } catch { /* ignore parse errors */ }
            window.dispatchEvent(new CustomEvent("cutready:ai-note-updated"));
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
          setStreamingStatus(`Agent "${ev.agent_id}" working…`);
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
  }, [addActivityEntries, loadSketches, loadNotes, loadStoryboards, openSketch, openNote, openStoryboard]);

  const messagesEndRef = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLTextAreaElement>(null);
  const autocompleteRef = useRef<HTMLDivElement>(null);
  const contextPickerRef = useRef<HTMLDivElement>(null);
  const modelPickerRef = useRef<HTMLDivElement>(null);
  const agentPickerRef= useRef<HTMLDivElement>(null);

  // Constrain dropdown heights to available viewport space
  const acMaxH = useDropdownMaxHeight(autocompleteRef, showAutocomplete);
  const ctxMaxH = useDropdownMaxHeight(contextPickerRef, showContextPicker);
  const modelMaxH = useDropdownMaxHeight(modelPickerRef, showModelPicker);
  const agentMaxH= useDropdownMaxHeight(agentPickerRef, showAgentPicker);

  const toggleToolbar = useCallback(() => {
    setToolbarExpanded((prev) => {
      const next = !prev;
      localStorage.setItem("cutready:chat-toolbar-expanded", String(next));
      return next;
    });
  }, []);

  // All agents: built-ins + custom
  const allAgents = useMemo(() => {
    const custom = settings.aiAgents || [];
    return [...BUILT_IN_AGENTS, ...custom];
  }, [settings.aiAgents]);

  const selectedAgent = useMemo(() => {
    const id = settings.aiSelectedAgent || "planner";
    return allAgents.find((a) => a.id === id) ?? BUILT_IN_AGENTS[0];
  }, [settings.aiSelectedAgent, allAgents]);

  // Auto-scroll to bottom on new messages and streaming updates
  useEffect(() => {
    messagesEndRef.current?.scrollIntoView({ behavior: "smooth" });
  }, [messages, streamingText]);

  // Click-outside to close pickers
  useEffect(() => {
    if (!showContextPicker && !showModelPicker && !showAgentPicker) return;
    const handle = (e: MouseEvent) => {
      if (showContextPicker && contextPickerRef.current && !contextPickerRef.current.contains(e.target as Node)) setShowContextPicker(false);
      if (showModelPicker && modelPickerRef.current && !modelPickerRef.current.contains(e.target as Node)) setShowModelPicker(false);
      if (showAgentPicker && agentPickerRef.current && !agentPickerRef.current.contains(e.target as Node)) setShowAgentPicker(false);
    };
    window.addEventListener("mousedown", handle);
    return () => window.removeEventListener("mousedown", handle);
  }, [showContextPicker, showModelPicker, showAgentPicker]);

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

  const buildConfig= useCallback(() => ({
    provider: settings.aiProvider,
    endpoint: settings.aiEndpoint,
    api_key: settings.aiApiKey,
    model: settings.aiModel || "unused",
    bearer_token: settings.aiAuthMode === "azure_oauth" ? settings.aiAccessToken : null,
    context_length: settings.aiContextLength || null,
    vision_mode: settings.aiVisionMode || "off",
  }), [settings]);

  // Build system prompt from selected agent
  const [memoryContext, setMemoryContext] = useState("");

  // Load memory context when project opens
  useEffect(() => {
    invoke<string>("get_memory_context")
      .then(setMemoryContext)
      .catch(() => setMemoryContext(""));
  }, [activeSketchPath]);

  // Keep Rust-side chat summary in sync so window close can archive reliably.
  // Updates whenever messages change (debounced by React's batching).
  useEffect(() => {
    if (messages.length > 1 && chatSessionPath) {
      const userMsgs = messages.filter((m) => m.role === "user");
      const summary = userMsgs.map((m) => textContent(m.content).slice(0, 100)).filter(Boolean).join("; ");
      if (summary) {
        invoke("update_chat_summary", {
          sessionId: chatSessionPath,
          summary: `Topics discussed: ${summary}`,
        }).catch(() => {});
      }
    }
  }, [messages, chatSessionPath]);

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
    if (activeNotePath) {
      prompt += `\n\nThe user is currently editing the note at: ${activeNotePath}. Use the read_note tool with this path to see its contents before making suggestions.`;
    }
    return prompt;
  }, [settings.aiSelectedAgent, settings.aiAgents, activeSketchPath, activeNotePath, memoryContext]);

  const handleSend = useCallback(async (overrideText?: string, opts?: { silent?: boolean; agent?: string }) => {
    const text = (overrideText ?? input).trim().replace(/\r\n/g, "\n");
    if (!text) return;
    const silent = opts?.silent ?? false;
    const agentOverride = opts?.agent;

    setInput("");
    setShowAutocomplete(false);

    // If agent is already running, push to pending stack
    if (loading) {
      try {
        await invoke("push_pending_chat_message", { message: text });
        // Show pending message with a queued marker (rendered specially by MessageRow)
        const pendingMsg: ChatMessage = { role: "user", content: text, pending: true };
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

      // Web refs shown as compact footnotes after the message text
      const webTags = webRefs.map((wr) => `[Web: ${wr.path}]`).join(" ");

      // Build separate LLM parts with full web content
      const llmParts = [...parts];
      for (const wr of webRefs) {
        if (wr.webContent && wr.webStatus === "ready") {
          llmParts.push(`[Web Content: ${wr.path}]\n${wr.webContent}`);
        }
      }

      // File refs + web refs shown as footnotes after the message text
      const footnote = parts.length > 0 ? `\n${parts.join(" · ")}` : "";
      userContent = `${text}${footnote}${webTags ? `\n${webTags}` : ""}`;
      llmContent = `${text}${footnote}\n\n${llmParts.filter((p) => p.startsWith("[Web Content:")).join("\n\n")}`;
    }

    const userMsg: ChatMessage = { role: "user", content: userContent };
    const newMessages = [...messages, userMsg];
    // For silent sends, don't update the displayed chat with the user message
    if (!silent) {
      setChatMessages(newMessages);
    }
    setReferences([]);

    // Build full conversation with system prompt — use llmContent for last message so LLM gets web content
    const llmMessages = newMessages.map((m, i) =>
      i === newMessages.length - 1 && llmContent ? { ...m, content: llmContent } : m
    );
    // If an agent override was requested (e.g. from ✨ buttons), use that agent's prompt
    let effectiveSystemPrompt = systemPrompt;
    if (agentOverride) {
      const customAgents = settings.aiAgents || [];
      let overridePrompt = resolveAgentPrompt(agentOverride, customAgents);
      if (memoryContext) overridePrompt += `\n${memoryContext}`;
      if (activeSketchPath) overridePrompt += `\n\nThe user is currently editing the sketch at: ${activeSketchPath}`;
      if (activeNotePath) overridePrompt += `\n\nThe user is currently editing the note at: ${activeNotePath}`;
      effectiveSystemPrompt = overridePrompt;
    }
    const fullMessages: ChatMessage[] = [
      { role: "system", content: effectiveSystemPrompt },
      ...llmMessages,
    ];

    setChatLoading(true);
    abortedRef.current = false;
    streamingRef.current = "";
    thinkingRef.current = "";
    setStreamingText("");
    setStreamingThinking("");
    setStreamingStatus("Connecting…");
    // Log the send to activity
    addActivityEntries([{
      id: crypto.randomUUID(),
      timestamp: new Date(),
      source: "chat",
      content: silent ? `✨ ${userContent.slice(0, 60)}…` : `Sent: "${userContent}"`,
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

      // Resolve the effective agent — override agent (from ✨ buttons) takes priority
      const effectiveAgent = agentOverride
        ? [...BUILT_IN_AGENTS, ...(settings.aiAgents || [])].find(a => a.id === agentOverride) ?? selectedAgent
        : selectedAgent;
      const config = {
        ...buildConfig(),
        bearer_token: freshBearerToken,
        // Apply per-agent model override if the effective agent specifies one
        ...(effectiveAgent.modelOverride ? { model: effectiveAgent.modelOverride } : {}),
      };

      // Build agent prompts map for sub-agent delegation
      const agentPrompts: Record<string, string> = {};
      for (const a of BUILT_IN_AGENTS) {
        agentPrompts[a.id] = a.prompt;
      }
      for (const a of (settings.aiAgents || [])) {
        agentPrompts[a.id] = a.prompt;
      }

      // Route to the backend agent command
      const result = await invoke<AgentChatResult>("agent_chat_with_tools", {
            config,
            messages: fullMessages,
            agentPrompts,
          });

      // Activity logging now handled by real-time agent-event listener

      // Use the backend's full conversation (with correct tool_call/tool_result ordering)
      // but strip the system prompt and restore display-friendly user message content
      // (backend has llmContent with full web scrapes; display should use compact userContent)
      const backendMessages = result.messages
        .filter((m) => m.role !== "system")
        .map((m) => {
          // Restore display version of user messages that had web content injected for the LLM
          if (m.role === "user" && llmContent && m.content === llmContent) {
            return { ...m, content: userContent };
          }
          return m;
        })
        // For silent sends, remove the triggering user message from display
        .filter((m) => !(silent && m.role === "user" && (m.content === userContent || m.content === llmContent)));

      // Log response to activity
      const toolCallCount = backendMessages.filter(
        (m) => m.role === "assistant" && m.tool_calls && m.tool_calls.length > 0,
      ).reduce((n, m) => n + (m.tool_calls?.length ?? 0), 0);
      addActivityEntries([{
        id: crypto.randomUUID(),
        timestamp: new Date(),
        source: "response",
        content: `${toolCallCount > 0 ? `${toolCallCount} tool call(s) → ` : ""}${result.response ?? ""}`,
        level: "success",
      }]);

      // If the user stopped generation, discard the result
      if (abortedRef.current) return;

      setChatMessages(backendMessages);
    } catch (err) {
      if (abortedRef.current) return;
      const errMsg = err instanceof Error ? err.message : String(err);
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
      if (!silent) setChatMessages(newMessages);
    } finally {
      setChatLoading(false);
      setStreamingText("");
      setStreamingThinking("");
      setStreamingStatus("");
      streamingRef.current = "";
      thinkingRef.current = "";
    }
  }, [input, loading, messages, references, systemPrompt, buildConfig, setChatMessages, setChatLoading, setChatError, addActivityEntries, settings.aiAgents]);

  // Pick up prompts queued from outside the chat (e.g. sparkle buttons)
  const handleSendRef = useRef(handleSend);
  handleSendRef.current = handleSend;
  useEffect(() => {
    if (pendingChatPrompt) {
      const { text, silent, agent } = pendingChatPrompt;
      useAppStore.setState({ pendingChatPrompt: null });
      handleSendRef.current(text, { silent, agent });
    }
  }, [pendingChatPrompt]);

  const handleStop = useCallback(() => {
    abortedRef.current = true;
    setChatLoading(false);
    setStreamingText("");
    setStreamingThinking("");
    setStreamingStatus("");
    streamingRef.current = "";
    thinkingRef.current = "";
  }, [setChatLoading]);

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

      // Detect # trigger for references
      const cursorPos = e.target.selectionStart;
      const textBefore = val.slice(0, cursorPos);
      const hashIndex = textBefore.lastIndexOf("#");

      if (hashIndex >= 0 && (hashIndex === 0 || textBefore[hashIndex - 1] === " ")) {
        const query = textBefore.slice(hashIndex + 1);

        // Detect completed #URL pattern — triggers when space follows the URL
        const webMatch = val.slice(hashIndex + 1).match(/^(?:web:)?(https?:\/\/\S+)\s/);
        if (webMatch) {
          const url = webMatch[1];
          setReferences((prev) => {
            if (prev.some((r) => r.path === url)) return prev;
            return [...prev, { type: "web", path: url, title: url, webStatus: "loading" }];
          });
          // Keep #URL text in the input — just close autocomplete
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
      // Replace the #query with a clean #title mention
      const cursorPos = inputRef.current?.selectionStart ?? input.length;
      const textBefore = input.slice(0, cursorPos);
      const hashIndex = textBefore.lastIndexOf("#");
      const mention = `#${file.title} `;
      const newInput = input.slice(0, hashIndex) + mention + input.slice(cursorPos);
      setInput(newInput);
      setShowAutocomplete(false);
      // Move cursor after the inserted mention
      setTimeout(() => {
        const pos = hashIndex + mention.length;
        inputRef.current?.setSelectionRange(pos, pos);
        inputRef.current?.focus();
      }, 0);
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
        <p className="text-xs text-[rgb(var(--color-text-secondary))] text-center">
          Open a workspace to start chatting
        </p>
      </div>
    );
  }

  if (!isConfigured) {
    return (
      <div className="flex-1 flex items-center justify-center p-4">
        <div className="text-center">
          <p className="text-xs text-[rgb(var(--color-text-secondary))] mb-2">
            Configure an AI provider in Settings to use the assistant
          </p>
          <button
            className="text-xs text-[rgb(var(--color-accent))] hover:underline"
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
      <div className="flex items-center gap-0.5 px-2 h-[30px] border-b border-[rgb(var(--color-border))] shrink-0">
        <button
          className="flex items-center justify-center w-[26px] h-[26px] rounded text-[rgb(var(--color-text-secondary))] hover:text-[rgb(var(--color-text))] hover:bg-[rgb(var(--color-surface-toolbar))] transition-colors"
          onClick={clearChat}
          title="New Chat"
        >
          <IconPlus size={14} />
        </button>
        <div className="flex-1" />
      </div>

      {/* Messages */}
      <div className="flex-1 overflow-y-auto min-h-0 py-2" style={{ fontSize: "var(--chat-font-size, 13px)" }}>
        {messages.length === 0 && !loading && (
          <div className="flex flex-col items-center justify-center h-full text-center px-4">
            <div className="w-10 h-10 rounded-full bg-[rgb(var(--color-accent))]/10 flex items-center justify-center mb-3 text-[rgb(var(--color-accent))]">
              <IconSparkles size={20} />
            </div>
            <p className="text-[13px] font-medium text-[rgb(var(--color-text))] mb-1">
              CutReady AI
            </p>
            <p className="text-xs text-[rgb(var(--color-text-secondary))] max-w-[220px] leading-relaxed mb-4">
              I can help plan your demo, generate sketches, or refine your script. Use <kbd className="px-1 py-0.5 text-[10px] bg-[rgb(var(--color-surface-alt))] rounded border border-[rgb(var(--color-border))]">#</kbd> to reference files and websites.
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
                    className="px-2.5 py-1 text-[11px] rounded-full border border-[rgb(var(--color-border))] text-[rgb(var(--color-text-secondary))] hover:text-[rgb(var(--color-text))] hover:border-[rgb(var(--color-accent))] hover:bg-[rgb(var(--color-accent))]/5 transition-colors"
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
          <MessageRow
            key={i}
            message={msg}
            projectRoot={currentProject?.root}
            onDelete={msg.role === "user" ? () => {
              const updated = messages.filter((_, idx) => idx !== i);
              setChatMessages(updated);
            } : undefined}
          />
        ))}

        {loading && (
          <div className="px-3.5 py-2">
            {streamingThinking && (
              <details className="mb-2 text-xs border border-[rgb(var(--color-border))] rounded-md overflow-hidden">
                <summary className="px-2.5 py-1.5 cursor-pointer text-[rgb(var(--color-text-secondary))] bg-[rgb(var(--color-surface-alt))] hover:bg-[rgb(var(--color-border))] select-none flex items-center gap-1.5">
                  <span className="opacity-60">💭</span> Thinking{!streamingText && <span className="inline-block w-1 h-3 bg-[rgb(var(--color-accent))] animate-pulse ml-1 rounded-sm" />}
                </summary>
                <div className="px-2.5 py-2 text-[rgb(var(--color-text-secondary))] leading-[1.5] whitespace-pre-wrap max-h-48 overflow-y-auto">
                  {streamingThinking}
                </div>
              </details>
            )}
            {streamingText ? (
              <div className="text-[13px] text-[rgb(var(--color-text))] leading-[1.6]">
                <MarkdownContent content={streamingText} projectRoot={currentProject?.root} />
                <span className="inline-block w-1.5 h-4 bg-[rgb(var(--color-accent))] animate-pulse ml-0.5 align-text-bottom rounded-sm" />
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
      <div className="shrink-0 mx-2.5 mb-2.5 rounded-lg border border-[rgb(var(--color-border))] bg-[rgb(var(--color-surface))] shadow-sm transition-colors focus-within:border-[rgb(var(--color-accent))]">
        {/* Reference chips (shown above textarea) */}
        {references.length > 0 && (
          <div className="px-2.5 pt-2 space-y-1">
            <div className="flex flex-wrap gap-1">
              {references.map((ref) => {
                const c = typeColors(ref.type);
                return (
                <span
                  key={ref.path}
                  className={`inline-flex items-center gap-1 px-1.5 py-0.5 text-[11px] rounded border transition-colors ${
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
                    className="text-[rgb(var(--color-text-secondary))] hover:text-error transition-colors"
                    onClick={() => { removeReference(ref.path); if (expandedWebRef === ref.path) setExpandedWebRef(null); }}
                    title="Remove"
                  >
                    <XMarkIcon className="w-2.5 h-2.5" />
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
                <div className="rounded border border-[rgb(var(--color-border))] bg-[rgb(var(--color-surface-alt))] text-[11px] text-[rgb(var(--color-text-secondary))] overflow-hidden">
                  <div className="flex items-center justify-between px-2 py-1 border-b border-[rgb(var(--color-border))]">
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
                  <span className="text-[10px] text-[rgb(var(--color-text-secondary))] opacity-50">{file.type}</span>
                </button>
              ))}
            </div>
          )}

          <textarea
            ref={inputRef}
            className="w-full resize-none bg-transparent px-2.5 py-2 text-[13px] text-[rgb(var(--color-text))] placeholder-[rgb(var(--color-text-secondary))]/60 focus:outline-none leading-[1.5]"
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
                  ? "bg-[rgb(var(--color-surface))] text-[rgb(var(--color-text))]"
                  : "text-[rgb(var(--color-text-secondary))] hover:text-[rgb(var(--color-text))] hover:bg-[rgb(var(--color-surface))]"
              }`}
              onClick={() => { setShowContextPicker(!showContextPicker); setContextFilter(""); }}
              title="Add Context (#)"
            >
              <IconPaperclip size={12} />
            </button>
            {showContextPicker && (
              <div className="absolute bottom-full left-0 mb-1 w-[240px] bg-[rgb(var(--color-surface))] border border-[rgb(var(--color-border))] rounded-lg shadow-lg overflow-hidden z-20 flex flex-col" style={{ maxHeight: ctxMaxH }}>
                <div className="px-2.5 pt-2 pb-1 shrink-0">
                  <input
                    className="w-full px-2 py-1 text-[11px] bg-[rgb(var(--color-surface-alt))] border border-[rgb(var(--color-border))] rounded text-[rgb(var(--color-text))] placeholder-[rgb(var(--color-text-secondary))] focus:outline-none focus:border-[rgb(var(--color-accent))]"
                    placeholder="Search files…"
                    value={contextFilter}
                    onChange={(e) => setContextFilter(e.target.value)}
                    autoFocus
                  />
                </div>
                <div className="flex-1 overflow-y-auto">
                  {contextPickerOptions.length === 0 ? (
                    <div className="px-3 py-2 text-[11px] text-[rgb(var(--color-text-secondary))]">
                      No matching files
                    </div>
                  ) : (
                    contextPickerOptions.map((file) => (
                      <button
                        key={file.path}
                        className="w-full flex items-center gap-2 px-2.5 py-1.5 text-left text-[11px] text-[rgb(var(--color-text-secondary))] hover:bg-[rgb(var(--color-surface-alt))] hover:text-[rgb(var(--color-text))] transition-colors"
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

          {/* Expand toggle */}
          <button
            className={`flex items-center justify-center w-[26px] h-[26px] rounded text-[rgb(var(--color-text-secondary))] hover:text-[rgb(var(--color-text))] hover:bg-[rgb(var(--color-surface))] transition-colors ${
              toolbarExpanded ? "bg-[rgb(var(--color-surface))]" : ""
            }`}
            onClick={toggleToolbar}
            title={toolbarExpanded ? "Hide options" : "Show agent, model & tools"}
          >
            <ChevronRightIcon
              width={12}
              height={12}
              className={`transition-transform ${toolbarExpanded ? "rotate-180" : ""}`}
            />
          </button>

          {/* Agent, Model, Tools — conditionally visible */}
          {toolbarExpanded && (
            <>
              {/* Agent picker */}
              <div className="relative" ref={agentPickerRef}>
                <button
                  className={`flex items-center gap-1 px-1.5 h-[26px] rounded text-[11px] transition-colors ${
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
                          <span className="text-[10px] font-medium text-[rgb(var(--color-text-secondary))] uppercase tracking-wider">Built-in</span>
                        </div>
                        <div className="py-0.5">
                          {BUILT_IN_AGENTS.map((agent) => (
                            <button
                              key={agent.id}
                              className={`w-full flex items-center gap-2 px-3 py-1.5 text-[11px] text-left transition-colors ${
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
                                  {agent.modelOverride && (
                                    <span className="text-[9px] text-[rgb(var(--color-text-secondary))] opacity-60">{agent.modelOverride}</span>
                                  )}
                                </div>
                                {agent.description && (
                                  <div className="text-[9px] text-[rgb(var(--color-text-secondary))] opacity-70 truncate">{agent.description}</div>
                                )}
                              </div>
                              {selectedAgent.id === agent.id && <IconCheck size={11} />}
                            </button>
                          ))}
                        </div>
                      </>
                    )}
                    {(settings.aiAgents?.length ?? 0) > 0 && (
                      <>
                        <div className="px-3 py-1.5 border-t border-[rgb(var(--color-border))] shrink-0">
                          <span className="text-[10px] font-medium text-[rgb(var(--color-text-secondary))] uppercase tracking-wider">Custom</span>
                        </div>
                        <div className="py-0.5 overflow-y-auto">
                          {(settings.aiAgents || []).map((agent) => (
                            <button
                              key={agent.id}
                              className={`w-full flex items-center gap-2 px-3 py-1.5 text-[11px] text-left transition-colors ${
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
                      ? "bg-[rgb(var(--color-surface))] text-[rgb(var(--color-text))]"
                      : "text-[rgb(var(--color-text-secondary))] hover:text-[rgb(var(--color-text))] hover:bg-[rgb(var(--color-surface))]"
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

            </>
          )}

          <div className="flex-1" />

          {/* Send / Stop button */}
          {loading ? (
            <button
              className="flex items-center justify-center w-[26px] h-[26px] rounded text-error hover:bg-error/10 transition-colors"
              onClick={handleStop}
              title="Stop generation"
            >
              <StopIcon width={14} height={14} />
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

// ── User Content — renders [Web: URL] as styled reference chips ──

function UserContent({ content }: { content: string }) {
  // Split on [Web: ...], [References: ...], and inline #URL patterns
  const parts: React.ReactNode[] = [];
  let lastIndex = 0;
  const combined = /\[(Web|References):\s*([^\]]+)\]|#(?:web:)?(https?:\/\/\S+)/g;
  let match;
  while ((match = combined.exec(content)) !== null) {
    if (match.index > lastIndex) {
      parts.push(content.slice(lastIndex, match.index));
    }
    if (match[1] === "Web") {
      parts.push(<WebRefChip key={match.index} url={match[2].trim()} />);
    } else if (match[1] === "References") {
      // Parse individual references: #note:path, #sketch:path, #storyboard:path
      const refStr = match[2].trim();
      const refs = refStr.split(/,\s*/);
      refs.forEach((ref, i) => {
        const refMatch = ref.match(/^#(note|sketch|storyboard):(.+)$/);
        if (refMatch) {
          const [, type, path] = refMatch;
          const c = typeColors(type);
          const title = path.replace(/\.\w+$/, "").split("/").pop() ?? path;
          parts.push(
            <span
              key={`${match!.index}-${i}`}
              className={`inline-flex items-center gap-1 px-1.5 py-0.5 rounded border text-[11px] font-mono align-baseline mr-0.5 ${c.bg} ${c.text} ${c.border}`}
            >
              <FileTypeIcon type={type} />
              <span className="max-w-[140px] truncate">{title}</span>
            </span>
          );
        } else {
          parts.push(
            <span
              key={`${match!.index}-${i}`}
              className="inline-flex items-center gap-1 px-1.5 py-0.5 rounded bg-[rgb(var(--color-surface))] border border-[rgb(var(--color-border))] text-[11px] text-[rgb(var(--color-text-secondary))] font-mono align-baseline mr-0.5"
            >
              <FileTypeIcon type="file" />
              <span className="max-w-[140px] truncate">{ref}</span>
            </span>
          );
        }
      });
    } else if (match[3]) {
      // Inline #URL — styled as accent link
      parts.push(
        <span key={match.index} className="text-[rgb(var(--color-accent))] font-mono text-[12px]">
          #<span className="underline decoration-[rgb(var(--color-accent))]/40">{match[3]}</span>
        </span>
      );
    }
    lastIndex = match.index + match[0].length;
  }
  if (lastIndex < content.length) {
    parts.push(content.slice(lastIndex));
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
      const result = await invoke<string>("fetch_url_content", { url });
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
        className="inline-flex items-center gap-1 px-1.5 py-0.5 rounded bg-[rgb(var(--color-surface))] border border-[rgb(var(--color-border))] text-[11px] text-[rgb(var(--color-accent))] hover:bg-[rgb(var(--color-surface-toolbar))] transition-colors font-mono align-baseline"
      >
        <GlobeAltIcon className="w-2.5 h-2.5 shrink-0" />
        <span className="max-w-[200px] truncate">{shortUrl}</span>
        <ChevronDownIcon className={`w-2 h-2 shrink-0 transition-transform ${expanded ? "rotate-180" : ""}`} />
      </button>
      {expanded && (
        <span className="block mt-1">
          <span className="block rounded border border-[rgb(var(--color-border))] bg-[rgb(var(--color-surface))] overflow-hidden">
            <span className="flex items-center justify-between px-2 py-1 border-b border-[rgb(var(--color-border))] bg-[rgb(var(--color-surface-toolbar))]">
              <span className="text-[10px] text-[rgb(var(--color-text-secondary))] font-mono truncate">{url}</span>
              {content && <span className="shrink-0 text-[10px] text-[rgb(var(--color-text-secondary))] tabular-nums ml-2">{content.length.toLocaleString()} chars</span>}
            </span>
            <span className="block max-h-[150px] overflow-y-auto p-2 text-[11px] font-mono text-[rgb(var(--color-text-secondary))] whitespace-pre-wrap break-words leading-[1.4]">
              {loading ? "Loading…" : content || "No content"}
            </span>
          </span>
        </span>
      )}
    </>
  );
}

// ── Message Row (VS Code Copilot chat style) ────────────────────

function MessageRow({ message, projectRoot, onDelete }: { message: ChatMessage; projectRoot?: string; onDelete?: () => void }) {
  if (message.role === "user") {
    return (
      <div className="group px-3.5 py-2 flex justify-end items-start gap-1.5">
        {onDelete && (
          <button
            onClick={onDelete}
            className="shrink-0 mt-2 p-1 rounded opacity-0 group-hover:opacity-100 text-[rgb(var(--color-text-secondary))] hover:text-error hover:bg-error/10 transition-all"
            title="Remove message"
          >
            <XMarkIcon className="w-3 h-3" />
          </button>
        )}
        <div className={`rounded-xl rounded-br-sm px-3 py-2 text-[13px] text-[rgb(var(--color-text))] whitespace-pre-wrap break-words leading-[1.6] max-w-[85%] ${
          message.pending
            ? "bg-[rgb(var(--color-surface-alt))] border border-dashed border-[rgb(var(--color-border))] opacity-70"
            : "bg-[#6b5ce7]/[0.05] border border-[#6b5ce7]/40 dark:bg-[#a49afa]/10 dark:border-[#a49afa]/40"
        }`}>
          {message.pending && (
            <span className="inline-flex items-center gap-1 text-[10px] text-[rgb(var(--color-text-secondary))] mb-1">
              <ClockIcon className="w-2.5 h-2.5" />
              Queued
            </span>
          )}
          <UserContent content={textContent(message.content)} />
        </div>
      </div>
    );
  }

  if (message.role === "assistant" && message.tool_calls && message.tool_calls.length > 0) {
    return (
      <div className="px-3.5 py-1">
        <ToolCallsRow toolCalls={message.tool_calls} />
      </div>
    );
  }

  if (message.role === "tool") {
    return null;
  }

  // Compaction / system events — rendered like a tool-call pill
  if (message.role === "system" && message.content) {
    return (
      <div className="px-3.5 py-1">
        <div className="inline-flex items-center gap-1.5 px-2 py-0.5 text-[11px] rounded border transition-colors bg-[rgb(var(--color-accent))]/10 text-[rgb(var(--color-text-secondary))] border-[rgb(var(--color-border))]">
          <Bars3Icon className="w-3 h-3 opacity-70 shrink-0" />
          <span className="font-medium truncate">{textContent(message.content)}</span>
        </div>
      </div>
    );
  }

  if (message.role === "assistant") {
    return (
      <div className="px-3.5 py-2">
        <div className="border-l-2 border-[rgb(var(--color-accent))]/30 pl-3 text-[13px] text-[rgb(var(--color-text))] leading-[1.6]">
          <MarkdownContent content={textContent(message.content)} projectRoot={projectRoot} />
        </div>
      </div>
    );
  }

  return null;
}

// ── Tool Call Row ────────────────────────────────────────────────

function ToolCallsRow({ toolCalls }: { toolCalls: ToolCall[] }) {
  const [expanded, setExpanded] = useState(false);

  // Determine dominant type color from the tool names
  function toolTypeColor(name: string): string {
    if (name.includes("note")) return "note";
    if (name.includes("sketch") || name.includes("planning")) return "sketch";
    if (name.includes("storyboard")) return "storyboard";
    if (name.includes("fetch_url")) return "web";
    return "";
  }

  // Build compact one-line summary
  const names = toolCalls.map((tc) => {
    const name = tc.function.name.replace(/_/g, " ");
    let summary = name;
    try {
      const args = JSON.parse(tc.function.arguments);
      if (args.path) summary += ` → ${args.path}`;
      else if (args.index !== undefined) summary += ` → row ${args.index}`;
    } catch { /* ignore */ }
    return summary;
  });
  const label = toolCalls.length === 1 ? names[0] : `${toolCalls.length} tool calls`;
  const dominantType = toolTypeColor(toolCalls[0]?.function.name ?? "");
  const c = typeColors(dominantType);

  return (
    <div>
      <button
        className={`inline-flex items-center gap-1.5 px-2 py-0.5 text-[11px] rounded border transition-colors max-w-full ${c.bg} ${c.text} ${c.border} hover:brightness-110`}
        onClick={() => setExpanded(!expanded)}
      >
        <span className="opacity-70"><IconWrench size={11} /></span>
        <span className="font-medium truncate">{label}</span>
        <IconChevron size={9} expanded={expanded} />
      </button>
      {expanded && (
        <div className="mt-1 space-y-1">
          {toolCalls.map((tc) => {
            const name = tc.function.name.replace(/_/g, " ").replace(/\b\w/g, (c) => c.toUpperCase());
            let parsed = "{}";
            try { parsed = JSON.stringify(JSON.parse(tc.function.arguments), null, 2); } catch { /* ignore */ }
            return (
              <div key={tc.id} className="text-[11px]">
                <div className="font-medium text-[rgb(var(--color-text-secondary))]">{name}</div>
                <pre className="p-2 rounded bg-[rgb(var(--color-surface-alt))] border border-[rgb(var(--color-border))] overflow-x-auto text-[rgb(var(--color-text-secondary))] leading-relaxed text-[10px]">
                  {parsed}
                </pre>
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
}

// ── Simple Markdown Renderer ─────────────────────────────────────

function MarkdownContent({ content, projectRoot }: { content: string; projectRoot?: string }) {
  return (
    <SafeMarkdown
      components={{
        h1: ({ children }) => <div className="font-bold text-[12px] mt-2 mb-1">{children}</div>,
        h2: ({ children }) => <div className="font-semibold text-[11px] mt-2 mb-0.5">{children}</div>,
        h3: ({ children }) => <div className="font-semibold text-[11px] mt-2 mb-0.5">{children}</div>,
        p: ({ children }) => <div className="my-0.5">{children}</div>,
        strong: ({ children }) => <strong className="font-bold text-[rgb(var(--color-text))]">{children}</strong>,
        em: ({ children }) => <em className="italic text-[rgb(var(--color-accent))]">{children}</em>,
        code: ({ className, children }) => {
          const isBlock = className?.includes("language-");
          if (isBlock) {
            return (
              <pre className="my-1.5 p-2 rounded bg-[rgb(var(--color-surface-alt))] border border-[rgb(var(--color-border))] overflow-x-auto text-[10px] leading-relaxed">
                <code>{children}</code>
              </pre>
            );
          }
          // Inline code — colorize if it looks like a project file path
          const text = typeof children === "string" ? children : "";
          const fileType = detectFileType(text);
          if (fileType) {
            const c = typeColors(fileType);
            return (
              <code className={`px-1 py-0.5 rounded text-[10px] border ${c.bg} ${c.text} ${c.border}`}>
                {children}
              </code>
            );
          }
          return (
            <code className="px-1 py-0.5 bg-[rgb(var(--color-surface-alt))] rounded text-[10px] border border-[rgb(var(--color-border))]">
              {children}
            </code>
          );
        },
        pre: ({ children }) => <>{children}</>,
        ul: ({ children }) => <ul className="ml-3 my-0.5 list-disc list-outside">{children}</ul>,
        ol: ({ children }) => <ol className="ml-3 my-0.5 list-decimal list-outside">{children}</ol>,
        li: ({ children }) => (
          <li className="my-0.5 pl-0.5">{children}</li>
        ),
        table: ({ children }) => (
          <div className="my-1.5 overflow-x-auto rounded border border-[rgb(var(--color-border))]">
            <table className="w-full text-[10px] border-collapse">{children}</table>
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
        a: ({ href, children }) => (
          <a href={href} className="text-[rgb(var(--color-accent))] hover:underline" target="_blank" rel="noopener noreferrer">{children}</a>
        ),
        blockquote: ({ children }) => (
          <div className="border-l-2 border-[rgb(var(--color-accent))] pl-2 my-1 text-[rgb(var(--color-text-secondary))]">{children}</div>
        ),
        hr: () => <div className="border-t border-[rgb(var(--color-border))] my-2" />,
        img: ({ src, alt, ...props }) => {
          let resolvedSrc = src ?? "";
          if (projectRoot && resolvedSrc.includes(".cutready/screenshots/")) {
            resolvedSrc = convertFileSrc(`${projectRoot}/${resolvedSrc}`);
          }
          return <img src={resolvedSrc} alt={alt ?? ""} {...props} className="max-w-full rounded my-1" />;
        },
      }}
    >
      {content}
    </SafeMarkdown>
  );
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
        const result = await invoke<{ id: string; name: string; capabilities?: Record<string, string> }[]>("list_models", { config });
        if (!cancelled) {
          // Show chat-capable models AND Responses API models (codex/pro)
          const chatModels = result.filter((m) => {
            if (!m.capabilities) return true; // no capabilities info = include (OpenAI, etc.)
            if (m.capabilities.chat_completion === "true") return true;
            // Include codex/pro models — we support them via Responses API
            const name = (m.id || m.name || "").toLowerCase();
            return name.includes("codex") || (name.includes("gpt-5") && name.endsWith("-pro"));
          });
          const ids = chatModels.map((m) => m.id || m.name);
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
    <div className="absolute bottom-full left-0 mb-1 w-[200px] bg-[rgb(var(--color-surface))] border border-[rgb(var(--color-border))] rounded-lg shadow-lg overflow-hidden z-20 flex flex-col" style={{ maxHeight }}>
      <div className="px-3 py-2 border-b border-[rgb(var(--color-border))] shrink-0">
        <span className="text-[10px] font-medium text-[rgb(var(--color-text-secondary))] uppercase tracking-wider">Model</span>
      </div>
      <div className="flex-1 overflow-y-auto py-1">
        {loadingModels ? (
          <div className="px-3 py-2 text-[11px] text-[rgb(var(--color-text-secondary))] italic">Loading…</div>
        ) : (
          models.map((model) => (
            <button
              key={model}
              className={`w-full flex items-center gap-2 px-3 py-1.5 text-left text-[11px] transition-colors ${
                model === currentModel
                  ? "text-[rgb(var(--color-accent))] bg-[rgb(var(--color-accent))]/5"
                  : "text-[rgb(var(--color-text-secondary))] hover:bg-[rgb(var(--color-surface-alt))] hover:text-[rgb(var(--color-text))]"
              }`}
              onClick={() => {
                updateSetting("aiModel", model);
                onClose();
              }}
            >
              {model === currentModel && (
                <CheckIcon className="w-2.5 h-2.5" />
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

function classifyError(error: string): { title: string; suggestion: string } {
  const lower = error.toLowerCase();
  if (lower.includes("401") || lower.includes("unauthorized") || lower.includes("authentication"))
    return { title: "Authentication failed", suggestion: "Check your API key or refresh your login in Settings." };
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
        <div className="text-[11px] text-[rgb(var(--color-text-secondary))] leading-relaxed">{suggestion}</div>
      </div>
      <div className="flex items-center gap-2 px-3 pb-2">
        <button
          onClick={onRetry}
          className="text-[11px] font-medium text-[rgb(var(--color-accent))] hover:underline"
        >
          Try again
        </button>
        <button
          onClick={() => setShowRaw(!showRaw)}
          className="text-[11px] text-[rgb(var(--color-text-secondary))] hover:text-[rgb(var(--color-text))] transition-colors"
        >
          {showRaw ? "Hide details" : "Show details"}
        </button>
        <div className="flex-1" />
        <button
          onClick={onDismiss}
          className="text-[11px] text-[rgb(var(--color-text-secondary))] hover:text-[rgb(var(--color-text))] transition-colors"
        >
          Dismiss
        </button>
      </div>
      {showRaw && (
        <div className="px-3 pb-2.5">
          <div className="text-[10px] font-mono text-error/80 bg-error/5 rounded px-2 py-1.5 max-h-[100px] overflow-y-auto break-all leading-relaxed">
            {error}
          </div>
        </div>
      )}
    </div>
  );
}

// ── Helpers ──────────────────────────────────────────────────────

/** Type-specific accent colors — matches the explorer sidebar selected styles. */
function typeColors(type: string): { text: string; bg: string; border: string } {
  switch (type) {
    case "sketch":
      return { text: "text-violet-500", bg: "bg-violet-500/10", border: "border-violet-500/25" };
    case "note":
      return { text: "text-rose-500", bg: "bg-rose-500/10", border: "border-rose-500/25" };
    case "storyboard":
      return { text: "text-success", bg: "bg-success/10", border: "border-success/25" };
    case "web":
      return { text: "text-accent", bg: "bg-accent/10", border: "border-accent/25" };
    default:
      return { text: "text-[rgb(var(--color-text-secondary))]", bg: "bg-[rgb(var(--color-surface))]", border: "border-[rgb(var(--color-border))]" };
  }
}

/** Detect file type from a path string for colorizing. */
function detectFileType(text: string): string | null {
  if (!text) return null;
  const t = text.trim();
  if (/\.sk$/i.test(t)) return "sketch";
  if (/\.md$/i.test(t) || /^notes?\//i.test(t)) return "note";
  if (/\.sb$/i.test(t) || /^storyboards?\//i.test(t)) return "storyboard";
  // Also match tool-style references
  if (/^(read_|set_|update_).*sketch|planning_row/i.test(t)) return "sketch";
  if (/^read_note/i.test(t)) return "note";
  return null;
}

function FileTypeIcon({ type }: { type: string }) {
  const c = typeColors(type);
  const cls = `shrink-0 ${c.text}`;
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

// ── Chat History ─────────────────────────────────────────────────

function ChatHistory({ onOpenSession }: { onOpenSession: () => void }) {
  const [sessions, setSessions] = useState<ChatSessionSummary[]>([]);
  const [loading, setLoading] = useState(true);
  const listChatSessions = useAppStore((s) => s.listChatSessions);
  const loadChatSession = useAppStore((s) => s.loadChatSession);
  const deleteChatSession = useAppStore((s) => s.deleteChatSession);
  const newChatSession = useAppStore((s) => s.newChatSession);
  const chatSessionPath = useAppStore((s) => s.chatSessionPath);

  const refresh = useCallback(async () => {
    setLoading(true);
    const list = await listChatSessions();
    // Sort by most recent first
    list.sort((a, b) => b.updated_at.localeCompare(a.updated_at));
    setSessions(list);
    setLoading(false);
  }, [listChatSessions]);

  useEffect(() => { refresh(); }, [refresh]);

  const handleOpen = useCallback(async (path: string) => {
    await loadChatSession(path);
    onOpenSession();
  }, [loadChatSession, onOpenSession]);

  const handleDelete = useCallback(async (e: React.MouseEvent, path: string) => {
    e.stopPropagation();
    await deleteChatSession(path);
    refresh();
  }, [deleteChatSession, refresh]);

  const handleNewChat = useCallback(() => {
    newChatSession();
    onOpenSession();
  }, [newChatSession, onOpenSession]);

  const formatDate = (iso: string) => {
    try {
      const d = new Date(iso);
      const now = new Date();
      const diff = now.getTime() - d.getTime();
      const mins = Math.floor(diff / 60000);
      if (mins < 1) return "Just now";
      if (mins < 60) return `${mins}m ago`;
      const hrs = Math.floor(mins / 60);
      if (hrs < 24) return `${hrs}h ago`;
      const days = Math.floor(hrs / 24);
      if (days < 7) return `${days}d ago`;
      return d.toLocaleDateString();
    } catch {
      return iso;
    }
  };

  return (
    <div className="flex flex-col h-full">
      {/* Header */}
      <div className="flex items-center justify-between px-3 py-2 border-b border-[rgb(var(--color-border))]">
        <span className="text-[11px] font-medium text-[rgb(var(--color-text-secondary))]">
          {sessions.length} session{sessions.length !== 1 ? "s" : ""}
        </span>
        <button
          onClick={handleNewChat}
          className="flex items-center gap-1 px-2 py-1 rounded text-[11px] font-medium text-[rgb(var(--color-accent))] hover:bg-[rgb(var(--color-accent))]/10 transition-colors"
          title="New chat"
        >
          <IconPlus size={12} />
          New Chat
        </button>
      </div>

      {/* Session list */}
      <div className="flex-1 overflow-y-auto">
        {loading ? (
          <div className="flex items-center justify-center py-8 text-[rgb(var(--color-text-secondary))] text-xs">
            Loading…
          </div>
        ) : sessions.length === 0 ? (
          <div className="flex flex-col items-center justify-center py-12 px-4 text-center gap-2">
            <IconHistory size={24} />
            <span className="text-[12px] text-[rgb(var(--color-text-secondary))]">No chat sessions yet</span>
            <span className="text-[11px] text-[rgb(var(--color-text-secondary))]/60">
              Start a conversation and it will appear here
            </span>
          </div>
        ) : (
          <div className="py-1">
            {sessions.map((s) => {
              const isActive = s.path === chatSessionPath;
              return (
                <div
                  key={s.path}
                  role="button"
                  tabIndex={0}
                  onClick={() => handleOpen(s.path)}
                  onKeyDown={(e) => { if (e.key === "Enter" || e.key === " ") handleOpen(s.path); }}
                  className={`group w-full text-left px-3 py-2.5 flex items-start gap-2 transition-colors border-l-2 cursor-pointer ${
                    isActive
                      ? "border-[rgb(var(--color-accent))] bg-[rgb(var(--color-accent))]/8"
                      : "border-transparent hover:bg-[rgb(var(--color-surface-hover))]"
                  }`}
                >
                  <IconSparkles size={14} />
                  <div className="flex-1 min-w-0">
                    <div className="text-[12px] font-medium text-[rgb(var(--color-text))] truncate leading-tight">
                      {s.title || "Untitled chat"}
                    </div>
                    <div className="flex items-center gap-2 mt-0.5">
                      <span className="text-[10px] text-[rgb(var(--color-text-secondary))]">
                        {s.message_count} message{s.message_count !== 1 ? "s" : ""}
                      </span>
                      <span className="text-[10px] text-[rgb(var(--color-text-secondary))]/50">·</span>
                      <span className="text-[10px] text-[rgb(var(--color-text-secondary))]">
                        {formatDate(s.updated_at)}
                      </span>
                    </div>
                  </div>
                  {/* Delete button — visible on hover */}
                  <button
                    onClick={(e) => handleDelete(e, s.path)}
                    className="shrink-0 p-1 rounded opacity-0 group-hover:opacity-100 hover:bg-[rgb(var(--color-surface-hover))] text-[rgb(var(--color-text-secondary))] hover:text-error transition-all"
                    title="Delete session"
                  >
                    <IconTrash size={12} />
                  </button>
                </div>
              );
            })}
          </div>
        )}
      </div>
    </div>
  );
}
