/**
 * exportToWord.ts — Export notes, sketches, and storyboards to .docx.
 *
 * The frontend builds Markdown; the backend renders it with Quilldown after
 * validating every image reference against the project root.
 */

import { save } from "../dialogs";
import { captureExportOpener } from "./openExportedFile";
import { invoke } from "../services/tauri";
import type { PlanningRow, Sketch, Storyboard } from "../types/sketch";
import { getElucimDocumentSize } from "./elucimDocument";
import { getUniqueStoryboardSketchPaths } from "./storyboard";

export type WordOrientation = "portrait" | "landscape";

export interface WordExportReport {
  imagesEmbedded: number;
  skippedRemoteImages: string[];
}

const NOTE_IMAGE_WIDTH_PX = 600;
const TABLE_IMAGE_WIDTH_PX = 240;

// ── Markdown helpers ─────────────────────────────────────────────

function timestamp(): string {
  return new Date().toLocaleDateString("en-US", {
    year: "numeric", month: "long", day: "numeric",
  });
}

function plural(count: number, one: string, many: string): string {
  return `${count} ${count === 1 ? one : many}`;
}

/** Escape text so Markdown renders it literally (titles, headings). */
export function escapeMarkdownText(text: string): string {
  return text.replace(/\s+/g, " ").trim().replace(/[\\`*_{}[\]()<>#+\-!|$~]/g, "\\$&");
}

/** Index of the closing backtick run of exactly `len` ticks at or after `from`, or -1. */
function findClosingTicks(line: string, from: number, len: number): number {
  for (let i = from; i < line.length; ) {
    if (line[i] !== "`") { i++; continue; }
    let j = i;
    while (line[j] === "`") j++;
    if (j - i === len) return i;
    i = j;
  }
  return -1;
}

/**
 * Escape one line for a GFM table cell: pipes everywhere; `<` (raw HTML Quilldown
 * would drop) and `$` (math) outside code spans; a trailing lone backslash so the
 * following <br> survives. Existing backslash escapes are preserved.
 */
function escapeCellLine(line: string): string {
  let out = "";
  let i = 0;
  while (i < line.length) {
    const ch = line[i];
    if (ch === "`") {
      let j = i;
      while (line[j] === "`") j++;
      const close = findClosingTicks(line, j, j - i);
      if (close >= 0) {
        out += line.slice(i, close + (j - i)).replace(/\|/g, "\\|");
        i = close + (j - i);
      } else {
        out += line.slice(i, j);
        i = j;
      }
    } else if (ch === "\\") {
      out += i + 1 < line.length ? line.slice(i, i + 2) : "\\\\";
      i += 2;
    } else {
      out += ch === "|" || ch === "<" || ch === "$" ? `\\${ch}` : ch;
      i++;
    }
  }
  return out;
}

/**
 * Convert multi-line Markdown into a single GFM table cell. Cells are
 * inline-only, so bullets and headings are flattened and lines join with <br>.
 */
export function toTableCell(text: string | null | undefined): string {
  const lines = (text ?? "")
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean)
    .map((line) => {
      const heading = line.match(/^#{1,6}\s+(.+)/);
      if (heading) return `**${heading[1]}**`;
      const bullet = line.match(/^[-*•]\s+(.+)/);
      if (bullet && !/^\*[^*]+\*$/.test(line)) return `• ${bullet[1]}`;
      return line;
    })
    .map(escapeCellLine);
  return lines.length > 0 ? lines.join("<br>") : "—";
}

function imageLink(alt: string, url: string): string {
  return `![${alt}](<${url.replace(/\\/g, "/")}>)`;
}

function bytesToBase64(bytes: Uint8Array): string {
  let binary = "";
  const chunk = 0x8000;
  for (let i = 0; i < bytes.length; i += chunk) {
    binary += String.fromCharCode(...bytes.subarray(i, i + chunk));
  }
  return btoa(binary);
}

// Light-mode token map — used to replace $token refs before rendering visuals for Word
const LIGHT_TOKENS: Record<string, string> = {
  foreground:  "#1e293b",
  background:  "#ffffff",
  title:       "#0f172a",
  subtitle:    "#475569",
  accent:      "#4f46e5",
  muted:       "#94a3b8",
  surface:     "#f1f5f9",
  border:      "#cbd5e1",
  primary:     "#4f46e5",
  secondary:   "#7c3aed",
  tertiary:    "#db2777",
  success:     "#16a34a",
  warning:     "#d97706",
  error:       "#dc2626",
};

/** Deep-replace $token color refs with light-mode hex values in a DSL object. */
function toLightMode(obj: unknown): unknown {
  if (typeof obj === "string" && obj.startsWith("$")) {
    return LIGHT_TOKENS[obj.slice(1)] ?? obj;
  }
  if (Array.isArray(obj)) return obj.map(toLightMode);
  if (obj && typeof obj === "object") {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(obj)) {
      out[k] = toLightMode(v);
    }
    return out;
  }
  return obj;
}

