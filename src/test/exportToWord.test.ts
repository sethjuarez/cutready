/**
 * Tests for exportToWord utility.
 */
import { describe, it, expect, vi } from "vitest";

// Mock file-saver before importing
vi.mock("file-saver", () => ({ saveAs: vi.fn() }));

// Mock Tauri invoke
vi.mock("@tauri-apps/api/core", () => ({ invoke: vi.fn() }));

import { exportSketchToWord, exportStoryboardToWord } from "../utils/exportToWord";
import { saveAs } from "file-saver";
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

describe("exportSketchToWord", () => {
  it("generates a .docx blob and triggers download", async () => {
    const sketch = makeMockSketch("My Demo");
    await exportSketchToWord(sketch);

    expect(saveAs).toHaveBeenCalledTimes(1);
    const [blob, filename] = (saveAs as unknown as ReturnType<typeof vi.fn>).mock.calls[0];
    expect(blob).toBeInstanceOf(Blob);
    expect(blob.type).toBe("application/vnd.openxmlformats-officedocument.wordprocessingml.document");
    expect(filename).toBe("My-Demo.docx");
  });

  it("handles empty rows gracefully", async () => {
    vi.mocked(saveAs).mockClear();
    const sketch = makeMockSketch("Empty", 0);
    await exportSketchToWord(sketch);

    expect(saveAs).toHaveBeenCalledTimes(1);
    const [blob, filename] = (saveAs as unknown as ReturnType<typeof vi.fn>).mock.calls[0];
    expect(blob).toBeInstanceOf(Blob);
    expect(filename).toBe("Empty.docx");
  });

  it("handles Lexical JSON description", async () => {
    vi.mocked(saveAs).mockClear();
    const sketch = makeMockSketch("Lexical");
    sketch.description = { root: { children: [{ text: "hello" }] } };
    await exportSketchToWord(sketch);
    expect(saveAs).toHaveBeenCalledTimes(1);
  });
});

describe("exportStoryboardToWord", () => {
  it("generates a .docx with resolved sketches", async () => {
    vi.mocked(saveAs).mockClear();
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

    await exportStoryboardToWord(storyboard, resolver);

    expect(saveAs).toHaveBeenCalledTimes(1);
    const [blob, filename] = (saveAs as unknown as ReturnType<typeof vi.fn>).mock.calls[0];
    expect(blob).toBeInstanceOf(Blob);
    expect(filename).toBe("Full-Demo-Storyboard.docx");
  });

  it("handles storyboard with no items", async () => {
    vi.mocked(saveAs).mockClear();
    const storyboard: Storyboard = {
      title: "Empty Board",
      description: "",
      items: [],
      created_at: "2025-01-01T00:00:00Z",
      updated_at: "2025-01-01T00:00:00Z",
    };

    await exportStoryboardToWord(storyboard, async () => new Map());

    expect(saveAs).toHaveBeenCalledTimes(1);
    const [_, filename] = (saveAs as unknown as ReturnType<typeof vi.fn>).mock.calls[0];
    expect(filename).toBe("Empty-Board.docx");
  });
});
