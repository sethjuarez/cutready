/**
 * exportToPowerPoint.ts — Generate simple teleprompter/operator .pptx decks.
 */

import pptxgen from "pptxgenjs";
import { save } from "@tauri-apps/plugin-dialog";
import { writeFile } from "@tauri-apps/plugin-fs";
import { openPath } from "@tauri-apps/plugin-opener";
import type { Sketch, Storyboard } from "../types/sketch";
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
  pageNumber: number;
  pageCount: number;
};

const SLIDE_WIDTH = 13.333;
const SLIDE_HEIGHT = 7.5;
const SLIDE_MARGIN = 0.66;
const BODY_FONT_SIZE = 36;
const BODY_HEIGHT = 5.05;
const NEXT_BAND_HEIGHT = 0.64;
const MAX_BODY_LINES = 8;
const CHARACTERS_PER_LINE = 40;

function sanitizeFilename(title: string): string {
  const sanitized = title.replace(/[^a-zA-Z0-9 ]/g, "").trim().replace(/\s+/g, "-");
  return sanitized || "CutReady-teleprompter";
}

function contentLabel(content: PowerPointExportContent): string {
  return content === "narrative" ? "Narration" : "Actions";
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
    const sourceText = content === "narrative" ? row.narrative : row.demo_actions;
    const pages = paginateMarkdown(sourceText);

    return pages.map((page, pageIndex) => {
      const { plainText, text } = markdownToSlideText(page);
      return {
        plainText,
        text,
        time: row.time,
        sketchTitle: sketch.title,
        sectionTitle,
        rowNumber: index + 1,
        pageNumber: pageIndex + 1,
        pageCount: pages.length,
      };
    });
  });
}

function paginateMarkdown(value: string): string[] {
  const lines = removeUnsafeBlocks(value)
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean)
    .map(asNoteBullet)
    .flatMap(splitMarkdownLine);

  const pages: string[] = [];
  let pageLines: string[] = [];
  let usedLines = 0;

  for (const line of lines) {
    const lineHeight = estimatedLineCount(line);
    if (pageLines.length > 0 && usedLines + lineHeight > MAX_BODY_LINES) {
      pages.push(pageLines.join("\n"));
      pageLines = [];
      usedLines = 0;
    }
    pageLines.push(line);
    usedLines += lineHeight;
  }

  if (pageLines.length > 0) pages.push(pageLines.join("\n"));
  return pages;
}

function asNoteBullet(line: string): string {
  return /^(?:[-*•]\s+|\d+[.)]\s+|#{1,6}\s+|>\s*)/.test(line) ? line : `- ${line}`;
}

