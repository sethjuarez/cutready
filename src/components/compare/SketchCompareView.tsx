import type { SketchComparison, SketchRow, SketchRowDiff } from "../../domain/compare/sketchCompare";
import { displayRowId } from "../../domain/compare/sketchCompare";
import { DiffBadge, TONE_ROW } from "./diffTone";

const COLUMNS = [
  { field: "time", label: "Time", width: "w-20" },
  { field: "narrative", label: "Narrative", width: "" },
  { field: "demo_actions", label: "Actions", width: "" },
  { field: "screenshot", label: "Screenshot", width: "w-36" },
] as const;

const COLUMN_FIELDS = new Set<string>(COLUMNS.map((c) => c.field));

const FIELD_LABELS: Record<string, string> = {
  title: "title",
  description: "description",
  state: "status",
  locked: "lock",
  metadata: "details",
  visual: "visual",
  locks: "cell locks",
  duration_seconds: "duration",
  motion_points: "motion points",
  typing_spots: "typing spots",
  narration_plan: "narration plan",
};

const fieldLabel = (field: string) => FIELD_LABELS[field] ?? field.replace(/_/g, " ");

function cellText(row: SketchRow | null, field: string): string {
  const value = row?.[field];
  if (value === null || value === undefined) return "";
  return typeof value === "string" ? value : JSON.stringify(value);
}

function Cell({ diff, field }: { diff: SketchRowDiff; field: string }) {
  const after = cellText(diff.after, field);
  const before = cellText(diff.before, field);
  if (diff.status === "removed") return <span className="line-through text-text-secondary">{before}</span>;
  if (diff.status !== "changed" || !diff.fields.includes(field)) return <span>{after}</span>;
  return (
    <span className="block rounded-sm bg-warning/15 px-1 -mx-1" data-changed-field={field}>
      {before && <span className="block line-through text-text-secondary">{before}</span>}
      <span className="block">{after || <em className="text-text-tertiary">empty</em>}</span>
    </span>
  );
}

function rowTone(diff: SketchRowDiff) {
  if (diff.status === "added" || diff.status === "removed" || diff.status === "changed") return diff.status;
  return diff.moved ? "moved" : null;
}

/** Planning table with added, removed and per-field changed rows. */
export function SketchCompareView({ comparison }: { comparison: SketchComparison }) {
  const changedRows = comparison.rows.filter((row) => row.status !== "unchanged" || row.moved);
  return (
    <div className="space-y-3">
      {comparison.fields.length > 0 && (
        <p className="text-sm text-text-secondary">
          Sketch {comparison.fields.map(fieldLabel).join(", ")} changed.
        </p>
      )}
      {changedRows.length === 0 && comparison.fields.length === 0 && (
        <p className="text-sm text-text-secondary">No changes to the planning table.</p>
      )}
      <table className="w-full table-fixed border-collapse text-sm" aria-label="Planning table changes">
        <thead>
          <tr className="border-b border-border text-left text-xs text-text-secondary">
            <th scope="col" className="w-24 py-1.5 pr-2 font-medium">Change</th>
            {COLUMNS.map((c) => (
              <th key={c.field} scope="col" className={`${c.width} py-1.5 pr-2 font-medium`}>{c.label}</th>
            ))}
          </tr>
        </thead>
        <tbody>
          {comparison.rows.map((diff) => {
            const tone = rowTone(diff);
            const extra = diff.fields.filter((f) => !COLUMN_FIELDS.has(f));
            return (
              <tr
                key={diff.key}
                className={`border-b border-border-subtle align-top ${tone ? TONE_ROW[tone] : ""}`}
                data-row-status={diff.status}
                data-row-id={displayRowId(diff.key)}
              >
                <td className="py-1.5 pr-2">
                  <div className="flex flex-wrap gap-1">
                    {tone && tone !== "moved" && <DiffBadge tone={tone} />}
                    {diff.moved && <DiffBadge tone="moved" />}
                  </div>
                  {extra.length > 0 && (
                    <div className="mt-1 text-2xs text-text-secondary">Also {extra.map(fieldLabel).join(", ")}</div>
                  )}
                </td>
                {COLUMNS.map((c) => (
                  <td key={c.field} className="whitespace-pre-wrap break-words py-1.5 pr-2">
                    <Cell diff={diff} field={c.field} />
                  </td>
                ))}
              </tr>
            );
          })}
        </tbody>
      </table>
    </div>
  );
}
