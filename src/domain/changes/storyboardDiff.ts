import { changedFields, keyValue, movedKeys, occurrenceKeys, parseJsonObject } from "./parse";
import type { StoryboardChanges } from "./types";

const STORYBOARD_FIELDS = ["title", "description", "locked", "metadata"];
const TOP_LEVEL = "";

interface Section {
  key: string;
  title: string;
  description: string;
}

interface Placement {
  /** Occurrence key of the sketch reference (path plus occurrence number). */
  key: string;
  /** Section key it sits in, or TOP_LEVEL. */
  container: string;
}

interface Flattened {
  sections: Section[];
  /** Sketch references in playback order. */
  sketches: Placement[];
}

function flatten(doc: Record<string, unknown>): Flattened {
  const items = Array.isArray(doc.items) ? doc.items.filter((item) => item && typeof item === "object") : [];
  const entries = items as Record<string, unknown>[];
  const sectionEntries = entries.filter((entry) => entry.type === "section");
  const sectionKeys = occurrenceKeys(sectionEntries.map((entry) => (typeof entry.title === "string" ? entry.title : "")));

  const sections: Section[] = [];
  const paths: string[] = [];
  const containers: string[] = [];
  let sectionIndex = 0;
  for (const entry of entries) {
    if (entry.type === "sketch_ref" && typeof entry.path === "string") {
      paths.push(entry.path);
      containers.push(TOP_LEVEL);
    } else if (entry.type === "section") {
      const key = sectionKeys[sectionIndex++];
      sections.push({ key, title: keyValue(key), description: typeof entry.description === "string" ? entry.description : "" });
      for (const path of Array.isArray(entry.sketches) ? entry.sketches : []) {
        if (typeof path !== "string") continue;
        paths.push(path);
        containers.push(key);
      }
    }
  }
  const keys = occurrenceKeys(paths);
  return { sections, sketches: keys.map((key, index) => ({ key, container: containers[index] })) };
}

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
  const before = parseJsonObject(beforeText);
  const after = parseJsonObject(afterText);
  if (!before || !after) return null;
  const a = flatten(before);
  const b = flatten(after);

  const beforeSections = new Map(a.sections.map((section) => [section.key, section]));
  const afterSections = new Map(b.sections.map((section) => [section.key, section]));
  const beforeSketches = new Map(a.sketches.map((placement) => [placement.key, placement.container]));
  const afterSketches = new Map(b.sketches.map((placement) => [placement.key, placement.container]));

  const moved = movedKeys(
    a.sketches.map((placement) => placement.key),
    b.sketches.map((placement) => placement.key),
  );
  for (const [key, container] of afterSketches) {
    if (beforeSketches.has(key) && beforeSketches.get(key) !== container) moved.add(key);
  }

  return {
    sectionsAdded: b.sections.filter((section) => !beforeSections.has(section.key)).map((section) => section.title),
    sectionsRemoved: a.sections.filter((section) => !afterSections.has(section.key)).map((section) => section.title),
    sectionsEdited: b.sections
      .filter((section) => {
        const previous = beforeSections.get(section.key);
        return previous !== undefined && previous.description !== section.description;
      })
      .map((section) => section.title),
    sectionsMoved: movedKeys(
      a.sections.map((section) => section.key),
      b.sections.map((section) => section.key),
    ).size,
    sketchesAdded: b.sketches.filter((placement) => !beforeSketches.has(placement.key)).map((placement) => keyValue(placement.key)),
    sketchesRemoved: a.sketches.filter((placement) => !afterSketches.has(placement.key)).map((placement) => keyValue(placement.key)),
    sketchesMoved: moved.size,
    fields: changedFields(before, after, STORYBOARD_FIELDS),
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
