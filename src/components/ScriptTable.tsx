import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import {
  DndContext,
  closestCenter,
  PointerSensor,
  useSensor,
  useSensors,
  type DragEndEvent,
  DragOverlay,
} from "@dnd-kit/core";
import {
  SortableContext,
  useSortable,
  verticalListSortingStrategy,
} from "@dnd-kit/sortable";
import { CSS } from "@dnd-kit/utilities";
import type { PlanningRow } from "../types/sketch";

function emptyRow(): PlanningRow {
  return { time: "", narrative: "", demo_actions: "", screenshot: null };
}

interface ScriptTableProps {
  rows: PlanningRow[];
  onChange: (rows: PlanningRow[]) => void;
  readOnly?: boolean;
}

export function ScriptTable({ rows, onChange, readOnly = false }: ScriptTableProps) {
  const [activeId, setActiveId] = useState<string | null>(null);

  const sensors = useSensors(
    useSensor(PointerSensor, { activationConstraint: { distance: 5 } }),
  );

  // Always-current ref to avoid stale closure issues in callbacks
  const rowsRef = useRef(rows);
  rowsRef.current = rows;

  // Stable IDs for each row (index-based, reset when row count changes)
  const rowIds = useMemo(
    () => rows.map((_, i) => `row-${i}`),
    [rows.length],
  );

  const updateRow = useCallback(
    (index: number, field: keyof PlanningRow, value: string) => {
      const updated = rowsRef.current.map((r, i) =>
        i === index ? { ...r, [field]: value } : r,
      );
      onChange(updated);
    },
    [onChange],
  );

  const addRow = useCallback(
    (afterIndex: number) => {
      const updated = [...rowsRef.current];
      updated.splice(afterIndex + 1, 0, emptyRow());
      onChange(updated);
    },
    [onChange],
  );

  const deleteRow = useCallback(
    (index: number) => {
      if (rowsRef.current.length <= 1) return;
      const updated = rowsRef.current.filter((_, i) => i !== index);
      onChange(updated);
    },
    [onChange],
  );

  const handleDragEnd = useCallback(
    (event: DragEndEvent) => {
      const { active, over } = event;
      setActiveId(null);
      if (!over || active.id === over.id) return;
      const oldIndex = rowIds.indexOf(active.id as string);
      const newIndex = rowIds.indexOf(over.id as string);
      if (oldIndex === -1 || newIndex === -1) return;
      const updated = [...rowsRef.current];
      const [moved] = updated.splice(oldIndex, 1);
      updated.splice(newIndex, 0, moved);
      onChange(updated);
    },
    [onChange, rowIds],
  );

  const displayRows = rows.length === 0 ? [emptyRow()] : rows;
  const activeIdx = activeId ? rowIds.indexOf(activeId) : -1;

  return (
    <div className="script-table-wrapper my-4 rounded-xl border border-[var(--color-border)] overflow-hidden">
      <table className="w-full border-collapse" style={{ tableLayout: "fixed" }}>
        <colgroup>
          {!readOnly && <col style={{ width: 28 }} />}
          <col style={{ width: 54 }} />
          <col />
          <col />
          <col style={{ width: 80 }} />
          {!readOnly && <col style={{ width: 36 }} />}
        </colgroup>
        <thead>
          <tr className="bg-[var(--color-surface-alt)]">
            {!readOnly && <th className="script-table-th" />}
            <th className="script-table-th">Time</th>
            <th className="script-table-th">Narrative</th>
            <th className="script-table-th">Actions</th>
            <th className="script-table-th">Screenshot</th>
            {!readOnly && <th className="script-table-th" />}
          </tr>
        </thead>
        <DndContext
          sensors={sensors}
          collisionDetection={closestCenter}
          onDragStart={(e) => setActiveId(e.active.id as string)}
          onDragEnd={handleDragEnd}
        >
          <SortableContext items={rowIds} strategy={verticalListSortingStrategy}>
            <tbody>
              {displayRows.map((row, idx) => (
                <SortableRow
                  key={rowIds[idx]}
                  id={rowIds[idx]}
                  row={row}
                  idx={idx}
                  readOnly={readOnly}
                  updateRow={updateRow}
                  addRow={addRow}
                  deleteRow={deleteRow}
                  isDragging={activeIdx === idx}
                />
              ))}
            </tbody>
          </SortableContext>
          <DragOverlay>
            {activeIdx >= 0 ? (
              <table className="w-full border-collapse">
                <tbody>
                  <tr className="bg-[var(--color-surface-alt)] border border-[var(--color-accent)] shadow-lg">
                    {!readOnly && <td className="p-1 w-7" />}
                    <td className="script-table-td text-xs" style={{ width: 50 }}>{displayRows[activeIdx].time}</td>
                    <td className="script-table-td text-xs">
                      {displayRows[activeIdx].narrative || "—"}
                    </td>
                    <td className="script-table-td text-xs">
                      {displayRows[activeIdx].demo_actions || "—"}
                    </td>
                    <td className="script-table-td text-xs text-center">—</td>
                    {!readOnly && <td className="script-table-td" />}
                  </tr>
                </tbody>
              </table>
            ) : null}
          </DragOverlay>
        </DndContext>
      </table>
    </div>
  );
}

