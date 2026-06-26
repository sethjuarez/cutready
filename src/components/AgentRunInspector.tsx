import { useCallback, useEffect, useMemo, useState, type ReactNode } from "react";
import {
  Bot,
  CheckCircle2,
  CircleDashed,
  Clock3,
  Database,
  FileStack,
  GitCommitHorizontal,
  MoreHorizontal,
  RefreshCw,
  ShieldCheck,
  Trash2,
  XCircle,
} from "lucide-react";
import { invoke } from "../services/tauri";
import { useAppStore } from "../stores/appStore";
import { useToastStore } from "../stores/toastStore";
import { useConfirmDialog } from "./ConfirmDialog";

type JsonValue = null | boolean | number | string | JsonValue[] | { [key: string]: JsonValue };

interface AgentRunSummary {
  run_id: string;
  parent_run_id: string | null;
  provider: string;
  model: string;
  status: string;
  started_at: string;
  completed_at: string | null;
  initial_goal: string | null;
  trajectory_event_count: number;
  touched_resource_count: number;
  checkpoint_count: number;
  resume_context_count: number;
  verification_result_count: number;
}

interface AgentTrajectoryEventRecord {
  id: number;
  event_id: string | null;
  parent_event_id: string | null;
  iteration: number | null;
  event_type: string;
  created_at: string;
  event: JsonValue;
}

interface AgentTouchedResourceRecord {
  id: number;
  kind: string;
  resource_id: string;
  operation: string;
  created_at: string;
  resource: JsonValue;
}

interface AgentCheckpointRecord {
  id: string;
  created_at: string;
  checkpoint: JsonValue;
}

interface AgentResumeContextRecord {
  id: number;
  checkpoint_id: string;
  created_at: string;
  context: JsonValue;
}

interface AgentVerificationResultRecord {
  id: number;
  criterion: string;
  status: string;
  created_at: string;
  result: JsonValue;
}

interface AgentRunDetail {
  run: AgentRunSummary;
  metadata: JsonValue;
  trajectory_events: AgentTrajectoryEventRecord[];
  touched_resources: AgentTouchedResourceRecord[];
  checkpoints: AgentCheckpointRecord[];
  resume_contexts: AgentResumeContextRecord[];
  verification_results: AgentVerificationResultRecord[];
}

interface AgentStateMaintenanceResult {
  deleted_runs: number;
  deleted_rows: number;
  size_before: number;
  size_after: number;
}

