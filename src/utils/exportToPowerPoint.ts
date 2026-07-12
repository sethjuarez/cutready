/**
 * exportToPowerPoint.ts — Generate simple teleprompter/operator .pptx decks.
 */

import pptxgen from "pptxgenjs";
import { save } from "@tauri-apps/plugin-dialog";
import { writeFile } from "@tauri-apps/plugin-fs";
import { openPath } from "@tauri-apps/plugin-opener";
import type { PlanningRow, Sketch, Storyboard } from "../types/sketch";
import { getUniqueStoryboardSketchPaths } from "./storyboard";

export type PowerPointExportContent = "narrative" | "actions";

type Slide = ReturnType<pptxgen["addSlide"]>;
type SlideText = Extract<Parameters<Slide["addText"]>[0], Array<unknown>>;
type SlideTextRun = SlideText[number];

type DeckRow = {
  plainText: string;
  text: SlideText;
  time?: string;
  sketchTitle: string;
  sectionTitle?: string;
  rowNumber: number;
};

const SLIDE_WIDTH = 13.333;
const SLIDE_HEIGHT = 7.5;
const SLIDE_MARGIN = 0.7;
const FOOTER_HEIGHT = 0.36;

function sanitizeFilename(title: string): string {
  const sanitized = title.replace(/[^a-zA-Z0-9 ]/g, "").trim().replace(/\s+/g, "-");
  return sanitized || "CutReady-teleprompter";
}

function contentLabel(content: PowerPointExportContent): string {
  return content === "narrative" ? "Narration" : "Actions";
}

function rowContent(row: PlanningRow, content: PowerPointExportContent): { plainText: string; text: SlideText } {
  return markdownToSlideText(content === "narrative" ? row.narrative : row.demo_actions);
}

function removeUnsafeBlocks(value: string): string {
  return value
    .replace(/<script\b[^>]*>[\s\S]*?<\/script>/gi, "")
    .replace(/```[\s\S]*?```/g, "");
}

function markdownToSlideText(value: string): { plainText: string; text: SlideText } {
  const lines = removeUnsafeBlocks(value).split(/\r?\n/);
  const text: SlideText = [];
  const plainTextLines: string[] = [];
  const parsedLines = lines.map(parseMarkdownLine).filter((line) => line.content.trim());

  parsedLines.forEach((line, index) => {
    const runs = inlineMarkdownRuns(line.content, line.options);
    if (runs.length === 0) return;
    runs[runs.length - 1].options = {
      ...runs[runs.length - 1].options,
      breakLine: index < parsedLines.length - 1,
    };
    text.push(...runs);
    plainTextLines.push(plainTextWithoutMarkdown(line.content));
  });

  return { plainText: plainTextLines.join("\n").trim(), text };
}

function parseMarkdownLine(line: string): { content: string; options?: SlideTextRun["options"] } {
  const trimmed = line.trim();
  if (!trimmed) return { content: "" };
  const baseOptions: SlideTextRun["options"] = { align: "left" };

  const heading = trimmed.match(/^#{1,6}\s+(.+)$/);
  if (heading) return { content: cleanInlineText(heading[1]), options: { ...baseOptions, bold: true } };

  const blockquote = trimmed.match(/^>\s?(.+)$/);
  if (blockquote) return { content: cleanInlineText(blockquote[1]), options: { ...baseOptions, italic: true } };

  const checklist = trimmed.match(/^[-*•]\s+\[[ xX]\]\s+(.+)$/);
  if (checklist) return { content: cleanInlineText(checklist[1]), options: { ...baseOptions, bullet: true } };

  const bullet = trimmed.match(/^[-*•]\s+(.+)$/);
  if (bullet) return { content: cleanInlineText(bullet[1]), options: { ...baseOptions, bullet: true } };

  const numbered = trimmed.match(/^\d+[.)]\s+(.+)$/);
  if (numbered) return { content: cleanInlineText(numbered[1]), options: { ...baseOptions, bullet: { type: "number", indent: 24 } } };

  return { content: cleanInlineText(trimmed), options: baseOptions };
}

