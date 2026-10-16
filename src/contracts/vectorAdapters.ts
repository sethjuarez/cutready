// Binds the generated @vector harness (src/contracts/generated/tests) to the
// frontend's production code. Hand-authored: generation never touches it.
import { parseDurationSeconds } from "../utils/documentMetadata";
import type { VectorAdapter } from "./generated/tests/vector-runner";

const backendOwnsDocuments =
  "The desktop frontend never decodes, edits, or saves .sk files; it sends edits " +
  "over IPC to the Rust backend, whose production path runs these vectors in " +
  "crates/cutready-contracts.";

export const vectorAdapters: Record<string, VectorAdapter> = {
  "PlanningTiming.parseDurationSeconds": {
    invoke: (input) => parseDurationSeconds((input as { time: string }).time),
  },
};

export const vectorWaivers: Record<string, string> = {
  "SketchDocument.roundTrip": backendOwnsDocuments,
  "SketchDocument.updateRowText": backendOwnsDocuments,
  "SketchDocument.reorderRows": backendOwnsDocuments,
};