export function AgentRunInspector() {
  const [runs, setRuns] = useState<AgentRunSummary[]>([]);
  const [loadingRuns, setLoadingRuns] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [busyRunId, setBusyRunId] = useState<string | null>(null);
  const [maintenanceBusy, setMaintenanceBusy] = useState(false);
  const activeTab = useAppStore((state) => state.openTabs.find((tab) => tab.id === state.activeTabId) ?? null);
  const openTabs = useAppStore((state) => state.openTabs);
  const openTab = useAppStore((state) => state.openTab);
  const closeTab = useAppStore((state) => state.closeTab);
  const showToast = useToastStore((state) => state.show);
  const hasRunningRun = useMemo(() => runs.some((run) => run.status.toLowerCase() === "running"), [runs]);
  const { confirm, confirmationDialog } = useConfirmDialog();

  const loadRuns = useCallback(async () => {
    setLoadingRuns(true);
    setError(null);
    try {
      const nextRuns = await invoke<AgentRunSummary[]>("list_agent_runs", { limit: 30 });
      setRuns(nextRuns);
    } catch (err) {
      setError(String(err));
    } finally {
      setLoadingRuns(false);
    }
  }, []);

  useEffect(() => {
    void loadRuns();
  }, [loadRuns]);

  useEffect(() => {
    const handleRunsUpdated = () => {
      void loadRuns();
    };
    window.addEventListener("cutready:agent-runs-updated", handleRunsUpdated);
    return () => window.removeEventListener("cutready:agent-runs-updated", handleRunsUpdated);
  }, [loadRuns]);

  const deleteRun = useCallback(async (run: AgentRunSummary) => {
    const confirmed = await confirm({
      title: "Delete agent run?",
      message: `Delete run ${shortId(run.run_id)} and its runtime records?\n\nThis only removes local agent trajectory data. It will not delete sketches, notes, visuals, or accepted project content.`,
      confirmLabel: "Delete run",
      variant: "error",
    });
    if (!confirmed) return;
    setBusyRunId(run.run_id);
    try {
      const result = await invoke<AgentStateMaintenanceResult>("delete_agent_run", { runId: run.run_id });
      const tabPath = agentRunTabPath(run.run_id);
      const runTab = openTabs.find((tab) => tab.type === "agent-run" && tab.path === tabPath);
      if (runTab) closeTab(runTab.id);
      showToast(`Deleted ${result.deleted_rows} run record${result.deleted_rows === 1 ? "" : "s"}`, 3000, "success");
      await loadRuns();
    } catch (err) {
      showToast(`Could not delete run: ${String(err)}`, 5000, "error");
    } finally {
      setBusyRunId(null);
    }
  }, [closeTab, confirm, loadRuns, openTabs, showToast]);

  const pruneRuns = useCallback(async () => {
    const confirmed = await confirm({
      title: "Prune old agent runs?",
      message: "Prune completed agent runs, keeping the 25 most recent completed runs?\n\nRunning runs and agent memory are preserved. This only removes older local trajectory/checkpoint/resource records.",
      confirmLabel: "Prune old runs",
      variant: "warning",
    });
    if (!confirmed) return;
    setMaintenanceBusy(true);
    try {
      const result = await invoke<AgentStateMaintenanceResult>("prune_agent_runs", { keepRecentCompleted: 25 });
      showToast(`Pruned ${result.deleted_runs} run${result.deleted_runs === 1 ? "" : "s"} (${result.deleted_rows} rows)`, 3500, "success");
      await loadRuns();
    } catch (err) {
      showToast(`Could not prune runs: ${String(err)}`, 5000, "error");
    } finally {
      setMaintenanceBusy(false);
    }
  }, [confirm, loadRuns, showToast]);

  const compactDatabase = useCallback(async () => {
    if (hasRunningRun) {
      showToast("Wait for the active agent run to finish before compacting the database.", 4000, "warning");
      return;
    }
    const confirmed = await confirm({
      title: "Compact agent database?",
      message: "Compact the local agent-state database now?\n\nThis runs SQLite VACUUM after cleanup. It may briefly lock the local runtime database.",
      confirmLabel: "Compact",
      variant: "warning",
    });
    if (!confirmed) return;
    setMaintenanceBusy(true);
    try {
      const result = await invoke<AgentStateMaintenanceResult>("compact_agent_state_database");
      showToast(`Compacted database: ${formatBytes(result.size_before)} → ${formatBytes(result.size_after)}`, 3500, "success");
    } catch (err) {
      showToast(`Could not compact database: ${String(err)}`, 5000, "error");
    } finally {
      setMaintenanceBusy(false);
    }
  }, [confirm, hasRunningRun, showToast]);

  return (
    <div className="flex h-full min-h-0 flex-col bg-[rgb(var(--color-surface))]">
      <div className="flex h-[38px] items-center gap-2 border-b border-[rgb(var(--color-border))] px-3">
        <div className="flex min-w-0 flex-1 items-center gap-2">
          <Bot className="h-3.5 w-3.5 text-[rgb(var(--color-accent))]" />
          <span className="truncate text-[11px] font-semibold uppercase tracking-[0.14em] text-[rgb(var(--color-text-secondary))]">
            Agent runs
          </span>
        </div>
        <button
          className="flex h-6 w-6 items-center justify-center rounded-md text-[rgb(var(--color-text-secondary))] transition-colors hover:bg-[rgb(var(--color-surface-alt))] hover:text-[rgb(var(--color-text))]"
          onClick={() => void loadRuns()}
          title="Refresh runs"
        >
          <RefreshCw className={`h-3.5 w-3.5 ${loadingRuns ? "animate-spin" : ""}`} />
        </button>
      </div>

      <div className="flex items-center gap-1 border-b border-[rgb(var(--color-border))] bg-[rgb(var(--color-surface-inset))] px-2 py-1.5">
        <button
          className="flex flex-1 items-center justify-center gap-1 rounded-lg px-2 py-1.5 text-[11px] text-[rgb(var(--color-text-secondary))] transition-colors hover:bg-[rgb(var(--color-surface))] hover:text-[rgb(var(--color-text))] disabled:cursor-not-allowed disabled:opacity-50"
          onClick={() => void pruneRuns()}
          disabled={maintenanceBusy || loadingRuns}
          title="Keep the 25 most recent completed runs and remove older completed runtime records"
        >
          <MoreHorizontal className="h-3 w-3" />
          Prune old
        </button>
        <button
          className="flex flex-1 items-center justify-center gap-1 rounded-lg px-2 py-1.5 text-[11px] text-[rgb(var(--color-text-secondary))] transition-colors hover:bg-[rgb(var(--color-surface))] hover:text-[rgb(var(--color-text))] disabled:cursor-not-allowed disabled:opacity-50"
          onClick={() => void compactDatabase()}
          disabled={maintenanceBusy || hasRunningRun}
          title={hasRunningRun ? "Wait for the active agent run to finish before compacting" : "Vacuum the local agent-state database"}
        >
          <Database className="h-3 w-3" />
          Compact
        </button>
      </div>

      <div className="flex-1 overflow-y-auto py-1">
        {error ? (
          <StateMessage label="Could not load agent runs" detail={error} />
        ) : loadingRuns ? (
          <StateMessage label="Loading runs..." />
        ) : runs.length === 0 ? (
          <StateMessage label="No runs yet" detail="Send an agent message that uses project tools, then refresh this list to inspect the run." />
        ) : (
          runs.map((run) => (
            <RunListItem
              key={run.run_id}
              run={run}
              active={activeTab?.type === "agent-run" && activeTab.path === agentRunTabPath(run.run_id)}
              onSelect={() => openTab({
                type: "agent-run",
                path: agentRunTabPath(run.run_id),
                title: `Run ${shortId(run.run_id)}`,
              })}
              onDelete={() => void deleteRun(run)}
              deleting={busyRunId === run.run_id}
            />
          ))
        )}
      </div>
      {confirmationDialog}
    </div>
  );
}