/* ── Sortable Row ──────────────────────────────────────────── */

function SortableRow({
  id,
  row,
  idx,
  readOnly,
  updateRow,
  addRow,
  deleteRow,
  isDragging,
}: {
  id: string;
  row: PlanningRow;
  idx: number;
  readOnly: boolean;
  updateRow: (index: number, field: keyof PlanningRow, value: string) => void;
  addRow: (afterIndex: number) => void;
  deleteRow: (index: number) => void;
  isDragging: boolean;
}) {
  const {
    attributes,
    listeners,
    setNodeRef,
    transform,
    transition,
    isSorting,
  } = useSortable({ id });

  const style = {
    transform: CSS.Transform.toString(transform),
    transition,
    opacity: isDragging ? 0.3 : 1,
  };

  return (
    <tr
      ref={setNodeRef}
      style={style}
      className={`group border-t border-[var(--color-border)] ${isSorting ? "" : "transition-colors"}`}
    >
      {!readOnly && (
        <td className="p-0 align-middle">
          <div
            className="cursor-grab active:cursor-grabbing opacity-30 group-hover:opacity-100 transition-opacity text-[var(--color-text-secondary)] hover:text-[var(--color-text)] flex items-center justify-center h-full"
            {...attributes}
            {...listeners}
          >
            <svg width="12" height="12" viewBox="0 0 24 24" fill="currentColor">
              <circle cx="9" cy="5" r="1.5" />
              <circle cx="15" cy="5" r="1.5" />
              <circle cx="9" cy="12" r="1.5" />
              <circle cx="15" cy="12" r="1.5" />
              <circle cx="9" cy="19" r="1.5" />
              <circle cx="15" cy="19" r="1.5" />
            </svg>
          </div>
        </td>
      )}
      <td className="py-2 px-1.5 align-top text-[0.8125rem]">
        <LocalInput
          value={row.time}
          onChange={(v) => updateRow(idx, "time", v)}
          placeholder="~30s"
          readOnly={readOnly}
        />
      </td>
      <td className="script-table-td align-top overflow-hidden">
        <MarkdownCell
          value={row.narrative}
          onChange={(v) => updateRow(idx, "narrative", v)}
          placeholder="What to say..."
          readOnly={readOnly}
        />
      </td>
      <td className="script-table-td align-top overflow-hidden">
        <MarkdownCell
          value={row.demo_actions}
          onChange={(v) => updateRow(idx, "demo_actions", v)}
          placeholder="What to do..."
          readOnly={readOnly}
        />
      </td>
      <td className="script-table-td align-top text-center">
        {row.screenshot ? (
          <div className="w-16 h-12 rounded-md bg-[var(--color-surface-alt)] border border-[var(--color-border)] overflow-hidden">
            <img src={row.screenshot} alt="" className="w-full h-full object-cover" />
          </div>
        ) : (
          <span className="text-[10px] text-[var(--color-text-secondary)]">—</span>
        )}
      </td>
      {!readOnly && (
        <td className="p-1 align-top">
          <div className="flex flex-col gap-0.5 opacity-0 group-hover:opacity-100 transition-opacity">
            <button
              onClick={() => addRow(idx)}
              className="p-0.5 rounded text-[var(--color-text-secondary)] hover:text-[var(--color-accent)] transition-colors"
              title="Add row below"
            >
              <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                <line x1="12" y1="5" x2="12" y2="19" />
                <line x1="5" y1="12" x2="19" y2="12" />
              </svg>
            </button>
            <button
              onClick={() => deleteRow(idx)}
              className="p-0.5 rounded text-[var(--color-text-secondary)] hover:text-red-500 transition-colors"
              title="Delete row"
            >
              <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                <line x1="18" y1="6" x2="6" y2="18" />
                <line x1="6" y1="6" x2="18" y2="18" />
              </svg>
            </button>
          </div>
        </td>
      )}
    </tr>
  );
}

