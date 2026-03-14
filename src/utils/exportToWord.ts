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

/** Render the last frame of an elucim visual as a PNG ImageRun for Word embedding. */
async function captureVisualLastFrame(visual: Record<string, unknown>): Promise<ImageRun | null> {
  try {
    // Dynamic import to avoid loading react-dom/server at app startup (React 19 compat)
    const { renderToSvgString } = await import("@elucim/dsl");
    const { svgToCanvas } = await import("@elucim/core");

    type ElucimDocument = Parameters<typeof renderToSvgString>[0];
    const dsl = visual as unknown as ElucimDocument;
    const root = dsl.root as unknown as Record<string, unknown>;
    const totalFrames = (root.durationInFrames as number) || 60;
    const lastFrame = Math.max(0, totalFrames - 1);
    const width = (root.width as number) || 640;
    const height = (root.height as number) || 360;

    // Headless render to SVG string at the last frame
    const svgString = renderToSvgString(dsl, lastFrame, { width, height });

    // Parse SVG string into an element for canvas conversion
    const parser = new DOMParser();
    const doc = parser.parseFromString(svgString, "image/svg+xml");
    const svgElement = doc.documentElement as unknown as SVGSVGElement;

    // Rasterize SVG → canvas → PNG blob
    const canvas = await svgToCanvas(svgElement, width * 2, height * 2);
    const blob: Blob = await new Promise((resolve, reject) => {
      canvas.toBlob((b) => (b ? resolve(b) : reject(new Error("toBlob failed"))), "image/png");
    });
    const buffer = await blob.arrayBuffer();

    return new ImageRun({
      data: new Uint8Array(buffer),
      transformation: { width: IMG_WIDTH, height: IMG_HEIGHT },
      type: "png",
    });
  } catch (e) {
    console.warn("[exportToWord] Failed to capture visual frame:", e);
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

function createDocument(children: (Paragraph | Table)[]): Document {
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
          size: { orientation: PageOrientation.LANDSCAPE },
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

export async function exportSketchToWord(sketch: Sketch, projectRoot: string): Promise<void> {
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

  const doc = createDocument(children);
  await saveDocument(doc, `${sanitizeFilename(sketch.title)}.docx`);
}

// ── Storyboard → Word ───────────────────────────────────────────

export async function exportStoryboardToWord(
  storyboard: Storyboard,
  projectRoot: string,
  resolveSketches: (paths: string[]) => Promise<Map<string, Sketch>>,
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

  const doc = createDocument(children);
  await saveDocument(doc, `${sanitizeFilename(storyboard.title)}.docx`);
}
