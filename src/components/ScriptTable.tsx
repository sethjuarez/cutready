import { useCallback, useState } from "react";
import type { PlanningRow } from "../types/sketch";

/** Generates a simple unique ID for planning rows. */
function rowId(): string {
  return crypto.randomUUID();
}

function emptyRow(): PlanningRow {
  return { id: rowId(), time: "", narrative: "", demo_actions: "", screenshot: null };
}

interface ScriptTableProps {
  rows: PlanningRow[];
  onChange: (rows: PlanningRow[]) => void;
  readOnly?: boolean;
}

export function ScriptTable({ rows, onChange, readOnly = false }: ScriptTableProps) {
  const [focusedCell, setFocusedCell] = useState<{ row: number; col: string } | null>(null);

  const updateRow = useCallback(
    (index: number, field: keyof PlanningRow, value: string) => {
      const updated = rows.map((r, i) =>
        i === index ? { ...r, [field]: value } : r,
      );
      onChange(updated);
    },
    [rows, onChange],
  );

  const addRow = useCallback(
    (afterIndex: number) => {
      const updated = [...rows];
      updated.splice(afterIndex + 1, 0, emptyRow());
      onChange(updated);
    },
    [rows, onChange],
  );

  const deleteRow = useCallback(
    (index: number) => {
      if (rows.length <= 1) return;
      const updated = rows.filter((_, i) => i !== index);
      onChange(updated);
    },
    [rows, onChange],
  );

  // Ensure at least one row
  const displayRows = rows.length === 0 ? [emptyRow()] : rows;

  return (
    <div className="script-table-wrapper my-4 rounded-xl border border-[var(--color-border)] overflow-hidden">
      <table className="w-full border-collapse">
        <thead>
          <tr className="bg-[var(--color-surface-alt)]">
            <th className="script-table-th" style={{ width: "80px" }}>Time</th>
            <th className="script-table-th">Narrative</th>
            <th className="script-table-th">Demo Actions</th>
            <th className="script-table-th" style={{ width: "100px" }}>Screenshot</th>
            {!readOnly && <th className="script-table-th" style={{ width: "36px" }} />}
          </tr>
        </thead>
        <tbody>
          {displayRows.map((row, idx) => (
            <tr key={row.id} className="group border-t border-[var(--color-border)]">
              <td className="script-table-td align-top">
                <CellInput
                  value={row.time}
                  onChange={(v) => updateRow(idx, "time", v)}
                  placeholder="~30s"
                  readOnly={readOnly}
                  focused={focusedCell?.row === idx && focusedCell?.col === "time"}
                  onFocus={() => setFocusedCell({ row: idx, col: "time" })}
                  onBlur={() => setFocusedCell(null)}
                />
              </td>
              <td className="script-table-td align-top">
                <CellTextarea
                  value={row.narrative}
                  onChange={(v) => updateRow(idx, "narrative", v)}
                  placeholder="What to say..."
                  readOnly={readOnly}
                  focused={focusedCell?.row === idx && focusedCell?.col === "narrative"}
                  onFocus={() => setFocusedCell({ row: idx, col: "narrative" })}
                  onBlur={() => setFocusedCell(null)}
                />
              </td>
              <td className="script-table-td align-top">
                <CellTextarea
                  value={row.demo_actions}
                  onChange={(v) => updateRow(idx, "demo_actions", v)}
                  placeholder="What to do..."
                  readOnly={readOnly}
                  focused={focusedCell?.row === idx && focusedCell?.col === "demo_actions"}
                  onFocus={() => setFocusedCell({ row: idx, col: "demo_actions" })}
                  onBlur={() => setFocusedCell(null)}
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
                <td className="script-table-td align-top">
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
          ))}
        </tbody>
      </table>
    </div>
  );
}

function CellInput({
  value,
  onChange,
  placeholder,
  readOnly,
  focused,
  onFocus,
  onBlur,
}: {
  value: string;
  onChange: (v: string) => void;
  placeholder: string;
  readOnly: boolean;
  focused: boolean;
  onFocus: () => void;
  onBlur: () => void;
}) {
  return (
    <input
      type="text"
      value={value}
      onChange={(e) => onChange(e.target.value)}
      placeholder={placeholder}
      readOnly={readOnly}
      onFocus={onFocus}
      onBlur={onBlur}
      className={`w-full bg-transparent text-xs px-1 py-0.5 rounded outline-none transition-colors ${
        focused ? "ring-1 ring-[var(--color-accent)]/40" : ""
      } placeholder:text-[var(--color-text-secondary)]/40`}
    />
  );
}

function CellTextarea({
  value,
  onChange,
  placeholder,
  readOnly,
  focused,
  onFocus,
  onBlur,
}: {
  value: string;
  onChange: (v: string) => void;
  placeholder: string;
  readOnly: boolean;
  focused: boolean;
  onFocus: () => void;
  onBlur: () => void;
}) {
  return (
    <textarea
      value={value}
      onChange={(e) => onChange(e.target.value)}
      placeholder={placeholder}
      readOnly={readOnly}
      onFocus={onFocus}
      onBlur={onBlur}
      rows={2}
      className={`w-full bg-transparent text-xs px-1 py-0.5 rounded outline-none resize-none transition-colors ${
        focused ? "ring-1 ring-[var(--color-accent)]/40" : ""
      } placeholder:text-[var(--color-text-secondary)]/40`}
    />
  );
}
