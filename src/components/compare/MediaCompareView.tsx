import type { ImageSide } from "../../services/versionCompare";

function Side({ side, label }: { side: ImageSide; label: string }) {
  return (
    <figure className="flex min-w-0 flex-col gap-1.5">
      <figcaption className="text-xs font-medium text-text-secondary">{label}</figcaption>
      <div className="flex min-h-[10rem] items-center justify-center rounded-card border border-border bg-surface-inset p-2">
        {side.state === "ready" ? (
          <img src={side.src} alt={label} className="max-h-[60vh] max-w-full object-contain" />
        ) : (
          <span className="text-sm text-text-secondary">
            {side.state === "absent" ? "Not in this version" : side.reason}
          </span>
        )}
      </div>
    </figure>
  );
}

/** Before and after images side by side. */
export function MediaCompareView({ before, after, beforeLabel, afterLabel }: { before: ImageSide; after: ImageSide; beforeLabel: string; afterLabel: string }) {
  return (
    <div className="grid grid-cols-2 gap-3">
      <Side side={before} label={beforeLabel} />
      <Side side={after} label={afterLabel} />
    </div>
  );
}