/* ── Local-state input (immune to debounced prop lag) ──────── */

function LocalInput({
  value,
  onChange,
  placeholder,
  readOnly,
}: {
  value: string;
  onChange: (v: string) => void;
  placeholder: string;
  readOnly: boolean;
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
      placeholder={placeholder}
      readOnly={readOnly}
      className="w-full bg-transparent text-xs px-1 py-0.5 rounded outline-none transition-colors focus:ring-1 focus:ring-[var(--color-accent)]/40 placeholder:text-[var(--color-text-secondary)]/40"
    />
  );
}

/** Move focus to the next (or previous) editable cell in the table. */
function focusAdjacentCell(from: HTMLElement, reverse = false) {
  const table = from.closest("table");
  if (!table) return;
  const cells = Array.from(
    table.querySelectorAll<HTMLElement>("input:not([readonly]), [data-cell]"),
  );
  const td = from.closest("td");
  const idx = cells.findIndex((el) => td?.contains(el));
  const next = cells[reverse ? idx - 1 : idx + 1];
  if (next) next.focus();
}

/* ── Inline formatting: **bold** and *italic* ──────────────── */

function formatInline(text: string): ReactNode {
  const parts: ReactNode[] = [];
  const regex = /(\*\*(.+?)\*\*|\*(.+?)\*)/g;
  let lastIndex = 0;
  let match;
  let key = 0;

  while ((match = regex.exec(text)) !== null) {
    if (match.index > lastIndex) {
      parts.push(text.slice(lastIndex, match.index));
    }
    if (match[2]) {
      parts.push(<strong key={key++}>{match[2]}</strong>);
    } else if (match[3]) {
      parts.push(<em key={key++}>{match[3]}</em>);
    }
    lastIndex = regex.lastIndex;
  }

  if (lastIndex === 0) return text;
  if (lastIndex < text.length) parts.push(text.slice(lastIndex));
  return <>{parts}</>;
}

/* ── Markdown block renderer ───────────────────────────────── */

function renderMarkdown(text: string): ReactNode {
  if (!text.trim()) return null;

  const lines = text.split("\n");
  const blocks: ReactNode[] = [];
  let i = 0;
  let bk = 0;

  while (i < lines.length) {
    const line = lines[i];

    // Bullet list (- or *)
    if (/^[-*]\s/.test(line)) {
      const items: string[] = [];
      while (i < lines.length && /^[-*]\s/.test(lines[i])) {
        items.push(lines[i].replace(/^[-*]\s/, ""));
        i++;
      }
      blocks.push(
        <ul key={bk++} className="md-cell-ul">
          {items.map((item, j) => (
            <li key={j}>{formatInline(item)}</li>
          ))}
        </ul>,
      );
      continue;
    }

    // Numbered list
    if (/^\d+\.\s/.test(line)) {
      const items: string[] = [];
      while (i < lines.length && /^\d+\.\s/.test(lines[i])) {
        items.push(lines[i].replace(/^\d+\.\s/, ""));
        i++;
      }
      blocks.push(
        <ol key={bk++} className="md-cell-ol">
          {items.map((item, j) => (
            <li key={j}>{formatInline(item)}</li>
          ))}
        </ol>,
      );
      continue;
    }

    // Empty line
    if (!line.trim()) {
      i++;
      continue;
    }

    // Paragraph
    blocks.push(
      <p key={bk++} className="md-cell-p">
        {formatInline(line)}
      </p>,
    );
    i++;
  }

  return <>{blocks}</>;
}