function cleanInlineText(value: string): string {
  return value
    .replace(/!\[([^\]]*)\]\([^)]+\)/g, "$1")
    .replace(/\[([^\]]+)\]\([^)]+\)/g, "$1")
    .replace(/<\/?[^>]+>/g, "");
}

function inlineMarkdownRuns(value: string, lineOptions?: SlideTextRun["options"]): SlideText {
  const runs: SlideText = [];
  const pattern = /(`[^`]+`|\*\*\*[^*]+\*\*\*|\*\*[^*]+\*\*|\*[^*]+\*)/g;
  let lastIndex = 0;

  const pushRun = (text: string, options?: SlideTextRun["options"]) => {
    if (!text) return;
    runs.push({ text, options: { ...(runs.length === 0 ? lineOptions : undefined), ...options } });
  };

  for (const match of value.matchAll(pattern)) {
    pushRun(value.slice(lastIndex, match.index));
    const raw = match[0];
    if (raw.startsWith("`")) {
      pushRun(raw.slice(1, -1), { fontFace: "Aptos Mono" });
    } else if (raw.startsWith("***")) {
      pushRun(raw.slice(3, -3), { bold: true, italic: true });
    } else if (raw.startsWith("**")) {
      pushRun(raw.slice(2, -2), { bold: true });
    } else if (raw.startsWith("*")) {
      pushRun(raw.slice(1, -1), { italic: true });
    }
    lastIndex = match.index! + raw.length;
  }

  pushRun(value.slice(lastIndex));
  return runs.length > 0 ? runs : [{ text: value, options: lineOptions }];
}