function splitMarkdownLine(line: string): string[] {
  if (estimatedLineCount(line) <= MAX_BODY_LINES) return [line];

  const prefixMatch = line.match(/^(\s*(?:[-*•]\s+|\d+[.)]\s+|#{1,6}\s+)?)(.*)$/);
  const prefix = prefixMatch?.[1] ?? "";
  const body = prefixMatch?.[2] ?? line;
  const maxCharacters = (MAX_BODY_LINES - 1) * CHARACTERS_PER_LINE;
  const sentences = body.match(/[^.!?]+[.!?]+(?:\s|$)|[^.!?]+$/g) ?? [body];
  const parts: string[] = [];
  let current = "";

  const addPart = (part: string) => {
    const trimmed = part.trim();
    if (!trimmed) return;
    if (current && plainTextWithoutMarkdown(`${current} ${trimmed}`).length > maxCharacters) {
      parts.push(`${prefix}${current}`.trimEnd());
      current = trimmed;
    } else {
      current = `${current} ${trimmed}`.trim();
    }
  };

  for (const sentence of sentences) {
    const words = sentence.trim().split(/\s+/);
    let wordGroup = "";
    for (const word of words) {
      if (wordGroup && plainTextWithoutMarkdown(`${wordGroup} ${word}`).length > maxCharacters) {
        addPart(wordGroup);
        wordGroup = word;
      } else {
        wordGroup = `${wordGroup} ${word}`.trim();
      }
    }
    addPart(wordGroup);
  }

  if (current) parts.push(`${prefix}${current}`.trimEnd());
  return parts.length > 0 ? parts : [line];
}

function estimatedLineCount(markdown: string): number {
  const text = plainTextWithoutMarkdown(markdown);
  return Math.max(1, Math.ceil(text.length / CHARACTERS_PER_LINE));
}

function slideTitle(row: DeckRow): string {
  const title = row.sectionTitle ? `${row.sectionTitle} - ${row.sketchTitle}` : row.sketchTitle;
  return row.pageCount > 1 ? `${title} (${row.pageNumber}/${row.pageCount})` : title;
}

function nextSlideLabel(rows: DeckRow[], index: number): string {
  const next = rows[index + 1];
  if (!next) return "END";

  const firstSentence = next.plainText.replace(/\s+/g, " ").match(/^.*?[.!?](?:\s|$)|^.+$/)?.[0]?.trim() ?? "";
  return firstSentence.split(/\s+/).slice(0, 6).join(" ");
}

function addContentSlide(pptx: pptxgen, row: DeckRow, index: number, rows: DeckRow[]) {
  const slide = pptx.addSlide();
  slide.background = { color: "000000" };

  slide.addText(slideTitle(row), {
    x: SLIDE_MARGIN,
    y: 0.5,
    w: SLIDE_WIDTH - SLIDE_MARGIN * 2,
    h: 0.46,
    margin: 0,
    fontFace: "Aptos",
    fontSize: 28,
    color: "FFFFFF",
    breakLine: false,
    valign: "middle",
    align: "left",
  });

  slide.addText(row.text, {
    x: SLIDE_MARGIN,
    y: 1.34,
    w: SLIDE_WIDTH - SLIDE_MARGIN * 2,
    h: BODY_HEIGHT,
    margin: 0,
    fontFace: "Aptos",
    fontSize: BODY_FONT_SIZE,
    color: "FFFFFF",
    breakLine: false,
    valign: "top",
    align: "left",
  });

  slide.addShape(pptx.ShapeType.rect, {
    x: 0,
    y: SLIDE_HEIGHT - NEXT_BAND_HEIGHT,
    w: SLIDE_WIDTH,
    h: NEXT_BAND_HEIGHT,
    fill: { color: "FFF887" },
    line: { color: "FFF887" },
  });
  slide.addText(`NEXT: ${nextSlideLabel(rows, index)}`, {
    x: SLIDE_MARGIN,
    y: SLIDE_HEIGHT - NEXT_BAND_HEIGHT + 0.06,
    w: SLIDE_WIDTH - SLIDE_MARGIN * 2,
    h: NEXT_BAND_HEIGHT - 0.08,
    margin: 0,
    fontFace: "Aptos",
    fontSize: 30,
    color: "000000",
    align: "right",
    valign: "middle",
  });
}

function addEmptySlide(pptx: pptxgen, title: string, content: PowerPointExportContent) {
  const slide = pptx.addSlide();
  slide.background = { color: "000000" };
  slide.addText(`No ${contentLabel(content).toLowerCase()} text found`, {
    x: SLIDE_MARGIN,
    y: 2.8,
    w: SLIDE_WIDTH - SLIDE_MARGIN * 2,
    h: 0.8,
    margin: 0,
    fontFace: "Aptos",
    fontSize: 30,
    color: "FFFFFF",
    bold: true,
    align: "center",
  });
  slide.addShape(pptx.ShapeType.rect, {
    x: 0,
    y: SLIDE_HEIGHT - NEXT_BAND_HEIGHT,
    w: SLIDE_WIDTH,
    h: NEXT_BAND_HEIGHT,
    fill: { color: "FFF887" },
    line: { color: "FFF887" },
  });
  slide.addText(`NEXT: ${title}`, {
    x: SLIDE_MARGIN,
    y: SLIDE_HEIGHT - NEXT_BAND_HEIGHT + 0.06,
    w: SLIDE_WIDTH - SLIDE_MARGIN * 2,
    h: NEXT_BAND_HEIGHT - 0.08,
    margin: 0,
    fontFace: "Aptos",
    fontSize: 30,
    color: "000000",
    align: "right",
    valign: "middle",
  });
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
    rows.forEach((row, index) => addContentSlide(pptx, row, index, rows));
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
