import { type Dispatch, type SetStateAction } from "react";
import { ChevronRight, Loader2, Pencil, Plus, Trash2 } from "lucide-react";
import type { Sketch, SketchSummary, StoryboardItem } from "../types/sketch";
import { formatDurationSummary, summarizeSketchDuration, summarizeSketchPathsDuration, type DurationDisplayMode } from "../utils/documentMetadata";
import { SafeMarkdown } from "./SafeMarkdown";
import { SketchBalancedView, SketchScreenView } from "./SketchVisualViews";

type StoryboardVisualMode = "balanced" | "screen";

interface StoryboardVisualViewProps {
  items: StoryboardItem[];
  sketchMap: Map<string, SketchSummary>;
  sketchCache: Map<string, Sketch>;
  projectRoot?: string | null;
  durationDisplayMode: DurationDisplayMode;
  onOpenSketch: (path: string) => void;
  locked?: boolean;
  collapsedItems: Set<string>;
  setCollapsedItems: Dispatch<SetStateAction<Set<string>>>;
  onAddNewSketch?: () => void;
  onPickExisting?: () => void;
  onAddSection?: () => void;
  onAddNewSketchToSection?: (sectionIndex: number) => void;
  onPickExistingForSection?: (sectionIndex: number) => void;
  onRemoveTopLevelSketch?: (index: number) => void;
  onRemoveSectionSketch?: (sectionIndex: number, sketchIndex: number) => void;
  onRemoveSection?: (sectionIndex: number) => void;
}

function getTopLevelCollapseKey(index: number): string {
  return `storyboard-item:${index}`;
}

function getNestedSketchCollapseKey(sectionIndex: number, sketchIndex: number): string {
  return `storyboard-item:${sectionIndex}:sketch:${sketchIndex}`;
}

function makePlaceholder(path: string): SketchSummary {
  return {
    path,
    title: "(Missing sketch)",
    state: "draft",
    row_count: 0,
    created_at: "",
    updated_at: "",
  };
}

