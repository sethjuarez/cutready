/**
 * exportToWord.ts — Generate .docx files from sketches and storyboards.
 *
 * Uses the `docx` library with Word's default Calibri theme and built-in
 * heading styles so documents look native when opened in Word.
 * Markdown in cell content (bold, italic, code, bullets) is rendered.
 */

import {
  Document,
  Packer,
  Paragraph,
  TextRun,
  ImageRun,
  Table,
  TableRow,
  TableCell,
  WidthType,
  HeadingLevel,
  BorderStyle,
  AlignmentType,
  LevelFormat,
  PageOrientation,
  convertInchesToTwip,
} from "docx";
import { save } from "@tauri-apps/plugin-dialog";
import { readFile, writeFile } from "@tauri-apps/plugin-fs";
import { open as shellOpen } from "@tauri-apps/plugin-shell";
import { invoke } from "@tauri-apps/api/core";
import type { Sketch, Storyboard } from "../types/sketch";

// ── Markdown → docx primitives ──────────────────────────────────

/** Parse inline markdown into styled TextRuns. Handles **bold**, *italic*, `code`. */
function parseInlineMarkdown(text: string): TextRun[] {
  const runs: TextRun[] = [];
  // Regex matches: `code`, ***bolditalic***, **bold**, *italic*, or plain text
  const pattern = /(`[^`]+`|\*\*\*[^*]+\*\*\*|\*\*[^*]+\*\*|\*[^*]+\*)/g;
  let lastIndex = 0;

  for (const match of text.matchAll(pattern)) {
    const before = text.slice(lastIndex, match.index);
    if (before) runs.push(new TextRun({ text: before }));

    const raw = match[0];
    if (raw.startsWith("`")) {
      runs.push(new TextRun({ text: raw.slice(1, -1), font: "Consolas", bold: true }));
    } else if (raw.startsWith("***")) {
      runs.push(new TextRun({ text: raw.slice(3, -3), bold: true, italics: true }));
    } else if (raw.startsWith("**")) {
      runs.push(new TextRun({ text: raw.slice(2, -2), bold: true }));
    } else if (raw.startsWith("*")) {
      runs.push(new TextRun({ text: raw.slice(1, -1), italics: true }));
    }
    lastIndex = match.index! + raw.length;
  }

  const tail = text.slice(lastIndex);
  if (tail) runs.push(new TextRun({ text: tail }));

  return runs.length > 0 ? runs : [new TextRun({ text: text || "—" })];
}

/** Convert a markdown string (possibly multi-line with bullets) into Paragraph[]. */
function markdownToParagraphs(text: string): Paragraph[] {
  if (!text?.trim()) return [new Paragraph({ text: "—" })];

  const lines = text.split("\n");
  const paragraphs: Paragraph[] = [];

  for (const line of lines) {
    const trimmed = line.trim();
    if (!trimmed) continue;

    // Bullet list item: - text or * text (but not *italic*)
    const bulletMatch = trimmed.match(/^[-*•]\s+(.+)/);
    if (bulletMatch && !trimmed.match(/^\*[^*]+\*$/)) {
      paragraphs.push(new Paragraph({
        children: parseInlineMarkdown(bulletMatch[1]),
        bullet: { level: 0 },
      }));
    }
    // Numbered list: 1. text
    else if (/^\d+[.)]\s+/.test(trimmed)) {
      const content = trimmed.replace(/^\d+[.)]\s+/, "");
      paragraphs.push(new Paragraph({
        children: parseInlineMarkdown(content),
        numbering: { reference: "decimal-list", level: 0 },
      }));
    }
    // Regular paragraph
    else {
      paragraphs.push(new Paragraph({ children: parseInlineMarkdown(trimmed) }));
    }
  }

  return paragraphs.length > 0 ? paragraphs : [new Paragraph({ text: "—" })];
}

// ── Helpers ─────────────────────────────────────────────────────

