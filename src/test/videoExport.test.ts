import { describe, expect, it } from "vitest";
import type { PlanningRow } from "../types/sketch";
import {
  emptyVideoExportOptions,
  getVideoExportIssues,
  normalizeVideoExportOptions,
  selectedFileToProjectRelativePath,
} from "../utils/videoExport";

function row(overrides: Partial<PlanningRow> = {}): PlanningRow {
  return {
    time: "0:05",
    narrative: "Narration",
    demo_actions: "Click through the demo",
    screenshot: "screenshots/home.png",
    narration: {
      path: "narration/row-1.wav",
      source_text: "Narration",
      source_text_hash: "hash",
      mime_type: "audio/wav",
      duration_ms: 5_000,
      byte_size: 1024,
      recorded_at: "2026-01-01T00:00:00.000Z",
    },
    ...overrides,
  };
}

describe("video export utilities", () => {
  it("requires at least one row", () => {
    expect(getVideoExportIssues([])).toEqual([{ rowNumber: 0, missing: ["at least one row"] }]);
  });

  it("accepts a visual frame manifest instead of a screenshot", () => {
    const issues = getVideoExportIssues(
      [row({ screenshot: null })],
      { resolvedDemoPath: null, generateResolvedDemo: false, visualFrameManifestPaths: [".cutready/visuals/row-1/frames.json"] },
    );

    expect(issues).toEqual([]);
  });

  it("accepts an attached visual without a pre-rendered frame manifest", () => {
    const issues = getVideoExportIssues(
      [row({ screenshot: null, visual: ".cutready/visuals/intro.json" })],
      { resolvedDemoPath: null, generateResolvedDemo: false, visualFrameManifestPaths: [] },
    );

    expect(issues).toEqual([]);
  });

  it("rejects unsafe or blank attached visual paths", () => {
    expect(getVideoExportIssues(
      [row({ screenshot: null, visual: "C:\\outside\\visual.json" })],
      { resolvedDemoPath: null, generateResolvedDemo: false, visualFrameManifestPaths: [] },
    )).toEqual([{
      rowNumber: 1,
      missing: ["project-relative visual path"],
    }]);

    expect(getVideoExportIssues(
      [row({ screenshot: null, visual: "   " })],
      { resolvedDemoPath: null, generateResolvedDemo: false, visualFrameManifestPaths: [] },
    )).toEqual([{
      rowNumber: 1,
      missing: ["screenshot, visual, visual frame manifest, or resolved demo media"],
    }]);
  });

  it("accepts a provided resolved demo as a media source", () => {
    expect(getVideoExportIssues(
      [row({ screenshot: null, visual: null })],
      {
        resolvedDemoPath: ".cutready/scenecast/resolved-demo.json",
        generateResolvedDemo: false,
        visualFrameManifestPaths: [],
      },
    )).toEqual([]);
  });

  it("does not treat resolved demo media as available for overlay rows", () => {
    expect(getVideoExportIssues(
      [row({ screenshot: null, visual: null, typing_spots: [{
        x: 0.2,
        y: 0.2,
        width: 0.4,
        height: 0.1,
        text: "Overlay",
      }] })],
      {
        resolvedDemoPath: ".cutready/scenecast/resolved-demo.json",
        generateResolvedDemo: false,
        visualFrameManifestPaths: [],
      },
    )).toEqual([{
      rowNumber: 1,
      missing: ["screenshot, visual, visual frame manifest, or resolved demo media"],
    }]);
  });

  it("does not treat resolved demo media as available for motion rows", () => {
    expect(getVideoExportIssues(
      [row({ screenshot: null, visual: null, motion_plan: {
        kind: "subtle_push",
        keyframes: [],
      } })],
      {
        resolvedDemoPath: ".cutready/scenecast/resolved-demo.json",
        generateResolvedDemo: false,
        visualFrameManifestPaths: [],
      },
    )).toEqual([{
      rowNumber: 1,
      missing: ["screenshot, visual, visual frame manifest, or resolved demo media"],
    }]);
  });

  it("still requires narration when a row uses a visual frame manifest", () => {
    const issues = getVideoExportIssues(
      [row({ screenshot: null, narration: null })],
      { resolvedDemoPath: null, generateResolvedDemo: false, visualFrameManifestPaths: [".cutready/visuals/row-1/frames.json"] },
    );

    expect(issues).toEqual([{ rowNumber: 1, missing: ["narration"] }]);
  });

  it("rejects unsafe typed artifact paths before export starts", () => {
    expect(getVideoExportIssues(
      [row()],
      { resolvedDemoPath: "C:\\outside\\resolved-demo.json", generateResolvedDemo: false, visualFrameManifestPaths: [] },
    )).toEqual([{ rowNumber: 0, missing: ["project-relative Scenecast resolved demo path"] }]);

    expect(getVideoExportIssues(
      [row({ screenshot: null })],
      { resolvedDemoPath: null, generateResolvedDemo: false, visualFrameManifestPaths: ["../outside/frames.json"] },
    )).toEqual([{
      rowNumber: 1,
      missing: [
        "project-relative visual frame manifest path",
      ],
    }]);
  });

  it("rejects rows that combine visual frame manifests with screenshot motion overlays", () => {
    expect(getVideoExportIssues(
      [row({ motion_plan: { kind: "subtle_push", keyframes: [] } })],
      { resolvedDemoPath: null, generateResolvedDemo: false, visualFrameManifestPaths: [".cutready/visuals/row-1/frames.json"] },
    )).toEqual([{
      rowNumber: 1,
      missing: ["row without typing spots or motion plan when using a visual frame manifest"],
    }]);
  });

  it("rejects automatically rendered visual rows with screenshot motion overlays", () => {
    expect(getVideoExportIssues(
      [row({
        screenshot: null,
        visual: ".cutready/visuals/intro.json",
        motion_plan: { kind: "subtle_push", keyframes: [] },
      })],
      { resolvedDemoPath: null, generateResolvedDemo: false, visualFrameManifestPaths: [] },
    )).toEqual([{
      rowNumber: 1,
      missing: ["visual row without typing spots or motion plan"],
    }]);
  });

  it("normalizes optional paths to backend-friendly nulls and row count", () => {
    expect(normalizeVideoExportOptions({
      resolvedDemoPath: "  .cutready/scenecast/resolved-demo.json  ",
      generateResolvedDemo: true,
      visualFrameManifestPaths: [" frames/one.json ", "", " frames/extra.json "],
    }, 2)).toEqual({
      resolvedDemoPath: ".cutready/scenecast/resolved-demo.json",
      generateResolvedDemo: true,
      visualFrameManifestPaths: ["frames/one.json", null],
    });

    expect(emptyVideoExportOptions(2)).toEqual({
      resolvedDemoPath: null,
      generateResolvedDemo: false,
      visualFrameManifestPaths: [null, null],
    });
  });

  it("requires screenshots for generated Scenecast resolved demos", () => {
    expect(getVideoExportIssues(
      [row({ screenshot: null })],
      { resolvedDemoPath: null, generateResolvedDemo: true, visualFrameManifestPaths: [".cutready/visuals/row-1/frames.json"] },
    )).toEqual([{
      rowNumber: 1,
      missing: ["screenshot for generated Scenecast resolved demo"],
    }]);

    expect(getVideoExportIssues(
      [row({ screenshot: null })],
      { resolvedDemoPath: ".cutready/scenecast/resolved-demo.json", generateResolvedDemo: true, visualFrameManifestPaths: [".cutready/visuals/row-1/frames.json"] },
    )).toEqual([]);
  });

  it("converts selected files under the project root to project-relative paths", () => {
    expect(selectedFileToProjectRelativePath(
      "C:\\projects\\demo",
      "C:\\projects\\demo\\.cutready\\visuals\\row-1\\frames.json",
    )).toBe(".cutready/visuals/row-1/frames.json");

    expect(selectedFileToProjectRelativePath(
      "/Users/seth/projects/demo",
      "/Users/seth/projects/demo/.cutready/visuals/row-1/frames.json",
    )).toBe(".cutready/visuals/row-1/frames.json");

    expect(selectedFileToProjectRelativePath(
      "C:\\projects\\demo",
      "C:/projects//demo/.cutready/visuals/row-1/frames.json",
    )).toBe(".cutready/visuals/row-1/frames.json");
  });

  it("rejects selected files outside the project root", () => {
    expect(selectedFileToProjectRelativePath(
      "C:\\projects\\demo",
      "C:\\projects\\other\\frames.json",
    )).toBeNull();

    expect(selectedFileToProjectRelativePath(
      "C:\\projects\\demo",
      "C:\\projects\\demo2\\frames.json",
    )).toBeNull();
  });
});
