import { useEffect, useRef, useState } from "react";
import type { WordOrientation } from "../utils/exportToWord";
import { FileText } from "lucide-react";

interface ExportWordButtonProps {
  onExport: (orientation: WordOrientation) => void | Promise<void>;
  disabled?: boolean;
  /** Show "Word" label next to icon. Default: false */
  showLabel?: boolean;
  /** Default orientation. Default: "landscape" */
  defaultOrientation?: WordOrientation;
  className?: string;
}

export function WordDocumentIcon({ className = "h-3.5 w-3.5" }: { className?: string }) {
  return (
    <span className={`relative inline-flex items-center justify-center ${className}`}>
      <FileText className="h-full w-full" />
      <span className="absolute -bottom-0.5 -right-0.5 rounded-[2px] bg-[rgb(var(--color-surface))] px-[1px] text-[7px] font-semibold leading-none text-[rgb(var(--color-accent))]">W</span>
    </span>
  );
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
    "flex items-center gap-1.5 shrink-0 text-xs text-[rgb(var(--color-text-secondary))] hover:text-[rgb(var(--color-accent))] px-3 py-1.5 rounded-lg border border-[rgb(var(--color-border))] hover:border-[rgb(var(--color-accent))]/40 hover:bg-[rgb(var(--color-accent))]/5 transition-colors disabled:opacity-30 disabled:cursor-not-allowed";

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
          <WordDocumentIcon />
        )}
        {showLabel && "Word"}
      </button>

      {open && (
        <div className="absolute right-0 top-full mt-1 z-dropdown min-w-[140px] rounded-lg border border-[rgb(var(--color-border))] bg-[rgb(var(--color-surface))] shadow-lg overflow-hidden">
          <button
            onClick={() => handlePick("portrait")}
            className={`w-full flex items-center gap-2 px-3 py-2 text-xs transition-colors hover:bg-[rgb(var(--color-accent))]/10 ${defaultOrientation === "portrait" ? "text-[rgb(var(--color-accent))] font-medium" : "text-[rgb(var(--color-text))]"}`}
          >
            <FileText className="shrink-0 w-3.5 h-3.5" />
            Portrait
          </button>
          <button
            onClick={() => handlePick("landscape")}
            className={`w-full flex items-center gap-2 px-3 py-2 text-xs transition-colors hover:bg-[rgb(var(--color-accent))]/10 ${defaultOrientation === "landscape" ? "text-[rgb(var(--color-accent))] font-medium" : "text-[rgb(var(--color-text))]"}`}
          >
            <FileText className="shrink-0 w-3.5 h-3.5" />
            Landscape
          </button>
        </div>
      )}
    </div>
  );
}
