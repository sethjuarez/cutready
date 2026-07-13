import { describe, it, expect, vi, beforeEach } from "vitest";
import { inflateRawSync } from "node:zlib";
import { exportSketchToPowerPoint, exportStoryboardToPowerPoint } from "../utils/exportToPowerPoint";
import type { Sketch, Storyboard } from "../types/sketch";

const mockSave = vi.fn();
vi.mock("@tauri-apps/plugin-dialog", () => ({ save: (...args: unknown[]) => mockSave(...args) }));

const mockWriteFile = vi.fn();
vi.mock("@tauri-apps/plugin-fs", () => ({ writeFile: (...args: unknown[]) => mockWriteFile(...args) }));

const mockOpenPath = vi.fn().mockResolvedValue(undefined);
vi.mock("@tauri-apps/plugin-opener", () => ({ openPath: (...args: unknown[]) => mockOpenPath(...args) }));

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

function extractZipEntry(bytes: Uint8Array, entryName: string): string {
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

  throw new Error(`ZIP entry not found: ${entryName}`);
}

function listZipEntries(bytes: Uint8Array): string[] {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const eocd = findSignature(bytes, 0x06054b50, bytes.length - 22, true);
  expect(eocd).toBeGreaterThanOrEqual(0);
  const centralDirOffset = view.getUint32(eocd + 16, true);
  const entries: string[] = [];

  let offset = centralDirOffset;
  while (offset < bytes.length && view.getUint32(offset, true) === 0x02014b50) {
    const fileNameLength = view.getUint16(offset + 28, true);
    const extraLength = view.getUint16(offset + 30, true);
    const commentLength = view.getUint16(offset + 32, true);
    const nameStart = offset + 46;
    entries.push(new TextDecoder().decode(bytes.slice(nameStart, nameStart + fileNameLength)));
    offset = nameStart + fileNameLength + extraLength + commentLength;
  }

  return entries;
}

function writtenPptxBytes(): Uint8Array {
  return mockWriteFile.mock.calls[0][1] as Uint8Array;
}

function slideTextValues(slideXml: string): string[] {
  return [...slideXml.matchAll(/<a:t>(.*?)<\/a:t>/g)].map((match) => match[1]);
}

function makeSketch(title = "Demo Sketch"): Sketch {
  return {
    title,
    description: "Description",
    rows: [
      {
        time: "0:00",
        narrative: "**Welcome** to the demo",
        demo_actions: "Open the app",
        screenshot: null,
      },
      {
        time: "0:10",
        narrative: "",
        demo_actions: "Click **Create**",
        screenshot: null,
      },
    ],
    state: "draft",
    created_at: "2026-01-01T00:00:00Z",
    updated_at: "2026-01-01T00:00:00Z",
  };
}

beforeEach(() => {
  mockSave.mockReset();
  mockWriteFile.mockReset();
  mockOpenPath.mockReset();
  mockSave.mockResolvedValue("/tmp/test.pptx");
  mockWriteFile.mockResolvedValue(undefined);
  mockOpenPath.mockResolvedValue(undefined);
});

