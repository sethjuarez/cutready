import { documentKindOf, mediaTypeOf } from "../changes/classify";
import type { MediaType } from "../changes/types";
import { compareNote, type NoteComparison } from "./noteCompare";
import { compareSketch, type SketchComparison } from "./sketchCompare";
import { compareStoryboard, type StoryboardComparison } from "./storyboardCompare";

export type FileComparison =
  | { view: "sketch"; comparison: SketchComparison }
  | { view: "storyboard"; comparison: StoryboardComparison }
  | { view: "note"; comparison: NoteComparison }
  /** Plain text, or a document that wouldn't parse: shown as a block diff. */
  | { view: "text"; comparison: NoteComparison }
  | { view: "media"; mediaType: MediaType }
  | { view: "unavailable"; reason: string };

export interface FileSides {
  path: string;
  /** Null when the file doesn't exist on that side. */
  before: string | null;
  after: string | null;
  isBinary: boolean;
}

/** Picks the document-aware view for one changed file. */
export function compareFile(file: FileSides): FileComparison {
  const mediaType = mediaTypeOf(file.path);
  if (mediaType === "image") return { view: "media", mediaType };
  if (mediaType === "video" || mediaType === "audio") return { view: "unavailable", reason: `Comparing ${mediaType} isn't supported yet.` };
  if (file.isBinary) return { view: "unavailable", reason: "This file isn't text, so there's nothing to compare line by line." };

  const kind = documentKindOf(file.path);
  if (kind === "sketch") {
    const comparison = compareSketch(file.before, file.after);
    if (comparison) return { view: "sketch", comparison };
  } else if (kind === "storyboard") {
    const comparison = compareStoryboard(file.before, file.after);
    if (comparison) return { view: "storyboard", comparison };
  } else if (kind === "note") {
    return { view: "note", comparison: compareNote(file.before, file.after) };
  }
  return { view: "text", comparison: compareNote(file.before, file.after, "line") };
}
