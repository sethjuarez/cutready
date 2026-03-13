/**
 * exportToWord.ts — Generate .docx files from sketches and storyboards.
 *
 * Uses the `docx` library to build structured Word documents with:
 * - Title page with storyboard/sketch name
 * - Planning table (Time | Narrative | Actions) per sketch
 * - Section headers for storyboard grouping
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
  AlignmentType,
  BorderStyle,
  ShadingType,
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

function headerCell(text: string): TableCell {
  return new TableCell({
    children: [new Paragraph({
      children: [new TextRun({ text, bold: true, size: 20, color: "FFFFFF" })],
      alignment: AlignmentType.CENTER,
    })],
    shading: { type: ShadingType.SOLID, color: "4F46E5" },
  });
}

function bodyCell(text: string): TableCell {
  return new TableCell({
    children: [new Paragraph({
      children: [new TextRun({ text: text || "—", size: 20 })],
      spacing: { before: 40, after: 40 },
    })],
  });
}

const thinBorder = {
  top: { style: BorderStyle.SINGLE, size: 1, color: "D1D5DB" },
  bottom: { style: BorderStyle.SINGLE, size: 1, color: "D1D5DB" },
  left: { style: BorderStyle.SINGLE, size: 1, color: "D1D5DB" },
  right: { style: BorderStyle.SINGLE, size: 1, color: "D1D5DB" },
} as const;

function buildPlanningTable(rows: Sketch["rows"]): Table {
  const header = new TableRow({
    children: [headerCell("Time"), headerCell("Narrative"), headerCell("Demo Actions")],
    tableHeader: true,
  });

  const dataRows = rows.map(
    (row) =>
      new TableRow({
        children: [bodyCell(row.time), bodyCell(row.narrative), bodyCell(row.demo_actions)],
      }),
  );

  return new Table({
    rows: [header, ...dataRows],
    width: { size: 100, type: WidthType.PERCENTAGE },
    borders: thinBorder,
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

// ── Sketch → Word ───────────────────────────────────────────────

function buildSketchContent(sketch: Sketch, level: (typeof HeadingLevel)[keyof typeof HeadingLevel] = HeadingLevel.HEADING_1): (Paragraph | Table)[] {
  const elements: (Paragraph | Table)[] = [];

  elements.push(new Paragraph({
    text: sketch.title,
    heading: level,
    spacing: { before: 300, after: 100 },
  }));

  const desc = descriptionText(sketch.description);
  if (desc.trim()) {
    elements.push(new Paragraph({
      children: [new TextRun({ text: desc, size: 22, color: "6B7280", italics: true })],
      spacing: { before: 100, after: 200 },
    }));
  }

  if (sketch.rows.length > 0) {
    elements.push(new Paragraph({
      text: "Planning Table",
      heading: HeadingLevel.HEADING_3,
      spacing: { before: 200, after: 100 },
    }));
    elements.push(buildPlanningTable(sketch.rows));
  }

  return elements;
}

export async function exportSketchToWord(sketch: Sketch): Promise<void> {
  const doc = new Document({
    sections: [{
      children: [
        new Paragraph({ text: sketch.title, heading: HeadingLevel.TITLE, spacing: { after: 100 } }),
        new Paragraph({
          children: [
            new TextRun({ text: `Generated ${timestamp()}`, color: "9CA3AF", size: 20 }),
            new TextRun({ text: `  ·  ${sketch.rows.length} scene${sketch.rows.length !== 1 ? "s" : ""}`, color: "9CA3AF", size: 20 }),
          ],
          spacing: { after: 300 },
        }),
        ...buildSketchContent(sketch, HeadingLevel.HEADING_1),
      ],
    }],
  });

  const blob = await Packer.toBlob(doc);
  const defaultName = `${sketch.title.replace(/[^a-zA-Z0-9 ]/g, "").trim().replace(/\s+/g, "-")}.docx`;
  const filePath = await save({
    defaultPath: defaultName,
    filters: [{ name: "Word Document", extensions: ["docx"] }],
  });
  if (!filePath) return;
  const buffer = await blob.arrayBuffer();
  await writeFile(filePath, new Uint8Array(buffer));
}

// ── Storyboard → Word ───────────────────────────────────────────

export async function exportStoryboardToWord(
  storyboard: Storyboard,
  resolveSketches: (paths: string[]) => Promise<Map<string, Sketch>>,
): Promise<void> {
  // Collect all sketch paths
  const paths: string[] = [];
  for (const item of storyboard.items) {
    if (item.type === "sketch_ref") paths.push(item.path);
    else if (item.type === "section") paths.push(...item.sketches);
  }

  const sketchMap = await resolveSketches([...new Set(paths)]);

  const children: (Paragraph | Table)[] = [];

  // Title
  children.push(new Paragraph({ text: storyboard.title, heading: HeadingLevel.TITLE, spacing: { after: 100 } }));

  const sketchCount = sketchMap.size;
  const totalRows = [...sketchMap.values()].reduce((s, sk) => s + sk.rows.length, 0);
  children.push(new Paragraph({
    children: [
      new TextRun({ text: `Generated ${timestamp()}`, color: "9CA3AF", size: 20 }),
      new TextRun({ text: `  ·  ${sketchCount} sketch${sketchCount !== 1 ? "es" : ""}, ${totalRows} scene${totalRows !== 1 ? "s" : ""}`, color: "9CA3AF", size: 20 }),
    ],
    spacing: { after: 200 },
  }));

  if (storyboard.description?.trim()) {
    children.push(new Paragraph({
      children: [new TextRun({ text: storyboard.description, size: 22, color: "6B7280", italics: true })],
      spacing: { after: 300 },
    }));
  }

  // Items in storyboard order
  for (const item of storyboard.items) {
    if (item.type === "section") {
      children.push(new Paragraph({
        text: item.title,
        heading: HeadingLevel.HEADING_1,
        spacing: { before: 400, after: 100 },
      }));
      for (const spath of item.sketches) {
        const sk = sketchMap.get(spath);
        if (sk) children.push(...buildSketchContent(sk, HeadingLevel.HEADING_2));
      }
    } else {
      const sk = sketchMap.get(item.path);
      if (sk) children.push(...buildSketchContent(sk, HeadingLevel.HEADING_1));
    }
  }

  const doc = new Document({
    sections: [{ children: children as Paragraph[] }],
  });

  const blob = await Packer.toBlob(doc);
  const defaultName = `${storyboard.title.replace(/[^a-zA-Z0-9 ]/g, "").trim().replace(/\s+/g, "-")}.docx`;
  const filePath = await save({
    defaultPath: defaultName,
    filters: [{ name: "Word Document", extensions: ["docx"] }],
  });
  if (!filePath) return;
  const buffer = await blob.arrayBuffer();
  await writeFile(filePath, new Uint8Array(buffer));
}
