import { lazy, Suspense, useMemo, useState } from "react";
import { FileText, GitFork, History, ListTree, Search, X } from "lucide-react";
import { buildTimeline, pathTimeline, searchTimeline } from "../../domain/history/timeline";
import { useHistoryFilterStore } from "../../stores/historyFilterStore";
import { useSyncStore } from "../../stores/syncStore";
import { useVersioningStore } from "../../stores/versioningStore";
import { useProjectSettings } from "../../stores/projectSettingsStore";
import { ErrorBoundary } from "../ErrorBoundary";
import { openCompareTab } from "../compare/openCompareTab";
import { HistoryTimeline } from "./HistoryTimeline";
import { useHistoryGraph } from "./useHistoryGraph";
import { useHistoryEntryMenu } from "./useHistoryEntryMenu";
import { usePathHistory } from "./usePathHistory";

const HistoryGraphView = lazy(() => import("./HistoryGraphView"));

type HistoryView = "timeline" | "graph";

const segmentClass = (active: boolean) =>
  `inline-flex h-7 items-center gap-1.5 rounded-control px-2.5 text-xs font-medium focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[rgb(var(--color-accent))] ${
    active
      ? "bg-[rgb(var(--color-surface))] text-[rgb(var(--color-text))] shadow-sm"
      : "text-[rgb(var(--color-text-secondary))] hover:text-[rgb(var(--color-text))]"
  }`;

function Message({ children, tone = "muted" }: { children: React.ReactNode; tone?: "muted" | "error" }) {
  return (
    <div className={`flex flex-1 items-center justify-center p-6 text-sm ${tone === "error" ? "text-[rgb(var(--color-error))]" : "text-[rgb(var(--color-text-secondary))]"}`}>
      {children}
    </div>
  );
}

