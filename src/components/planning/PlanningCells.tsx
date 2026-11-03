import { useEffect, useRef, useState, type ReactNode } from "react";
import { Sparkles, Lock, Unlock } from "lucide-react";
import remarkBreaks from "remark-breaks";
import remarkGfm from "remark-gfm";
import { SafeMarkdown } from "../SafeMarkdown";
import { continueMarkdownList } from "../../utils/markdownList";


/* ── Local-state input (immune to debounced prop lag) ──────── */

export function LocalInput({
  value,
  onChange,
  placeholder,
  label,
  readOnly,
  onAddRow,
  hasActionRail = false,
}: {
  value: string;
  onChange: (v: string) => void;
  placeholder: string;
  label?: string;
  readOnly: boolean;
  onAddRow?: () => void;
  hasActionRail?: boolean;
}) {
  const [local, setLocal] = useState(value);
  const isFocusedRef = useRef(false);

  useEffect(() => {
    if (!isFocusedRef.current) setLocal(value);
  }, [value]);

  return (
    <input
      type="text"
      value={local}
      onChange={(e) => {
        setLocal(e.target.value);
        onChange(e.target.value);
      }}
      onFocus={() => { isFocusedRef.current = true; }}
      onBlur={() => { isFocusedRef.current = false; }}
      onKeyDown={(e) => {
        if (e.key === "Tab") {
          e.preventDefault();
          const moved = focusAdjacentCell(e.currentTarget, e.shiftKey);
          if (!moved && !e.shiftKey && onAddRow) onAddRow();
        }
      }}
      placeholder={placeholder}
      aria-label={label}
      readOnly={readOnly}
      className={`w-full bg-transparent text-sm font-semibold tabular-nums py-0.5 rounded outline-none transition-colors focus:ring-1 focus:ring-[rgb(var(--color-accent))]/40 placeholder:text-[rgb(var(--color-text-secondary))]/40 ${hasActionRail ? "pl-1 pr-5" : "px-1"}`}
    />
  );
}

/** Move focus to the next (or previous) editable cell in the table.
 *  Returns true if focus moved, false if there was no cell to move to. */
export function focusAdjacentCell(from: HTMLElement, reverse = false): boolean {
  const table = from.closest(".script-table-wrapper");
  if (!table) return false;
  // Use data-tab-order for explicit tab sequence
  const cells = Array.from(
    table.querySelectorAll<HTMLElement>("[data-tab-cell]"),
  );
  // Sort by data-tab-cell numeric value for correct order
  cells.sort((a, b) => {
    const ai = parseInt(a.getAttribute("data-tab-cell") || "0", 10);
    const bi = parseInt(b.getAttribute("data-tab-cell") || "0", 10);
    return ai - bi;
  });
  const own = from.closest("[data-tab-cell]");
  const idx = cells.findIndex((el) => el === own);
  if (idx === -1) return false;
  const next = cells[reverse ? idx - 1 : idx + 1];
  if (next) {
    // Find the first focusable element inside the wrapper
    const focusable = next.querySelector<HTMLElement>(
      "input, textarea, [tabindex='0'], [data-cell]"
    );
    if (focusable) { focusable.focus(); } else { next.focus(); }
    return true;
  }
  return false;
}

/* ── Markdown Cell: edit raw markdown, preview formatted ───── */

