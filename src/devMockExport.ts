// Web-shim fixtures for document and video export commands.
type Args = Record<string, unknown> | undefined;
type SendProgress = (args: Args, progress: Record<string, unknown>) => void;

const VIDEO_PROGRESS = [
  { phase: "title", current: 1, message: "Rendering sketch title card" },
  { phase: "lead-in", current: 2, message: "Holding the first screen for 0.5 seconds" },
  { phase: "row", current: 3, message: "Rendering row 1 of 3" },
  { phase: "gap", current: 4, message: "Holding row 1 for 0.5s, then row 2 for 0.5s" },
  { phase: "hold", current: 6, message: "Holding the final screen for 3 seconds" },
  { phase: "assembling", current: 7, message: "Assembling the MP4" },
];

function mockResolvedDemoInspection(args: Args) {
  const rowCount = typeof args?.rowCount === "number" ? args.rowCount : 3;
  return {
    schemaVersion: "scenecast.resolved-demo.v1",
    title: "Mock resolved demo",
    canExport: true,
    blockingError: null,
    diagnosticCount: 0,
    rowCount,
    rows: Array.from({ length: rowCount }, (_, index) => ({
      rowNumber: index + 1,
      stepCount: 1,
      segmentCount: 1,
      durationSeconds: 2.5,
      mediaAssetCount: 1,
      missingAssetCount: 0,
      invalidAssetCount: 0,
      steps: [{
        id: `mock-step-${index + 1}`,
        title: `Mock row ${index + 1}`,
        description: null,
        targetLabels: ["Continue"],
        guideMarkLabels: [],
        segmentKinds: ["scene"],
      }],
    })),
    diagnostics: [],
  };
}

const handlers: Record<string, (args: Args, sendProgress: SendProgress) => unknown> = {
  export_markdown_to_word: () => ({ imagesEmbedded: 0, skippedRemoteImages: [] }),
  inspect_resolved_demo: (args) => mockResolvedDemoInspection(args),
  export_sketch_video: (args, sendProgress) => {
    for (const step of VIDEO_PROGRESS) sendProgress(args, { ...step, total: 7 });
    return {
      path: typeof args?.outputPath === "string"
        ? args.outputPath
        : "exports/demo-introduction-20250115-120000.mp4",
      duration_seconds: 12,
      row_count: 3,
    };
  },
};

export function isExportMockCommand(cmd: string): boolean {
  return cmd in handlers;
}

export function mockExportInvoke(cmd: string, args: Args, sendProgress: SendProgress): unknown {
  return handlers[cmd](args, sendProgress);
}