export function AgentRunTab({ runId }: { runId: string }) {
  const [detail, setDetail] = useState<AgentRunDetail | null>(null);
  const [loadingDetail, setLoadingDetail] = useState(true);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    setLoadingDetail(true);
    setError(null);
    invoke<AgentRunDetail | null>("get_agent_run", { runId })
      .then((nextDetail) => {
        if (!cancelled) setDetail(nextDetail);
      })
      .catch((err) => {
        if (!cancelled) setError(String(err));
      })
      .finally(() => {
        if (!cancelled) setLoadingDetail(false);
      });
    return () => {
      cancelled = true;
    };
  }, [runId]);

  if (error) return <StateMessage label="Could not load run detail" detail={error} />;
  if (loadingDetail) return <StateMessage label="Loading run detail..." />;
  if (!detail) return <StateMessage label="Run not found" detail="The run may have been pruned or the project agent-state database may have changed." />;

  return (
    <div className="h-full min-h-0 overflow-y-auto">
      <RunDetail detail={detail} />
    </div>
  );
}

function RunListItem({
  run,
  active,
  onSelect,
  onDelete,
  deleting,
}: {
  run: AgentRunSummary;
  active: boolean;
  onSelect: () => void;
  onDelete: () => void;
  deleting: boolean;
}) {
  const status = statusTone(run.status);
  const preview = run.initial_goal?.trim() || failedRunHint(run.status);
  const isRunning = run.status.toLowerCase() === "running";
  return (
    <div
      className={`group w-full border-l-2 px-3 py-2.5 text-left transition-colors ${
        active
          ? "border-[rgb(var(--color-accent))] bg-[rgb(var(--color-accent))]/10"
          : "border-transparent hover:bg-[rgb(var(--color-surface-alt))]"
      }`}
    >
      <div className="flex items-start gap-2">
        <button className="min-w-0 flex-1 text-left" onClick={onSelect}>
          <div className="flex items-center gap-2">
            <span className={`flex h-5 w-5 shrink-0 items-center justify-center rounded-full ${status.bg} ${status.text}`}>
              {statusIcon(run.status)}
            </span>
            <span className="min-w-0 flex-1 truncate text-[12px] font-medium text-[rgb(var(--color-text))]">
              {run.model || "Unknown model"}
            </span>
            <span className="text-[10px] text-[rgb(var(--color-text-secondary))]">{formatRelative(run.started_at)}</span>
          </div>
          <div className="mt-1 flex items-center gap-1.5 pl-7 text-[10px] text-[rgb(var(--color-text-secondary))]">
            <span className={`rounded-full px-1.5 py-0.5 font-medium ${status.bg} ${status.text}`}>
              {run.status}
            </span>
            <span className="truncate">{run.provider}</span>
            <span className="opacity-50">·</span>
            <span className="font-mono">{shortId(run.run_id)}</span>
          </div>
          <div className="mt-1 truncate pl-7 text-[11px] leading-5 text-[rgb(var(--color-text-secondary))]" title={preview}>
            {preview}
          </div>
        </button>
        <button
          className="mt-0.5 flex h-6 w-6 shrink-0 items-center justify-center rounded-md text-[rgb(var(--color-text-secondary))] opacity-0 transition-colors hover:bg-error/10 hover:text-error group-hover:opacity-100 disabled:cursor-not-allowed disabled:opacity-40 disabled:hover:bg-transparent disabled:hover:text-[rgb(var(--color-text-secondary))]"
          onClick={onDelete}
          disabled={deleting || isRunning}
          title={isRunning ? "Running runs cannot be deleted" : "Delete run records"}
        >
          {deleting ? <CircleDashed className="h-3 w-3 animate-spin" /> : <Trash2 className="h-3 w-3" />}
        </button>
      </div>
      <div className="mt-2 grid grid-cols-4 gap-1 pl-7">
        <MiniCount label="events" value={run.trajectory_event_count} />
        <MiniCount label="files" value={run.touched_resource_count} />
        <MiniCount label="checks" value={run.verification_result_count} />
        <MiniCount label="saves" value={run.checkpoint_count} />
      </div>
    </div>
  );
}

