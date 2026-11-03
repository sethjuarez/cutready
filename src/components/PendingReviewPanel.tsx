import { useCallback, useEffect, useState } from "react";
import { Check, Undo2 } from "lucide-react";
import type { RunReview } from "../contracts/generated/model/run-review";
import type { DocumentReview } from "../contracts/generated/model/document-review";
import { reviewIpc } from "../ipc/review";
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
      setReviews(await reviewIpc.listPendingReviews());
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
        await reviewIpc.keepRunDocument(args);
      } else {
        // Unsaved edits must reach disk first so the undo merges against them.
        await flushEditorWrites();
        const store = useVersioningStore.getState();
        await store.replaceFileOnDisk(doc.doc, () => reviewIpc.undoRunDocument(args));
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
  const pendingCount = reviews.reduce((total, run) => total + run.documents.length, 0);

  return (
    <section className="border-b border-[rgb(var(--color-border-subtle))] py-1.5" aria-labelledby="pending-review-title">
      <h2 id="pending-review-title" className="flex items-center gap-1.5 px-3 py-1 text-xs font-semibold text-[rgb(var(--color-text-secondary))]">
        Pending review{" "}
        <span aria-hidden="true" className="rounded-pill bg-[rgb(var(--color-accent))]/10 px-1.5 font-medium tabular-nums text-[rgb(var(--color-accent-hover))]">
          {pendingCount}
        </span>
        <span className="sr-only">{`${pendingCount} ${pendingCount === 1 ? "document" : "documents"}`}</span>
      </h2>
      {reviews.map((run) => run.documents.map((doc) => {
        const key = reviewKey(run, doc);
        const busy = busyKey === key;
        return (
          <div key={key} className="flex items-center gap-1 px-3 py-1">
            <div className="min-w-0 flex-1">
              <div className="truncate text-sm text-[rgb(var(--color-text))]" title={doc.doc}>{doc.doc}</div>
              <div className="truncate text-xs text-[rgb(var(--color-text-secondary))]">
                {run.actor} · {doc.writes} change{doc.writes === 1 ? "" : "s"}{doc.created ? " · new" : ""}
              </div>
            </div>
            <button
              className="flex h-7 w-7 items-center justify-center rounded-control text-[rgb(var(--color-text-secondary))] transition-colors duration-fast ease-fluent hover:bg-fill-hover hover:text-[rgb(var(--color-text))] disabled:opacity-50"
              onClick={() => void resolve(run, doc, "keep")}
              disabled={busyKey !== null}
              title="Keep these changes"
              aria-label={`Keep changes to ${doc.doc}`}
            >
              <Check aria-hidden="true" className="h-4 w-4" />
            </button>
            <button
              className="flex h-7 w-7 items-center justify-center rounded-control text-[rgb(var(--color-text-secondary))] transition-colors duration-fast ease-fluent hover:bg-fill-hover hover:text-[rgb(var(--color-text))] disabled:opacity-50"
              onClick={() => void resolve(run, doc, "undo")}
              disabled={busyKey !== null}
              title="Undo these changes"
              aria-label={`Undo changes to ${doc.doc}`}
            >
              <Undo2 aria-hidden="true" className={`h-4 w-4 ${busy ? "animate-pulse" : ""}`} />
            </button>
          </div>
        );
      }))}
      {confirmationDialog}
    </section>
  );
}

function reviewKey(run: RunReview, doc: DocumentReview): string {
  return `${run.run_id}:${doc.doc}`;
}

