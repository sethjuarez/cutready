import { useEffect, useRef, useState } from "react";
import type { WordOrientation } from "../utils/exportToWord";

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
          <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round">
            <path d="M14 2H6a2 2 0 00-2 2v16a2 2 0 002 2h12a2 2 0 002-2V8z" />
            <polyline points="14 2 14 8 20 8" />
            <line x1="12" y1="18" x2="12" y2="12" />
            <polyline points="9 15 12 18 15 15" />
          </svg>
        )}
        {showLabel && "Word"}
      </button>

      {open && (
        <div className="absolute right-0 top-full mt-1 z-50 min-w-[140px] rounded-lg border border-[var(--color-border)] bg-[var(--color-surface)] shadow-lg overflow-hidden">
          <button
            onClick={() => handlePick("portrait")}
            className={`w-full flex items-center gap-2 px-3 py-2 text-xs transition-colors hover:bg-[var(--color-accent)]/10 ${defaultOrientation === "portrait" ? "text-[var(--color-accent)] font-medium" : "text-[var(--color-text)]"}`}
          >
            <svg width="12" height="14" viewBox="0 0 12 14" fill="none" stroke="currentColor" strokeWidth="1.2" strokeLinecap="round" strokeLinejoin="round" className="shrink-0">
              <rect x="0.5" y="0.5" width="11" height="13" rx="1" />
            </svg>
            Portrait
          </button>
          <button
            onClick={() => handlePick("landscape")}
            className={`w-full flex items-center gap-2 px-3 py-2 text-xs transition-colors hover:bg-[var(--color-accent)]/10 ${defaultOrientation === "landscape" ? "text-[var(--color-accent)] font-medium" : "text-[var(--color-text)]"}`}
          >
            <svg width="14" height="12" viewBox="0 0 14 12" fill="none" stroke="currentColor" strokeWidth="1.2" strokeLinecap="round" strokeLinejoin="round" className="shrink-0">
              <rect x="0.5" y="0.5" width="13" height="11" rx="1" />
            </svg>
            Landscape
          </button>
        </div>
      )}
    </div>
  );
}