function agentRunTabPath(runId: string): string {
  return `__agent_run/${runId}`;
}

function failedRunHint(status: string): string {
  return status.toLowerCase() === "failed" ? "Failed before a starting message was recorded" : "No starting message recorded";
}

function statusIcon(status: string): ReactNode {
  switch (status.toLowerCase()) {
    case "running":
      return <CircleDashed className="h-3 w-3" />;
    case "failed":
      return <XCircle className="h-3 w-3" />;
    default:
      return <CheckCircle2 className="h-3 w-3" />;
  }
}

function RunDetail({ detail }: { detail: AgentRunDetail }) {
  const run = detail.run;
  const metadataEntries = useMemo(() => objectEntries(detail.metadata).slice(0, 8), [detail.metadata]);

  return (
    <div className="mx-auto flex w-full max-w-6xl flex-col gap-4 p-5">
      <section className="rounded-2xl border border-[rgb(var(--color-border))] bg-[rgb(var(--color-surface))] p-4 shadow-sm">
        <div className="flex flex-wrap items-start justify-between gap-3">
          <div className="min-w-0">
            <div className="mb-1 flex items-center gap-2 text-[10px] font-semibold uppercase tracking-[0.16em] text-[rgb(var(--color-text-secondary))]">
              <Bot className="h-3.5 w-3.5 text-[rgb(var(--color-accent))]" />
              Conversation state
            </div>
            <h2 className="truncate text-[18px] font-semibold tracking-[-0.02em] text-[rgb(var(--color-text))]">
              {run.model}
            </h2>
            <div className="mt-1 flex flex-wrap items-center gap-2 text-[11px] text-[rgb(var(--color-text-secondary))]">
              <StatusPill status={run.status} />
              <span>{run.provider}</span>
              <span className="opacity-50">·</span>
              <span className="font-mono">{run.run_id}</span>
            </div>
          </div>
          <div className="grid min-w-[16rem] grid-cols-2 gap-2 text-[11px]">
            <Fact label="Started" value={formatDateTime(run.started_at)} />
            <Fact label="Completed" value={run.completed_at ? formatDateTime(run.completed_at) : "Still running"} />
          </div>
        </div>
        {metadataEntries.length > 0 && (
          <div className="mt-4 grid grid-cols-2 gap-2 md:grid-cols-4">
            {metadataEntries.map(([key, value]) => (
              <Fact key={key} label={humanize(key)} value={valuePreview(value)} />
            ))}
          </div>
        )}
      </section>

      <div className="grid gap-4 xl:grid-cols-[minmax(0,1.4fr)_minmax(22rem,0.85fr)]">
        <TimelineCard events={detail.trajectory_events} />
        <div className="flex min-w-0 flex-col gap-4">
          <ResourcesCard resources={detail.touched_resources} />
          <VerificationCard results={detail.verification_results} />
          <CheckpointCard checkpoints={detail.checkpoints} resumeContexts={detail.resume_contexts} />
        </div>
      </div>
    </div>
  );
}