export function MarkdownCell({
  value,
  onChange,
  placeholder,
  label,
  readOnly,
  onAddRow,
  hasActionRail = false,
}: {
  value: string;
  onChange: (v: string) => void;
  placeholder: string;
  label?: string;
  readOnly: boolean;
  onAddRow?: () => void;
  hasActionRail?: boolean;
}){
  const [isEditing, setIsEditing] = useState(false);
  const [localValue, setLocalValue] = useState(value);
  const textareaRef = useRef<HTMLTextAreaElement>(null);
  const cursorRef = useRef<number | null>(null);
  const isEditingRef = useRef(false);
  isEditingRef.current = isEditing;

  // Sync from parent when value changes externally (not while editing)
  useEffect(() => {
    if (!isEditingRef.current) setLocalValue(value);
  }, [value]);

  // Auto-resize textarea
  useEffect(() => {
    if (isEditing && textareaRef.current) {
      const el = textareaRef.current;
      el.style.height = "auto";
      el.style.height = el.scrollHeight + "px";
    }
  }, [localValue, isEditing]);

  // Restore cursor after programmatic value changes
  useEffect(() => {
    if (cursorRef.current !== null && textareaRef.current) {
      textareaRef.current.selectionStart = textareaRef.current.selectionEnd =
        cursorRef.current;
      cursorRef.current = null;
    }
  }, [localValue]);

  // Focus when entering edit mode
  useEffect(() => {
    if (isEditing && textareaRef.current) {
      textareaRef.current.focus();
      const len = textareaRef.current.value.length;
      textareaRef.current.selectionStart = textareaRef.current.selectionEnd = len;
    }
  }, [isEditing]);

  const handleChange = (newValue: string) => {
    setLocalValue(newValue);
    onChange(newValue);
  };

  // Preview mode — use localValue to preserve edits before debounce saves
  if (readOnly || !isEditing) {
    return (
      <div
        data-cell
        role="textbox"
        aria-readonly={readOnly || undefined}
        aria-label={label}
        tabIndex={readOnly ? undefined : 0}
        className={`md-cell-preview min-h-[1.5rem] rounded outline-none transition-colors ${hasActionRail ? "pr-7" : ""} ${!readOnly ? "cursor-text focus:ring-1 focus:ring-[rgb(var(--color-accent))]/40" : ""}`}
        onClick={() => {
          if (!readOnly) setIsEditing(true);
        }}
        onFocus={() => {
          if (!readOnly) setIsEditing(true);
        }}
        onKeyDown={(e) => {
          if (readOnly) return;
          if (e.key === "Tab") {
            e.preventDefault();
            const td = (e.target as HTMLElement).closest<HTMLElement>("[data-tab-cell]");
            if (td) {
              const moved = focusAdjacentCell(td, e.shiftKey);
              if (!moved && !e.shiftKey && onAddRow) onAddRow();
            }
            return;
          }
          if (e.key === "Enter" || e.key === " ") {
            e.preventDefault();
            setIsEditing(true);
          }
        }}
      >
        <SafeMarkdown
          placeholder={placeholder}
          placeholderClassName="text-[rgb(var(--color-text-secondary))] opacity-40"
          remarkPlugins={[remarkGfm, remarkBreaks]}
        >
          {localValue}
        </SafeMarkdown>
      </div>
    );
  }

  // Edit mode
  return (
    <textarea
      ref={textareaRef}
      value={localValue}
      onChange={(e) => handleChange(e.target.value)}
      onBlur={() => setIsEditing(false)}
      placeholder={placeholder}
      aria-label={label}
      rows={1}
      className={`md-cell-editor w-full bg-transparent p-0 rounded outline-none resize-none ring-1 ring-[rgb(var(--color-accent))]/40 placeholder:text-[rgb(var(--color-text-secondary))]/40 ${hasActionRail ? "pr-7" : "pr-0"}`}
      onKeyDown={(e) => {
        // Tab / Shift+Tab → move to adjacent cell
        if (e.key === "Tab") {
          e.preventDefault();
          // Capture the cell before setIsEditing removes textarea from DOM
          const td = (e.target as HTMLElement).closest<HTMLElement>("[data-tab-cell]");
          setIsEditing(false);
          requestAnimationFrame(() => {
            if (td) {
              const moved = focusAdjacentCell(td, e.shiftKey);
              if (!moved && !e.shiftKey && onAddRow) onAddRow();
            }
          });
          return;
        }
        // Escape → exit edit mode
        if (e.key === "Escape") {
          e.preventDefault();
          setIsEditing(false);
          return;
        }
        if (e.key === "Enter" && (e.ctrlKey || e.metaKey)) {
          e.preventDefault();
          e.stopPropagation();
          setIsEditing(false);
          return;
        }
        if (e.key !== "Enter") return;
        if (continueMarkdownList({
          value: localValue,
          selectionStart: e.currentTarget.selectionStart,
          selectionEnd: e.currentTarget.selectionEnd,
          onChange: handleChange,
          setCursor: (position) => { cursorRef.current = position; },
        })) {
          e.preventDefault();
        }
      }}
    />
  );
}

/* ── Sparkle button — appears on hover for AI-assisted editing ── */

export function CellActionRail({ children, persistent = false }: { children: ReactNode; persistent?: boolean }) {
  return (
    <div className={`absolute right-0.5 top-0.5 z-[1] flex w-4 flex-col items-center gap-0.5 transition-opacity group-hover/cell:opacity-100 focus-within:opacity-100 ${persistent ? "opacity-100" : "opacity-0"}`}>
      {children}
    </div>
  );
}

export function SparkleButton({ onClick }: { onClick: () => void }) {
  return (
    <button
      onClick={(e) => { e.stopPropagation(); onClick(); }}
      className="p-0.5 rounded text-[rgb(var(--color-accent))] hover:bg-[rgb(var(--color-accent))]/10"
      title="Improve with AI"
    >
      <Sparkles className="w-3 h-3" />
    </button>
  );
}

export function CellLockButton({ locked, onClick, label, className = "" }: { locked: boolean; onClick: () => void; label?: string; className?: string }) {
  const name = `${locked ? "Unlock" : "Lock"} ${label ?? "cell"}`;
  return (
    <button
      onClick={(e) => { e.stopPropagation(); onClick(); }}
      className={`inline-flex h-4 w-4 items-center justify-center rounded border transition-colors ${
        locked
          ? "border-[rgb(var(--color-warning))]/25 bg-[rgb(var(--color-warning))]/10 text-[rgb(var(--color-warning))]"
          : "border-transparent text-[rgb(var(--color-text-secondary))] hover:border-[rgb(var(--color-border))] hover:bg-[rgb(var(--color-surface-alt))] hover:text-[rgb(var(--color-accent))]"
      } ${className}`}
      title={locked ? "Unlock cell" : "Lock cell"}
      aria-label={name}
    >
      {locked ? <Lock className="w-3 h-3" /> : <Unlock className="w-3 h-3" />}
    </button>
  );
}
