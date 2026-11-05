// Pure rules for project imports: which command handles a file, picker options, note names.
import type { NoteImportCommand } from "../../ipc/workspace";
import { noteImportCommand } from "../../utils/home";

export type ImportTarget =
  | { kind: "sketch" }
  | { kind: "storyboard" }
  | { kind: "note"; command: NoteImportCommand }
  | { kind: "video" };

export const VIDEO_EXTENSIONS = ["mp4", "mov", "mkv", "webm", "avi", "m4v"];
const DOCUMENT_EXTENSIONS = ["docx", "doc", "pdf", "pptx"];

const fileName = (path: string) => path.split(/[\\/]/).pop() ?? path;

/** The importer for a file, from its extension (case-insensitive), or null if unsupported. */
export function importTarget(path: string): ImportTarget | null {
  const name = fileName(path);
  const dot = name.lastIndexOf(".");
  if (dot <= 0) return null;
  const ext = name.slice(dot + 1).toLowerCase();
  if (ext === "sk") return { kind: "sketch" };
  if (ext === "sb") return { kind: "storyboard" };
  const command = noteImportCommand(name);
  if (command) return { kind: "note", command };
  if (VIDEO_EXTENSIONS.includes(ext)) return { kind: "video" };
  return null;
}

/** Splits paths into those CutReady can import and those it can't, keeping order. */
export function partitionImportable(paths: string[]) {
  const supported: string[] = [];
  const unsupported: string[] = [];
  for (const path of paths) (importTarget(path) ? supported : unsupported).push(path);
  return { supported, unsupported };
}

export const containsVideo = (paths: string[]) => paths.some((path) => importTarget(path)?.kind === "video");

export type PickerKind = "files" | "video";

const videoFilter = { name: "Videos (.mp4, .mov, .mkv, .webm)", extensions: VIDEO_EXTENSIONS };

/** Options for the native file picker. */
export const importPickerOptions: Record<PickerKind, { title: string; filters: { name: string; extensions: string[] }[] }> = {
  files: {
    title: "Import Files",
    filters: [
      { name: "All supported", extensions: ["sk", "sb", "md", ...DOCUMENT_EXTENSIONS, ...VIDEO_EXTENSIONS] },
      videoFilter,
      { name: "Sketches (.sk)", extensions: ["sk"] },
      { name: "Storyboards (.sb)", extensions: ["sb"] },
      { name: "Markdown (.md)", extensions: ["md"] },
      { name: "Documents (.docx, .pdf, .pptx)", extensions: DOCUMENT_EXTENSIONS },
    ],
  },
  video: { title: "Import Video as Sketch", filters: [videoFilter] },
};

/** A note file stem from a name or path ("Q3 Plan.docx" -> "q3-plan"), or `fallback`. */
export function noteStem(text: string, fallback = "pasted-note") {
  const base = fileName(text).replace(/\.[^.]+$/, "");
  const slug = base.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "");
  return slug || fallback;
}

/** Candidate note paths: `stem.md`, then `stem-2.md`, `stem-3.md`, ... */
export function* noteNameCandidates(stem: string, limit = 100) {
  yield `${stem}.md`;
  for (let n = 2; n <= limit; n++) yield `${stem}-${n}.md`;
}

/** Plain-language toast for files that were skipped. */
export function skippedFilesMessage(paths: string[]) {
  const names = paths.map(fileName);
  const shown = names.slice(0, 3).join(", ");
  const more = names.length > 3 ? ` and ${names.length - 3} more` : "";
  return `Skipped ${shown}${more}: CutReady can't import ${names.length === 1 ? "this file type" : "these file types"}.`;
}