function TimelineCard({ events }: { events: AgentTrajectoryEventRecord[] }) {
  return (
    <InspectorCard
      icon={<GitCommitHorizontal className="h-3.5 w-3.5" />}
      title="Trajectory"
      count={events.length}
      empty="No trajectory events recorded"
    >
      <div className="relative space-y-2">
        <div className="absolute bottom-2 left-[0.6875rem] top-2 w-px bg-[rgb(var(--color-border-subtle))]" />
        {events.map((event) => (
          <div key={event.id} className="relative flex gap-3">
            <span className="z-10 mt-1 flex h-5 w-5 shrink-0 items-center justify-center rounded-full border border-[rgb(var(--color-border))] bg-[rgb(var(--color-surface))]">
              <span className="h-1.5 w-1.5 rounded-full bg-[rgb(var(--color-accent))]" />
            </span>
            <div className="min-w-0 flex-1 rounded-xl border border-[rgb(var(--color-border-subtle))] bg-[rgb(var(--color-surface-alt))]/50 px-3 py-2">
              <div className="flex items-center gap-2">
                <span className="truncate text-[12px] font-medium text-[rgb(var(--color-text))]">
                  {eventSummary(event)}
                </span>
                <span className="ml-auto shrink-0 text-[10px] text-[rgb(var(--color-text-secondary))]">
                  {formatRelative(event.created_at)}
                </span>
              </div>
              <div className="mt-1 flex flex-wrap gap-1.5 text-[10px] text-[rgb(var(--color-text-secondary))]">
                <span className="rounded-full bg-[rgb(var(--color-surface))] px-1.5 py-0.5 font-mono">
                  {humanize(event.event_type)}
                </span>
                {event.iteration != null && <span>iteration {event.iteration}</span>}
                {event.event_id && <span className="font-mono">{shortId(event.event_id)}</span>}
              </div>
            </div>
          </div>
        ))}
      </div>
    </InspectorCard>
  );
}

