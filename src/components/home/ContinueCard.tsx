// "Continue where you left off": the open project's most recently edited document.
import { useEffect, useState } from "react";
import { FileText, LayoutList, PenLine } from "lucide-react";
import { useAppStore } from "../../stores/appStore";
import { documentsIpc } from "../../ipc/documents";
import { useProjectImage } from "../../hooks/useProjectImage";
import { formatDuration, summarizeSketchDuration } from "../../utils/documentMetadata";
import { formatRelativeDate } from "../../utils/relativeDate";
import { lastEditedDocument, sketchPlacement, type LastEdited } from "../../utils/home";
import type { Sketch, Storyboard } from "../../types/sketch";
import { primaryButton } from "./NewWorkspaceForms";

interface SketchDetails {
  screenshot: string | null;
  durationSeconds: number;
  placement: string | null;
}

/** Reads the sketch for its thumbnail and duration, and finds the storyboard that uses it. */
function useSketchDetails(doc: LastEdited | null): SketchDetails | null {
  const storyboards = useAppStore((s) => s.storyboards);
  const [details, setDetails] = useState<SketchDetails | null>(null);
  const sketchPath = doc?.kind === "sketch" ? doc.path : null;

  useEffect(() => {
    setDetails(null);
    if (!sketchPath) return;
    let cancelled = false;
    void (async () => {
      try {
        const sketch = (await documentsIpc.read<Sketch>("sketch", sketchPath)).document;
        let placement: string | null = null;
        for (const summary of storyboards) {
          try {
            const storyboard = (await documentsIpc.read<Storyboard>("storyboard", summary.path)).document;
            const found = sketchPlacement(storyboard, sketchPath);
            if (found) {
              placement = found.section ? `${storyboard.title} · ${found.section}` : storyboard.title;
              break;
            }
          } catch { /* skip unreadable storyboards */ }
        }
        if (cancelled) return;
        setDetails({
          screenshot: sketch.rows.find((row) => row.screenshot)?.screenshot ?? null,
          durationSeconds: summarizeSketchDuration(sketch.rows).knownSeconds,
          placement,
        });
      } catch {
        if (!cancelled) setDetails(null);
      }
    })();
    return () => { cancelled = true; };
  }, [sketchPath, storyboards]);

  return details;
}

const KIND_LABEL = { sketch: "Sketch", storyboard: "Storyboard", note: "Note" } as const;
const KIND_ICON = { sketch: PenLine, storyboard: LayoutList, note: FileText } as const;

function Chip({ children }: { children: string }) {
  return (
    <span className="rounded-pill border border-[rgb(var(--color-border-subtle))] px-2 py-0.5 text-xs text-[rgb(var(--color-text-secondary))]">
      {children}
    </span>
  );
}

export function ContinueCard() {
  const project = useAppStore((s) => s.currentProject);
  const sketches = useAppStore((s) => s.sketches);
  const storyboards = useAppStore((s) => s.storyboards);
  const notes = useAppStore((s) => s.notes);
  const doc = project ? lastEditedDocument(sketches, storyboards, notes) : null;
  const details = useSketchDetails(doc);
  const thumbnail = useProjectImage(project?.root ?? null, details?.screenshot);

  if (!doc) return null;

  const open = () => {
    const app = useAppStore.getState();
    if (doc.kind === "sketch") void app.openSketch(doc.path);
    else if (doc.kind === "storyboard") void app.openStoryboard(doc.path);
    else void app.openNote(doc.path);
  };

  const Icon = KIND_ICON[doc.kind];
  const chips: string[] = [];
  if (doc.kind === "sketch") {
    chips.push(`${doc.row_count} row${doc.row_count === 1 ? "" : "s"}`);
    if (details && details.durationSeconds > 0) chips.push(formatDuration(details.durationSeconds));
  } else if (doc.kind === "storyboard") {
    chips.push(`${doc.sketch_count} sketch${doc.sketch_count === 1 ? "" : "es"}`);
  }
  const where = doc.kind === "sketch" && details?.placement ? details.placement : KIND_LABEL[doc.kind];

  return (
    <section aria-labelledby="home-continue-heading" className="mt-8">
      <h2 id="home-continue-heading" className="mb-2.5 text-sm font-semibold">Continue where you left off</h2>
      <div
        data-testid="home-continue"
        className="flex items-center gap-[18px] rounded-card border border-[rgb(var(--color-border-subtle))] bg-[rgb(var(--color-surface))] px-4 py-3 shadow-layer"
      >
        <div className="grid aspect-[16/10] w-[176px] shrink-0 place-items-center overflow-hidden rounded-control border border-[rgb(var(--color-border-subtle))] bg-[rgb(var(--color-surface-alt))]">
          {thumbnail ? (
            <img src={thumbnail} alt="" className="h-full w-full object-cover" draggable={false} />
          ) : (
            <Icon aria-hidden="true" className="h-7 w-7 text-[rgb(var(--color-text-tertiary))]" />
          )}
        </div>
        <div className="min-w-0 flex-1">
          <p className="truncate text-xl font-semibold" title={doc.title}>{doc.title}</p>
          <p className="mt-0.5 truncate text-sm text-[rgb(var(--color-text-secondary))]">
            {where} · edited {formatRelativeDate(doc.updated_at)}
          </p>
          {chips.length > 0 && (
            <div className="mt-2 flex flex-wrap gap-1.5">
              {chips.map((chip) => <Chip key={chip}>{chip}</Chip>)}
            </div>
          )}
        </div>
        <button type="button" onClick={open} className={primaryButton} aria-label={`Open ${doc.title}`}>
          Open
        </button>
      </div>
    </section>
  );
}
