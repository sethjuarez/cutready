import { Copy, Minus, Square, X } from "lucide-react";
import type { ReactNode } from "react";

interface WindowControlsProps {
  maximized: boolean;
  onMinimize: () => void;
  onMaximize: () => void;
  onClose: () => void;
}

/** Windows/Linux caption buttons. macOS uses native traffic lights instead. */
export function WindowControls({ maximized, onMinimize, onMaximize, onClose }: WindowControlsProps) {
  return (
    <div className="ml-1.5 flex h-full items-stretch" onMouseDown={(event) => event.stopPropagation()}>
      <CaptionButton label="Minimize" onClick={onMinimize}>
        <Minus className="h-4 w-4" strokeWidth={1.5} aria-hidden="true" />
      </CaptionButton>
      <CaptionButton label={maximized ? "Restore" : "Maximize"} onClick={onMaximize}>
        {maximized ? (
          <Copy className="h-3.5 w-3.5" strokeWidth={1.5} aria-hidden="true" />
        ) : (
          <Square className="h-3.5 w-3.5" strokeWidth={1.5} aria-hidden="true" />
        )}
      </CaptionButton>
      <CaptionButton label="Close" onClick={onClose} danger>
        <X className="h-4 w-4" strokeWidth={1.5} aria-hidden="true" />
      </CaptionButton>
    </div>
  );
}

function CaptionButton({
  label,
  onClick,
  danger = false,
  children,
}: {
  label: string;
  onClick: () => void;
  danger?: boolean;
  children: ReactNode;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      aria-label={label}
      title={label}
      className={[
        "inline-flex h-full w-[46px] items-center justify-center text-[rgb(var(--color-text))]",
        "transition-colors duration-fast ease-fluent focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-[rgb(var(--color-accent))]",
        danger
          ? "hover:bg-error hover:text-accent-fg active:bg-error/90"
          : "hover:bg-fill-hover active:bg-fill-pressed",
      ].join(" ")}
    >
      {children}
    </button>
  );
}
