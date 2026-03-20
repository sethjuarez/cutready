import { useEffect, useRef, useState } from "react";
import type { WordOrientation } from "../utils/exportToWord";
import { ArrowDownTrayIcon, DocumentIcon } from "@heroicons/react/24/outline";

interface ExportWordButtonProps {
  onExport: (orientation: WordOrientation) => void | Promise<void>;
  disabled?: boolean;
  /** Show "Word" label next to icon. Default: false */
  showLabel?: boolean;
  /** Default orientation. Default: "landscape" */
  defaultOrientation?: WordOrientation;
  className?: string;
}

export function ExportWordButton({
  onExport,
  disabled,
  showLabel,
  defaultOrientation = "landscape",
  className,
}: ExportWordButtonProps) {
  const [open, setOpen] = useState(false);
  const [busy, setBusy] = useState(false);
  const ref = useRef<HTMLDivElement>(null);

  // Close popover on outside click
  useEffect(() => {
    if (!open) return;
    const handler = (e: MouseEvent) => {
      if (ref.current && !ref.current.contains(e.target as Node)) setOpen(false);
    };
    document.addEventListener("mousedown", handler);
    return () => document.removeEventListener("mousedown", handler);
  }, [open]);

  const handlePick = async (orientation: WordOrientation) => {
    setOpen(false);
    setBusy(true);
    try {
      await onExport(orientation);
    } finally {
      setBusy(false);
    }
  };

  const btnClass = className ??
    "flex items-center gap-1.5 shrink-0 text-xs text-[var(--color-text-secondary)] hover:text-[var(--color-accent)] px-3 py-1.5 rounded-lg border border-[var(--color-border)] hover:border-[var(--color-accent)]/40 hover:bg-[var(--color-accent)]/5 transition-colors disabled:opacity-30 disabled:cursor-not-allowed";

  return (
    <div className="relative" ref={ref}>
      <button
        onClick={() => setOpen(!open)}
        disabled={disabled || busy}
        className={btnClass}
        title="Export to Word (.docx)"
      >
        {busy ? (
          <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" className="animate-spin">
            <path d="M21 12a9 9 0 1 1-6.219-8.56" />
          </svg>
        ) : (
          <ArrowDownTrayIcon className="w-3.5 h-3.5" />
        )}
        {showLabel && "Word"}
      </button>

      {open && (
        <div className="absolute right-0 top-full mt-1 z-50 min-w-[140px] rounded-lg border border-[var(--color-border)] bg-[var(--color-surface)] shadow-lg overflow-hidden">
          <button
            onClick={() => handlePick("portrait")}
            className={`w-full flex items-center gap-2 px-3 py-2 text-xs transition-colors hover:bg-[var(--color-accent)]/10 ${defaultOrientation === "portrait" ? "text-[var(--color-accent)] font-medium" : "text-[var(--color-text)]"}`}
          >
            <DocumentIcon className="shrink-0 w-3.5 h-3.5" />
            Portrait
          </button>
          <button
            onClick={() => handlePick("landscape")}
            className={`w-full flex items-center gap-2 px-3 py-2 text-xs transition-colors hover:bg-[var(--color-accent)]/10 ${defaultOrientation === "landscape" ? "text-[var(--color-accent)] font-medium" : "text-[var(--color-text)]"}`}
          >
            <DocumentIcon className="shrink-0 w-3.5 h-3.5" />
            Landscape
          </button>
        </div>
      )}
    </div>
  );
}
