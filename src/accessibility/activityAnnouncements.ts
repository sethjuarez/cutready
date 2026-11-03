// Turns agent run events into short, plain phrases for screen readers, each
// tagged with the Accessibility > Announcements category that gates it.
import type { AgentEvent } from "../ipc/events";
import type { AnnouncementCategory } from "./settings";

export interface Announcement {
  category: AnnouncementCategory;
  text: string;
}

// Known CutReady agent tools plus common harness file tools. Anything else,
// including web search and fetch, counts as a plain tool call.
const READ_TOOLS = new Set([
  "list_project_files",
  "read_note",
  "read_sketch",
  "read_storyboard",
  "read_visual",
  "view",
  "grep",
  "glob",
  "read_file",
]);
const EDIT_TOOLS = new Set([
  "write_note",
  "write_sketch",
  "write_storyboard",
  "write_visual",
  "create_visual",
  "update_planning_row",
  "set_row_visual",
  "apply_row_visual_nudge",
  "apply_row_visual_command",
  "add_items_to_project",
  "create_project",
  "edit",
  "create",
  "write_file",
]);

export function toolCategory(name: string): AnnouncementCategory {
  const tool = name.toLowerCase();
  if (READ_TOOLS.has(tool)) return "readingFiles";
  if (EDIT_TOOLS.has(tool)) return "editingDocuments";
  return "toolCalls";
}

/** `update_planning_row` → "update planning row". */
export function humanizeToolName(name: string): string {
  return name.replace(/[_-]+/g, " ").trim() || "tool";
}

/**
 * Stateful so a stream of `thinking` deltas yields one "Thinking" and a tool
 * result knows which category its call belonged to.
 */
export function createActivityClassifier() {
  let thinking = false;

  return function classify(event: AgentEvent): Announcement | null {
    const wasThinking = thinking;
    thinking = event.type === "thinking";
    switch (event.type) {
      case "thinking":
        return wasThinking ? null : { category: "reasoning", text: "Thinking" };
      case "tool_call": {
        const name = event.name ?? "tool";
        const category = toolCategory(name);
        const text =
          category === "readingFiles"
            ? "Reading files"
            : category === "editingDocuments"
              ? "Editing documents"
              : `Running ${humanizeToolName(name)}`;
        return { category, text };
      }
      case "tool_result": {
        const name = humanizeToolName(event.name ?? "tool");
        return { category: "commandFinished", text: event.status === "failure" ? `${name} failed` : `${name} finished` };
      }
      case "agent_start":
        return { category: "agentChange", text: `${event.agent_id ?? "Agent"} agent started` };
      default:
        return null;
    }
  };
}

/**
 * Whether an announcement passes the user's switches. A finished read or edit
 * also needs its own category on, so silencing "Reading files" silences its
 * "finished" too.
 */
export function shouldAnnounce(
  announcement: Announcement,
  event: Pick<AgentEvent, "type" | "name">,
  enabled: Record<AnnouncementCategory, boolean>,
): boolean {
  if (!enabled[announcement.category]) return false;
  if (event.type === "tool_result") {
    const callCategory = toolCategory(event.name ?? "");
    if (callCategory !== "toolCalls" && !enabled[callCategory]) return false;
  }
  return true;
}
