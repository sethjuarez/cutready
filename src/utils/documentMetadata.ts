import type { PlanningRow, Storyboard } from "../types/sketch";
import { getStoryboardSketchPaths } from "./storyboard";

export interface DocumentMetadata {
  fields?: Record<string, string>;
}

export interface ParsedNoteDocument {
  metadata: DocumentMetadata;
  body: string;
}

export interface DurationSummary {
  knownSeconds: number;
  unspecifiedRows: number;
}

export type DurationDisplayMode = "seconds" | "minutes";

export function normalizeMetadata(metadata: DocumentMetadata | null | undefined): DocumentMetadata {
  const fields = Object.fromEntries(
    Object.entries(metadata?.fields ?? {})
      .map(([key, value]) => [key.trim(), String(value).trim()] as const)
      .filter(([key, value]) => key.length > 0 && value.length > 0),
  );
  return Object.keys(fields).length > 0 ? { fields } : {};
}

export function parseNoteDocument(content: string): ParsedNoteDocument {
  if (!content.startsWith("---\n")) return { metadata: {}, body: content };
  const end = content.indexOf("\n---", 4);
  if (end === -1) return { metadata: {}, body: content };

  const frontmatter = content.slice(4, end);
  const bodyStart = content.startsWith("\n", end + 4) ? end + 5 : end + 4;
  const fields: Record<string, string> = {};
  for (const line of frontmatter.split(/\r?\n/)) {
    const separator = line.indexOf(":");
    if (separator <= 0) continue;
    const key = line.slice(0, separator).trim();
    const value = unquoteFrontmatterValue(line.slice(separator + 1).trim());
    if (key && value) fields[key] = value;
  }
  return { metadata: normalizeMetadata({ fields }), body: content.slice(bodyStart) };
}

export function serializeNoteDocument(metadata: DocumentMetadata, body: string): string {
  const normalized = normalizeMetadata(metadata);
  const entries = Object.entries(normalized.fields ?? {});
  if (entries.length === 0) return body;
  const frontmatter = entries
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([key, value]) => `${key}: ${quoteFrontmatterValue(value)}`)
    .join("\n");
  return `---\n${frontmatter}\n---\n${body}`;
}

export function parseDurationSeconds(value: string): number | null {
  const text = value.trim().toLowerCase().replace(/^~/, "").trim();
  if (!text) return null;

  const clock = text.match(/^(\d+):([0-5]?\d)(?::([0-5]?\d))?$/);
  if (clock) {
    const first = Number(clock[1]);
    const second = Number(clock[2]);
    const third = clock[3] ? Number(clock[3]) : null;
    return third === null ? first * 60 + second : first * 3600 + second * 60 + third;
  }

  let total = 0;
  let matched = false;
  const pattern = /(\d+(?:\.\d+)?)\s*(h|hr|hrs|hour|hours|m|min|mins|minute|minutes|s|sec|secs|second|seconds)\b/g;
  for (const match of text.matchAll(pattern)) {
    matched = true;
    const amount = Number(match[1]);
    const unit = match[2];
    if (unit.startsWith("h")) total += amount * 3600;
    else if (unit.startsWith("m")) total += amount * 60;
    else total += amount;
  }
  if (matched) return Math.round(total);

  const seconds = text.match(/^(\d+(?:\.\d+)?)$/);
  return seconds ? Math.round(Number(seconds[1])) : null;
}

export function formatDuration(totalSeconds: number): string {
  const seconds = Math.max(0, Math.round(totalSeconds));
  const hours = Math.floor(seconds / 3600);
  const minutes = Math.floor((seconds % 3600) / 60);
  const remainder = seconds % 60;
  if (hours > 0) return `${hours}:${String(minutes).padStart(2, "0")}:${String(remainder).padStart(2, "0")}`;
  return `${minutes}:${String(remainder).padStart(2, "0")}`;
}

export function formatDurationDisplay(totalSeconds: number, mode: DurationDisplayMode): string {
  if (mode === "seconds") return `${Math.max(0, Math.round(totalSeconds))}s`;
  return `${formatDuration(totalSeconds)}m`;
}

export function summarizeSketchDuration(rows: PlanningRow[]): DurationSummary {
  return rows.reduce<DurationSummary>((summary, row) => {
    const seconds = row.duration_seconds ?? parseDurationSeconds(row.time);
    if (seconds === null || seconds <= 0) {
      summary.unspecifiedRows += 1;
    } else {
      summary.knownSeconds += seconds;
    }
    return summary;
  }, { knownSeconds: 0, unspecifiedRows: 0 });
}

export function summarizeStoryboardDuration(storyboard: Storyboard, sketches: ReadonlyMap<string, { rows: PlanningRow[] }>): DurationSummary {
  return summarizeSketchPathsDuration(getStoryboardSketchPaths(storyboard), sketches);
}

export function summarizeSketchPathsDuration(paths: string[], sketches: ReadonlyMap<string, { rows: PlanningRow[] }>): DurationSummary {
  return paths.reduce<DurationSummary>((summary, path) => {
    const sketch = sketches.get(path);
    if (!sketch) {
      summary.unspecifiedRows += 1;
      return summary;
    }
    const sketchSummary = summarizeSketchDuration(sketch.rows);
    summary.knownSeconds += sketchSummary.knownSeconds;
    summary.unspecifiedRows += sketchSummary.unspecifiedRows;
    return summary;
  }, { knownSeconds: 0, unspecifiedRows: 0 });
}

export function formatDurationSummary(summary: DurationSummary, mode: DurationDisplayMode = "minutes"): string {
  const known = formatDurationDisplay(summary.knownSeconds, mode);
  if (summary.unspecifiedRows === 0) return known;
  return `${summary.knownSeconds > 0 ? `${known} + ` : ""}${summary.unspecifiedRows} unspecified row${summary.unspecifiedRows === 1 ? "" : "s"}`;
}

function quoteFrontmatterValue(value: string): string {
  return value.includes(":") || value.includes("#") || value.startsWith(" ") || value.endsWith(" ")
    ? JSON.stringify(value)
    : value;
}

function unquoteFrontmatterValue(value: string): string {
  if (!value.startsWith("\"")) return value;
  try {
    return JSON.parse(value);
  } catch {
    return value;
  }
}
