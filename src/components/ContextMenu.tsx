import { useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { ChevronRight } from "lucide-react";

export interface ContextMenuItem {
  label?: string;
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
    const previous = document.activeElement as HTMLElement | null;
    const menu = menuRef.current;
    if (menu) enabledItems(menu)[0]?.focus();
    return () => {
      // Restore focus only if the closing menu took it with it; an action may have focused something new.
      const active = document.activeElement;
      if (!active || active === document.body || menu?.contains(active)) previous?.focus?.();
    };
  }, []);

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
      role="menu"
      onKeyDown={handleMenuKeyDown}
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

function enabledItems(menu: Element): HTMLElement[] {
  return Array.from(menu.querySelectorAll<HTMLElement>(':scope > [role="menuitem"]')).filter(
    (el) => el.getAttribute("aria-disabled") !== "true",
  );
}

function handleMenuKeyDown(e: React.KeyboardEvent<HTMLDivElement>) {
  const item = (e.target as HTMLElement).closest<HTMLElement>('[role="menuitem"]');
  const menu = item?.parentElement;
  if (!item || !menu) return;
  const list = enabledItems(menu);
  const index = list.indexOf(item);
  const move = (next: number) => list[(next + list.length) % list.length]?.focus();
  switch (e.key) {
    case "ArrowDown": move(index + 1); break;
    case "ArrowUp": move(index - 1); break;
    case "Home": move(0); break;
    case "End": move(list.length - 1); break;
    case "Enter":
    case " ":
      item.click();
      break;
    default:
      return;
  }
  e.preventDefault();
}

function MenuItemRow({ item, onClose }: { item: ContextMenuItem; onClose: () => void }) {
  const [showSub, setShowSub] = useState(false);
  const rowRef = useRef<HTMLDivElement>(null);
  const subRef = useRef<HTMLDivElement>(null);
  const focusSubOnOpen = useRef(false);

  useEffect(() => {
    if (showSub && focusSubOnOpen.current && subRef.current) {
      focusSubOnOpen.current = false;
      enabledItems(subRef.current)[0]?.focus();
    }
  }, [showSub]);

  return (
    <div
      ref={rowRef}
      tabIndex={-1}
      onKeyDown={(e) => {
        if (!item.submenu || item.disabled) return;
        if (e.target === rowRef.current && (e.key === "ArrowRight" || e.key === "Enter" || e.key === " ")) {
          focusSubOnOpen.current = true;
          setShowSub(true);
          e.preventDefault();
          e.stopPropagation();
        } else if (e.target !== rowRef.current && e.key === "ArrowLeft") {
          setShowSub(false);
          rowRef.current?.focus();
          e.preventDefault();
          e.stopPropagation();
        }
      }}
      role="menuitem"
      aria-disabled={item.disabled || undefined}
      aria-haspopup={item.submenu ? "menu" : undefined}
      aria-expanded={item.submenu ? showSub : undefined}
      className={`relative flex items-center outline-none gap-2 px-3 py-1.5 select-none transition-colors ${
        item.disabled
          ? "text-[rgb(var(--color-text-secondary))]/40 cursor-not-allowed"
          : "text-[rgb(var(--color-text))] hover:bg-[rgb(var(--color-surface-alt))] focus:bg-[rgb(var(--color-surface-alt))] cursor-pointer"
      }`}
      onMouseEnter={() => !item.disabled && item.submenu && setShowSub(true)}
      onMouseLeave={() => item.submenu && setShowSub(false)}
      onClick={() => {
        if (item.disabled) return;
        if (item.submenu) {
          setShowSub(true);
          return;
        }
        item.action?.();
        onClose();
      }}
    >
      {item.icon && <span className="shrink-0 w-3.5 h-3.5 flex items-center justify-center opacity-70">{item.icon}</span>}
      <span className="flex-1">{item.label}</span>
      {item.submenu && <ChevronRight className="w-3 h-3 shrink-0 text-[rgb(var(--color-text-secondary))]" />}

      {showSub && item.submenu && (
        <div ref={subRef} role="menu" aria-label={item.label} className="absolute left-full top-[-2px] ml-0.5 min-w-[160px] bg-[rgb(var(--color-surface))] border border-[rgb(var(--color-border))] rounded-lg shadow-xl py-1 z-[51]">
          {item.submenu.map((sub, si) =>
            sub.separator ? (
              <div key={si} className="my-1 h-px bg-[rgb(var(--color-border-subtle))]" />
            ) : (
              <div
                key={si}
                tabIndex={-1}
                role="menuitem"
                aria-disabled={sub.disabled || undefined}
                className={`flex items-center gap-2 outline-none px-3 py-1.5 select-none transition-colors ${
                  sub.disabled
                    ? "text-[rgb(var(--color-text-secondary))]/40 cursor-not-allowed"
                    : "text-[rgb(var(--color-text))] hover:bg-[rgb(var(--color-surface-alt))] focus:bg-[rgb(var(--color-surface-alt))] cursor-pointer"
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