/** The History document tab: the current timeline's versions as a list, or Draftline's graph. */
export function HistoryTab() {
  const { graph, loading: graphLoading, error: graphError } = useHistoryGraph();
  const document = useHistoryFilterStore((s) => s.document);
  const setDocument = useHistoryFilterStore((s) => s.setDocument);
  const pathHistory = usePathHistory(document?.path ?? null);
  const openSnapshotPreview = useVersioningStore((s) => s.openSnapshotPreview);
  const hasRemote = useSyncStore((s) => !!s.currentRemote);
  const isDirty = useVersioningStore((s) => s.isDirty);
  const template = useProjectSettings()?.commit_template ?? null;
  const [view, setView] = useState<HistoryView>("timeline");
  const [expanded, setExpanded] = useState(false);
  const [query, setQuery] = useState("");
  const filtered = view === "timeline" && !!document;
  const loading = filtered ? pathHistory.loading : graphLoading;
  const error = filtered ? pathHistory.error : graphError;
  const timeline = useMemo(() => {
    if (document) return pathHistory.history ? pathTimeline(pathHistory.history, graph, hasRemote, template) : [];
    return graph ? buildTimeline(graph, hasRemote, template) : [];
  }, [document, pathHistory.history, graph, hasRemote, template]);
  const visible = useMemo(() => searchTimeline(timeline, query), [timeline, query]);
  const preview = (id: string) => void openSnapshotPreview(id);
  const entryMenu = useHistoryEntryMenu(document, timeline, preview, (target) =>
    openCompareTab(target.path ? { ...target, aliases: pathHistory.history?.paths ?? [] } : target));

  let body: React.ReactNode;
  if (error) body = <Message tone="error">Couldn't load history: {error}</Message>;
  else if (filtered ? !pathHistory.history : !graph) body = <Message>{loading ? "Loading history…" : "No versions yet."}</Message>;
  else if (view === "graph" && graph) {
    body = (
      <ErrorBoundary fallback={<Message tone="error">The graph failed to render.</Message>}>
        <Suspense fallback={<Message>Loading graph…</Message>}>
          <HistoryGraphView graph={graph} view={expanded ? "expanded" : "first-parent"} onSelect={preview} />
        </Suspense>
      </ErrorBoundary>
    );
  } else if (timeline.length === 0 && (!isDirty || document)) {
    const empty = <Message>{document ? `No saved versions changed ${document.title} yet.` : "No versions yet."}</Message>;
    // A filtered document may still have unsaved work; UnsavedEntry hides itself when it doesn't.
    body = document && isDirty
      ? <div className="flex-1 overflow-y-auto"><HistoryTimeline entries={[]} onPreview={preview} path={document.path} />{empty}</div>
      : empty;
  } else if (visible.length === 0 && query.trim()) body = <Message>No versions match “{query}”.</Message>;
  else body = <div className="flex-1 overflow-y-auto"><HistoryTimeline entries={visible} onPreview={preview} onMenu={entryMenu.openMenu} showUnsaved={!query.trim()} path={document?.path ?? null} /></div>;

  return (
    <section className="flex min-h-0 flex-1 flex-col" aria-labelledby="history-tab-title" data-testid="history-tab">
      <header className="flex shrink-0 flex-wrap items-center gap-3 border-b border-[rgb(var(--color-border-subtle))] px-4 py-2">
        <h2 id="history-tab-title" className="flex items-center gap-2 text-sm font-semibold text-[rgb(var(--color-text))]">
          <History className="h-4 w-4 text-[rgb(var(--color-text-secondary))]" aria-hidden />
          History
        </h2>
        <div role="group" aria-label="History view" className="inline-flex rounded-control bg-[rgb(var(--color-surface-inset))] p-0.5">
          <button type="button" aria-pressed={view === "timeline"} className={segmentClass(view === "timeline")} onClick={() => setView("timeline")}>
            <ListTree className="h-3.5 w-3.5" aria-hidden /> Timeline
          </button>
          <button type="button" aria-pressed={view === "graph"} className={segmentClass(view === "graph")} onClick={() => setView("graph")}>
            <GitFork className="h-3.5 w-3.5" aria-hidden /> Graph
          </button>
        </div>
        {document && (
          <span className="inline-flex h-7 min-w-0 items-center gap-1.5 rounded-full bg-[rgb(var(--color-surface-alt))] pl-2.5 pr-1 text-xs text-[rgb(var(--color-text))]" data-testid="history-document-filter">
            <FileText className="h-3.5 w-3.5 shrink-0 text-[rgb(var(--color-text-secondary))]" aria-hidden />
            <span className="max-w-[16rem] truncate" title={document.path}>{document.title}</span>
            {view === "graph" && <span className="text-[rgb(var(--color-text-secondary))]">· Timeline only</span>}
            <button
              type="button"
              onClick={() => setDocument(null)}
              aria-label={`Show history for the whole project instead of ${document.title}`}
              title="Show the whole project"
              className="grid h-5 w-5 place-items-center rounded-full text-[rgb(var(--color-text-secondary))] hover:bg-fill-hover hover:text-[rgb(var(--color-text))] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[rgb(var(--color-accent))]"
            >
              <X className="h-3 w-3" aria-hidden />
            </button>
          </span>
        )}
        <div className="ml-auto flex items-center gap-2">
          {view === "timeline" ? (
            <label className="relative">
              <span className="sr-only">Search versions</span>
              <Search className="pointer-events-none absolute left-2 top-1/2 h-3.5 w-3.5 -translate-y-1/2 text-[rgb(var(--color-text-secondary))]" aria-hidden />
              <input
                type="search"
                value={query}
                onChange={(event) => setQuery(event.target.value)}
                placeholder="Search versions"
                className="h-7 w-56 rounded-control border border-[rgb(var(--color-border))] bg-[rgb(var(--color-surface))] pl-7 pr-2 text-xs text-[rgb(var(--color-text))] placeholder:text-[rgb(var(--color-text-tertiary))] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[rgb(var(--color-accent))]"
              />
            </label>
          ) : (
            <label className="flex items-center gap-1.5 text-xs text-[rgb(var(--color-text-secondary))]">
              <input type="checkbox" checked={expanded} onChange={(event) => setExpanded(event.target.checked)} className="accent-[rgb(var(--color-accent))]" />
              Show merged-in versions
            </label>
          )}
        </div>
      </header>
      {body}
      {entryMenu.element}
    </section>
  );
}
