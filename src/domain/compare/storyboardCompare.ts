import { changedFields, keyValue, movedKeys, occurrenceKeys, parseJsonObject } from "../changes/parse";
import { diffSequence } from "./sequenceDiff";

export const STORYBOARD_FIELDS = ["title", "description", "locked", "metadata"] as const;

export type CompareStatus = "added" | "removed" | "unchanged";

export interface StoryboardSketchDiff {
  /** Occurrence key: the path plus which reference to it this is. */
  key: string;
  path: string;
  status: CompareStatus;
  /** On both sides, but its playback order or section changed. */
  moved: boolean;
}

export interface StoryboardSectionDiff {
  kind: "section";
  key: string;
  title: string;
  status: CompareStatus;
  moved: boolean;
  /** Description changed on a section kept on both sides. */
  edited: boolean;
  sketches: StoryboardSketchDiff[];
}

export type StoryboardEntryDiff = StoryboardSectionDiff | ({ kind: "sketch" } & StoryboardSketchDiff);

export interface StoryboardComparison {
  /** Top-level sketches and sections in after order, with removed entries where they used to be. */
  entries: StoryboardEntryDiff[];
  fields: string[];
}

interface ParsedSection {
  key: string;
  title: string;
  description: string;
  sketches: string[];
}

type ParsedEntry = { kind: "sketch"; key: string } | { kind: "section"; section: ParsedSection };

interface Parsed {
  entries: ParsedEntry[];
  sections: ParsedSection[];
  /** Sketch occurrence keys in playback order, with the section each sits in ("" for top level). */
  sketches: Array<{ key: string; container: string }>;
}

function parse(doc: Record<string, unknown>): Parsed {
  const items = (Array.isArray(doc.items) ? doc.items.filter((item) => item && typeof item === "object") : []) as Record<string, unknown>[];
  const sectionKeys = occurrenceKeys(items.filter((item) => item.type === "section").map((item) => (typeof item.title === "string" ? item.title : "")));

  // Shape first, then occurrence keys over every reference in playback order.
  const shape: Array<{ kind: "sketch"; path: string } | { kind: "section"; key: string; description: string; paths: string[] }> = [];
  let sectionIndex = 0;
  for (const item of items) {
    if (item.type === "sketch_ref" && typeof item.path === "string") shape.push({ kind: "sketch", path: item.path });
    else if (item.type === "section") {
      const paths = (Array.isArray(item.sketches) ? item.sketches : []).filter((path): path is string => typeof path === "string");
      shape.push({ kind: "section", key: sectionKeys[sectionIndex++], description: typeof item.description === "string" ? item.description : "", paths });
    }
  }
  const keys = occurrenceKeys(shape.flatMap((entry) => (entry.kind === "sketch" ? [entry.path] : entry.paths)));

  const parsed: Parsed = { entries: [], sections: [], sketches: [] };
  let next = 0;
  for (const entry of shape) {
    if (entry.kind === "sketch") {
      const key = keys[next++];
      parsed.entries.push({ kind: "sketch", key });
      parsed.sketches.push({ key, container: "" });
    } else {
      const sketches = entry.paths.map(() => keys[next++]);
      const section = { key: entry.key, title: keyValue(entry.key), description: entry.description, sketches };
      parsed.entries.push({ kind: "section", section });
      parsed.sections.push(section);
      for (const key of sketches) parsed.sketches.push({ key, container: entry.key });
    }
  }
  return parsed;
}

/** Empty or missing text reads as an empty storyboard; malformed text is null. */
function storyboardOf(text: string | null | undefined): Record<string, unknown> | null {
  return text ? parseJsonObject(text) : {};
}

/** Merges two keyed lists into display order: after order, with removed items where they used to be. */
function interleave<T>(before: readonly string[], after: readonly string[], afterKeys: Set<string>, emit: (key: string, side: "before" | "after") => T): T[] {
  const out: T[] = [];
  for (const step of diffSequence(before, after)) {
    if (step.op === "delete") {
      if (!afterKeys.has(before[step.a])) out.push(emit(before[step.a], "before"));
    } else out.push(emit(after[step.b], "after"));
  }
  return out;
}

