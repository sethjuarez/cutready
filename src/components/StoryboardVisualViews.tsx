import { FileText, Image as ImageIcon, Mic2, Plus, Trash2 } from "lucide-react";
import type { Sketch, SketchSummary, StoryboardItem } from "../types/sketch";
import { ProjectImage } from "./ProjectImage";
import VisualCell from "./VisualCell";
import { formatDurationSummary, summarizeSketchDuration, summarizeSketchPathsDuration, type DurationDisplayMode } from "../utils/documentMetadata";

function firstSketchMedia(sketch?: Sketch) {
  return sketch?.rows.find((row) => row.visual || row.screenshot) ?? null;
}

function StoryboardMedia({
  sketch,
  projectRoot,
  className = "",
  imageClassName = "h-full w-full object-contain",
}: {
  sketch?: Sketch;
  projectRoot?: string | null;
  className?: string;
  imageClassName?: string;
}) {
  const media = firstSketchMedia(sketch);
  const mediaClass = `min-h-[150px] overflow-hidden rounded-xl border border-[rgb(var(--color-border))] bg-[rgb(var(--color-surface-alt))] ${className}`;

  if (media?.visual) {
    return (
      <div className={mediaClass}>
        <VisualCell visualPath={media.visual} mode="thumbnail" className="!h-full !w-full !rounded-none !border-0" />
      </div>
    );
  }

  if (media?.screenshot) {
    return (
      <div className={mediaClass}>
        <ProjectImage
          relativePath={media.screenshot}
          projectRoot={projectRoot}
          alt=""
          className={imageClassName}
        />
      </div>
    );
  }

  return (
    <div className={`${mediaClass} flex flex-col items-center justify-center gap-2 text-[rgb(var(--color-text-secondary))]`}>
      <ImageIcon className="h-5 w-5" />
      <span className="text-xs">No media yet</span>
    </div>
  );
}

function sketchTitle(path: string, sketchMap: Map<string, SketchSummary>): string {
  return sketchMap.get(path)?.title ?? path;
}

function narrationCount(sketch?: Sketch): number {
  return sketch?.rows.filter((row) => row.narration?.path).length ?? 0;
}

function SketchSummaryCard({
  path,
  sketchMap,
  sketchCache,
  projectRoot,
  durationDisplayMode,
  onOpen,
  compact = false,
  locked = false,
  onRemove,
}: {
  path: string;
  sketchMap: Map<string, SketchSummary>;
  sketchCache: Map<string, Sketch>;
  projectRoot?: string | null;
  durationDisplayMode: DurationDisplayMode;
  onOpen: (path: string) => void;
  compact?: boolean;
  locked?: boolean;
  onRemove?: () => void;
}) {
  const summary = sketchMap.get(path);
  const fullSketch = sketchCache.get(path);
  const duration = fullSketch ? formatDurationSummary(summarizeSketchDuration(fullSketch.rows), durationDisplayMode) : null;
  const firstText = fullSketch?.rows.find((row) => row.narrative.trim() || row.demo_actions.trim());
  const narratedRows = narrationCount(fullSketch);

  return (
    <div
      className={`group block w-full overflow-hidden rounded-2xl border border-[rgb(var(--color-border-subtle))] bg-[rgb(var(--color-surface))]/45 text-left shadow-sm transition-colors hover:border-[rgb(var(--color-accent))]/45 ${
        compact ? "" : "md:grid md:grid-cols-[minmax(220px,0.9fr)_minmax(0,1fr)]"
      }`}
    >
      <StoryboardMedia
        sketch={fullSketch}
        projectRoot={projectRoot}
        className={compact ? "aspect-video min-h-0 rounded-none border-0 md:min-h-[260px]" : "m-3"}
        imageClassName="h-full w-full object-contain"
      />
      <div className="space-y-2 p-3">
        <div className="flex items-center justify-between gap-2">
          <div className="flex flex-wrap items-center gap-2">
            <span className="inline-flex items-center gap-1.5 text-[10px] font-semibold uppercase tracking-[0.2em] text-[rgb(var(--color-text-secondary))]/70">
              <FileText className="h-3 w-3" />
              {summary?.row_count ?? fullSketch?.rows.length ?? 0} rows
            </span>
            {narratedRows > 0 && (
              <span className="inline-flex items-center gap-1 rounded-full border border-[rgb(var(--color-border))] bg-[rgb(var(--color-surface-alt))] px-2 py-0.5 text-[10px] font-medium text-[rgb(var(--color-text-secondary))]">
                <Mic2 className="h-3 w-3 text-[rgb(var(--color-accent))]" />
                {narratedRows} narrated
              </span>
            )}
          </div>
          <div className="flex shrink-0 items-center gap-1">
            {duration && (
              <span className="rounded-full border border-[rgb(var(--color-border))] bg-[rgb(var(--color-surface-alt))] px-2 py-0.5 text-[10px] font-medium text-[rgb(var(--color-text-secondary))]">
                {duration}
              </span>
            )}
            {!locked && onRemove && (
              <button
                type="button"
                onClick={onRemove}
                className="rounded-full p-1 text-[rgb(var(--color-text-secondary))] opacity-0 transition-all hover:bg-error/10 hover:text-error group-hover:opacity-100 focus-visible:opacity-100"
                title="Remove from storyboard"
                aria-label={`Remove ${summary?.title ?? path} from storyboard`}
              >
                <Trash2 className="h-3.5 w-3.5" />
              </button>
            )}
          </div>
        </div>
        <button
          type="button"
          onClick={() => onOpen(path)}
          className="text-left text-base font-semibold text-[rgb(var(--color-text))] transition-colors hover:text-[rgb(var(--color-accent))]"
        >
          {summary?.title ?? path}
        </button>
        <p className="line-clamp-3 text-sm leading-6 text-[rgb(var(--color-text-secondary))]">
          {firstText?.narrative || firstText?.demo_actions || "Open this sketch to add narrative, actions, screenshots, and visuals."}
        </p>
      </div>
    </div>
  );
}

