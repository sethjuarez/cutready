// Pure helpers for the home screen: recents, defaults, last-edited document and prompts.
import type { RecentProject } from "../types/project";
import type { NoteSummary, SketchSummary, Storyboard, StoryboardSummary } from "../types/sketch";
import type { NoteImportCommand } from "../ipc/workspace";

/** How many recent projects the composer's project picker offers. */
export const PROJECT_PICKER_LIMIT = 5;
/** The agent the home composer starts on. */
export const DEFAULT_HOME_AGENT = "planner";

export function workspaceName(path: string): string {
  return path.replace(/[/\\]+$/, "").split(/[/\\]/).pop() || "workspace";
}

/** Compares folder paths ignoring separator style, trailing separators and case. */
export function samePath(a: string | null | undefined, b: string | null | undefined): boolean {
  if (!a || !b) return false;
  const norm = (p: string) => p.replace(/\\/g, "/").replace(/\/+$/, "").toLowerCase();
  return norm(a) === norm(b);
}

/** Whether `path` is the open project's folder (the repo root, or its root for a sub-project). */
export function isOpenProject(project: { root: string; repo_root: string } | null | undefined, path: string | null | undefined): boolean {
  return !!project && (samePath(project.repo_root, path) || samePath(project.root, path));
}

/** Recent projects, most recently opened first. */
export function sortRecents(recents: RecentProject[]): RecentProject[] {
  const time = (p: RecentProject) => {
    const t = Date.parse(p.last_opened);
    return Number.isNaN(t) ? 0 : t;
  };
  return [...recents].sort((a, b) => time(b) - time(a));
}

/** The projects the composer's picker lists: the last few opened, newest first. */
export function projectPickerOptions(recents: RecentProject[]): RecentProject[] {
  return sortRecents(recents).slice(0, PROJECT_PICKER_LIMIT);
}

/** The project the composer targets by default: the most recently opened one, or null when there are none. */
export function defaultProjectPath(recents: RecentProject[]): string | null {
  return projectPickerOptions(recents)[0]?.path ?? null;
}

/** Keeps a still-listed choice, otherwise falls back to the default. */
export function resolveProjectSelection(selected: string | null, recents: RecentProject[]): string | null {
  const options = projectPickerOptions(recents);
  if (selected && options.some((p) => samePath(p.path, selected))) return selected;
  return defaultProjectPath(recents);
}

/** Planner when it exists, otherwise the first agent. */
export function defaultAgentId(agents: { id: string }[]): string {
  return agents.some((a) => a.id === DEFAULT_HOME_AGENT) ? DEFAULT_HOME_AGENT : (agents[0]?.id ?? DEFAULT_HOME_AGENT);
}

export function timeOfDayGreeting(date: Date): string {
  const hour = date.getHours();
  if (hour < 12) return "Good morning";
  if (hour < 18) return "Good afternoon";
  return "Good evening";
}

export type LastEdited =
  | { kind: "sketch"; path: string; title: string; updated_at: string; row_count: number }
  | { kind: "storyboard"; path: string; title: string; updated_at: string; sketch_count: number }
  | { kind: "note"; path: string; title: string; updated_at: string };

/** The most recently updated sketch, storyboard or note, or null when the project is empty. */
export function lastEditedDocument(
  sketches: SketchSummary[],
  storyboards: StoryboardSummary[],
  notes: NoteSummary[],
): LastEdited | null {
  const candidates: LastEdited[] = [
    ...sketches.map((s) => ({ kind: "sketch" as const, path: s.path, title: s.title, updated_at: s.updated_at, row_count: s.row_count })),
    ...storyboards.map((s) => ({ kind: "storyboard" as const, path: s.path, title: s.title, updated_at: s.updated_at, sketch_count: s.sketch_count })),
    ...notes.map((n) => ({ kind: "note" as const, path: n.path, title: n.title, updated_at: n.updated_at })),
  ];
  let best: LastEdited | null = null;
  let bestTime = -Infinity;
  for (const candidate of candidates) {
    const time = Date.parse(candidate.updated_at);
    if (!Number.isNaN(time) && time > bestTime) {
      best = candidate;
      bestTime = time;
    }
  }
  return best;
}

/** Where a sketch sits in a storyboard: the storyboard title plus its section, if any. */
export function sketchPlacement(storyboard: Storyboard, sketchPath: string): { section: string | null } | null {
  for (const item of storyboard.items) {
    if (item.type === "sketch_ref" && item.path === sketchPath) return { section: null };
    if (item.type === "section" && item.sketches.includes(sketchPath)) return { section: item.title };
  }
  return null;
}

/** The note import command for a file, by extension, or null when it isn't importable. */
export function noteImportCommand(filePath: string): NoteImportCommand | null {
  const ext = filePath.split(".").pop()?.toLowerCase();
  switch (ext) {
    case "pptx": return "import_pptx";
    case "docx":
    case "doc": return "import_docx";
    case "pdf": return "import_pdf";
    case "md": return "import_markdown";
    default: return null;
  }
}

/** "Untitled sketch", numbered past any existing untitled sketch file. */
export function uniqueSketchTitle(existingPaths: string[]): string {
  const taken = new Set(existingPaths.map((p) => p.replace(/\\/g, "/").toLowerCase()));
  for (let n = 1; ; n += 1) {
    const title = n === 1 ? "Untitled sketch" : `Untitled sketch ${n}`;
    const slug = title.toLowerCase().replace(/[^a-z0-9]+/g, "-");
    if (!taken.has(`${slug}.sk`)) return title;
  }
}

/** A chat mention that attaches a note, quoted so paths with spaces survive. */
export function noteMention(notePath: string): string {
  return `@"note:${notePath}"`;
}

/** The Planner request sent after a deck or document is imported as a note. */
export function draftFromImportPrompt(notePath: string, source: "deck" | "document"): string {
  const what = source === "deck"
    ? "Turn the slides in this imported deck into a storyboard of sketches, one planning row per slide."
    : "Draft a storyboard of sketches from this imported document.";
  return `${what} ${noteMention(notePath)}`;
}