function ResourcesCard({ resources }: { resources: AgentTouchedResourceRecord[] }) {
  return (
    <InspectorCard
      icon={<FileStack className="h-3.5 w-3.5" />}
      title="Touched resources"
      count={resources.length}
      empty="No touched resources recorded"
    >
      <div className="space-y-1.5">
        {resources.map((resource) => (
          <div key={resource.id} className="rounded-xl border border-[rgb(var(--color-border-subtle))] bg-[rgb(var(--color-surface-alt))]/45 px-3 py-2">
            <div className="flex items-center gap-2">
              <span className="truncate font-mono text-[11px] text-[rgb(var(--color-text))]">{resource.resource_id}</span>
              <span className="ml-auto rounded-full bg-[rgb(var(--color-surface))] px-1.5 py-0.5 text-[10px] text-[rgb(var(--color-text-secondary))]">
                {resource.operation}
              </span>
            </div>
            <div className="mt-1 text-[10px] text-[rgb(var(--color-text-secondary))]">{resource.kind} · {formatDateTime(resource.created_at)}</div>
          </div>
        ))}
      </div>
    </InspectorCard>
  );
}

function VerificationCard({ results }: { results: AgentVerificationResultRecord[] }) {
  return (
    <InspectorCard
      icon={<ShieldCheck className="h-3.5 w-3.5" />}
      title="Verification"
      count={results.length}
      empty="No verification results recorded"
    >
      <div className="space-y-1.5">
        {results.map((result) => {
          const tone = verificationTone(result.status);
          return (
            <div key={result.id} className="rounded-xl border border-[rgb(var(--color-border-subtle))] bg-[rgb(var(--color-surface-alt))]/45 px-3 py-2">
              <div className="flex items-start gap-2">
                <span className={`mt-0.5 rounded-full px-1.5 py-0.5 text-[10px] font-medium ${tone}`}>
                  {result.status}
                </span>
                <span className="min-w-0 flex-1 text-[11px] font-medium text-[rgb(var(--color-text))]">{result.criterion}</span>
              </div>
              <div className="mt-1 text-[10px] text-[rgb(var(--color-text-secondary))]">{summaryFromJson(result.result) || formatDateTime(result.created_at)}</div>
            </div>
          );
        })}
      </div>
    </InspectorCard>
  );
}

function CheckpointCard({
  checkpoints,
  resumeContexts,
}: {
  checkpoints: AgentCheckpointRecord[];
  resumeContexts: AgentResumeContextRecord[];
}) {
  return (
    <InspectorCard
      icon={<Clock3 className="h-3.5 w-3.5" />}
      title="Checkpoints"
      count={checkpoints.length + resumeContexts.length}
      empty="No checkpoints or resume contexts recorded"
    >
      <div className="space-y-2">
        {checkpoints.map((checkpoint) => (
          <div key={`checkpoint-${checkpoint.id}`} className="rounded-xl border border-[rgb(var(--color-border-subtle))] bg-[rgb(var(--color-surface-alt))]/45 px-3 py-2">
            <div className="flex items-center gap-2">
              <span className="font-mono text-[11px] text-[rgb(var(--color-text))]">{checkpoint.id}</span>
              <span className="ml-auto text-[10px] text-[rgb(var(--color-text-secondary))]">{formatRelative(checkpoint.created_at)}</span>
            </div>
            <div className="mt-1 text-[10px] leading-relaxed text-[rgb(var(--color-text-secondary))]">
              {summaryFromJson(checkpoint.checkpoint) || "Checkpoint saved"}
            </div>
          </div>
        ))}
        {resumeContexts.map((context) => (
          <div key={`resume-${context.id}`} className="rounded-xl border border-[rgb(var(--color-accent))]/20 bg-[rgb(var(--color-accent))]/[0.06] px-3 py-2">
            <div className="text-[10px] font-semibold uppercase tracking-[0.12em] text-[rgb(var(--color-accent))]">
              Resume context
            </div>
            <div className="mt-1 text-[11px] text-[rgb(var(--color-text))]">Checkpoint {context.checkpoint_id}</div>
            <div className="mt-1 text-[10px] leading-relaxed text-[rgb(var(--color-text-secondary))]">
              {summaryFromJson(context.context) || formatDateTime(context.created_at)}
            </div>
          </div>
        ))}
      </div>
    </InspectorCard>
  );
}

