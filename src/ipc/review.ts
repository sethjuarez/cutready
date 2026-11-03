// Typed calls for reviewing agent changes (Keep / Undo per run document).
import { invoke } from "../services/tauri";
import { RunReview } from "../contracts/generated/model/run-review";

export interface RunDocumentArgs {
  runId: string;
  doc: string;
  throughSeq: number;
}

export const reviewIpc = {
  listPendingReviews: async () => {
    const raw = await invoke<Record<string, unknown>[]>("list_pending_reviews");
    return raw.map((review) => RunReview.load(review));
  },
  keepRunDocument: (args: RunDocumentArgs) => invoke<void>("keep_run_document", { ...args }),
  undoRunDocument: (args: RunDocumentArgs) => invoke<void>("undo_run_document", { ...args }),
};