/* ── Markdown Cell: edit raw markdown, preview formatted ───── */

function MarkdownCell({
  value,
  onChange,
  placeholder,
  readOnly,
}: {
  value: string;
  onChange: (v: string) => void;
  placeholder: string;
  readOnly: boolean;
}) {
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
    const rendered = renderMarkdown(localValue);
    return (
      <div
        data-cell
        tabIndex={readOnly ? undefined : 0}
        className={`md-cell-preview min-h-[1.5rem] rounded outline-none transition-colors ${!readOnly ? "cursor-text focus:ring-1 focus:ring-[var(--color-accent)]/40" : ""}`}
        onClick={() => {
          if (!readOnly) setIsEditing(true);
        }}
        onFocus={() => {
          if (!readOnly) setIsEditing(true);
        }}
        onKeyDown={(e) => {
          if (!readOnly && e.key === "Enter") {
            e.preventDefault();
            setIsEditing(true);
          }
        }}
      >
        {rendered || (
          <span className="text-xs text-[var(--color-text-secondary)] opacity-40">
            {placeholder}
          </span>
        )}
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
      className="w-full bg-transparent text-xs px-1 py-0.5 rounded outline-none resize-none ring-1 ring-[var(--color-accent)]/40 placeholder:text-[var(--color-text-secondary)]/40"
      onKeyDown={(e) => {
        // Tab / Shift+Tab → move to adjacent cell
        if (e.key === "Tab") {
          e.preventDefault();
          // Capture td before setIsEditing removes textarea from DOM
          const td = (e.target as HTMLElement).closest("td");
          setIsEditing(false);
          requestAnimationFrame(() => {
            if (td) focusAdjacentCell(td, e.shiftKey);
          });
          return;
        }
        // Escape → exit edit mode
        if (e.key === "Escape") {
          e.preventDefault();
          setIsEditing(false);
          return;
        }
        if (e.key !== "Enter") return;
        const pos = e.currentTarget.selectionStart;
        const before = localValue.slice(0, pos);
        const after = localValue.slice(pos);
        const lastLine = before.split("\n").pop() || "";

        // Auto-continue bullet lists
        const bulletMatch = lastLine.match(/^([-*])\s(.*)/);
        if (bulletMatch) {
          e.preventDefault();
          if (!bulletMatch[2].trim()) {
            // Empty bullet → end the list
            const lineStart = before.lastIndexOf("\n") + 1;
            handleChange(localValue.slice(0, lineStart) + after);
            cursorRef.current = lineStart;
            return;
          }
          const prefix = bulletMatch[1] + " ";
          handleChange(before + "\n" + prefix + after);
          cursorRef.current = pos + 1 + prefix.length;
          return;
        }

        // Auto-continue numbered lists
        const numMatch = lastLine.match(/^(\d+)\.\s(.*)/);
        if (numMatch) {
          e.preventDefault();
          if (!numMatch[2].trim()) {
            // Empty numbered item → end the list
            const lineStart = before.lastIndexOf("\n") + 1;
            handleChange(localValue.slice(0, lineStart) + after);
            cursorRef.current = lineStart;
            return;
          }
          const prefix = parseInt(numMatch[1]) + 1 + ". ";
          handleChange(before + "\n" + prefix + after);
          cursorRef.current = pos + 1 + prefix.length;
          return;
        }
      }}
    />
  );
}
