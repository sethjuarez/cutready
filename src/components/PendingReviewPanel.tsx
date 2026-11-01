import { useCallback, useEffect, useState } from "react";
import { Check, Undo2 } from "lucide-react";
import { RunReview } from "../contracts/generated/model/run-review";
import type { DocumentReview } from "../contracts/generated/model/document-review";
import { invoke } from "../services/tauri";
import { clearSuppressedEditorFlush, suppressEditorFlush, useAppStore } from "../stores/appStore";
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
      await invoke(action === "keep" ? "keep_run_document" : "undo_run_document", {
        runId: run.run_id,
        doc: doc.doc,
        throughSeq: doc.through_seq,
      });
      if (action === "undo") await refreshAfterUndo(doc);
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

/** Undo rewrote or removed `doc` on disk: reload the sidebar and any open copy. */
async function refreshAfterUndo(doc: DocumentReview) {
  const store = useAppStore.getState();
  const path = doc.doc;
  if (doc.created) {
    store.openTabs.filter((tab) => tab.path === path).forEach((tab) => store.closeTab(tab.id));
  }
  const reloadOpen = async (activePath: string | null, open: (path: string) => Promise<void>) => {
    if (doc.created || activePath !== path) return;
    suppressEditorFlush(path);
    try {
      await open(path);
    } finally {
      globalThis.setTimeout(() => clearSuppressedEditorFlush(path), 100);
    }
  };
  if (path.endsWith(".sk")) {
    await store.loadSketches();
    await reloadOpen(store.activeSketchPath, store.openSketch);
  } else if (path.endsWith(".sb")) {
    await store.loadStoryboards();
    await reloadOpen(store.activeStoryboardPath, store.openStoryboard);
  } else if (path.endsWith(".md")) {
    await store.loadNotes();
    await reloadOpen(store.activeNotePath, store.openNote);
  }
  await store.checkDirty();
  await store.refreshChangedFiles();
}