function InspectorCard({
  icon,
  title,
  count,
  empty,
  children,
}: {
  icon: ReactNode;
  title: string;
  count: number;
  empty: string;
  children: ReactNode;
}) {
  return (
    <section className="min-w-0 rounded-2xl border border-[rgb(var(--color-border))] bg-[rgb(var(--color-surface))] p-3 shadow-sm">
      <div className="mb-3 flex items-center gap-2">
        <span className="flex h-6 w-6 items-center justify-center rounded-lg bg-[rgb(var(--color-accent))]/10 text-[rgb(var(--color-accent))]">
          {icon}
        </span>
        <h3 className="text-[12px] font-semibold text-[rgb(var(--color-text))]">{title}</h3>
        <span className="ml-auto rounded-full bg-[rgb(var(--color-surface-alt))] px-2 py-0.5 text-[10px] text-[rgb(var(--color-text-secondary))]">
          {count}
        </span>
      </div>
      {count === 0 ? <p className="px-1 py-4 text-center text-[11px] text-[rgb(var(--color-text-secondary))]">{empty}</p> : children}
    </section>
  );
}

function MiniCount({ label, value }: { label: string; value: number }) {
  return (
    <span className="rounded-md bg-[rgb(var(--color-surface-alt))] px-1.5 py-1 text-center">
      <span className="block text-[11px] font-semibold text-[rgb(var(--color-text))]">{value}</span>
      <span className="block text-[8px] uppercase tracking-[0.1em] text-[rgb(var(--color-text-secondary))]">{label}</span>
    </span>
  );
}

function Fact({ label, value }: { label: string; value: string }) {
  return (
    <div className="min-w-0 rounded-xl border border-[rgb(var(--color-border-subtle))] bg-[rgb(var(--color-surface-alt))]/55 px-3 py-2">
      <div className="text-[9px] font-semibold uppercase tracking-[0.12em] text-[rgb(var(--color-text-secondary))]">{label}</div>
      <div className="mt-1 truncate text-[11px] text-[rgb(var(--color-text))]" title={value}>{value}</div>
    </div>
  );
}

function StatusPill({ status }: { status: string }) {
  const tone = statusTone(status);
  return <span className={`rounded-full px-2 py-0.5 text-[10px] font-medium ${tone.bg} ${tone.text}`}>{status}</span>;
}

function StateMessage({ label, detail }: { label: string; detail?: string }) {
  return (
    <div className="flex h-full min-h-[12rem] flex-col items-center justify-center gap-2 px-6 text-center">
      <CircleDashed className="h-6 w-6 text-[rgb(var(--color-text-secondary))]/60" />
      <div className="text-[12px] font-medium text-[rgb(var(--color-text))]">{label}</div>
      {detail && <div className="max-w-sm text-[11px] leading-relaxed text-[rgb(var(--color-text-secondary))]">{detail}</div>}
    </div>
  );
}

function statusTone(status: string) {
  switch (status.toLowerCase()) {
    case "completed":
      return { bg: "bg-[rgb(var(--color-success))]/10", text: "text-[rgb(var(--color-success))]" };
    case "failed":
      return { bg: "bg-error/10", text: "text-error" };
    case "running":
      return { bg: "bg-[rgb(var(--color-accent))]/10", text: "text-[rgb(var(--color-accent))]" };
    default:
      return { bg: "bg-[rgb(var(--color-surface-alt))]", text: "text-[rgb(var(--color-text-secondary))]" };
  }
}

