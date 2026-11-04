import { useEffect, useId, useRef, useState, type KeyboardEvent, type ReactNode } from "react";
import { Check, ChevronDown } from "lucide-react";

export interface HomeDropdownOption {
  value: string;
  label: string;
  description?: string;
  icon?: ReactNode;
}

export interface HomeDropdownAction {
  label: string;
  icon?: ReactNode;
  onSelect: () => void;
}

interface HomeDropdownProps {
  /** Accessible name of the picker, e.g. "Project". */
  label: string;
  options: HomeDropdownOption[];
  selected: string | null;
  onSelect: (value: string) => void;
  /** Text on the trigger when nothing is selected. */
  placeholder?: string;
  icon?: ReactNode;
  /** A command listed under the options, e.g. "Open folder…". */
  action?: HomeDropdownAction;
  loading?: boolean;
  emptyText?: string;
  testId?: string;
}

const itemSelector = '[data-dropdown-item="true"]';

/** A compact picker for the composer bar: one trigger, one listbox, and an optional trailing command. */
export function HomeDropdown({
  label,
  options,
  selected,
  onSelect,
  placeholder = "Choose",
  icon,
  action,
  loading = false,
  emptyText = "Nothing to choose",
  testId,
}: HomeDropdownProps) {
  const [open, setOpen] = useState(false);
  const rootRef = useRef<HTMLDivElement>(null);
  const triggerRef = useRef<HTMLButtonElement>(null);
  const listRef = useRef<HTMLDivElement>(null);
  const listId = useId();
  const current = options.find((option) => option.value === selected);

  useEffect(() => {
    if (!open) return;
    const items = Array.from(listRef.current?.querySelectorAll<HTMLElement>(itemSelector) ?? []);
    (items.find((item) => item.getAttribute("aria-selected") === "true") ?? items[0])?.focus();
    const onPointer = (event: MouseEvent) => {
      if (!rootRef.current?.contains(event.target as Node)) setOpen(false);
    };
    document.addEventListener("mousedown", onPointer);
    return () => document.removeEventListener("mousedown", onPointer);
  }, [open, loading]);

  const close = (refocus = true) => {
    setOpen(false);
    if (refocus) triggerRef.current?.focus();
  };

  const choose = (value: string) => {
    onSelect(value);
    close();
  };

  const onListKeyDown = (event: KeyboardEvent<HTMLDivElement>) => {
    const items = Array.from(listRef.current?.querySelectorAll<HTMLElement>(itemSelector) ?? []);
    const index = items.indexOf(document.activeElement as HTMLElement);
    const move = (next: number) => items[(next + items.length) % items.length]?.focus();
    switch (event.key) {
      case "ArrowDown": move(index + 1); break;
      case "ArrowUp": move(index - 1); break;
      case "Home": move(0); break;
      case "End": move(items.length - 1); break;
      case "Escape": close(); break;
      case "Tab": close(false); return;
      default: return;
    }
    event.preventDefault();
  };

  return (
    <div ref={rootRef} className="relative min-w-0">
      <button
        ref={triggerRef}
        type="button"
        data-testid={testId}
        aria-haspopup="listbox"
        aria-expanded={open}
        aria-controls={open ? listId : undefined}
        aria-label={`${label}: ${current?.label ?? placeholder}`}
        title={current?.description ?? current?.label ?? label}
        onClick={() => setOpen((value) => !value)}
        onKeyDown={(event) => {
          if (event.key === "ArrowDown" || event.key === "ArrowUp") {
            event.preventDefault();
            setOpen(true);
          } else if (event.key === "Escape" && open) {
            event.preventDefault();
            setOpen(false);
          }
        }}
        className="inline-flex h-7 max-w-[200px] items-center gap-1.5 rounded-control px-2 text-sm text-[rgb(var(--color-text-secondary))] transition-colors duration-fast hover:bg-fill-hover hover:text-[rgb(var(--color-text))] focus:outline-none focus-visible:ring-2 focus-visible:ring-[rgb(var(--color-accent))]"
      >
        {icon && <span aria-hidden="true" className="flex shrink-0">{icon}</span>}
        <span className="truncate">{current?.label ?? placeholder}</span>
        <ChevronDown aria-hidden="true" className="h-3.5 w-3.5 shrink-0" />
      </button>
      {open && (
        <div
          ref={listRef}
          onKeyDown={onListKeyDown}
          className="absolute left-0 top-full z-dropdown mt-1 w-64 overflow-hidden rounded-card border border-[rgb(var(--color-border))] bg-[rgb(var(--color-surface))] py-1 shadow-lg"
        >
          <div id={listId} role="listbox" aria-label={label} className="max-h-64 overflow-y-auto">
            {loading ? (
              <p className="px-3 py-2 text-sm text-[rgb(var(--color-text-secondary))]">Loading…</p>
            ) : options.length === 0 ? (
              <p className="px-3 py-2 text-sm text-[rgb(var(--color-text-secondary))]">{emptyText}</p>
            ) : (
              options.map((option) => {
                const isSelected = option.value === selected;
                return (
                  <div
                    key={option.value}
                    role="option"
                    tabIndex={-1}
                    data-dropdown-item="true"
                    aria-selected={isSelected}
                    title={option.description}
                    onClick={() => choose(option.value)}
                    onKeyDown={(event) => {
                      if (event.key === "Enter" || event.key === " ") {
                        event.preventDefault();
                        choose(option.value);
                      }
                    }}
                    className="flex cursor-pointer items-center gap-2 px-3 py-1.5 text-sm text-[rgb(var(--color-text))] outline-none hover:bg-fill-hover focus:bg-fill-hover"
                  >
                    <Check aria-hidden="true" className={`h-3.5 w-3.5 shrink-0 text-[rgb(var(--color-accent))] ${isSelected ? "" : "invisible"}`} />
                    {option.icon && <span aria-hidden="true" className="flex shrink-0">{option.icon}</span>}
                    <span className="min-w-0 flex-1">
                      <span className="block truncate">{option.label}</span>
                      {option.description && (
                        <span className="block truncate text-xs text-[rgb(var(--color-text-secondary))]">{option.description}</span>
                      )}
                    </span>
                  </div>
                );
              })
            )}
          </div>
          {action && (
            <>
              <div className="my-1 h-px bg-[rgb(var(--color-border-subtle))]" />
              <button
                type="button"
                data-dropdown-item="true"
                tabIndex={-1}
                onClick={() => { close(); action.onSelect(); }}
                className="flex w-full items-center gap-2 px-3 py-1.5 text-left text-sm text-[rgb(var(--color-text))] outline-none hover:bg-fill-hover focus:bg-fill-hover"
              >
                <span aria-hidden="true" className="flex h-3.5 w-3.5 shrink-0 items-center justify-center">{action.icon}</span>
                {action.label}
              </button>
            </>
          )}
        </div>
      )}
    </div>
  );
}
