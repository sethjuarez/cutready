import { useEffect, useRef, useState } from "react";
import { CircleHelp } from "lucide-react";
import type { ChatRunDetails } from "../../types/sketch";
import { ComposerPopover } from "./ComposerPopover";
import { formatRunDuration, formatRunTokens, harnessRunLabel, providerRunLabel, reasoningEffortLabel } from "./runDetails";

export function RunDetailsPopover({
  details,
  toolCount = 0,
  status = "Completed",
}: {
  details: ChatRunDetails;
  toolCount?: number;
  status?: "Completed" | "Configured";
}) {
  const [open, setOpen] = useState(false);
  const anchorRef = useRef<HTMLSpanElement>(null);
  const panelRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!open) return;
    const onMouseDown = (event: MouseEvent) => {
      const target = event.target as Node;
      if (anchorRef.current?.contains(target) || panelRef.current?.contains(target)) return;
      setOpen(false);
    };
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") setOpen(false);
    };
    window.addEventListener("mousedown", onMouseDown);
    window.addEventListener("keydown", onKeyDown);
    return () => {
      window.removeEventListener("mousedown", onMouseDown);
      window.removeEventListener("keydown", onKeyDown);
    };
  }, [open]);
  const usage = details.usage;
  const effectiveToolCount = details.tool_calls ?? toolCount;
  const rows = [
    ["Harness", harnessRunLabel(details.execution_engine)],
    ["Provider", providerRunLabel(details.provider)],
    ["Model", details.model || "—"],
    ["Reasoning", reasoningEffortLabel(details.reasoning_effort ?? "")],
    ["Agent", details.agent_id || "—"],
    ["Duration", formatRunDuration(details.elapsed_ms)],
    ["Tools", `${effectiveToolCount} call${effectiveToolCount === 1 ? "" : "s"}`],
    ["Tokens", usage ? `${formatRunTokens(usage.prompt_tokens)} in / ${formatRunTokens(usage.completion_tokens)} out` : "—"],
  ];

  return (
    <span ref={anchorRef} className="relative inline-flex items-center">
      <button
        type="button"
        aria-label="Show run details"
        aria-expanded={open}
        onClick={() => setOpen((value) => !value)}
        className="inline-flex h-5 w-5 items-center justify-center rounded-full border border-[rgb(var(--color-border-subtle))] bg-[rgb(var(--color-surface-alt))]/50 text-[rgb(var(--color-text-secondary))]/70 transition-colors hover:border-[rgb(var(--color-accent))]/45 hover:bg-[rgb(var(--color-accent))]/10 hover:text-[rgb(var(--color-accent))] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[rgb(var(--color-accent))]/35"
        title="Show run details"
      >
        <CircleHelp className="h-3.5 w-3.5" />
      </button>
      {open && (
        <ComposerPopover
          ref={panelRef}
          anchorRef={anchorRef}
          width={288}
          align="right"
          role="dialog"
          aria-label="Run details"
          className="z-dropdown block overflow-y-auto rounded-2xl border border-[rgb(var(--color-border-subtle))] bg-[rgb(var(--color-surface))] p-3 text-left normal-case tracking-normal text-[rgb(var(--color-text))] shadow-xl"
        >
          <span className="mb-2 flex items-center justify-between">
            <span className="text-xs font-semibold uppercase tracking-[0.14em] text-[rgb(var(--color-text-secondary))]">
              Run details
            </span>
            <span className="rounded-full bg-[rgb(var(--color-accent))]/10 px-2 py-0.5 text-2xs font-medium text-[rgb(var(--color-accent))]">
              {status}
            </span>
          </span>
          <span className="grid grid-cols-[5.75rem_minmax(0,1fr)] gap-x-3 gap-y-1.5">
            {rows.map(([label, value]) => (
              <span key={label} className="contents">
                <span className="text-2xs font-medium uppercase tracking-[0.12em] text-[rgb(var(--color-text-secondary))]/75">
                  {label}
                </span>
                <span className="truncate font-mono text-xs normal-case tracking-normal text-[rgb(var(--color-text))]/90">
                  {value}
                </span>
              </span>
            ))}
          </span>
          {details.run_id && (
            <span className="mt-2 block truncate border-t border-[rgb(var(--color-border-subtle))] pt-2 font-mono text-2xs normal-case tracking-normal text-[rgb(var(--color-text-secondary))]/70">
              {details.run_id}
            </span>
          )}
        </ComposerPopover>
      )}
    </span>
  );
}