function timestamp(): string {
  return new Date().toLocaleDateString("en-US", {
    year: "numeric", month: "long", day: "numeric",
  });
}

const tableBorder = {
  top: { style: BorderStyle.SINGLE, size: 4, color: "BFBFBF" },
  bottom: { style: BorderStyle.SINGLE, size: 4, color: "BFBFBF" },
  left: { style: BorderStyle.SINGLE, size: 4, color: "BFBFBF" },
  right: { style: BorderStyle.SINGLE, size: 4, color: "BFBFBF" },
  insideHorizontal: { style: BorderStyle.SINGLE, size: 4, color: "BFBFBF" },
  insideVertical: { style: BorderStyle.SINGLE, size: 4, color: "BFBFBF" },
} as const;

const cellMargins = {
  top: convertInchesToTwip(0.04),
  bottom: convertInchesToTwip(0.04),
  left: convertInchesToTwip(0.08),
  right: convertInchesToTwip(0.08),
};

function headerCell(text: string): TableCell {
  return new TableCell({
    children: [new Paragraph({ children: [new TextRun({ text, bold: true })] })],
    margins: cellMargins,
  });
}

function bodyCell(text: string): TableCell {
  return new TableCell({
    children: markdownToParagraphs(text),
    margins: cellMargins,
  });
}

const IMG_WIDTH = convertInchesToTwip(2.5);
const IMG_HEIGHT = convertInchesToTwip(1.4); // ~16:9 aspect ratio

// Thumbnail size for visuals in the planning table — max 200px wide
const VISUAL_WIDTH = 200;
const VISUAL_HEIGHT = 112; // ~16:9

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

/** Read a screenshot file and return an ImageRun, or null on failure. */
async function readScreenshot(projectRoot: string, relativePath: string): Promise<ImageRun | null> {
  try {
    const fullPath = `${projectRoot}/${relativePath}`;
    const data = await readFile(fullPath);
    return new ImageRun({
      data,
      transformation: { width: IMG_WIDTH, height: IMG_HEIGHT },
      type: "jpg",
    });
  } catch {
    return null;
  }
}

/** Load a visual from its file path, then render the last frame as a PNG ImageRun for Word embedding. */
async function captureVisualLastFrame(visualPath: string): Promise<ImageRun | null> {
  try {
    const visual = await invoke<Record<string, unknown>>("get_visual", { relativePath: visualPath });
    if (!visual || !visual.root) return null;

    const { renderToPng } = await import("@elucim/dsl");

    // Convert to light-mode colors for print-friendly Word output
    type ElucimDocument = Parameters<typeof renderToPng>[0];
    const dsl = toLightMode(visual) as unknown as ElucimDocument;
    const root = dsl.root as unknown as Record<string, unknown>;
    const totalFrames = (root.durationInFrames as number) || 60;
    const lastFrame = Math.max(0, totalFrames - 1);
    const width = (root.width as number) || 640;
    const height = (root.height as number) || 360;

    const pngBytes = await renderToPng(dsl, lastFrame, { width, height, scale: 2 });

    return new ImageRun({
      data: pngBytes,
      transformation: { width: VISUAL_WIDTH, height: VISUAL_HEIGHT },
      type: "png",
    });
  } catch (e) {
    console.error("[exportToWord] Failed to capture visual frame:", visualPath, e);
    return null;
  }
}

function screenshotCell(image: ImageRun | null): TableCell {
  return new TableCell({
    children: [new Paragraph(image ? { children: [image] } : { text: "—" })],
    margins: cellMargins,
  });
}