function toggleCollapse(
  setCollapsedItems: Dispatch<SetStateAction<Set<string>>>,
  key: string,
) {
  setCollapsedItems((prev) => {
    const next = new Set(prev);
    if (next.has(key)) next.delete(key);
    else next.add(key);
    return next;
  });
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
  if (locked || (!onAddNewSketch && !onPickExisting && !onAddSection)) return null;

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

function DurationPill({ label }: { label: string }) {
  return (
    <span className="shrink-0 rounded-full border border-[rgb(var(--color-border))] bg-[rgb(var(--color-surface-alt))] px-2 py-0.5 text-[10px] font-medium text-[rgb(var(--color-text-secondary))]">
      {label}
    </span>
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

function ReadOnlySketchRows({
  mode,
  sketch,
  projectRoot,
}: {
  mode: StoryboardVisualMode;
  sketch: Sketch;
  projectRoot?: string | null;
}) {
  if (sketch.rows.length === 0) {
    return <p className="py-2 text-xs text-[rgb(var(--color-text-secondary))]">No rows yet</p>;
  }

  const View = mode === "balanced" ? SketchBalancedView : SketchScreenView;
  return (
    <View
      rows={sketch.rows}
      onChange={() => {}}
      projectRoot={projectRoot}
      readOnly
    />
  );
}

function ContainedSketch({
  mode,
  path,
  sketchMap,
  sketchCache,
  projectRoot,
  durationDisplayMode,
  collapsed,
  onToggleCollapse,
  onOpen,
  locked,
  onRemove,
  outlineLevel = "top",
}: {
  mode: StoryboardVisualMode;
  path: string;
  sketchMap: Map<string, SketchSummary>;
  sketchCache: Map<string, Sketch>;
  projectRoot?: string | null;
  durationDisplayMode: DurationDisplayMode;
  collapsed: boolean;
  onToggleCollapse: () => void;
  onOpen: () => void;
  locked?: boolean;
  onRemove?: () => void;
  outlineLevel?: "top" | "nested";
}) {
  const summary = sketchMap.get(path) ?? makePlaceholder(path);
  const fullSketch = sketchCache.get(path);
  const isTopLevel = outlineLevel === "top";
  const duration = fullSketch ? formatDurationSummary(summarizeSketchDuration(fullSketch.rows), durationDisplayMode) : null;

  return (
    <div className={`group/sketch ${isTopLevel ? "rounded-xl border border-[rgb(var(--color-border-subtle))] bg-[rgb(var(--color-surface))]/25 px-3 py-2.5" : "rounded-lg bg-[rgb(var(--color-surface))]/25 px-3 py-1.5"}`}>
      <div className={`flex items-start gap-3 ${isTopLevel ? "" : "py-1"}`}>
        <div className="min-w-0 flex-1">
          {isTopLevel && (
            <div className="mb-1 flex items-center gap-2 text-[10px] font-semibold uppercase tracking-[0.2em] text-[rgb(var(--color-text-secondary))]/60">
              <span>Sketch</span>
              <span className="h-px w-5 bg-[rgb(var(--color-border))]" />
              <span className="tracking-[0.14em]">
                {summary.row_count} {summary.row_count === 1 ? "row" : "rows"}
              </span>
            </div>
          )}

          <div className="flex items-center gap-2">
            <button
              type="button"
              onClick={onToggleCollapse}
              className="shrink-0 text-[rgb(var(--color-text-secondary))] transition-colors hover:text-[rgb(var(--color-text))]"
              title={collapsed ? "Show sketch" : "Hide sketch"}
              aria-label={collapsed ? `Expand ${summary.title}` : `Collapse ${summary.title}`}
            >
              <ChevronRight className={`h-3.5 w-3.5 transition-transform ${collapsed ? "" : "rotate-90"}`} />
            </button>

            <button
              type="button"
              onClick={onToggleCollapse}
              className={`min-w-0 truncate text-left font-semibold text-[rgb(var(--color-text))] transition-colors hover:text-[rgb(var(--color-text-secondary))] ${isTopLevel ? "text-[15px]" : "text-[13px]"}`}
              title={collapsed ? `Expand ${summary.title}` : `Collapse ${summary.title}`}
            >
              {summary.title}
            </button>

            <span className={`shrink-0 text-[10px] text-[rgb(var(--color-text-secondary))]/85 ${isTopLevel ? "hidden" : ""}`}>
              {summary.row_count} {summary.row_count === 1 ? "row" : "rows"}
            </span>

            {duration && <DurationPill label={duration} />}

            <button
              type="button"
              onClick={onOpen}
              className="shrink-0 rounded p-1 text-[rgb(var(--color-text-secondary))] opacity-0 transition-all hover:text-[rgb(var(--color-text))] group-hover/sketch:opacity-100 focus-visible:opacity-100"
              title="Open in editor"
              aria-label={`Open ${summary.title} in editor`}
            >
              <Pencil className="h-3.5 w-3.5" />
            </button>

            {!locked && onRemove && (
              <button
                type="button"
                onClick={onRemove}
                className="shrink-0 rounded p-1 text-[rgb(var(--color-text-secondary))] opacity-0 transition-all hover:text-error group-hover/sketch:opacity-100 focus-visible:opacity-100"
                title="Remove from storyboard"
                aria-label={`Remove ${summary.title} from storyboard`}
              >
                <Trash2 className="h-3.5 w-3.5" />
              </button>
            )}
          </div>

          {fullSketch && typeof fullSketch.description === "string" && fullSketch.description.trim() && (
            <div className="prose-desc mb-2 text-sm leading-relaxed text-[rgb(var(--color-text-secondary))]">
              <SafeMarkdown>{fullSketch.description}</SafeMarkdown>
            </div>
          )}

          {!collapsed && (fullSketch ? (
            <div className="mt-2">
              <ReadOnlySketchRows mode={mode} sketch={fullSketch} projectRoot={projectRoot} />
            </div>
          ) : (
            <div className="flex items-center gap-2 py-3">
              <Loader2 className="h-3.5 w-3.5 animate-spin text-[rgb(var(--color-accent))]" />
              <span className="text-xs text-[rgb(var(--color-text-secondary))]">Loading sketch...</span>
            </div>
          ))}
        </div>
      </div>
    </div>
  );
}

function SectionBlock({
  mode,
  item,
  index,
  sketchMap,
  sketchCache,
  projectRoot,
  durationDisplayMode,
  locked,
  collapsed,
  onToggleCollapse,
  collapsedItems,
  setCollapsedItems,
  onOpenSketch,
  onAddNewSketch,
  onPickExisting,
  onRemoveSketch,
  onRemoveSection,
}: {
  mode: StoryboardVisualMode;
  item: Extract<StoryboardItem, { type: "section" }>;
  index: number;
  sketchMap: Map<string, SketchSummary>;
  sketchCache: Map<string, Sketch>;
  projectRoot?: string | null;
  durationDisplayMode: DurationDisplayMode;
  locked?: boolean;
  collapsed: boolean;
  onToggleCollapse: () => void;
  collapsedItems: Set<string>;
  setCollapsedItems: Dispatch<SetStateAction<Set<string>>>;
  onOpenSketch: (path: string) => void;
  onAddNewSketch?: () => void;
  onPickExisting?: () => void;
  onRemoveSketch?: (sketchIndex: number) => void;
  onRemoveSection?: () => void;
}) {
  const duration = item.sketches.length > 0
    ? formatDurationSummary(summarizeSketchPathsDuration(item.sketches, sketchCache), durationDisplayMode)
    : null;

  return (
    <section className="group/section rounded-xl border border-[rgb(var(--color-border-subtle))] bg-[rgb(var(--color-surface))]/25 px-3 py-2.5">
      <div className="flex items-start gap-3">
        <div className="min-w-0 flex-1">
          <div className="mb-1 flex items-center gap-2 text-[10px] font-semibold uppercase tracking-[0.2em] text-[rgb(var(--color-text-secondary))]/60">
            <span>Section</span>
            <span className="h-px w-5 bg-[rgb(var(--color-border))]" />
            <span className="tracking-[0.14em]">
              {item.sketches.length} {item.sketches.length === 1 ? "sketch" : "sketches"}
            </span>
          </div>

          <div className="flex items-center gap-2">
            <button
              type="button"
              onClick={onToggleCollapse}
              className="shrink-0 text-[rgb(var(--color-text-secondary))] transition-colors hover:text-[rgb(var(--color-text))]"
              title={collapsed ? "Show sketches" : "Hide sketches"}
              aria-label={collapsed ? `Expand ${item.title}` : `Collapse ${item.title}`}
            >
              <ChevronRight className={`h-3.5 w-3.5 transition-transform ${collapsed ? "" : "rotate-90"}`} />
            </button>
            <button
              type="button"
              onClick={onToggleCollapse}
              className="min-w-0 truncate text-left text-base font-semibold leading-tight text-[rgb(var(--color-text))] transition-colors hover:text-[rgb(var(--color-text-secondary))]"
              title={collapsed ? `Expand ${item.title}` : `Collapse ${item.title}`}
            >
              {item.title}
            </button>
            {duration && <DurationPill label={duration} />}
            {!locked && onRemoveSection && (
              <button
                type="button"
                onClick={onRemoveSection}
                className="shrink-0 rounded p-1 text-[rgb(var(--color-text-secondary))] opacity-0 transition-all hover:text-error group-hover/section:opacity-100 focus-visible:opacity-100"
                title="Remove section"
                aria-label={`Remove section ${item.title}`}
              >
                <Trash2 className="h-3.5 w-3.5" />
              </button>
            )}
          </div>

          {item.description && (
            <div className="prose-desc mt-2 text-sm leading-relaxed text-[rgb(var(--color-text-secondary))]">
              <SafeMarkdown>{item.description}</SafeMarkdown>
            </div>
          )}
        </div>
      </div>

      {!collapsed && (
        <div className="mt-2 space-y-2 pl-6">
          {item.sketches.length === 0 ? (
            <p className="rounded-xl border border-dashed border-[rgb(var(--color-border-subtle))] bg-[rgb(var(--color-surface))]/35 px-4 py-4 text-center text-xs text-[rgb(var(--color-text-secondary))]">
              No sketches in this section yet.
            </p>
          ) : (
            item.sketches.map((path, sketchIndex) => {
              const collapseKey = getNestedSketchCollapseKey(index, sketchIndex);
              return (
                <ContainedSketch
                  key={`${path}-${sketchIndex}`}
                  mode={mode}
                  path={path}
                  sketchMap={sketchMap}
                  sketchCache={sketchCache}
                  projectRoot={projectRoot}
                  durationDisplayMode={durationDisplayMode}
                  collapsed={collapsedItems.has(collapseKey)}
                  onToggleCollapse={() => toggleCollapse(setCollapsedItems, collapseKey)}
                  onOpen={() => onOpenSketch(path)}
                  locked={locked}
                  onRemove={onRemoveSketch ? () => onRemoveSketch(sketchIndex) : undefined}
                  outlineLevel="nested"
                />
              );
            })
          )}
        </div>
      )}

      {!collapsed && !locked && (
        <div className="mt-2 flex gap-2 pl-6">
          {onAddNewSketch && (
            <button
              type="button"
              onClick={onAddNewSketch}
              className="rounded-full border border-[rgb(var(--color-border-subtle))] px-3 py-1 text-[10px] font-medium uppercase tracking-[0.14em] text-[rgb(var(--color-text-secondary))] transition-colors hover:border-[rgb(var(--color-accent))]/45 hover:text-[rgb(var(--color-accent))]"
            >
              New sketch
            </button>
          )}
          {onPickExisting && (
            <button
              type="button"
              onClick={onPickExisting}
              className="rounded-full border border-transparent px-3 py-1 text-[10px] font-medium uppercase tracking-[0.14em] text-[rgb(var(--color-text-secondary))] transition-colors hover:bg-[rgb(var(--color-accent))]/10 hover:text-[rgb(var(--color-accent))]"
            >
              Add existing sketch
            </button>
          )}
        </div>
      )}
    </section>
  );
}

function StoryboardVisualView({ mode, ...props }: StoryboardVisualViewProps & { mode: StoryboardVisualMode }) {
  const {
    items,
    sketchMap,
    sketchCache,
    projectRoot,
    durationDisplayMode,
    onOpenSketch,
    locked,
    collapsedItems,
    setCollapsedItems,
    onAddNewSketch,
    onPickExisting,
    onAddSection,
    onAddNewSketchToSection,
    onPickExistingForSection,
    onRemoveTopLevelSketch,
    onRemoveSectionSketch,
    onRemoveSection,
  } = props;

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
        const collapseKey = getTopLevelCollapseKey(index);
        if (item.type === "sketch_ref") {
          return (
            <ContainedSketch
              key={`${item.path}-${index}`}
              mode={mode}
              path={item.path}
              sketchMap={sketchMap}
              sketchCache={sketchCache}
              projectRoot={projectRoot}
              durationDisplayMode={durationDisplayMode}
              collapsed={collapsedItems.has(collapseKey)}
              onToggleCollapse={() => toggleCollapse(setCollapsedItems, collapseKey)}
              onOpen={() => onOpenSketch(item.path)}
              locked={locked}
              onRemove={onRemoveTopLevelSketch ? () => onRemoveTopLevelSketch(index) : undefined}
            />
          );
        }

        return (
          <SectionBlock
            key={`${item.title}-${index}`}
            mode={mode}
            item={item}
            index={index}
            sketchMap={sketchMap}
            sketchCache={sketchCache}
            projectRoot={projectRoot}
            durationDisplayMode={durationDisplayMode}
            locked={locked}
            collapsed={collapsedItems.has(collapseKey)}
            onToggleCollapse={() => toggleCollapse(setCollapsedItems, collapseKey)}
            collapsedItems={collapsedItems}
            setCollapsedItems={setCollapsedItems}
            onOpenSketch={onOpenSketch}
            onAddNewSketch={onAddNewSketchToSection ? () => onAddNewSketchToSection(index) : undefined}
            onPickExisting={onPickExistingForSection ? () => onPickExistingForSection(index) : undefined}
            onRemoveSketch={onRemoveSectionSketch ? (sketchIndex) => onRemoveSectionSketch(index, sketchIndex) : undefined}
            onRemoveSection={onRemoveSection ? () => onRemoveSection(index) : undefined}
          />
        );
      })}
    </div>
  );
}

export function StoryboardBalancedView(props: StoryboardVisualViewProps) {
  return <StoryboardVisualView {...props} mode="balanced" />;
}

export function StoryboardScreenView(props: StoryboardVisualViewProps) {
  return <StoryboardVisualView {...props} mode="screen" />;
}