/** Render a visual's last frame to a PNG data URL. */
async function renderVisualDataUrl(visualPath: string): Promise<string> {
  const visual = await invoke<Record<string, unknown> | null>("get_visual", { relativePath: visualPath });
  if (!visual) throw new Error(`Visual not found: ${visualPath}`);

  const { renderToPng, toRenderableDocument } = await import("@elucim/dsl");
  const dsl = toRenderableDocument(toLightMode(visual));
  const root = dsl.root as unknown as Record<string, unknown>;
  const totalFrames = (root.durationInFrames as number) || 60;
  const { width, height } = getElucimDocumentSize(dsl, { width: 640, height: 360 });
  const png = await renderToPng(dsl, Math.max(0, totalFrames - 1), { width, height, scale: 2 });
  return `data:image/png;base64,${bytesToBase64(png)}`;
}

function descriptionText(desc: unknown): string {
  if (typeof desc === "string") return desc;
  if (desc && typeof desc === "object") {
    try {
      const extract = (node: any): string => {
        if (node.text) return node.text;
        if (node.children) return node.children.map(extract).join("");
        return "";
      };
      return extract(desc);
    } catch { /* ignore */ }
  }
  return "";
}

function sanitizeFilename(title: string): string {
  return title.replace(/[^a-zA-Z0-9 ]/g, "").trim().replace(/\s+/g, "-") || "export";
}

// ── Document builders ────────────────────────────────────────────

async function mediaCell(row: PlanningRow): Promise<string> {
  if (row.visual) {
    try {
      return imageLink("Visual", await renderVisualDataUrl(row.visual));
    } catch (e) {
      throw new Error(`Could not render visual ${row.visual}: ${e instanceof Error ? e.message : String(e)}`);
    }
  }
  return row.screenshot ? imageLink("Screenshot", row.screenshot) : "—";
}

async function planningTable(rows: PlanningRow[]): Promise<string> {
  const hasMedia = rows.some((row) => row.screenshot || row.visual);
  const header = ["Time", "Narrative", "Demo Actions"];
  if (hasMedia) header.push("Visual / Screenshot");

  const lines = [
    `| ${header.join(" | ")} |`,
    `| ${header.map(() => "---").join(" | ")} |`,
  ];
  for (const row of rows) {
    const cells = [toTableCell(row.time), toTableCell(row.narrative), toTableCell(row.demo_actions)];
    if (hasMedia) cells.push(await mediaCell(row));
    lines.push(`| ${cells.join(" | ")} |`);
  }
  return lines.join("\n");
}

async function sketchMarkdown(sketch: Sketch, level: number, includeTitle: boolean): Promise<string> {
  const blocks: string[] = [];
  if (includeTitle) blocks.push(`${"#".repeat(level)} ${escapeMarkdownText(sketch.title)}`);
  const desc = descriptionText(sketch.description).trim();
  if (desc) blocks.push(desc);
  if (sketch.rows.length > 0) blocks.push(await planningTable(sketch.rows));
  return blocks.join("\n\n");
}

export function buildNoteMarkdown(title: string, markdown: string): string {
  return [`# ${escapeMarkdownText(title)}`, `*Exported ${timestamp()}*`, markdown.trim()]
    .filter(Boolean)
    .join("\n\n");
}

