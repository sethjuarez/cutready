import { webIpc } from "../../ipc/web";
import type { ChatMessage, ChatToolActivity, ChatWorkingNotes } from "../../types/sketch";

const webContentRequests = new Map<string, Promise<string>>();

export const NO_TOOL_ACTIVITY: ChatToolActivity[] = [];

/**
 * Safely extract text from a ChatMessage content field.
 * The backend may return content as a plain string OR as an array of
 * ContentPart objects ({type: "text", text: "..."} / {type: "image_url", ...}).
 * This normalizes both to a plain string for rendering.
 */
export function textContent(content: ChatMessage["content"]): string {
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

export function fetchWebReferenceContent(
  url: string,
  fetcher: (referenceUrl: string) => Promise<string> = webIpc.fetchUrlContent,
): Promise<string> {
  const existing = webContentRequests.get(url);
  if (existing) return existing;

  const request = fetcher(url);
  webContentRequests.set(url, request);
  void request.then(() => {
    webContentRequests.delete(url);
  }, () => {
    webContentRequests.delete(url);
  });
  return request;
}

export function workingNotesPreview(notes: ChatWorkingNotes, maxLength = 120): string {
  const drafts = notes.drafts ?? [];
  const raw = notes.thinking?.trim() || drafts[drafts.length - 1]?.trim() || "";
  const normalized = raw.replace(/\s+/g, " ").trim();
  if (normalized.length <= maxLength) return normalized;
  return `${normalized.slice(0, Math.max(0, maxLength - 1)).trimEnd()}…`;
}

export function formatToolName(name: string): string {
  return name.replace(/_/g, " ").replace(/\b\w/g, (char) => char.toUpperCase());
}

export function describeToolCall(name: string, argumentsJson: string): string {
  let args: Record<string, unknown> = {};
  try {
    const parsed = JSON.parse(argumentsJson);
    if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
      args = parsed as Record<string, unknown>;
    }
  } catch {
    // The expandable tool timeline still exposes the original arguments.
  }

  if (name === "update_planning_row") {
    const rowNumber = args.row_number;
    const legacyRowIndex = args.row_index ?? args.rowIndex;
    const path = typeof args.path === "string" ? args.path.split(/[\\/]/).pop() : undefined;
    const rowLabel = typeof rowNumber === "number"
      ? ` ${rowNumber}`
      : typeof legacyRowIndex === "number"
        ? ` ${legacyRowIndex + 1}`
        : "";
    return `Updating planning row${rowLabel}${path ? ` in ${path}` : ""}`;
  }
  if (name === "read_sketch" && typeof args.path === "string") {
    return `Reading ${args.path.split(/[\\/]/).pop()}`;
  }
  if (name === "write_note" && typeof args.path === "string") {
    return `Writing ${args.path.split(/[\\/]/).pop()}`;
  }

  return `${formatToolName(name)} started`;
}

export function formatMaybeJson(value: string): string {
  try {
    return JSON.stringify(JSON.parse(value), null, 2);
  } catch {
    return value;
  }
}
