import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Download, Search, Trash2 } from "lucide-react";
import { useAppStore } from "../../stores/appStore";
import { useToastStore } from "../../stores/toastStore";
import { reloadMediaLibrary, useMediaItems } from "../../hooks/useMediaLibrary";
import {
  MEDIA_FILTERS,
  filterCounts,
  filterMedia,
  removalPaths,
  removalPlan,
  toMediaItems,
  type MediaFilter,
  type MediaItem,
} from "../../utils/media";
import { MediaCard } from "./MediaCard";
import { RemoveUnusedDialog } from "./RemoveUnusedDialog";

const EMPTY_TEXT: Record<MediaFilter, string> = {
  all: "No media yet. Screenshots, visuals and narration takes appear here as you add them.",
  images: "No images or visuals yet.",
  video: "No video yet.",
  audio: "No audio yet. Record or generate a narration on a sketch row to add one.",
  unused: "Everything in the library is in use.",
};

/** A confirmed removal is only valid in the project it was planned for. */
type Plan = ReturnType<typeof removalPlan> & { root: string };

const projectRoot = () => useAppStore.getState().currentProject?.root ?? null;

function errorText(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

/** The project's media library: images, visuals and audio, with usage and cleanup of unused files. */
export function MediaView() {
  const items = useMediaItems();
  const importAsset = useAppStore((s) => s.importAsset);
  const [filter, setFilter] = useState<MediaFilter>("all");
  const [query, setQuery] = useState("");
  const [plan, setPlan] = useState<Plan | null>(null);
  const [busy, setBusy] = useState(false);
  const removeButtonRef = useRef<HTMLButtonElement>(null);
  const root = useAppStore((s) => s.currentProject?.root ?? null);

  useEffect(() => {
    setPlan((current) => (current && current.root !== root ? null : current));
  }, [root]);

  const counts = useMemo(() => filterCounts(items), [items]);
  const visible = useMemo(() => filterMedia(items, filter, query), [items, filter, query]);
  const removable = useMemo(() => removalPlan(items).remove.length, [items]);

  const openItem = useCallback((item: MediaItem) => {
    const { openTab, setView } = useAppStore.getState();
    openTab({ type: "asset", path: item.path, title: item.name });
    setView("project");
  }, []);

  const openDocument = useCallback((path: string) => {
    const { openSketch, openNote, setView } = useAppStore.getState();
    void (path.endsWith(".md") ? openNote(path) : openSketch(path));
    setView("project");
  }, []);

  // Re-read usage before confirming so the dialog never lists a file that just became used.
  const startRemove = useCallback(async () => {
    const planned = projectRoot();
    if (!planned) return;
    await reloadMediaLibrary();
    if (projectRoot() !== planned) return;
    const { assets, narrationAssets } = useAppStore.getState();
    setPlan({ ...removalPlan(toMediaItems(assets, narrationAssets)), root: planned });
  }, []);

  const closeDialog = useCallback(() => {
    setPlan(null);
    requestAnimationFrame(() => removeButtonRef.current?.focus());
  }, []);

  const confirmRemove = useCallback(async () => {
    if (!plan) return;
    // The backend deletes in whichever project is open now, so never apply a plan made in another one.
    if (projectRoot() !== plan.root) {
      setPlan(null);
      return;
    }
    setBusy(true);
    try {
      const { images, narrations } = removalPaths(plan.remove);
      const { deleteUnlinkedAssets, deleteUnlinkedNarrationAssets } = useAppStore.getState();
      if (images.length > 0) await deleteUnlinkedAssets(images);
      if (narrations.length > 0) await deleteUnlinkedNarrationAssets(narrations);
    } catch (err) {
      useToastStore.getState().show(`Could not remove all unused media: ${errorText(err)}`, 6000, "error");
    } finally {
      if (projectRoot() === plan.root) await reloadMediaLibrary();
      setBusy(false);
      closeDialog();
    }
  }, [plan, closeDialog]);

  return (
    <div className="flex h-full flex-col overflow-hidden" data-testid="media-view">
      <header className="flex shrink-0 flex-wrap items-center gap-3 px-6 pt-5 pb-3">
        <h1 className="mr-auto text-lg font-semibold text-[rgb(var(--color-text))]">Media</h1>
        <label className="relative flex items-center">
          <span className="sr-only">Search media</span>
          <Search className="pointer-events-none absolute left-2.5 h-4 w-4 text-[rgb(var(--color-text-secondary))]" aria-hidden="true" />
          <input
            type="search"
            value={query}
            onChange={(event) => setQuery(event.target.value)}
            placeholder="Search by name"
            className="cr-input h-8 w-56 pl-8 text-[13px]"
            data-testid="media-search"
          />
        </label>
        <button type="button" onClick={() => void importAsset()} className="cr-btn inline-flex items-center gap-1.5">
          <Download className="h-4 w-4" aria-hidden="true" />
          Import image
        </button>
      </header>

      <div className="flex shrink-0 flex-wrap items-center gap-2 px-6 pb-3">
        <div role="toolbar" aria-label="Filter media" className="flex flex-wrap gap-1.5">
          {MEDIA_FILTERS.map(({ id, label }) => {
            const active = filter === id;
            return (
              <button
                key={id}
                type="button"
                onClick={() => setFilter(id)}
                aria-pressed={active}
                className={`inline-flex h-7 items-center gap-1.5 rounded-full border px-3 text-[13px] transition-colors ${
                  active
                    ? "border-[rgb(var(--color-accent))]/40 bg-[rgb(var(--color-accent))]/10 text-[rgb(var(--color-text))]"
                    : "border-[rgb(var(--color-border))] text-[rgb(var(--color-text-secondary))] hover:bg-[rgb(var(--color-surface-alt))] hover:text-[rgb(var(--color-text))]"
                }`}
                data-testid={`media-filter-${id}`}
              >
                {label}
                <span className="text-xs tabular-nums opacity-80">{counts[id]}</span>
              </button>
            );
          })}
        </div>
        {filter === "unused" && removable > 0 && (
          <button
            ref={removeButtonRef}
            type="button"
            onClick={() => void startRemove()}
            className="cr-btn ml-auto inline-flex items-center gap-1.5"
            data-testid="media-remove-unused"
          >
            <Trash2 className="h-4 w-4" aria-hidden="true" />
            Remove unused ({removable})
          </button>
        )}
      </div>

      <div className="min-h-0 flex-1 overflow-y-auto px-6 pb-6">
        {visible.length === 0 ? (
          <p className="py-16 text-center text-[13px] text-[rgb(var(--color-text-secondary))]" data-testid="media-empty">
            {query.trim() ? `No media matches "${query.trim()}".` : EMPTY_TEXT[filter]}
          </p>
        ) : (
          <ul className="grid gap-3 [grid-template-columns:repeat(auto-fill,minmax(180px,1fr))]" aria-label="Media">
            {visible.map((item) => (
              <MediaCard key={item.path} item={item} onOpen={openItem} onOpenDocument={openDocument} />
            ))}
          </ul>
        )}
      </div>

      <RemoveUnusedDialog
        open={plan != null}
        remove={plan?.remove ?? []}
        keep={plan?.keep ?? []}
        busy={busy}
        onConfirm={() => void confirmRemove()}
        onCancel={closeDialog}
      />
    </div>
  );
}