async function buildPlanningTable(rows: Sketch["rows"], projectRoot: string): Promise<Table> {
  const hasMedia = rows.some((r) => r.screenshot || r.visual);

  const headerCells = [headerCell("Time"), headerCell("Narrative"), headerCell("Demo Actions")];
  if (hasMedia) headerCells.push(headerCell("Visual / Screenshot"));

  const header = new TableRow({ children: headerCells, tableHeader: true });

  const dataRows = await Promise.all(rows.map(async (row) => {
    const cells = [bodyCell(row.time), bodyCell(row.narrative), bodyCell(row.demo_actions)];
    if (hasMedia) {
      if (row.visual) {
        const img = await captureVisualLastFrame(row.visual);
        cells.push(screenshotCell(img));
      } else {
        const img = row.screenshot ? await readScreenshot(projectRoot, row.screenshot) : null;
        cells.push(screenshotCell(img));
      }
    }
    return new TableRow({ children: cells });
  }));

  return new Table({
    rows: [header, ...dataRows],
    width: { size: 100, type: WidthType.PERCENTAGE },
    borders: tableBorder,
  });
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
  return title.replace(/[^a-zA-Z0-9 ]/g, "").trim().replace(/\s+/g, "-");
}

// ── Document factory ────────────────────────────────────────────

export type WordOrientation = "portrait" | "landscape";

function createDocument(children: (Paragraph | Table)[], orientation: WordOrientation = "landscape"): Document {
  return new Document({
    styles: {
      default: {
        document: {
          run: { font: "Calibri", size: 22 }, // 11pt Calibri — Word default
        },
      },
    },
    numbering: {
      config: [{
        reference: "decimal-list",
        levels: [{
          level: 0,
          format: LevelFormat.DECIMAL,
          text: "%1.",
          alignment: AlignmentType.START,
          style: {
            paragraph: {
              indent: { left: convertInchesToTwip(0.5), hanging: convertInchesToTwip(0.25) },
            },
          },
        }],
      }],
    },
    sections: [{
      properties: {
        page: {
          size: { orientation: orientation === "landscape" ? PageOrientation.LANDSCAPE : PageOrientation.PORTRAIT },
        },
      },
      children: children as Paragraph[],
    }],
  });
}

async function saveDocument(doc: Document, defaultName: string): Promise<void> {
  const blob = await Packer.toBlob(doc);
  const filePath = await save({
    defaultPath: defaultName,
    filters: [{ name: "Word Document", extensions: ["docx"] }],
  });
  if (!filePath) return;
  const buffer = await blob.arrayBuffer();
  await writeFile(filePath, new Uint8Array(buffer));
  // Open the exported file in the default application
  await shellOpen(filePath).catch(() => {});
}

// ── Note (Markdown) → Word ───────────────────────────────────────

/** Heading-level map: # → HEADING_1, ## → HEADING_2, etc. */
const headingLevels: Record<number, (typeof HeadingLevel)[keyof typeof HeadingLevel]> = {
  1: HeadingLevel.HEADING_1,
  2: HeadingLevel.HEADING_2,
  3: HeadingLevel.HEADING_3,
  4: HeadingLevel.HEADING_4,
  5: HeadingLevel.HEADING_5,
  6: HeadingLevel.HEADING_6,
};

/**
 * Parse a full markdown document into docx Paragraphs, handling headings,
 * images, bullet/numbered lists, and inline formatting.
 */
