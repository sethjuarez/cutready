/**
 * exportToWord.ts — Generate .docx files from sketches and storyboards.
 *
 * Uses the `docx` library with Word's default Calibri theme and built-in
 * heading styles so documents look native when opened in Word.
 */

import {
  Document,
  Packer,
  Paragraph,
  TextRun,
  Table,
  TableRow,
  TableCell,
  WidthType,
  HeadingLevel,
  BorderStyle,
  convertInchesToTwip,
} from "docx";
import { save } from "@tauri-apps/plugin-dialog";
import { writeFile } from "@tauri-apps/plugin-fs";
import type { Sketch, Storyboard } from "../types/sketch";

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

function headerCell(text: string): TableCell {
  return new TableCell({
    children: [new Paragraph({
      children: [new TextRun({ text, bold: true })],
    })],
    margins: { top: convertInchesToTwip(0.04), bottom: convertInchesToTwip(0.04), left: convertInchesToTwip(0.08), right: convertInchesToTwip(0.08) },
  });
}

function bodyCell(text: string): TableCell {
  return new TableCell({
    children: [new Paragraph({ text: text || "—" })],
    margins: { top: convertInchesToTwip(0.04), bottom: convertInchesToTwip(0.04), left: convertInchesToTwip(0.08), right: convertInchesToTwip(0.08) },
  });
}

function buildPlanningTable(rows: Sketch["rows"]): Table {
  const header = new TableRow({
    children: [headerCell("Time"), headerCell("Narrative"), headerCell("Demo Actions")],
    tableHeader: true,
  });

  const dataRows = rows.map(
    (row) => new TableRow({
      children: [bodyCell(row.time), bodyCell(row.narrative), bodyCell(row.demo_actions)],
    }),
  );

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
    sections: [{ children: children as Paragraph[] }],
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

function buildSketchContent(sketch: Sketch, level: (typeof HeadingLevel)[keyof typeof HeadingLevel] = HeadingLevel.HEADING_1): (Paragraph | Table)[] {
  const elements: (Paragraph | Table)[] = [];

  elements.push(new Paragraph({ text: sketch.title, heading: level }));

  const desc = descriptionText(sketch.description);
  if (desc.trim()) {
    elements.push(new Paragraph({
      children: [new TextRun({ text: desc, italics: true })],
    }));
  }

  if (sketch.rows.length > 0) {
    elements.push(buildPlanningTable(sketch.rows));
  }

  return elements;
}

export async function exportSketchToWord(sketch: Sketch): Promise<void> {
  const children: (Paragraph | Table)[] = [
    new Paragraph({ text: sketch.title, heading: HeadingLevel.TITLE }),
    new Paragraph({
      children: [
        new TextRun({ text: `Generated ${timestamp()}  ·  ${sketch.rows.length} scene${sketch.rows.length !== 1 ? "s" : ""}`, italics: true }),
      ],
    }),
    new Paragraph({}), // blank line
    ...buildSketchContent(sketch, HeadingLevel.HEADING_1),
  ];

  const doc = createDocument(children);
  await saveDocument(doc, `${sanitizeFilename(sketch.title)}.docx`);
}

// ── Storyboard → Word ───────────────────────────────────────────

export async function exportStoryboardToWord(
  storyboard: Storyboard,
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
        if (sk) children.push(...buildSketchContent(sk, HeadingLevel.HEADING_2));
      }
    } else {
      const sk = sketchMap.get(item.path);
      if (sk) children.push(...buildSketchContent(sk, HeadingLevel.HEADING_1));
    }
  }

  const doc = createDocument(children);
  await saveDocument(doc, `${sanitizeFilename(storyboard.title)}.docx`);
}
