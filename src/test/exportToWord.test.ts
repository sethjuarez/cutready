/**
 * Tests for exportToWord utility.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";
import { inflateRawSync } from "node:zlib";

// Mock Tauri dialog
const mockSave = vi.fn();
vi.mock("@tauri-apps/plugin-dialog", () => ({ save: (...args: unknown[]) => mockSave(...args) }));

// Mock Tauri fs
const mockWriteFile = vi.fn();
const mockReadFile = vi.fn();
vi.mock("@tauri-apps/plugin-fs", () => ({
  writeFile: (...args: unknown[]) => mockWriteFile(...args),
  readFile: (...args: unknown[]) => mockReadFile(...args),
}));

// Mock Tauri invoke — returns a minimal visual doc for get_visual calls
const mockInvoke = vi.fn().mockImplementation((cmd: string) => {
  if (cmd === "get_visual") {
    return Promise.resolve({ root: { type: "group", width: 640, height: 360, durationInFrames: 60, children: [] } });
  }
  return Promise.resolve(undefined);
});
vi.mock("@tauri-apps/api/core", () => ({ invoke: (...args: unknown[]) => mockInvoke(...args), convertFileSrc: (p: string) => p }));

// Mock Tauri opener
const mockOpenPath = vi.fn().mockResolvedValue(undefined);
vi.mock("@tauri-apps/plugin-opener", () => ({
  openPath: (...args: unknown[]) => mockOpenPath(...args),
}));

// Mock elucim packages
vi.mock("@elucim/dsl", () => ({
  DslRenderer: () => null,
  renderToSvgString: () => '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 640 360"></svg>',
}));
vi.mock("@elucim/core", () => ({
  svgToCanvas: () => {
    const canvas = document.createElement("canvas");
    canvas.width = 640;
    canvas.height = 360;
    // Provide a toBlob that returns a minimal PNG blob
    canvas.toBlob = (cb: BlobCallback) => cb(new Blob(["fake-png"], { type: "image/png" }));
    return Promise.resolve(canvas);
  },
}));

import { exportSketchToWord, exportStoryboardToWord, exportNoteToWord } from "../utils/exportToWord";
import type { Sketch, Storyboard } from "../types/sketch";

function findSignature(bytes: Uint8Array, signature: number, start: number, reverse = false): number {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  if (reverse) {
    for (let i = start; i >= 0; i--) {
      if (view.getUint32(i, true) === signature) return i;
    }
  } else {
    for (let i = start; i <= bytes.length - 4; i++) {
      if (view.getUint32(i, true) === signature) return i;
    }
  }
  return -1;
}

function extractDocxEntry(bytes: Uint8Array, entryName: string): string {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const eocd = findSignature(bytes, 0x06054b50, bytes.length - 22, true);
  expect(eocd).toBeGreaterThanOrEqual(0);
  const centralDirOffset = view.getUint32(eocd + 16, true);

  let offset = centralDirOffset;
  while (offset < bytes.length && view.getUint32(offset, true) === 0x02014b50) {
    const compression = view.getUint16(offset + 10, true);
    const compressedSize = view.getUint32(offset + 20, true);
    const fileNameLength = view.getUint16(offset + 28, true);
    const extraLength = view.getUint16(offset + 30, true);
    const commentLength = view.getUint16(offset + 32, true);
    const localHeaderOffset = view.getUint32(offset + 42, true);
    const nameStart = offset + 46;
    const name = new TextDecoder().decode(bytes.slice(nameStart, nameStart + fileNameLength));

    if (name === entryName) {
      const localNameLength = view.getUint16(localHeaderOffset + 26, true);
      const localExtraLength = view.getUint16(localHeaderOffset + 28, true);
      const dataStart = localHeaderOffset + 30 + localNameLength + localExtraLength;
      const compressed = bytes.slice(dataStart, dataStart + compressedSize);
      const content = compression === 8 ? inflateRawSync(compressed) : Buffer.from(compressed);
      return content.toString("utf8");
    }

    offset = nameStart + fileNameLength + extraLength + commentLength;
  }

  throw new Error(`DOCX entry not found: ${entryName}`);
}

function writtenDocumentXml(): string {
  const bytes = mockWriteFile.mock.calls[0][1] as Uint8Array;
  return extractDocxEntry(bytes, "word/document.xml");
}

function makeMockSketch(title = "Test Sketch", rowCount = 3): Sketch {
  return {
    title,
    description: "A test description",
    rows: Array.from({ length: rowCount }, (_, i) => ({
      time: `0:${String(i * 15).padStart(2, "0")}`,
      narrative: `Step ${i + 1} narrative`,
      demo_actions: `Action ${i + 1}`,
      screenshot: null,
    })),
    state: "draft",
    created_at: "2025-01-01T00:00:00Z",
    updated_at: "2025-01-01T00:00:00Z",
  };
}

beforeEach(() => {
  mockSave.mockReset();
  mockWriteFile.mockReset();
  mockReadFile.mockReset();
  mockOpenPath.mockReset();
  mockSave.mockResolvedValue("/tmp/test.docx");
  mockWriteFile.mockResolvedValue(undefined);
  mockReadFile.mockResolvedValue(new Uint8Array([0xFF, 0xD8, 0xFF])); // minimal JPEG header
  mockOpenPath.mockResolvedValue(undefined);
});

describe("exportSketchToWord", () => {
  it("shows save dialog and writes .docx file", async () => {
    const sketch = makeMockSketch("My Demo");
    await exportSketchToWord(sketch, "/projects/test");

    expect(mockSave).toHaveBeenCalledTimes(1);
    expect(mockSave).toHaveBeenCalledWith({
      defaultPath: "My-Demo.docx",
      filters: [{ name: "Word Document", extensions: ["docx"] }],
    });
    expect(mockWriteFile).toHaveBeenCalledTimes(1);
    expect(mockWriteFile.mock.calls[0][0]).toBe("/tmp/test.docx");
    expect(mockWriteFile.mock.calls[0][1]).toBeInstanceOf(Uint8Array);
  }, 15_000);

  it("does nothing when user cancels save dialog", async () => {
    mockSave.mockResolvedValue(null);
    const sketch = makeMockSketch("Cancelled");
    await exportSketchToWord(sketch, "/projects/test");

    expect(mockSave).toHaveBeenCalledTimes(1);
    expect(mockWriteFile).not.toHaveBeenCalled();
  }, 15_000);

  it("handles empty rows gracefully", async () => {
    const sketch = makeMockSketch("Empty", 0);
    await exportSketchToWord(sketch, "/projects/test");

    expect(mockSave).toHaveBeenCalledWith(
      expect.objectContaining({ defaultPath: "Empty.docx" }),
    );
    expect(mockWriteFile).toHaveBeenCalledTimes(1);
  }, 15_000);

  it("handles Lexical JSON description", async () => {
    const sketch = makeMockSketch("Lexical");
    sketch.description = { root: { children: [{ text: "hello" }] } };
    await exportSketchToWord(sketch, "/projects/test");
    expect(mockWriteFile).toHaveBeenCalledTimes(1);
  }, 15_000);

  it("renders sketch description markdown headings, lists, bold, italic, and links", async () => {
    const sketch = makeMockSketch("Markdown Sketch", 0);
    sketch.description = "# Scene Goal\n\n- **Bold** point\n- *Italic* point\n- [Docs](https://example.com)";

    await exportSketchToWord(sketch, "/projects/test");

    const xml = writtenDocumentXml();
    expect(xml).toContain("Scene Goal");
    expect(xml).not.toContain("# Scene Goal");
    expect(xml).toContain("Bold");
    expect(xml).toContain("<w:b/>");
    expect(xml).toContain("Italic");
    expect(xml).toContain("<w:i/>");
    expect(xml).toContain("Docs (https://example.com)");
  }, 15_000);
});

describe("exportStoryboardToWord", () => {
  it("generates a .docx with resolved sketches", async () => {
    const sk1 = makeMockSketch("Intro", 2);
    const sk2 = makeMockSketch("Demo", 4);

    const storyboard: Storyboard = {
      title: "Full Demo Storyboard",
      description: "End-to-end walkthrough",
      items: [
        { type: "sketch_ref", path: "sketches/intro.sk" },
        { type: "section", title: "Main Content", sketches: ["sketches/demo.sk"] },
      ],
      created_at: "2025-01-01T00:00:00Z",
      updated_at: "2025-01-01T00:00:00Z",
    };

    const resolver = async (paths: string[]) => {
      const map = new Map<string, Sketch>();
      for (const p of paths) {
        if (p.includes("intro")) map.set(p, sk1);
        if (p.includes("demo")) map.set(p, sk2);
      }
      return map;
    };

    await exportStoryboardToWord(storyboard, "/projects/test", resolver);

    expect(mockSave).toHaveBeenCalledWith(
      expect.objectContaining({ defaultPath: "Full-Demo-Storyboard.docx" }),
    );
    expect(mockWriteFile).toHaveBeenCalledTimes(1);
    expect(mockWriteFile.mock.calls[0][0]).toBe("/tmp/test.docx");
  }, 15_000);

  it("handles storyboard with no items", async () => {
    const storyboard: Storyboard = {
      title: "Empty Board",
      description: "",
      items: [],
      created_at: "2025-01-01T00:00:00Z",
      updated_at: "2025-01-01T00:00:00Z",
    };

    await exportStoryboardToWord(storyboard, "/projects/test", async () => new Map());

    expect(mockSave).toHaveBeenCalledWith(
      expect.objectContaining({ defaultPath: "Empty-Board.docx" }),
    );
    expect(mockWriteFile).toHaveBeenCalledTimes(1);
  }, 15_000);

  it("includes planning row timing for storyboard sketches", async () => {
    const sk1 = makeMockSketch("Intro", 1);
    const sk2 = makeMockSketch("Demo", 1);
    sk1.rows[0].time = "00:05";
    sk2.rows[0].time = "01:15";

    const storyboard: Storyboard = {
      title: "Timed Storyboard",
      description: "",
      items: [
        { type: "sketch_ref", path: "sketches/intro.sk" },
        { type: "sketch_ref", path: "sketches/demo.sk" },
      ],
      created_at: "2025-01-01T00:00:00Z",
      updated_at: "2025-01-01T00:00:00Z",
    };

    await exportStoryboardToWord(storyboard, "/projects/test", async () => new Map([
      ["sketches/intro.sk", sk1],
      ["sketches/demo.sk", sk2],
    ]));

    const xml = writtenDocumentXml();
    expect(xml).toContain("00:05");
    expect(xml).toContain("01:15");
    expect(xml).toContain("Time");
  }, 15_000);

  it("renders storyboard description markdown instead of raw markdown text", async () => {
    const storyboard: Storyboard = {
      title: "Markdown Storyboard",
      description: "# Story Goals\n\n- **Bold** beat\n- [Docs](https://example.com)",
      items: [],
      created_at: "2025-01-01T00:00:00Z",
      updated_at: "2025-01-01T00:00:00Z",
    };

    await exportStoryboardToWord(storyboard, "/projects/test", async () => new Map());

    const xml = writtenDocumentXml();
    expect(xml).toContain("Story Goals");
    expect(xml).not.toContain("# Story Goals");
    expect(xml).toContain("Bold");
    expect(xml).toContain("<w:b/>");
    expect(xml).toContain("Docs (https://example.com)");
  }, 15_000);
});

describe("exportNoteToWord", () => {
  it("exports markdown note with headings and paragraphs", async () => {
    const md = [
      "# Introduction",
      "",
      "This is a **bold** and *italic* note.",
      "",
      "## Section Two",
      "",
      "- Bullet one",
      "- Bullet two",
      "",
      "1. First item",
      "2. Second item",
    ].join("\n");

    await exportNoteToWord("My Notes", md, "/projects/test");

    expect(mockSave).toHaveBeenCalledWith({
      defaultPath: "My-Notes.docx",
      filters: [{ name: "Word Document", extensions: ["docx"] }],
    });
    expect(mockWriteFile).toHaveBeenCalledTimes(1);
    expect(mockWriteFile.mock.calls[0][1]).toBeInstanceOf(Uint8Array);
  }, 15_000);

  it("does nothing when user cancels save dialog", async () => {
    mockSave.mockResolvedValue(null);
    await exportNoteToWord("Cancelled", "Some content", "/projects/test");
    expect(mockWriteFile).not.toHaveBeenCalled();
  }, 15_000);

  it("handles empty markdown gracefully", async () => {
    await exportNoteToWord("Empty Note", "", "/projects/test");
    expect(mockSave).toHaveBeenCalledWith(
      expect.objectContaining({ defaultPath: "Empty-Note.docx" }),
    );
    expect(mockWriteFile).toHaveBeenCalledTimes(1);
  }, 15_000);

  it("handles blockquotes and horizontal rules", async () => {
    const md = "> This is a quote\n\n---\n\nRegular text after rule.";
    await exportNoteToWord("Quotes", md, "/projects/test");
    expect(mockWriteFile).toHaveBeenCalledTimes(1);
  }, 15_000);

  it("handles GFM tables", async () => {
    const md = "| Name | Value |\n| --- | --- |\n| Alpha | 100 |\n| Beta | 200 |";
    await exportNoteToWord("Tables", md, "/projects/test");
    expect(mockWriteFile).toHaveBeenCalledTimes(1);
  }, 15_000);

  it("handles images with fallback text when file missing", async () => {
    mockReadFile.mockRejectedValue(new Error("Not found"));
    const md = "![Screenshot](.cutready/screenshots/demo.png)";
    await exportNoteToWord("With Image", md, "/projects/test");
    expect(mockWriteFile).toHaveBeenCalledTimes(1);
  }, 15_000);

  it("inlines images when readFile succeeds", async () => {
    mockReadFile.mockResolvedValue(new Uint8Array([0x89, 0x50, 0x4E, 0x47])); // PNG header
    const md = "![Demo screenshot](.cutready/screenshots/demo.png)";
    await exportNoteToWord("With Image", md, "/projects/test");
    expect(mockReadFile).toHaveBeenCalledTimes(1);
    // readFile should be called with the full path
    const callPath = mockReadFile.mock.calls[0][0] as string;
    expect(callPath).toContain(".cutready/screenshots/demo.png");
    expect(mockWriteFile).toHaveBeenCalledTimes(1);
  }, 15_000);

  it("handles images mixed with text on same line", async () => {
    mockReadFile.mockResolvedValue(new Uint8Array([0xFF, 0xD8, 0xFF]));
    const md = "See this: ![shot](.cutready/screenshots/a.png) and this text after.";
    await exportNoteToWord("Mixed", md, "/projects/test");
    expect(mockReadFile).toHaveBeenCalledTimes(1);
    expect(mockWriteFile).toHaveBeenCalledTimes(1);
  }, 15_000);

  it("handles multiple images on separate lines", async () => {
    mockReadFile.mockResolvedValue(new Uint8Array([0xFF, 0xD8, 0xFF]));
    const md = [
      "![First](.cutready/screenshots/a.png)",
      "",
      "![Second](.cutready/screenshots/b.png)",
    ].join("\n");
    await exportNoteToWord("Multi Image", md, "/projects/test");
    expect(mockReadFile).toHaveBeenCalledTimes(2);
    expect(mockWriteFile).toHaveBeenCalledTimes(1);
  }, 15_000);

  it("handles image path with spaces", async () => {
    mockReadFile.mockResolvedValue(new Uint8Array([0xFF, 0xD8, 0xFF]));
    const md = "![Shot](.cutready/screenshots/my screenshot.png)";
    await exportNoteToWord("Spaces", md, "/projects/test");
    const callPath = mockReadFile.mock.calls[0][0] as string;
    expect(callPath).toContain("my screenshot.png");
    expect(mockWriteFile).toHaveBeenCalledTimes(1);
  }, 15_000);
});