describe("exportSketchToPowerPoint", () => {
  it("exports narration slides in the simple format", async () => {
    await exportSketchToPowerPoint(makeSketch("My Demo"), "narrative");

    expect(mockSave).toHaveBeenCalledWith({
      defaultPath: "My-Demo-Narration.pptx",
      filters: [{ name: "PowerPoint Presentation", extensions: ["pptx"] }],
    });
    expect(mockWriteFile).toHaveBeenCalledTimes(1);
    expect(mockWriteFile.mock.calls[0][0]).toBe("/tmp/test.pptx");

    const slideXml = extractZipEntry(writtenPptxBytes(), "ppt/slides/slide1.xml");
    expect(slideXml).toContain("Welcome");
    expect(slideXml).toContain("to the demo");
    expect(slideXml).not.toContain("**Welcome**");
    expect(() => extractZipEntry(writtenPptxBytes(), "ppt/slides/slide2.xml")).toThrow();
  }, 15_000);

  it("keeps markdown formatting but removes unsafe script/code blocks", async () => {
    const sketch = makeSketch("Plain Text");
    sketch.rows[0].narrative = [
      "Now observe behavior.",
      "",
      "- one",
      "- two",
      "1. numbered",
      "> YES",
      "**Bold** and *italic*",
      "<script>alert('nope')</script>",
      "```js",
      "console.log('nope')",
      "```",
    ].join("\n");

    await exportSketchToPowerPoint(sketch, "narrative");

    const text = slideTextValues(extractZipEntry(writtenPptxBytes(), "ppt/slides/slide1.xml")).join("\n");
    expect(text).toContain("Now observe behavior.");
    expect(text).toContain("one");
    expect(text).toContain("two");
    expect(text).toContain("numbered");
    expect(text).toContain("YES");
    expect(text).toContain("Bold");
    expect(text).toContain("italic");
    expect(text).not.toContain("&gt; YES");
    expect(text).not.toContain("script");
    expect(text).not.toContain("console.log");
    const slideXml = extractZipEntry(writtenPptxBytes(), "ppt/slides/slide1.xml");
    expect(slideXml).toContain("<a:buChar");
    expect(slideXml).toContain("<a:buAutoNum");
    expect(slideXml).toContain('b="1"');
    expect(slideXml).toContain('i="1"');
    expect(slideXml).not.toContain('algn="ctr"');
  }, 15_000);

  it("does not emit a macro-enabled PowerPoint package", async () => {
    await exportSketchToPowerPoint(makeSketch("No Macros"), "narrative");

    const entries = listZipEntries(writtenPptxBytes());
    expect(entries).not.toContain("ppt/vbaProject.bin");
    expect(entries.some((entry) => entry.toLowerCase().includes("vba"))).toBe(false);
  }, 15_000);

  it("exports actions slides when requested", async () => {
    await exportSketchToPowerPoint(makeSketch("Operator Demo"), "actions");

    expect(mockSave).toHaveBeenCalledWith(
      expect.objectContaining({ defaultPath: "Operator-Demo-Actions.pptx" }),
    );

    const firstSlide = extractZipEntry(writtenPptxBytes(), "ppt/slides/slide1.xml");
    const secondSlide = extractZipEntry(writtenPptxBytes(), "ppt/slides/slide2.xml");
    expect(firstSlide).toContain("Open the app");
    expect(secondSlide).toContain("Click");
    expect(secondSlide).toContain("Create");
  }, 15_000);

  it("splits long narration into readable notes slides with a next cue", async () => {
    const sketch = makeSketch("Production Notes");
    sketch.rows[0].narrative = [
      "Welcome to the workspace, where we keep the entire demo plan organized.",
      "Start by opening the storyboard so everyone can see the sequence at a glance.",
      "Each sketch holds the narration, the operator action, and the reference assets for one scene.",
      "Use the planning table to make adjustments while the production team reviews the flow.",
      "When the script is ready, export the notes deck for the presenter and control room.",
      "The deck keeps every passage large enough to read without shrinking the type.",
      "Long passages continue on a new slide at a sentence boundary instead of cramming the screen.",
    ].join("\n");

    await exportSketchToPowerPoint(sketch, "narrative");

    const firstSlide = extractZipEntry(writtenPptxBytes(), "ppt/slides/slide1.xml");
    const secondSlide = extractZipEntry(writtenPptxBytes(), "ppt/slides/slide2.xml");
    expect(firstSlide).toContain("000000");
    expect(firstSlide).toContain("FFF887");
    expect(firstSlide).toContain("NEXT:");
    expect(firstSlide).not.toContain('fit="shrink"');
    expect(firstSlide).toContain("<a:buChar");
    expect(secondSlide).toContain("Long passages continue");
  }, 15_000);

  it("does nothing when the save dialog is canceled", async () => {
    mockSave.mockResolvedValue(null);

    await exportSketchToPowerPoint(makeSketch("Cancelled"), "narrative");

    expect(mockSave).toHaveBeenCalledTimes(1);
    expect(mockWriteFile).not.toHaveBeenCalled();
  }, 15_000);
});

describe("exportStoryboardToPowerPoint", () => {
  it("flattens storyboard sketches in order", async () => {
    const intro = makeSketch("Intro");
    const demo = makeSketch("Demo");
    demo.rows[0].narrative = "Second sketch narration";
    const storyboard: Storyboard = {
      title: "Full Demo",
      description: "Storyboard",
      items: [
        { type: "sketch_ref", path: "intro.sk" },
        { type: "section", title: "Build", sketches: ["demo.sk"] },
      ],
      created_at: "2026-01-01T00:00:00Z",
      updated_at: "2026-01-01T00:00:00Z",
    };

    await exportStoryboardToPowerPoint(storyboard, "narrative", async () => new Map([
      ["intro.sk", intro],
      ["demo.sk", demo],
    ]));

    expect(mockSave).toHaveBeenCalledWith(
      expect.objectContaining({ defaultPath: "Full-Demo-Narration.pptx" }),
    );
    expect(extractZipEntry(writtenPptxBytes(), "ppt/slides/slide1.xml")).toContain("Welcome");
    expect(extractZipEntry(writtenPptxBytes(), "ppt/slides/slide2.xml")).toContain("Second sketch narration");
  }, 15_000);
});
