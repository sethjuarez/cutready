// Binds the generated @vector harness (src/contracts/generated/tests) to the
// frontend's production code. Hand-authored: generation never touches it.
import { parseDurationSeconds } from "../utils/documentMetadata";
import { promoteChatArtifact, roundTripChatArtifact } from "./chatPromotion";
import type { VectorAdapter } from "./generated/tests/vector-runner";

const backendOwnsDocuments =
  "The desktop frontend never decodes, edits, or saves .sk or .sb files; it sends edits " +
  "over IPC to the Rust backend, whose production path runs these vectors in " +
  "crates/cutready-contracts.";

export const vectorAdapters: Record<string, VectorAdapter> = {
  "ChatArtifactDocument.promote": {
    invoke: (input) => {
      const value = input as { session: unknown; request: unknown };
      return promoteChatArtifact(
        value.session as Parameters<typeof promoteChatArtifact>[0],
        value.request as Parameters<typeof promoteChatArtifact>[1],
      );
    },
  },
  "ChatArtifactDocument.roundTrip": {
    invoke: (input) =>
      roundTripChatArtifact(
        (input as { artifact: unknown }).artifact as Parameters<typeof roundTripChatArtifact>[0],
      ),
  },
  "PlanningTiming.parseDurationSeconds": {
    invoke: (input) => parseDurationSeconds((input as { time: string }).time),
  },
};

export const vectorWaivers: Record<string, string> = {
  "SketchDocument.roundTrip": backendOwnsDocuments,
  "SketchDocument.updateRowText": backendOwnsDocuments,
  "SketchDocument.reorderRows": backendOwnsDocuments,
  "StoryboardDocument.roundTrip": backendOwnsDocuments,
  "StoryboardDocument.upgrade": backendOwnsDocuments,
};