function plainTextWithoutMarkdown(value: string): string {
  return cleanInlineText(value)
    .replace(/`([^`]+)`/g, "$1")
    .replace(/\*\*\*([^*]+)\*\*\*/g, "$1")
    .replace(/\*\*([^*]+)\*\*/g, "$1")
    .replace(/\*([^*]+)\*/g, "$1");
}

function collectSketchRows(
  sketch: Sketch,
  content: PowerPointExportContent,
  sectionTitle?: string,
): DeckRow[] {
  return sketch.rows.flatMap((row, index) => {
    const { plainText, text } = rowContent(row, content);
    if (!plainText) return [];
    return [{
      plainText,
      text,
      time: row.time,
      sketchTitle: sketch.title,
      sectionTitle,
      rowNumber: index + 1,
    }];
  });
}

function addContentSlide(pptx: pptxgen, row: DeckRow, index: number, total: number) {
  const slide = pptx.addSlide();
  slide.background = { color: "17151F" };

  slide.addText(row.text, {
    x: SLIDE_MARGIN,
    y: 0.72,
    w: SLIDE_WIDTH - SLIDE_MARGIN * 2,
    h: SLIDE_HEIGHT - 1.7,
    margin: 4,
    fontFace: "Aptos Display",
    fontSize: fontSizeForText(row.plainText),
    color: "FFFFFF",
    bold: true,
    breakLine: false,
    fit: "shrink",
    valign: "top",
    align: "left",
  });

  const footerParts = [
    row.sectionTitle,
    row.sketchTitle,
    row.time?.trim() ? row.time.trim() : null,
    `Scene ${row.rowNumber}`,
    `${index + 1}/${total}`,
  ].filter(Boolean);

  slide.addText(footerParts.join("  ·  "), {
    x: SLIDE_MARGIN,
    y: SLIDE_HEIGHT - SLIDE_MARGIN,
    w: SLIDE_WIDTH - SLIDE_MARGIN * 2,
    h: FOOTER_HEIGHT,
    margin: 0,
    fontFace: "Aptos",
    fontSize: 9,
    color: "B9B3CF",
    align: "left",
  });
}

function addEmptySlide(pptx: pptxgen, title: string, content: PowerPointExportContent) {
  const slide = pptx.addSlide();
  slide.background = { color: "17151F" };
  slide.addText(`No ${contentLabel(content).toLowerCase()} text found`, {
    x: SLIDE_MARGIN,
    y: 2.8,
    w: SLIDE_WIDTH - SLIDE_MARGIN * 2,
    h: 0.8,
    margin: 0,
    fontFace: "Aptos Display",
    fontSize: 30,
    color: "FFFFFF",
    bold: true,
    align: "center",
  });
  slide.addText(title, {
    x: SLIDE_MARGIN,
    y: 6.8,
    w: SLIDE_WIDTH - SLIDE_MARGIN * 2,
    h: FOOTER_HEIGHT,
    margin: 0,
    fontFace: "Aptos",
    fontSize: 9,
    color: "B9B3CF",
    align: "center",
  });
}

function fontSizeForText(text: string): number {
  const length = text.length;
  if (length > 700) return 28;
  if (length > 500) return 32;
  if (length > 320) return 38;
  if (length > 180) return 46;
  return 56;
}

function createDeck(title: string, content: PowerPointExportContent, rows: DeckRow[]): pptxgen {
  const pptx = new pptxgen();
  pptx.layout = "LAYOUT_WIDE";
  pptx.author = "CutReady";
  pptx.company = "CutReady";
  pptx.subject = `${contentLabel(content)} teleprompter deck`;
  pptx.title = title;
  pptx.theme = {
    headFontFace: "Aptos Display",
    bodyFontFace: "Aptos",
  };

  if (rows.length === 0) {
    addEmptySlide(pptx, title, content);
  } else {
    rows.forEach((row, index) => addContentSlide(pptx, row, index, rows.length));
  }

  return pptx;
}

async function saveDeck(pptx: pptxgen, defaultName: string): Promise<boolean> {
  const filePath = await save({
    defaultPath: defaultName,
    filters: [{ name: "PowerPoint Presentation", extensions: ["pptx"] }],
  });
  if (!filePath) return false;

  const output = await pptx.write({ outputType: "uint8array" });
  await writeFile(filePath, output instanceof Uint8Array ? output : new Uint8Array(output as ArrayBuffer));
  try {
    await openPath(filePath);
  } catch (e) {
    console.error("[exportToPowerPoint] Failed to open file:", filePath, e);
  }
  return true;
}

export async function exportSketchToPowerPoint(
  sketch: Sketch,
  content: PowerPointExportContent,
): Promise<boolean> {
  const rows = collectSketchRows(sketch, content);
  const label = contentLabel(content);
  const pptx = createDeck(`${sketch.title} ${label}`, content, rows);
  return saveDeck(pptx, `${sanitizeFilename(sketch.title)}-${label}.pptx`);
}

export async function exportStoryboardToPowerPoint(
  storyboard: Storyboard,
  content: PowerPointExportContent,
  resolveSketches: (paths: string[]) => Promise<Map<string, Sketch>>,
): Promise<boolean> {
  const sketchMap = await resolveSketches(getUniqueStoryboardSketchPaths(storyboard));
  const rows: DeckRow[] = [];

  for (const item of storyboard.items) {
    if (item.type === "section") {
      for (const sketchPath of item.sketches) {
        const sketch = sketchMap.get(sketchPath);
        if (sketch) rows.push(...collectSketchRows(sketch, content, item.title));
      }
    } else {
      const sketch = sketchMap.get(item.path);
      if (sketch) rows.push(...collectSketchRows(sketch, content));
    }
  }

  const label = contentLabel(content);
  const pptx = createDeck(`${storyboard.title} ${label}`, content, rows);
  return saveDeck(pptx, `${sanitizeFilename(storyboard.title)}-${label}.pptx`);
}