async function markdownToDocxContent(
  markdown: string,
  projectRoot: string,
): Promise<(Paragraph | Table)[]> {
  const elements: (Paragraph | Table)[] = [];
  const lines = markdown.split("\n");

  // Collect GFM table rows
  let tableBuffer: string[] = [];

  const flushTable = () => {
    if (tableBuffer.length < 2) {
      // Not a valid table — emit as regular paragraphs
      for (const tl of tableBuffer) {
        elements.push(new Paragraph({ children: parseInlineMarkdown(tl) }));
      }
      tableBuffer = [];
      return;
    }

    // Parse header and data rows, skip separator row
    const parseRow = (row: string) =>
      row.split("|").map((c) => c.trim()).filter((c) => c.length > 0);

    const headers = parseRow(tableBuffer[0]);
    const dataRows = tableBuffer
      .slice(2) // skip header + separator
      .map(parseRow);

    const headerRow = new TableRow({
      children: headers.map((h) => headerCell(h)),
      tableHeader: true,
    });

    const rows = dataRows.map(
      (cols) =>
        new TableRow({
          children: headers.map((_, i) => bodyCell(cols[i] || "")),
        }),
    );

    elements.push(
      new Table({
        rows: [headerRow, ...rows],
        width: { size: 100, type: WidthType.PERCENTAGE },
        borders: tableBorder,
      }),
    );

    tableBuffer = [];
  };

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    const trimmed = line.trim();

    // Detect table rows (start with |)
    if (trimmed.startsWith("|") && trimmed.endsWith("|")) {
      // Check if separator row (all dashes/colons)
      const isSep = /^\|[\s:|-]+\|$/.test(trimmed);
      if (tableBuffer.length > 0 || (!isSep && trimmed.includes("|"))) {
        tableBuffer.push(trimmed);
        continue;
      }
    } else if (tableBuffer.length > 0) {
      flushTable();
    }

    // Blank line
    if (!trimmed) {
      elements.push(new Paragraph({}));
      continue;
    }

    // Heading: # through ######
    const headingMatch = trimmed.match(/^(#{1,6})\s+(.+)/);
    if (headingMatch) {
      const level = headingMatch[1].length;
      const heading = headingLevels[level] ?? HeadingLevel.HEADING_6;
      elements.push(
        new Paragraph({
          children: parseInlineMarkdown(headingMatch[2]),
          heading,
        }),
      );
      continue;
    }

    // Image: ![alt](path)
    const imgMatch = trimmed.match(/^!\[([^\]]*)\]\(([^)]+)\)/);
    if (imgMatch) {
      const imgPath = imgMatch[2];
      const img = await readScreenshot(projectRoot, imgPath);
      if (img) {
        elements.push(new Paragraph({ children: [img] }));
      } else {
        elements.push(
          new Paragraph({
            children: [new TextRun({ text: `[Image: ${imgPath}]`, italics: true })],
          }),
        );
      }
      continue;
    }

    // Horizontal rule: --- or *** or ___
    if (/^[-*_]{3,}$/.test(trimmed)) {
      elements.push(
        new Paragraph({
          border: {
            bottom: { style: BorderStyle.SINGLE, size: 6, color: "BFBFBF", space: 1 },
          },
        }),
      );
      continue;
    }

    // Bullet list: - text or * text (but not *italic*)
    const bulletMatch = trimmed.match(/^[-*•]\s+(.+)/);
    if (bulletMatch && !trimmed.match(/^\*[^*]+\*$/)) {
      elements.push(
        new Paragraph({
          children: parseInlineMarkdown(bulletMatch[1]),
          bullet: { level: 0 },
        }),
      );
      continue;
    }

    // Numbered list: 1. text
    if (/^\d+[.)]\s+/.test(trimmed)) {
      const content = trimmed.replace(/^\d+[.)]\s+/, "");
      elements.push(
        new Paragraph({
          children: parseInlineMarkdown(content),
          numbering: { reference: "decimal-list", level: 0 },
        }),
      );
      continue;
    }

    // Blockquote: > text
    const quoteMatch = trimmed.match(/^>\s*(.*)/);
    if (quoteMatch) {
      elements.push(
        new Paragraph({
          children: [new TextRun({ text: quoteMatch[1] || "", italics: true })],
          indent: { left: convertInchesToTwip(0.5) },
        }),
      );
      continue;
    }

    // Regular paragraph
    elements.push(new Paragraph({ children: parseInlineMarkdown(trimmed) }));
  }

  // Flush any remaining table
  if (tableBuffer.length > 0) flushTable();

  return elements;
}

