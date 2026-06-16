import { useEffect, useMemo, useState } from "react";
import { Database, KeyRound, Table2 } from "lucide-react";
import { invoke } from "../services/tauri";

interface DatabasePreview {
  path: string;
  size: number;
  tables: DatabaseTablePreview[];
}

interface DatabaseTablePreview {
  name: string;
  table_type: string;
  row_count: number;
  columns: DatabaseColumnPreview[];
  rows: DatabaseCellPreview[][];
}

interface DatabaseColumnPreview {
  name: string;
  data_type: string;
  not_null: boolean;
  primary_key: boolean;
}

interface DatabaseCellPreview {
  kind: string;
  value: string | null;
}

export const AGENT_STATE_DATABASE_PATH = "cutready://agent-state";

export function DatabaseViewer({ path }: { path: string }) {
  const { databasePath, tableName } = parseDatabaseTabPath(path);
  const [preview, setPreview] = useState<DatabasePreview | null>(null);
  const [selectedTable, setSelectedTable] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    setError(null);
    const request = databasePath === AGENT_STATE_DATABASE_PATH
      ? invoke<DatabasePreview>("get_agent_state_database_preview")
      : invoke<DatabasePreview>("get_database_preview", { relativePath: databasePath });
    request
      .then((result) => {
        if (cancelled) return;
        setPreview(result);
        setSelectedTable(tableName ?? result.tables[0]?.name ?? null);
      })
      .catch((err) => {
        if (!cancelled) setError(String(err));
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [databasePath, tableName]);

  const table = useMemo(
    () => preview?.tables.find((candidate) => candidate.name === selectedTable) ?? preview?.tables[0] ?? null,
    [preview, selectedTable],
  );
  const showTableSidebar = !tableName;

  if (loading) {
    return (
      <div className="flex h-full items-center justify-center bg-[rgb(var(--color-surface))] text-sm text-[rgb(var(--color-text-secondary))]">
        Reading database...
      </div>
    );
  }

  if (error || !preview) {
    return (
      <div className="flex h-full items-center justify-center bg-[rgb(var(--color-surface))] px-6">
        <div className="max-w-lg rounded-2xl border border-[rgb(var(--color-border))] bg-[rgb(var(--color-surface-alt))] p-5 shadow-sm">
          <p className="text-sm font-medium text-[rgb(var(--color-text))]">Could not open database</p>
          <p className="mt-2 text-xs leading-5 text-[rgb(var(--color-text-secondary))]">{error ?? "The file is not a readable SQLite database."}</p>
        </div>
      </div>
    );
  }

  return (
    <div className="flex h-full min-h-0 bg-[rgb(var(--color-surface))] text-[rgb(var(--color-text))]">
      {showTableSidebar && (
        <aside className="flex w-64 shrink-0 flex-col border-r border-[rgb(var(--color-border))] bg-[rgb(var(--color-surface-inset))]">
          <div className="border-b border-[rgb(var(--color-border))] p-4">
            <div className="flex items-center gap-2">
              <span className="rounded-xl bg-[rgb(var(--color-accent))]/10 p-2 text-[rgb(var(--color-accent))]">
                <Database className="h-4 w-4" />
              </span>
              <div className="min-w-0">
                <p className="truncate text-sm font-semibold">{basename(preview.path)}</p>
                <p className="text-[11px] text-[rgb(var(--color-text-secondary))]">{formatBytes(preview.size)}</p>
              </div>
            </div>
            <p className="mt-3 truncate font-mono text-[10px] text-[rgb(var(--color-text-secondary))]" title={preview.path}>
              {preview.path}
            </p>
          </div>

          <div className="flex-1 overflow-y-auto p-2">
            {preview.tables.length === 0 ? (
              <p className="px-2 py-3 text-xs text-[rgb(var(--color-text-secondary))]">No user tables found.</p>
            ) : (
              preview.tables.map((candidate) => {
                const selected = candidate.name === table?.name;
                return (
                  <button
                    key={`${candidate.table_type}:${candidate.name}`}
                    onClick={() => setSelectedTable(candidate.name)}
                    className={`flex w-full items-center gap-2 rounded-lg px-2.5 py-2 text-left transition-colors ${
                      selected
                        ? "bg-[rgb(var(--color-accent))]/10 text-[rgb(var(--color-accent))]"
                        : "text-[rgb(var(--color-text-secondary))] hover:bg-[rgb(var(--color-surface-alt))] hover:text-[rgb(var(--color-text))]"
                    }`}
                  >
                    <Table2 className="h-3.5 w-3.5 shrink-0" />
                    <span className="min-w-0 flex-1 truncate text-xs font-medium">{candidate.name}</span>
                    <span className="rounded-full bg-[rgb(var(--color-surface-alt))] px-1.5 py-0.5 text-[10px] text-[rgb(var(--color-text-secondary))]">
                      {candidate.row_count}
                    </span>
                  </button>
                );
              })
            )}
          </div>
        </aside>
      )}

      <main className="flex min-w-0 flex-1 flex-col">
        {table ? (
          <>
            <header className="shrink-0 border-b border-[rgb(var(--color-border))] bg-[rgb(var(--color-surface))] px-5 py-4">
              <div className="flex items-start justify-between gap-4">
                <div className="min-w-0">
                  <p className="text-[11px] font-medium uppercase tracking-wider text-[rgb(var(--color-text-secondary))]">
                    {table.table_type}
                  </p>
                  <h2 className="mt-1 truncate text-lg font-semibold">{table.name}</h2>
                </div>
                <div className="flex shrink-0 items-center gap-2 text-[11px] text-[rgb(var(--color-text-secondary))]">
                  <span className="rounded-full border border-[rgb(var(--color-border))] px-2 py-1">
                    {table.columns.length} columns
                  </span>
                  <span className="rounded-full border border-[rgb(var(--color-border))] px-2 py-1">
                    {table.row_count} rows
                  </span>
                </div>
              </div>
            </header>

            <div className="grid shrink-0 grid-cols-2 gap-3 border-b border-[rgb(var(--color-border))] bg-[rgb(var(--color-surface-alt))]/50 p-4">
              {table.columns.map((column) => (
                <div key={column.name} className="rounded-xl border border-[rgb(var(--color-border))] bg-[rgb(var(--color-surface))] px-3 py-2">
                  <div className="flex items-center gap-2">
                    {column.primary_key && <KeyRound className="h-3 w-3 text-[rgb(var(--color-accent))]" />}
                    <span className="truncate font-mono text-xs font-medium">{column.name}</span>
                    <span className="ml-auto text-[10px] uppercase text-[rgb(var(--color-text-secondary))]">
                      {column.data_type || "any"}
                    </span>
                  </div>
                  {column.not_null && (
                    <p className="mt-1 text-[10px] text-[rgb(var(--color-text-secondary))]">not null</p>
                  )}
                </div>
              ))}
            </div>

            <div className="min-h-0 flex-1 overflow-auto">
              <table className="w-full table-fixed border-separate border-spacing-0 text-left text-xs">
                <thead className="sticky top-0 z-10 bg-[rgb(var(--color-surface-inset))]">
                  <tr>
                    {table.columns.map((column) => (
                      <th key={column.name} className="border-b border-r border-[rgb(var(--color-border))] px-3 py-2 font-mono font-semibold">
                        {column.name}
                      </th>
                    ))}
                  </tr>
                </thead>
                <tbody>
                  {table.rows.length === 0 ? (
                    <tr>
                      <td className="px-3 py-8 text-center text-[rgb(var(--color-text-secondary))]" colSpan={Math.max(table.columns.length, 1)}>
                        No rows to preview.
                      </td>
                    </tr>
                  ) : (
                    table.rows.map((row, rowIndex) => (
                      <tr key={rowIndex} className="odd:bg-[rgb(var(--color-surface-alt))]/35">
                        {row.map((cell, cellIndex) => (
                          <td key={cellIndex} className="max-w-[24rem] overflow-hidden border-b border-r border-[rgb(var(--color-border))]/60 px-3 py-2 align-top">
                            <span className={`block max-h-32 overflow-y-auto whitespace-pre-wrap break-all leading-5 ${cell.kind === "null" ? "italic text-[rgb(var(--color-text-secondary))]" : "font-mono text-[rgb(var(--color-text))]"}`}>
                              {cell.value ?? "NULL"}
                            </span>
                          </td>
                        ))}
                      </tr>
                    ))
                  )}
                </tbody>
              </table>
            </div>

            {table.row_count > table.rows.length && (
              <div className="shrink-0 border-t border-[rgb(var(--color-border))] bg-[rgb(var(--color-surface-inset))] px-4 py-2 text-[11px] text-[rgb(var(--color-text-secondary))]">
                Showing first {table.rows.length} rows.
              </div>
            )}
          </>
        ) : (
          <div className="flex h-full items-center justify-center text-sm text-[rgb(var(--color-text-secondary))]">
            Select a table to inspect.
          </div>
        )}
      </main>
    </div>
  );
}

function basename(path: string): string {
  return path.split(/[\\/]/).filter(Boolean).pop() ?? path;
}

export function databaseTabPath(databasePath: string, tableName?: string): string {
  return tableName ? `${databasePath}#${encodeURIComponent(tableName)}` : databasePath;
}

export function parseDatabaseTabPath(path: string): { databasePath: string; tableName: string | null } {
  const [databasePath, rawTableName] = path.split("#", 2);
  return {
    databasePath,
    tableName: rawTableName ? decodeURIComponent(rawTableName) : null,
  };
}

function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}