export async function buildSketchMarkdown(sketch: Sketch): Promise<string> {
  return [
    `# ${escapeMarkdownText(sketch.title)}`,
    `*Generated ${timestamp()} · ${plural(sketch.rows.length, "scene", "scenes")}*`,
    await sketchMarkdown(sketch, 1, false),
  ].filter(Boolean).join("\n\n");
}

export async function buildStoryboardMarkdown(
  storyboard: Storyboard,
  sketchMap: Map<string, Sketch>,
): Promise<string> {
  const totalRows = [...sketchMap.values()].reduce((sum, sketch) => sum + sketch.rows.length, 0);
  const blocks = [
    `# ${escapeMarkdownText(storyboard.title)}`,
    `*Generated ${timestamp()} · ${plural(sketchMap.size, "sketch", "sketches")}, ${plural(totalRows, "scene", "scenes")}*`,
  ];
  if (storyboard.description?.trim()) blocks.push(storyboard.description.trim());

  for (const item of storyboard.items) {
    if (item.type === "section") {
      blocks.push(`## ${escapeMarkdownText(item.title)}`);
      if (item.description?.trim()) blocks.push(item.description.trim());
      for (const path of item.sketches) {
        const sketch = sketchMap.get(path);
        if (sketch) blocks.push(await sketchMarkdown(sketch, 3, true));
      }
    } else {
      const sketch = sketchMap.get(item.path);
      if (sketch) blocks.push(await sketchMarkdown(sketch, 2, true));
    }
  }
  return blocks.join("\n\n");
}

// ── Export ───────────────────────────────────────────────────────

async function saveMarkdownAsWord(
  markdown: string,
  defaultName: string,
  orientation: WordOrientation,
  maxImageWidthPx: number,
): Promise<WordExportReport | null> {
  const outputPath = await save({
    defaultPath: defaultName,
    filters: [{ name: "Word Document", extensions: ["docx"] }],
  });
  if (!outputPath) return null;
  const openExportedFile = captureExportOpener();

  const report = await invoke<WordExportReport>("export_markdown_to_word", {
    markdown,
    outputPath,
    orientation,
    maxImageWidthPx,
  });
  try {
    await openExportedFile(outputPath);
  } catch (e) {
    console.error("[exportToWord] Failed to open file:", outputPath, e);
  }
  return report;
}

/** Returns null when the user cancels the save dialog. */
export async function exportNoteToWord(
  title: string,
  markdown: string,
  orientation: WordOrientation = "portrait",
): Promise<WordExportReport | null> {
  return saveMarkdownAsWord(
    buildNoteMarkdown(title, markdown),
    `${sanitizeFilename(title)}.docx`,
    orientation,
    NOTE_IMAGE_WIDTH_PX,
  );
}

/** Returns null when the user cancels the save dialog. */
export async function exportSketchToWord(
  sketch: Sketch,
  orientation: WordOrientation = "landscape",
): Promise<WordExportReport | null> {
  return saveMarkdownAsWord(
    await buildSketchMarkdown(sketch),
    `${sanitizeFilename(sketch.title)}.docx`,
    orientation,
    TABLE_IMAGE_WIDTH_PX,
  );
}

/** Returns null when the user cancels the save dialog. */
export async function exportStoryboardToWord(
  storyboard: Storyboard,
  resolveSketches: (paths: string[]) => Promise<Map<string, Sketch>>,
  orientation: WordOrientation = "landscape",
): Promise<WordExportReport | null> {
  const sketchMap = await resolveSketches(getUniqueStoryboardSketchPaths(storyboard));
  return saveMarkdownAsWord(
    await buildStoryboardMarkdown(storyboard, sketchMap),
    `${sanitizeFilename(storyboard.title)}.docx`,
    orientation,
    TABLE_IMAGE_WIDTH_PX,
  );
}

/** User-facing summary for a completed export. */
export function describeWordExport(report: WordExportReport): { message: string; type: "success" | "warning" } {
  if (report.skippedRemoteImages.length > 0) {
    return {
      message: `Exported to Word. ${plural(report.skippedRemoteImages.length, "remote image was", "remote images were")} not embedded.`,
      type: "warning",
    };
  }
  return { message: "Exported to Word", type: "success" };
}
