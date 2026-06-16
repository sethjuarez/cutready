import { useCallback, useEffect, useState } from "react";
import { Database, RefreshCw, Table2 } from "lucide-react";
import { invoke } from "../services/tauri";
import { useAppStore } from "../stores/appStore";
import { AGENT_STATE_DATABASE_PATH, databaseTabPath } from "./DatabaseViewer";

const AGENT_STATE_DB = AGENT_STATE_DATABASE_PATH;

interface DatabasePreview {
  path: string;
  size: number;
  tables: DatabaseTablePreview[];
}

interface DatabaseTablePreview {
  name: string;
  table_type: string;
  row_count: number;
}

const friendlyTableNames: Record<string, string> = {
  agent_runs: "Runs",
  trajectory_events: "Events",
  touched_resources: "Resources",
  checkpoints: "Checkpoints",
  resume_contexts: "Resume Context",
  verification_results: "Verification",
};

export function AgentStateDatabasePanel() {
  const [preview, setPreview] = useState<DatabasePreview | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const activeTab = useAppStore((state) => state.openTabs.find((tab) => tab.id === state.activeTabId) ?? null);
  const openDatabase = useAppStore((state) => state.openDatabase);

  const loadPreview = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const nextPreview = await invoke<DatabasePreview>("get_agent_state_database_preview");
      setPreview(nextPreview);
    } catch (err) {
      setPreview(null);
      setError(String(err));
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void loadPreview();
  }, [loadPreview]);

  return (
    <div className="flex h-full min-h-0 flex-col bg-[rgb(var(--color-surface))]">
      <div className="flex h-[38px] items-center gap-2 border-b border-[rgb(var(--color-border))] px-3">
        <div className="flex min-w-0 flex-1 items-center gap-2">
          <Database className="h-3.5 w-3.5 text-[rgb(var(--color-accent))]" />
          <span className="truncate text-[11px] font-semibold uppercase tracking-[0.14em] text-[rgb(var(--color-text-secondary))]">
            Agent state
          </span>
        </div>
        <button
          className="flex h-6 w-6 items-center justify-center rounded-md text-[rgb(var(--color-text-secondary))] transition-colors hover:bg-[rgb(var(--color-surface-alt))] hover:text-[rgb(var(--color-text))]"
          onClick={() => void loadPreview()}
          title="Refresh database"
        >
          <RefreshCw className={`h-3.5 w-3.5 ${loading ? "animate-spin" : ""}`} />
        </button>
      </div>

      <div className="border-b border-[rgb(var(--color-border))] px-3 py-3">
        <div className="flex items-center gap-2">
          <span className="rounded-xl bg-[rgb(var(--color-accent))]/10 p-2 text-[rgb(var(--color-accent))]">
            <Database className="h-4 w-4" />
          </span>
          <div className="min-w-0">
            <p className="truncate text-sm font-semibold text-[rgb(var(--color-text))]">agent-state.db</p>
            <p className="text-[11px] text-[rgb(var(--color-text-secondary))]">
              {preview ? `${preview.tables.length} tables · ${formatBytes(preview.size)}` : "Local runtime state"}
            </p>
          </div>
        </div>
      </div>

      <div className="flex-1 overflow-y-auto py-1">
        {error ? (
          <StateMessage label="Could not load agent state" detail={error} />
        ) : loading ? (
          <StateMessage label="Loading database..." />
        ) : !preview || preview.tables.length === 0 ? (
          <StateMessage label="No agent-state tables" detail="Run an agent workflow, then refresh this panel." />
        ) : (
          preview.tables.map((table) => (
            <TableListItem
              key={`${table.table_type}:${table.name}`}
              table={table}
              active={activeTab?.type === "database" && activeTab.path === databaseTabPath(AGENT_STATE_DB, table.name)}
              onSelect={() => openDatabase(AGENT_STATE_DB, table.name)}
            />
          ))
        )}
      </div>
    </div>
  );
}

function TableListItem({
  table,
  active,
  onSelect,
}: {
  table: DatabaseTablePreview;
  active: boolean;
  onSelect: () => void;
}) {
  const label = friendlyTableNames[table.name] ?? titleize(table.name);
  return (
    <button
      className={`group w-full border-l-2 px-3 py-2.5 text-left transition-colors ${
        active
          ? "border-[rgb(var(--color-accent))] bg-[rgb(var(--color-accent))]/10"
          : "border-transparent hover:bg-[rgb(var(--color-surface-alt))]"
      }`}
      onClick={onSelect}
    >
      <div className="flex items-center gap-2">
        <span className="flex h-5 w-5 shrink-0 items-center justify-center rounded-full bg-[rgb(var(--color-accent))]/10 text-[rgb(var(--color-accent))]">
          <Table2 className="h-3 w-3" />
        </span>
        <span className="min-w-0 flex-1 truncate text-[12px] font-medium text-[rgb(var(--color-text))]">
          {label}
        </span>
        <span className="rounded-full bg-[rgb(var(--color-surface-alt))] px-1.5 py-0.5 text-[10px] text-[rgb(var(--color-text-secondary))]">
          {table.row_count}
        </span>
      </div>
      <div className="mt-1 truncate pl-7 font-mono text-[10px] text-[rgb(var(--color-text-secondary))]" title={table.name}>
        {table.name}
      </div>
    </button>
  );
}

function StateMessage({ label, detail }: { label: string; detail?: string }) {
  return (
    <div className="px-3 py-6 text-center">
      <p className="text-xs font-medium text-[rgb(var(--color-text))]">{label}</p>
      {detail && <p className="mt-1 text-[11px] leading-5 text-[rgb(var(--color-text-secondary))]">{detail}</p>}
    </div>
  );
}

function titleize(value: string): string {
  return value
    .split("_")
    .filter(Boolean)
    .map((part) => part.charAt(0).toUpperCase() + part.slice(1))
    .join(" ");
}

function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}