const entryKey = (entry: ParsedEntry) => (entry.kind === "sketch" ? `s:${entry.key}` : `g:${entry.section.key}`);

/**
 * Section and sketch-reference comparison of two storyboard files. Sections
 * match by title (repeated titles by occurrence); references match by path and
 * occurrence. A missing side reads as an empty storyboard. Null when either
 * side is malformed.
 */
export function compareStoryboard(beforeText: string | null | undefined, afterText: string | null | undefined): StoryboardComparison | null {
  const beforeDoc = storyboardOf(beforeText);
  const afterDoc = storyboardOf(afterText);
  if (!beforeDoc || !afterDoc) return null;
  const a = parse(beforeDoc);
  const b = parse(afterDoc);

  const beforeContainer = new Map(a.sketches.map((placement) => [placement.key, placement.container]));
  const afterContainer = new Map(b.sketches.map((placement) => [placement.key, placement.container]));
  const sketchesMoved = movedKeys(a.sketches.map((p) => p.key), b.sketches.map((p) => p.key));
  for (const [key, container] of afterContainer) {
    if (beforeContainer.has(key) && beforeContainer.get(key) !== container) sketchesMoved.add(key);
  }
  const sectionsMoved = movedKeys(a.sections.map((s) => s.key), b.sections.map((s) => s.key));
  const beforeSections = new Map(a.sections.map((section) => [section.key, section]));
  const afterSections = new Map(b.sections.map((section) => [section.key, section]));

  const sketch = (key: string, side: "before" | "after"): StoryboardSketchDiff => {
    const present = side === "after" ? beforeContainer.has(key) : afterContainer.has(key);
    return {
      key,
      path: keyValue(key),
      status: present ? "unchanged" : side === "after" ? "added" : "removed",
      moved: present && sketchesMoved.has(key),
    };
  };
  // A sketch still in the storyboard shows only where it now sits.
  const afterSketchKeys = new Set(afterContainer.keys());
  const sketchesIn = (before: readonly string[], after: readonly string[], side: "before" | "after" | "both") => {
    if (side === "before") return before.filter((key) => !afterContainer.has(key)).map((key) => sketch(key, "before"));
    if (side === "after") return after.map((key) => sketch(key, "after"));
    return interleave(before, after, afterSketchKeys, sketch);
  };

  const beforeEntries = new Map(a.entries.map((entry) => [entryKey(entry), entry]));
  const afterEntries = new Map(b.entries.map((entry) => [entryKey(entry), entry]));
  const entries = interleave(
    a.entries.map(entryKey),
    b.entries.map(entryKey),
    new Set([...afterEntries.keys(), ...[...afterSketchKeys].map((key) => `s:${key}`)]),
    (key, side): StoryboardEntryDiff => {
      const entry = (side === "after" ? afterEntries : beforeEntries).get(key)!;
      if (entry.kind === "sketch") return { kind: "sketch", ...sketch(entry.key, side) };
      const previous = beforeSections.get(entry.section.key);
      const current = afterSections.get(entry.section.key);
      const both = previous !== undefined && current !== undefined;
      return {
        kind: "section",
        key: entry.section.key,
        title: entry.section.title,
        status: both ? "unchanged" : side === "after" ? "added" : "removed",
        moved: both && sectionsMoved.has(entry.section.key),
        edited: both && previous.description !== current.description,
        sketches: sketchesIn(previous?.sketches ?? [], current?.sketches ?? [], both ? "both" : side),
      };
    },
  );
  return { entries, fields: changedFields(beforeDoc, afterDoc, STORYBOARD_FIELDS) };
}

/** Every sketch reference in the comparison, top level and inside sections. */
export function storyboardSketches(comparison: StoryboardComparison): StoryboardSketchDiff[] {
  return comparison.entries.flatMap((entry) => (entry.kind === "sketch" ? [entry] : entry.sketches));
}

export function storyboardSections(comparison: StoryboardComparison): StoryboardSectionDiff[] {
  return comparison.entries.filter((entry): entry is StoryboardSectionDiff => entry.kind === "section");
}