function StoryboardActionBar({
  locked,
  onAddNewSketch,
  onPickExisting,
  onAddSection,
}: {
  locked?: boolean;
  onAddNewSketch?: () => void;
  onPickExisting?: () => void;
  onAddSection?: () => void;
}) {
  if (locked) return null;

  return (
    <div className="flex flex-wrap gap-2 rounded-2xl border border-dashed border-[rgb(var(--color-border))] bg-[rgb(var(--color-surface-alt))]/35 p-3">
      {onAddNewSketch && (
        <button
          type="button"
          onClick={onAddNewSketch}
          className="inline-flex items-center gap-1.5 rounded-lg bg-[rgb(var(--color-accent))] px-3 py-2 text-xs font-medium text-[rgb(var(--color-accent-fg))] transition-colors hover:bg-[rgb(var(--color-accent-hover))]"
        >
          <Plus className="h-3.5 w-3.5" />
          New Sketch
        </button>
      )}
      {onPickExisting && (
        <button
          type="button"
          onClick={onPickExisting}
          className="inline-flex items-center gap-1.5 rounded-lg border border-[rgb(var(--color-border))] px-3 py-2 text-xs font-medium text-[rgb(var(--color-text-secondary))] transition-colors hover:border-[rgb(var(--color-accent))]/45 hover:text-[rgb(var(--color-accent))]"
        >
          <Plus className="h-3.5 w-3.5" />
          Existing Sketch
        </button>
      )}
      {onAddSection && (
        <button
          type="button"
          onClick={onAddSection}
          className="inline-flex items-center gap-1.5 rounded-lg border border-[rgb(var(--color-border))] px-3 py-2 text-xs font-medium text-[rgb(var(--color-text-secondary))] transition-colors hover:border-[rgb(var(--color-accent))]/45 hover:text-[rgb(var(--color-accent))]"
        >
          <Plus className="h-3.5 w-3.5" />
          Section
        </button>
      )}
    </div>
  );
}

