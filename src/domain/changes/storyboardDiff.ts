import { compareStoryboard, storyboardSections, storyboardSketches } from "../compare/storyboardCompare";
import { parseJsonObject } from "./parse";
import type { StoryboardChanges } from "./types";

/**
 * Section and sketch-reference changes between two storyboard files. Sections
 * match by title (repeated titles by occurrence); references match by path and
 * occurrence, so adding a second reference to the same sketch counts. Null when
 * either side won't parse.
 */
export function diffStoryboard(
  beforeText: string | null | undefined,
  afterText: string | null | undefined,
): StoryboardChanges | null {
  if (!parseJsonObject(beforeText) || !parseJsonObject(afterText)) return null;
  const comparison = compareStoryboard(beforeText, afterText);
  if (!comparison) return null;
  const sections = storyboardSections(comparison);
  const sketches = storyboardSketches(comparison);
  return {
    sectionsAdded: sections.filter((section) => section.status === "added").map((section) => section.title),
    sectionsRemoved: sections.filter((section) => section.status === "removed").map((section) => section.title),
    sectionsEdited: sections.filter((section) => section.edited).map((section) => section.title),
    sectionsMoved: sections.filter((section) => section.moved).length,
    sketchesAdded: sketches.filter((sketch) => sketch.status === "added").map((sketch) => sketch.path),
    sketchesRemoved: sketches.filter((sketch) => sketch.status === "removed").map((sketch) => sketch.path),
    sketchesMoved: sketches.filter((sketch) => sketch.moved).length,
    fields: comparison.fields,
  };
}

export function storyboardHasChanges(changes: StoryboardChanges): boolean {
  return (
    changes.sectionsAdded.length +
      changes.sectionsRemoved.length +
      changes.sectionsEdited.length +
      changes.sectionsMoved +
      changes.sketchesAdded.length +
      changes.sketchesRemoved.length +
      changes.sketchesMoved +
      changes.fields.length >
    0
  );
}
