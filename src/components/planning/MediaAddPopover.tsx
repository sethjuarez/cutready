import { useEffect, useMemo, useRef, useState, type KeyboardEvent as ReactKeyboardEvent } from "react";
import { createPortal } from "react-dom";
import { usePopover } from "../../hooks/usePopover";
import { Sparkles, Image as ImageIcon, Folder, Plus, Camera, ClipboardPaste, Mic, type LucideIcon } from "lucide-react";


/* ── Media add popover — single "+" button expands to action list ── */

interface MediaAddPopoverProps {
  idx: number;
  assetKind: "visual" | "narration";
  hasNarration: boolean;
  hasPrimaryAsset: boolean;
  variant?: "compact" | "placeholder";
  onCaptureScreenshot?: (idx: number) => void;
  onPasteImage?: (idx: number) => void;
  onPickImage?: (idx: number) => void;
  onBrowseImage?: (idx: number) => void;
  onGenerateVisual?: (idx: number) => void;
  onStartNarrationRecording?: (idx: number) => void;
  onGenerateNarration?: (idx: number) => void;
  onPickNarration?: (idx: number) => void;
}

export function MediaAddPopover({
  idx,
  assetKind,
  hasNarration,
  hasPrimaryAsset,
  variant = "compact",
  onCaptureScreenshot,
  onPasteImage,
  onPickImage,
  onBrowseImage,
  onGenerateVisual,
  onStartNarrationRecording,
  onGenerateNarration,
  onPickNarration,
}: MediaAddPopoverProps) {
  const { state, ref, addRef, toggle, close } = usePopover();
  const itemsRef = useRef<(HTMLButtonElement | null)[]>([]);
  const buttonRef = useRef<HTMLButtonElement>(null);
  const portalRef = useRef<HTMLDivElement>(null);
  const [pos, setPos] = useState<{ top: number; left: number } | null>(null);

  // Register the portaled menu container so clicks inside don't trigger close
  useEffect(() => { addRef(portalRef); }, [addRef]);

  const items = useMemo(() => {
    const list: { icon: LucideIcon; label: string; action: () => void; disabled?: boolean; title?: string }[] = [];
    if (assetKind === "visual") {
      const imageVerb = hasPrimaryAsset ? "Replace" : "Add";
      list.push({ icon: Camera, label: `${imageVerb} screenshot`, action: () => onCaptureScreenshot?.(idx) });
      if (onPasteImage) list.push({ icon: ClipboardPaste, label: `${imageVerb} from clipboard`, action: () => onPasteImage(idx) });
      if (onPickImage) list.push({ icon: ImageIcon, label: `${imageVerb} from workspace`, action: () => onPickImage(idx) });
      if (onBrowseImage) list.push({ icon: Folder, label: `${imageVerb} from file`, action: () => onBrowseImage(idx) });
      if (onGenerateVisual) list.push({ icon: Sparkles, label: hasPrimaryAsset ? "Replace with visual" : "Generate visual", action: () => onGenerateVisual(idx) });
    } else if (assetKind === "narration") {
      const narrationVerb = hasNarration ? "Replace" : "Add";
      list.push({
        icon: Sparkles,
        label: "Generate narration",
        action: () => onGenerateNarration?.(idx),
        disabled: !onGenerateNarration,
        title: onGenerateNarration ? undefined : "Generate narration is not wired yet",
      });
      if (onStartNarrationRecording) list.push({ icon: Mic, label: `${narrationVerb} narration`, action: () => onStartNarrationRecording(idx) });
      if (onPickNarration) list.push({ icon: Folder, label: `${narrationVerb} from workspace`, action: () => onPickNarration(idx) });
    }
    return list;
  }, [assetKind, hasNarration, hasPrimaryAsset, idx, onCaptureScreenshot, onPasteImage, onPickImage, onBrowseImage, onGenerateVisual, onStartNarrationRecording, onGenerateNarration, onPickNarration]);

  const handleItemClick = (action: () => void) => {
    close();
    action();
  };

  const handleKeyDown = (e: ReactKeyboardEvent, index: number) => {
    if (e.key === "ArrowDown") {
      e.preventDefault();
      const next = (index + 1) % items.length;
      itemsRef.current[next]?.focus();
    } else if (e.key === "ArrowUp") {
      e.preventDefault();
      const prev = (index - 1 + items.length) % items.length;
      itemsRef.current[prev]?.focus();
    }
  };

  // Compute position when popover opens
  useEffect(() => {
    if (state !== null && buttonRef.current) {
      const rect = buttonRef.current.getBoundingClientRect();
      setPos({ top: rect.top, left: rect.left });
    } else {
      setPos(null);
    }
  }, [state]);

  // Close on scroll
  useEffect(() => {
    if (state === null) return;
    const handleScroll = () => close();
    window.addEventListener("scroll", handleScroll, true);
    return () => window.removeEventListener("scroll", handleScroll, true);
  }, [state, close]);

  // Focus first item when popover opens
  useEffect(() => {
    if (state !== null) {
      requestAnimationFrame(() => itemsRef.current[0]?.focus());
    }
  }, [state]);

  return (
    <div ref={ref} className="relative inline-flex">
      <button
        ref={buttonRef}
        onClick={toggle}
        className={`${variant === "placeholder" ? "h-7 w-7" : "h-8 w-8"} rounded-md border border-dashed border-[rgb(var(--color-border))] hover:border-[rgb(var(--color-accent))] hover:bg-[rgb(var(--color-accent))]/5 transition-colors flex items-center justify-center`}
        title="Add media"
        aria-expanded={state !== null}
        aria-haspopup="true"
      >
        <Plus className="w-4 h-4 text-[rgb(var(--color-text-secondary))]" />
      </button>
      {state !== null && pos && createPortal(
        <div
          ref={portalRef}
          className="fixed z-dropdown min-w-[170px] py-1 bg-[rgb(var(--color-surface))] border border-[rgb(var(--color-border))] rounded-lg shadow-lg"
          style={{ top: pos.top, left: pos.left, transform: "translateY(-100%) translateY(-4px)" }}
          role="menu"
        >
          {items.map((item, i) => {
            const Icon = item.icon;
            return (
              <button
                key={item.label}
                ref={(el) => { itemsRef.current[i] = el; }}
                role="menuitem"
                tabIndex={0}
                onClick={() => {
                  if (!item.disabled) handleItemClick(item.action);
                }}
                onKeyDown={(e) => handleKeyDown(e, i)}
                aria-disabled={item.disabled ? "true" : undefined}
                title={item.title}
                className={`w-full flex items-center gap-2 px-3 py-1.5 text-xs text-[rgb(var(--color-text-secondary))] transition-colors text-left ${
                  item.disabled
                    ? "cursor-not-allowed opacity-45"
                    : "hover:text-[rgb(var(--color-accent))] hover:bg-[rgb(var(--color-accent))]/5"
                }`}
              >
                <Icon className="w-3.5 h-3.5 flex-shrink-0" />
                {item.label}
              </button>
            );
          })}
        </div>,
        document.body,
      )}
    </div>
  );
}

