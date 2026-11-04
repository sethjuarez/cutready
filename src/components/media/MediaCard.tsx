import { Suspense, useEffect, useId, useRef, useState } from "react";
import { FileText, PenLine } from "lucide-react";
import { useAppStore } from "../../stores/appStore";
import { formatBytes, isUnused, usedInLabel, type MediaItem } from "../../utils/media";
import { ProjectImage } from "../ProjectImage";
import VisualCell from "../VisualCell";
import { KIND_LABEL, MediaKindIcon } from "./MediaKindIcon";

interface MediaCardProps {
  item: MediaItem;
  onOpen: (item: MediaItem) => void;
  onOpenDocument: (path: string) => void;
}

function Thumbnail({ item }: { item: MediaItem }) {
  if (item.kind === "visual") {
    return (
      <Suspense fallback={<div className="h-full w-full animate-pulse" />}>
        <VisualCell visualPath={item.path} mode="thumbnail" className="!h-full !w-full !rounded-none" />
      </Suspense>
    );
  }
  if (item.kind === "image") {
    return <ProjectImage relativePath={item.path} alt="" className="h-full w-full object-cover" />;
  }
  return (
    <div className="grid h-full w-full place-items-center text-[rgb(var(--color-text-secondary))]">
      <MediaKindIcon kind={item.kind} className="h-8 w-8" />
    </div>
  );
}

/** Which sketches and notes use an item; each opens on click. */
function UsagePopover({ item, onOpenDocument }: { item: MediaItem; onOpenDocument: (path: string) => void }) {
  const [open, setOpen] = useState(false);
  const rootRef = useRef<HTMLDivElement>(null);
  const listId = useId();
  const sketches = useAppStore((s) => s.sketches);
  const notes = useAppStore((s) => s.notes);
  const titleOf = (path: string) =>
    [...sketches, ...notes].find((doc) => doc.path === path)?.title || path.split("/").pop() || path;

  useEffect(() => {
    if (!open) return;
    const close = (event: MouseEvent) => {
      if (!rootRef.current?.contains(event.target as Node)) setOpen(false);
    };
    document.addEventListener("mousedown", close);
    return () => document.removeEventListener("mousedown", close);
  }, [open]);

  const refs = [
    ...item.sketches.map((path) => ({ path, Icon: PenLine })),
    ...item.notes.map((path) => ({ path, Icon: FileText })),
  ];
  return (
    <div
      ref={rootRef}
      className="relative"
      onKeyDown={(event) => {
        if (event.key === "Escape" && open) {
          event.stopPropagation();
          setOpen(false);
        }
      }}
    >
      <button
        type="button"
        onClick={() => setOpen((value) => !value)}
        aria-expanded={open}
        aria-controls={open ? listId : undefined}
        className="show-underlines-target rounded px-1 -mx-1 text-xs text-[rgb(var(--color-text-secondary))] hover:bg-[rgb(var(--color-surface-alt))] hover:text-[rgb(var(--color-text))]"
        data-testid="media-usage"
      >
        {usedInLabel(item)}
      </button>
      {open && (
        <ul
          id={listId}
          aria-label={`Documents using ${item.name}`}
          className="absolute left-0 top-full z-20 mt-1 w-56 rounded-lg border border-[rgb(var(--color-border))] bg-[rgb(var(--color-surface))] p-1 shadow-lg"
        >
          {refs.map(({ path, Icon }) => (
            <li key={path}>
              <button
                type="button"
                onClick={() => {
                  setOpen(false);
                  onOpenDocument(path);
                }}
                className="flex w-full min-w-0 items-center gap-2 rounded-md px-2 py-1.5 text-left text-[13px] text-[rgb(var(--color-text))] hover:bg-[rgb(var(--color-surface-alt))]"
              >
                <Icon className="h-4 w-4 shrink-0 text-[rgb(var(--color-text-secondary))]" aria-hidden="true" />
                <span className="truncate">{titleOf(path)}</span>
              </button>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

/** One library item: preview, name, type and size, and where it's used. */
export function MediaCard({ item, onOpen, onOpenDocument }: MediaCardProps) {
  const unused = isUnused(item);
  return (
    <li className="flex min-w-0 flex-col rounded-xl border border-[rgb(var(--color-border))] bg-[rgb(var(--color-surface))]" data-testid="media-card" data-unused={unused || undefined}>
      <button
        type="button"
        onClick={() => onOpen(item)}
        className="aspect-[16/10] overflow-hidden rounded-t-xl border-b border-[rgb(var(--color-border))] bg-[rgb(var(--color-surface-alt))] focus-visible:outline focus-visible:outline-2 focus-visible:outline-[rgb(var(--color-accent))]"
        aria-label={`Open ${item.name}`}
      >
        <Thumbnail item={item} />
      </button>
      <div className="flex min-w-0 flex-col gap-1 px-3 py-2">
        <div className="truncate text-[13px] font-medium text-[rgb(var(--color-text))]" title={item.path}>{item.name}</div>
        <div className="flex min-w-0 items-center gap-2 whitespace-nowrap text-xs text-[rgb(var(--color-text-secondary))]">
          <span>{KIND_LABEL[item.kind]}</span>
          <span aria-hidden="true">·</span>
          <span>{formatBytes(item.size)}</span>
        </div>
        <div className="flex min-h-5 min-w-0 items-center whitespace-nowrap">
          {unused ? (
            <span className="rounded-md border border-[rgb(var(--color-border))] px-1.5 py-px text-[11px] font-medium text-[rgb(var(--color-text-secondary))]" data-testid="media-unused-badge">
              Unused
            </span>
          ) : (
            <UsagePopover item={item} onOpenDocument={onOpenDocument} />
          )}
        </div>
      </div>
    </li>
  );
}