function EmptyStoryboardVisual({
  locked,
  onAddNewSketch,
  onPickExisting,
  onAddSection,
}: {
  locked?: boolean;
  onAddNewSketch?: () => void;
  onPickExisting?: () => void;
  onAddSection?: () => void;
}) {
  return (
    <div className="rounded-2xl border border-dashed border-[rgb(var(--color-border))] bg-[rgb(var(--color-surface-alt))]/40 px-4 py-10 text-center">
      <p className="text-sm font-medium text-[rgb(var(--color-text))]">No storyboard items yet</p>
      <p className="mt-1 text-xs text-[rgb(var(--color-text-secondary))]">
        Add sketches or sections to start shaping the demo flow.
      </p>
      <div className="mt-4 flex justify-center">
        <StoryboardActionBar
          locked={locked}
          onAddNewSketch={onAddNewSketch}
          onPickExisting={onPickExisting}
          onAddSection={onAddSection}
        />
      </div>
    </div>
  );
}

export function StoryboardBalancedView({
  items,
  sketchMap,
  sketchCache,
  projectRoot,
  durationDisplayMode,
  onOpenSketch,
  locked,
  onAddNewSketch,
  onPickExisting,
  onAddSection,
  onAddNewSketchToSection,
  onPickExistingForSection,
  onRemoveTopLevelSketch,
  onRemoveSectionSketch,
  onRemoveSection,
}: {
  items: StoryboardItem[];
  sketchMap: Map<string, SketchSummary>;
  sketchCache: Map<string, Sketch>;
  projectRoot?: string | null;
  durationDisplayMode: DurationDisplayMode;
  onOpenSketch: (path: string) => void;
  locked?: boolean;
  onAddNewSketch?: () => void;
  onPickExisting?: () => void;
  onAddSection?: () => void;
  onAddNewSketchToSection?: (sectionIndex: number) => void;
  onPickExistingForSection?: (sectionIndex: number) => void;
  onRemoveTopLevelSketch?: (index: number) => void;
  onRemoveSectionSketch?: (sectionIndex: number, sketchIndex: number) => void;
  onRemoveSection?: (sectionIndex: number) => void;
}) {
  if (items.length === 0) {
    return (
      <EmptyStoryboardVisual
        locked={locked}
        onAddNewSketch={onAddNewSketch}
        onPickExisting={onPickExisting}
        onAddSection={onAddSection}
      />
    );
  }

  return (
    <div className="space-y-4">
      <StoryboardActionBar
        locked={locked}
        onAddNewSketch={onAddNewSketch}
        onPickExisting={onPickExisting}
        onAddSection={onAddSection}
      />
      {items.map((item, index) => {
        if (item.type === "sketch_ref") {
          return (
            <SketchSummaryCard
              key={`${item.path}-${index}`}
              path={item.path}
              sketchMap={sketchMap}
              sketchCache={sketchCache}
              projectRoot={projectRoot}
              durationDisplayMode={durationDisplayMode}
              onOpen={onOpenSketch}
              locked={locked}
              onRemove={() => onRemoveTopLevelSketch?.(index)}
            />
          );
        }

        const duration = formatDurationSummary(summarizeSketchPathsDuration(item.sketches, sketchCache), durationDisplayMode);
        return (
          <section key={`${item.title}-${index}`} className="rounded-2xl border border-[rgb(var(--color-border-subtle))] bg-[rgb(var(--color-surface))]/25 p-3">
            <div className="mb-3 flex items-start justify-between gap-3">
              <div>
                <div className="text-[10px] font-semibold uppercase tracking-[0.22em] text-[rgb(var(--color-text-secondary))]/70">
                  Section · {item.sketches.length} {item.sketches.length === 1 ? "sketch" : "sketches"}
                </div>
                <h3 className="mt-1 text-lg font-semibold text-[rgb(var(--color-text))]">{item.title}</h3>
                {item.description && <p className="mt-1 text-sm text-[rgb(var(--color-text-secondary))]">{item.description}</p>}
              </div>
              <div className="flex shrink-0 items-center gap-1">
                {item.sketches.length > 0 && (
                  <span className="rounded-full border border-[rgb(var(--color-border))] bg-[rgb(var(--color-surface-alt))] px-2 py-0.5 text-[10px] font-medium text-[rgb(var(--color-text-secondary))]">
                    {duration}
                  </span>
                )}
                {!locked && onRemoveSection && (
                  <button
                    type="button"
                    onClick={() => onRemoveSection(index)}
                    className="rounded-full p-1 text-[rgb(var(--color-text-secondary))] transition-colors hover:bg-error/10 hover:text-error"
                    title="Remove section"
                    aria-label={`Remove section ${item.title}`}
                  >
                    <Trash2 className="h-3.5 w-3.5" />
                  </button>
                )}
              </div>
            </div>
            <StoryboardActionBar
              locked={locked}
              onAddNewSketch={onAddNewSketchToSection ? () => onAddNewSketchToSection(index) : undefined}
              onPickExisting={onPickExistingForSection ? () => onPickExistingForSection(index) : undefined}
            />
            <div className="space-y-3">
              {item.sketches.map((path, sketchIndex) => (
                <SketchSummaryCard
                  key={`${path}-${sketchIndex}`}
                  path={path}
                  sketchMap={sketchMap}
                  sketchCache={sketchCache}
                  projectRoot={projectRoot}
                  durationDisplayMode={durationDisplayMode}
                  onOpen={onOpenSketch}
                  locked={locked}
                  onRemove={() => onRemoveSectionSketch?.(index, sketchIndex)}
                />
              ))}
            </div>
          </section>
        );
      })}
    </div>
  );
}

