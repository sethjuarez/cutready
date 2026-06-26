import { Sparkles } from "lucide-react";
import type { MouseEventHandler } from "react";

interface FieldAiButtonProps {
  label: string;
  title?: string;
  onClick: MouseEventHandler<HTMLButtonElement>;
  className?: string;
  iconClassName?: string;
}

export function FieldAiButton({
  label,
  title = label,
  onClick,
  className = "",
  iconClassName = "h-3.5 w-3.5",
}: FieldAiButtonProps) {
  return (
    <button
      type="button"
      onClick={onClick}
      className={`inline-flex h-7 w-7 items-center justify-center rounded-md text-[rgb(var(--color-accent))] opacity-0 transition-all hover:bg-[rgb(var(--color-accent))]/10 focus-visible:opacity-100 focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-[rgb(var(--color-accent))]/40 ${className}`}
      title={title}
      aria-label={label}
    >
      <Sparkles className={iconClassName} />
    </button>
  );
}
