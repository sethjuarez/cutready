import { useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { ChevronRight } from "lucide-react";

export interface ContextMenuItem {
  label: string;
  icon?: React.ReactNode;
  action?: () => void;
  submenu?: ContextMenuItem[];
  disabled?: boolean;
  separator?: boolean;
}

interface Props {
  items: ContextMenuItem[];
  position: { x: number; y: number };
  onClose: () => void;
}

export function ContextMenu({ items, position, onClose }: Props) {
  const menuRef = useRef<HTMLDivElement>(null);
  const [pos, setPos] = useState(position);

  // Adjust position after mount to avoid viewport overflow
  useEffect(() => {
    if (!menuRef.current) return;
    const rect = menuRef.current.getBoundingClientRect();
    let { x, y } = position;
    if (x + rect.width > window.innerWidth - 8) x = window.innerWidth - rect.width - 8;
    if (y + rect.height > window.innerHeight - 8) y = window.innerHeight - rect.height - 8;
    setPos({ x, y });
  }, []); // eslint-disable-line react-hooks/exhaustive-deps

  useEffect(() => {
    const handleClick = (e: MouseEvent) => {
      if (menuRef.current && !menuRef.current.contains(e.target as Node)) onClose();
    };
    const handleKey = (e: KeyboardEvent) => { if (e.key === "Escape") onClose(); };
    document.addEventListener("mousedown", handleClick);
    document.addEventListener("keydown", handleKey);
    return () => {
      document.removeEventListener("mousedown", handleClick);
      document.removeEventListener("keydown", handleKey);
    };
  }, [onClose]);

  return createPortal(
    <div
      ref={menuRef}
      style={{ position: "fixed", left: pos.x, top: pos.y }}
      className="z-[50] min-w-[180px] bg-[rgb(var(--color-surface))] border border-[rgb(var(--color-border))] rounded-lg shadow-xl py-1 text-xs"
    >
      {items.map((item, i) =>
        item.separator ? (
          <div key={i} className="my-1 h-px bg-[rgb(var(--color-border-subtle))]" />
        ) : (
          <MenuItemRow key={i} item={item} onClose={onClose} />
        )
      )}
    </div>,
    document.body
  );
}

function MenuItemRow({ item, onClose }: { item: ContextMenuItem; onClose: () => void }) {
  const [showSub, setShowSub] = useState(false);

  return (
    <div
      className={`relative flex items-center gap-2 px-3 py-1.5 select-none transition-colors ${
        item.disabled
          ? "text-[rgb(var(--color-text-secondary))]/40 cursor-not-allowed"
          : "text-[rgb(var(--color-text))] hover:bg-[rgb(var(--color-surface-alt))] cursor-pointer"
      }`}
      onMouseEnter={() => !item.disabled && item.submenu && setShowSub(true)}
      onMouseLeave={() => item.submenu && setShowSub(false)}
      onClick={() => {
        if (item.disabled || item.submenu) return;
        item.action?.();
        onClose();
      }}
    >
      {item.icon && <span className="shrink-0 w-3.5 h-3.5 flex items-center justify-center opacity-70">{item.icon}</span>}
      <span className="flex-1">{item.label}</span>
      {item.submenu && <ChevronRight className="w-3 h-3 shrink-0 text-[rgb(var(--color-text-secondary))]" />}

      {showSub && item.submenu && (
        <div className="absolute left-full top-[-2px] ml-0.5 min-w-[160px] bg-[rgb(var(--color-surface))] border border-[rgb(var(--color-border))] rounded-lg shadow-xl py-1 z-[51]">
          {item.submenu.map((sub, si) =>
            sub.separator ? (
              <div key={si} className="my-1 h-px bg-[rgb(var(--color-border-subtle))]" />
            ) : (
              <div
                key={si}
                className={`flex items-center gap-2 px-3 py-1.5 select-none transition-colors ${
                  sub.disabled
                    ? "text-[rgb(var(--color-text-secondary))]/40 cursor-not-allowed"
                    : "text-[rgb(var(--color-text))] hover:bg-[rgb(var(--color-surface-alt))] cursor-pointer"
                }`}
                onClick={(e) => {
                  if (sub.disabled) return;
                  e.stopPropagation();
                  sub.action?.();
                  onClose();
                }}
              >
                {sub.icon && <span className="shrink-0 w-3.5 h-3.5 flex items-center justify-center opacity-70">{sub.icon}</span>}
                <span className="flex-1">{sub.label}</span>
              </div>
            )
          )}
        </div>
      )}
    </div>
  );
}
