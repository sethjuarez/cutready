import { useCallback, useEffect, useState } from "react";
import { Check, Undo2 } from "lucide-react";
import { RunReview } from "../contracts/generated/model/run-review";
import type { DocumentReview } from "../contracts/generated/model/document-review";
import { invoke } from "../services/tauri";
import { flushEditorWrites } from "../stores/appStore";
import { useVersioningStore } from "../stores/versioningStore";
import { useToastStore } from "../stores/toastStore";
import { useConfirmDialog } from "./ConfirmDialog";

/** Agent changes that nobody has kept or undone yet, with Keep and Undo per document. */
export function PendingReviewPanel() {
  const [reviews, setReviews] = useState<RunReview[]>([]);
  const [busyKey, setBusyKey] = useState<string | null>(null);
  const showToast = useToastStore((state) => state.show);
  const { confirm, confirmationDialog } = useConfirmDialog();

  const loadReviews = useCallback(async () => {
    try {
      const raw = await invoke<Record<string, unknown>[]>("list_pending_reviews");
      setReviews(raw.map((review) => RunReview.load(review)));
    } catch {
      setReviews([]);
    }
  }, []);

  useEffect(() => {
    void loadReviews();
    window.addEventListener("cutready:agent-runs-updated", loadReviews);
    return () => window.removeEventListener("cutready:agent-runs-updated", loadReviews);
  }, [loadReviews]);

  const resolve = useCallback(async (run: RunReview, doc: DocumentReview, action: "keep" | "undo") => {
    if (action === "undo" && doc.created) {
      const confirmed = await confirm({
        title: "Undo new document?",
        message: `This run created ${doc.doc}. Undoing removes the file.`,
        confirmLabel: "Remove file",
        variant: "warning",
      });
      if (!confirmed) return;
    }
    setBusyKey(reviewKey(run, doc));
    try {
      const args = { runId: run.run_id, doc: doc.doc, throughSeq: doc.through_seq };
      if (action === "keep") {
        await invoke("keep_run_document", args);
      } else {
        // Unsaved edits must reach disk first so the undo merges against them.
        await flushEditorWrites();
        const store = useVersioningStore.getState();
        await store.replaceFileOnDisk(doc.doc, () => invoke("undo_run_document", args));
        await store.refreshChangedFiles();
      }
    } catch (err) {
      showToast(`Could not ${action} ${doc.doc}: ${String(err)}`, 5000, "error");
    } finally {
      setBusyKey(null);
      await loadReviews();
    }
  }, [confirm, loadReviews, showToast]);

  if (reviews.length === 0) return confirmationDialog;

  return (
    <div className="border-b border-[rgb(var(--color-border))] py-1">
      <div className="px-3 py-1 text-[10px] font-semibold uppercase tracking-[0.14em] text-[rgb(var(--color-text-secondary))]">
        Pending review
      </div>
      {reviews.map((run) => run.documents.map((doc) => {
        const key = reviewKey(run, doc);
        const busy = busyKey === key;
        return (
          <div key={key} className="flex items-center gap-2 px-3 py-1 text-[12px]">
            <div className="min-w-0 flex-1">
              <div className="truncate text-[rgb(var(--color-text))]" title={doc.doc}>{doc.doc}</div>
              <div className="truncate text-[10px] text-[rgb(var(--color-text-secondary))]">
                {run.actor} · {doc.writes} change{doc.writes === 1 ? "" : "s"}{doc.created ? " · new" : ""}
              </div>
            </div>
            <button
              className="flex h-6 w-6 items-center justify-center rounded-md text-[rgb(var(--color-text-secondary))] transition-colors hover:bg-[rgb(var(--color-surface-alt))] hover:text-[rgb(var(--color-text))] disabled:opacity-50"
              onClick={() => void resolve(run, doc, "keep")}
              disabled={busyKey !== null}
              title="Keep these changes"
              aria-label={`Keep changes to ${doc.doc}`}
            >
              <Check className="h-3.5 w-3.5" />
            </button>
            <button
              className="flex h-6 w-6 items-center justify-center rounded-md text-[rgb(var(--color-text-secondary))] transition-colors hover:bg-[rgb(var(--color-surface-alt))] hover:text-[rgb(var(--color-text))] disabled:opacity-50"
              onClick={() => void resolve(run, doc, "undo")}
              disabled={busyKey !== null}
              title="Undo these changes"
              aria-label={`Undo changes to ${doc.doc}`}
            >
              <Undo2 className={`h-3.5 w-3.5 ${busy ? "animate-pulse" : ""}`} />
            </button>
          </div>
        );
      }))}
      {confirmationDialog}
    </div>
  );
}

function reviewKey(run: RunReview, doc: DocumentReview): string {
  return `${run.run_id}:${doc.doc}`;
}

