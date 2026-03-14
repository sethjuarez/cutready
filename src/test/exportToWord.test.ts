/**
 * Tests for exportToWord utility.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";

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

// Mock Tauri invoke
vi.mock("@tauri-apps/api/core", () => ({ invoke: vi.fn() }));

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

import { exportSketchToWord, exportStoryboardToWord } from "../utils/exportToWord";
import type { Sketch, Storyboard } from "../types/sketch";

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
  mockSave.mockResolvedValue("/tmp/test.docx");
  mockWriteFile.mockResolvedValue(undefined);
  mockReadFile.mockResolvedValue(new Uint8Array([0xFF, 0xD8, 0xFF])); // minimal JPEG header
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
});