export async function exportNoteToWord(
  title: string,
  markdown: string,
  projectRoot: string,
  orientation: WordOrientation = "portrait",
): Promise<void> {
  const children: (Paragraph | Table)[] = [
    new Paragraph({ text: title, heading: HeadingLevel.TITLE }),
    new Paragraph({
      children: [new TextRun({ text: `Exported ${timestamp()}`, italics: true })],
    }),
    new Paragraph({}),
    ...await markdownToDocxContent(markdown, projectRoot),
  ];

  const doc = createDocument(children, orientation);
  await saveDocument(doc, `${sanitizeFilename(title)}.docx`);
}

// ── Sketch → Word ───────────────────────────────────────────────

async function buildSketchContent(sketch: Sketch, projectRoot: string, level: (typeof HeadingLevel)[keyof typeof HeadingLevel] = HeadingLevel.HEADING_1): Promise<(Paragraph | Table)[]> {
  const elements: (Paragraph | Table)[] = [];

  elements.push(new Paragraph({ text: sketch.title, heading: level }));

  const desc = descriptionText(sketch.description);
  if (desc.trim()) {
    elements.push(...markdownToParagraphs(desc));
  }

  if (sketch.rows.length > 0) {
    elements.push(await buildPlanningTable(sketch.rows, projectRoot));
  }

  return elements;
}

export async function exportSketchToWord(sketch: Sketch, projectRoot: string, orientation: WordOrientation = "landscape"): Promise<void> {
  const children: (Paragraph | Table)[] = [
    new Paragraph({ text: sketch.title, heading: HeadingLevel.TITLE }),
    new Paragraph({
      children: [
        new TextRun({ text: `Generated ${timestamp()}  ·  ${sketch.rows.length} scene${sketch.rows.length !== 1 ? "s" : ""}`, italics: true }),
      ],
    }),
    new Paragraph({}), // blank line
    ...await buildSketchContent(sketch, projectRoot, HeadingLevel.HEADING_1),
  ];

  const doc = createDocument(children, orientation);
  await saveDocument(doc, `${sanitizeFilename(sketch.title)}.docx`);
}

// ── Storyboard → Word ───────────────────────────────────────────

export async function exportStoryboardToWord(
  storyboard: Storyboard,
  projectRoot: string,
  resolveSketches: (paths: string[]) => Promise<Map<string, Sketch>>,
  orientation: WordOrientation = "landscape",
): Promise<void> {
  const paths: string[] = [];
  for (const item of storyboard.items) {
    if (item.type === "sketch_ref") paths.push(item.path);
    else if (item.type === "section") paths.push(...item.sketches);
  }

  const sketchMap = await resolveSketches([...new Set(paths)]);
  const children: (Paragraph | Table)[] = [];

  // Title + subtitle
  children.push(new Paragraph({ text: storyboard.title, heading: HeadingLevel.TITLE }));

  const sketchCount = sketchMap.size;
  const totalRows = [...sketchMap.values()].reduce((s, sk) => s + sk.rows.length, 0);
  children.push(new Paragraph({
    children: [new TextRun({
      text: `Generated ${timestamp()}  ·  ${sketchCount} sketch${sketchCount !== 1 ? "es" : ""}, ${totalRows} scene${totalRows !== 1 ? "s" : ""}`,
      italics: true,
    })],
  }));

  if (storyboard.description?.trim()) {
    children.push(new Paragraph({}));
    children.push(new Paragraph({ text: storyboard.description }));
  }

  children.push(new Paragraph({})); // blank line before content

  // Items in storyboard order
  for (const item of storyboard.items) {
    if (item.type === "section") {
      children.push(new Paragraph({ text: item.title, heading: HeadingLevel.HEADING_1 }));
      for (const spath of item.sketches) {
        const sk = sketchMap.get(spath);
        if (sk) children.push(...await buildSketchContent(sk, projectRoot, HeadingLevel.HEADING_2));
      }
    } else {
      const sk = sketchMap.get(item.path);
      if (sk) children.push(...await buildSketchContent(sk, projectRoot, HeadingLevel.HEADING_1));
    }
  }

  const doc = createDocument(children, orientation);
  await saveDocument(doc, `${sanitizeFilename(storyboard.title)}.docx`);
}
