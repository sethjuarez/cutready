import { ChevronDown, GitBranch } from "lucide-react";
import { useAppStore } from "../stores/appStore";
import { useVersioningStore } from "../stores/versioningStore";

const chipClass =
  "inline-flex h-7 min-w-0 items-center gap-1.5 rounded-control px-2 text-xs text-[rgb(var(--color-text-secondary))] transition-colors duration-fast ease-fluent hover:bg-fill-hover hover:text-[rgb(var(--color-text))] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[rgb(var(--color-accent))]";

/** Active variation chip shown next to the project name. Opens the Changes view. */
export function TitleBarVariationChip() {
  const activeTimeline = useVersioningStore((s) => s.timelines.find((t) => t.is_active));
  const setView = useAppStore((s) => s.setView);
  if (!activeTimeline) return null;
  const name = activeTimeline.label || activeTimeline.name;
  return (
    <button
      type="button"
      className={`${chipClass} max-w-[180px] max-[1100px]:hidden`}
      onClick={() => setView("changes")}
      title={`Variation: ${name}`}
      aria-label={`Variation ${name}. Open changes`}
      data-testid="titlebar-variation"
    >
      <GitBranch className="h-3.5 w-3.5 shrink-0" aria-hidden="true" />
      <span className="truncate">{name}</span>
      <ChevronDown className="h-3 w-3 shrink-0 opacity-70" aria-hidden="true" />
    </button>
  );
}

