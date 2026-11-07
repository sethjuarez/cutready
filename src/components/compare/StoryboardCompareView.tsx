import type { StoryboardComparison, StoryboardSketchDiff } from "../../domain/compare/storyboardCompare";
import { DiffBadge, TONE_ROW, type DiffTone } from "./diffTone";

const sketchName = (path: string) => path.split("/").pop()?.replace(/\.sk$/, "") || path;

function tone(status: StoryboardSketchDiff["status"], moved: boolean): DiffTone | null {
  if (status === "added" || status === "removed") return status;
  return moved ? "moved" : null;
}

function Badges({ status, moved, edited }: { status: StoryboardSketchDiff["status"]; moved: boolean; edited?: boolean }) {
  const t = tone(status, moved);
  return (
    <span className="flex gap-1">
      {t && <DiffBadge tone={t} />}
      {edited && <DiffBadge tone="changed" label="Edited" />}
    </span>
  );
}

function SketchLine({ sketch }: { sketch: StoryboardSketchDiff }) {
  const t = tone(sketch.status, sketch.moved);
  return (
    <li
      className={`flex items-center justify-between gap-2 rounded px-2 py-1 ${t ? TONE_ROW[t] : ""}`}
      data-entry-status={sketch.status}
      data-moved={sketch.moved || undefined}
    >
      <span className={`truncate ${sketch.status === "removed" ? "line-through" : ""}`} title={sketch.path}>{sketchName(sketch.path)}</span>
      <Badges status={sketch.status} moved={sketch.moved} />
    </li>
  );
}

/** Sections and sketch references added, removed or moved. */
export function StoryboardCompareView({ comparison }: { comparison: StoryboardComparison }) {
  const changed = comparison.fields.length > 0 || comparison.entries.some((entry) =>
    entry.status !== "unchanged" || entry.moved || (entry.kind === "section" && (entry.edited || entry.sketches.some((s) => s.status !== "unchanged" || s.moved))));
  return (
    <div className="space-y-2 text-sm">
      {comparison.fields.length > 0 && (
        <p className="text-text-secondary">Storyboard {comparison.fields.join(", ")} changed.</p>
      )}
      {!changed && <p className="text-text-secondary">No changes to the storyboard's order.</p>}
      <ul className="space-y-1" aria-label="Storyboard changes">
        {comparison.entries.map((entry) => entry.kind === "sketch" ? (
          <SketchLine key={entry.key} sketch={entry} />
        ) : (
          <li key={entry.key} className="rounded border border-border-subtle" data-entry-status={entry.status}>
            <div className={`flex items-center justify-between gap-2 px-2 py-1 font-medium ${(() => { const t = tone(entry.status, entry.moved); return t ? TONE_ROW[t] : ""; })()}`}>
              <span className={`truncate ${entry.status === "removed" ? "line-through" : ""}`}>{entry.title || "Untitled section"}</span>
              <Badges status={entry.status} moved={entry.moved} edited={entry.edited} />
            </div>
            {entry.sketches.length > 0 && (
              <ul className="space-y-0.5 py-1 pl-4 pr-1">
                {entry.sketches.map((sketch) => <SketchLine key={sketch.key} sketch={sketch} />)}
              </ul>
            )}
          </li>
        ))}
      </ul>
    </div>
  );
}