function verificationTone(status: string) {
  switch (status.toLowerCase()) {
    case "passed":
    case "success":
      return "bg-[rgb(var(--color-success))]/10 text-[rgb(var(--color-success))]";
    case "failed":
    case "error":
      return "bg-error/10 text-error";
    default:
      return "bg-[rgb(var(--color-surface))] text-[rgb(var(--color-text-secondary))]";
  }
}

function objectEntries(value: JsonValue): Array<[string, JsonValue]> {
  if (!value || Array.isArray(value) || typeof value !== "object") return [];
  return Object.entries(value);
}

function eventSummary(event: AgentTrajectoryEventRecord): string {
  const found = deepFindString(event.event, ["goal", "tool_name", "toolName", "name", "criterion", "message", "reason"]);
  const label = eventLabel(event.event_type);
  return found ? `${label} · ${found}` : label;
}

function eventLabel(eventType: string): string {
  switch (eventType) {
    case "turn_started":
      return "Started turn";
    case "turn_completed":
      return "Completed turn";
    case "model_call_started":
      return "Started model call";
    case "model_call_completed":
      return "Completed model call";
    case "tool_call_started":
      return "Started tool call";
    case "tool_call_completed":
      return "Completed tool call";
    case "verification_recorded":
      return "Recorded verification";
    case "checkpoint_created":
      return "Created checkpoint";
    case "resource_touched":
      return "Touched resource";
    default:
      return humanize(eventType);
  }
}

function summaryFromJson(value: JsonValue): string {
  return deepFindString(value, ["summary", "goal", "next_step", "nextStep", "reason", "message", "details"]) ?? "";
}

function deepFindString(value: JsonValue, keys: string[], depth = 0): string | null {
  if (depth > 4 || value == null) return null;
  if (typeof value === "string") return value.length <= 140 ? value : `${value.slice(0, 137)}...`;
  if (typeof value !== "object") return null;
  if (Array.isArray(value)) {
    for (const item of value) {
      const found = deepFindString(item, keys, depth + 1);
      if (found) return found;
    }
    return null;
  }
  for (const key of keys) {
    const direct = value[key];
    if (typeof direct === "string" && direct.trim()) return direct.trim();
    if (Array.isArray(direct)) {
      const strings = direct.filter((item): item is string => typeof item === "string");
      if (strings.length > 0) return strings.slice(0, 2).join("; ");
    }
  }
  for (const nested of Object.values(value)) {
    const found = deepFindString(nested, keys, depth + 1);
    if (found) return found;
  }
  return null;
}

function valuePreview(value: JsonValue): string {
  if (value == null) return "None";
  if (typeof value === "boolean") return value ? "Yes" : "No";
  if (typeof value === "number") return value.toLocaleString();
  if (typeof value === "string") return value;
  if (Array.isArray(value)) return `${value.length} item${value.length === 1 ? "" : "s"}`;
  return `${Object.keys(value).length} field${Object.keys(value).length === 1 ? "" : "s"}`;
}

function humanize(value: string): string {
  return value.replace(/[_-]/g, " ").replace(/\b\w/g, (char) => char.toUpperCase());
}

function shortId(value: string): string {
  return value.length > 8 ? value.slice(0, 8) : value;
}

function formatDateTime(iso: string): string {
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return iso;
  return date.toLocaleString();
}

function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

function formatRelative(iso: string): string {
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return iso;
  const diffMs = Date.now() - date.getTime();
  const absMs = Math.abs(diffMs);
  const minute = 60_000;
  const hour = 60 * minute;
  const day = 24 * hour;
  if (absMs < minute) return "just now";
  if (absMs < hour) return `${Math.round(diffMs / minute)}m ago`;
  if (absMs < day) return `${Math.round(diffMs / hour)}h ago`;
  if (absMs < 7 * day) return `${Math.round(diffMs / day)}d ago`;
  return date.toLocaleDateString();
}