export function StoryboardScreenView({
  items,
  sketchMap,
  sketchCache,
  projectRoot,
  durationDisplayMode,
  onOpenSketch,
  locked,
  onAddNewSketch,
  onPickExisting,
  onAddSection,
  onRemoveTopLevelSketch,
  onRemoveSectionSketch,
}: {
  items: StoryboardItem[];
  sketchMap: Map<string, SketchSummary>;
  sketchCache: Map<string, Sketch>;
  projectRoot?: string | null;
  durationDisplayMode: DurationDisplayMode;
  onOpenSketch: (path: string) => void;
  locked?: boolean;
  onAddNewSketch?: () => void;
  onPickExisting?: () => void;
  onAddSection?: () => void;
  onRemoveTopLevelSketch?: (index: number) => void;
  onRemoveSectionSketch?: (sectionIndex: number, sketchIndex: number) => void;
}) {
  const entries = items.flatMap((item, itemIndex) => item.type === "sketch_ref"
    ? [{ path: item.path, section: null as string | null, itemIndex, sketchIndex: null as number | null }]
    : item.sketches.map((path, sketchIndex) => ({ path, section: item.title, itemIndex, sketchIndex })));

  if (entries.length === 0) {
    return (
      <EmptyStoryboardVisual
        locked={locked}
        onAddNewSketch={onAddNewSketch}
        onPickExisting={onPickExisting}
        onAddSection={onAddSection}
      />
    );
  }

  return (
    <div className="space-y-3">
      <StoryboardActionBar
        locked={locked}
        onAddNewSketch={onAddNewSketch}
        onPickExisting={onPickExisting}
        onAddSection={onAddSection}
      />
      {entries.map((entry, index) => (
        <div key={`${entry.path}-${index}`} className="space-y-2">
          {entry.section && (index === 0 || entries[index - 1]?.itemIndex !== entry.itemIndex) && (
            <div className="text-[10px] font-semibold uppercase tracking-[0.22em] text-[rgb(var(--color-text-secondary))]/70">
              {entry.section}
            </div>
          )}
          <SketchSummaryCard
            path={entry.path}
            sketchMap={sketchMap}
            sketchCache={sketchCache}
            projectRoot={projectRoot}
            durationDisplayMode={durationDisplayMode}
            onOpen={onOpenSketch}
            locked={locked}
            onRemove={() => {
              if (entry.sketchIndex === null) {
                onRemoveTopLevelSketch?.(entry.itemIndex);
              } else {
                onRemoveSectionSketch?.(entry.itemIndex, entry.sketchIndex);
              }
            }}
            compact
          />
          <div className="px-1 text-[10px] font-medium uppercase tracking-[0.16em] text-[rgb(var(--color-text-secondary))]/70">
            Shot {index + 1} · {sketchTitle(entry.path, sketchMap)}
          </div>
        </div>
      ))}
    </div>
  );
}
