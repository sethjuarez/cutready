import type { SketchSummary } from "../types/sketch";

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
      className="group relative flex items-start gap-3 px-4 py-3 rounded-xl border border-[var(--color-border)] bg-[var(--color-surface)] hover:border-[var(--color-accent)]/40 cursor-pointer transition-colors"
    >
      {/* Icon */}
      <div className="mt-0.5 text-[var(--color-text-secondary)]">
        <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
          <path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z" />
          <polyline points="14 2 14 8 20 8" />
        </svg>
      </div>

      {/* Content */}
      <div className="flex-1 min-w-0">
        <div className="text-sm font-medium truncate">{sketch.title}</div>
        <div className="flex items-center gap-2 mt-1">
          <span className="text-[10px] text-[var(--color-text-secondary)]">
            {sketch.row_count} {sketch.row_count === 1 ? "row" : "rows"}
          </span>
          <span className="text-[10px] px-1.5 py-0.5 rounded-full bg-[var(--color-accent)]/10 text-[var(--color-accent)]">
            {stateLabels[sketch.state] ?? sketch.state}
          </span>
        </div>
      </div>

      {/* Remove button (in storyboard context) */}
      {onRemove && (
        <button
          onClick={(e) => { e.stopPropagation(); onRemove(); }}
          className="opacity-0 group-hover:opacity-100 p-1 rounded text-[var(--color-text-secondary)] hover:text-[var(--color-text)] transition-all"
          title="Remove from storyboard"
        >
          <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
            <line x1="18" y1="6" x2="6" y2="18" />
            <line x1="6" y1="6" x2="18" y2="18" />
          </svg>
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
      className="w-full flex items-center gap-2 px-3 py-2 text-left rounded-lg hover:bg-[var(--color-surface-alt)] transition-colors"
    >
      <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" className="text-[var(--color-text-secondary)] shrink-0">
        <path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z" />
        <polyline points="14 2 14 8 20 8" />
      </svg>
      <span className="text-xs truncate">{sketch.title}</span>
      <span className="text-[10px] text-[var(--color-text-secondary)] ml-auto shrink-0">
        {sketch.row_count} rows
      </span>
    </button>
  );
}
