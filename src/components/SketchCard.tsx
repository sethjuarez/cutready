import type { SketchSummary } from "../types/sketch";
import { DocumentIcon, XMarkIcon } from "@heroicons/react/24/outline";

interface SketchCardProps {
  sketch: SketchSummary;
  onOpen: () => void;
  onRemove?: () => void;
}

const stateLabels: Record<string, string> = {
  draft: "Draft",
  recording_enriched: "Recording",
  refined: "Refined",
  final: "Final",
};

export function SketchCard({ sketch, onOpen, onRemove }: SketchCardProps) {
  return (
    <div
      onClick={onOpen}
      className="group relative flex items-start gap-3 px-4 py-3 rounded-xl border border-[rgb(var(--color-border))] bg-[rgb(var(--color-surface))] hover:border-[rgb(var(--color-accent))]/40 cursor-pointer transition-colors"
    >
      {/* Icon */}
      <div className="mt-0.5 text-[rgb(var(--color-text-secondary))]">
        <DocumentIcon className="w-4 h-4" />
      </div>

      {/* Content */}
      <div className="flex-1 min-w-0">
        <div className="text-sm font-medium truncate">{sketch.title}</div>
        <div className="flex items-center gap-2 mt-1">
          <span className="text-[10px] text-[rgb(var(--color-text-secondary))]">
            {sketch.row_count} {sketch.row_count === 1 ? "row" : "rows"}
          </span>
          <span className="text-[10px] px-1.5 py-0.5 rounded-full bg-[rgb(var(--color-accent))]/10 text-[rgb(var(--color-accent))]">
            {stateLabels[sketch.state] ?? sketch.state}
          </span>
        </div>
      </div>

      {/* Remove button (in storyboard context) */}
      {onRemove && (
        <button
          onClick={(e) => { e.stopPropagation(); onRemove(); }}
          className="opacity-0 group-hover:opacity-100 p-1 rounded text-[rgb(var(--color-text-secondary))] hover:text-[rgb(var(--color-text))] transition-all"
          title="Remove from storyboard"
        >
          <XMarkIcon className="w-3 h-3" />
        </button>
      )}
    </div>
  );
}

/** Compact sketch card used in the picker. */
export function SketchPickerItem({
  sketch,
  onSelect,
}: {
  sketch: SketchSummary;
  onSelect: () => void;
}) {
  return (
    <button
      onClick={onSelect}
      className="w-full flex items-center gap-2 px-3 py-2 text-left rounded-lg hover:bg-[rgb(var(--color-surface-alt))] transition-colors"
    >
      <DocumentIcon className="w-3.5 h-3.5 text-[rgb(var(--color-text-secondary))] shrink-0" />
      <span className="text-xs truncate">{sketch.title}</span>
      <span className="text-[10px] text-[rgb(var(--color-text-secondary))] ml-auto shrink-0">
        {sketch.row_count} rows
      </span>
    </button>
  );
}
