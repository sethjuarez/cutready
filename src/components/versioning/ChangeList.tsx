import { useState } from "react";
import { ChevronDown, ChevronRight, Undo2, X } from "lucide-react";
import { describeChange, documentName, summaryChips, type DocumentChange } from "../../domain/changes";
import { fileBelongsToProject } from "../../domain/versioning";
import { discardChangesWithUndo } from "../../services/discardWithUndo";
import { isSaveBlocked } from "../../services/versionOperation";
import { useAppStore } from "../../stores/appStore";
import { useChangeSummaryStore } from "../../stores/changeSummaryStore";
import { ChangeChips } from "./ChangeChips";
import { draftlineToRepoPath } from "../../utils/draftlinePaths";

const isDatabasePath = (path: string) => /\.(db|sqlite|sqlite3)$/i.test(path);

const STATUS_MARK: Record<DocumentChange["status"], string> = {
  added: "A",
  deleted: "D",
  modified: "M",
  renamed: "R",
  conflicted: "!",
};

function discard(count: number, path?: string) {
  void discardChangesWithUndo(count, path).catch((err) => {
    // The chip shows "Couldn't save – Retry" for a blocked save.
    if (!isSaveBlocked(err)) console.error("Discard failed:", err);
  });
}

/** Change summary chips, expandable into documents with diff and Discard. */
export function ChangeList() {
  const summary = useChangeSummaryStore((s) => s.summary);
  const currentProject = useAppStore((s) => s.currentProject);
  const isMultiProject = useAppStore((s) => s.isMultiProject);
  const projects = useAppStore((s) => s.projects);
  const openTab = useAppStore((s) => s.openTab);
  const openDatabase = useAppStore((s) => s.openDatabase);
  const [expanded, setExpanded] = useState(false);
  const [projectFilter, setProjectFilter] = useState("all");

  if (!summary) {
    return <p className="px-3 py-2 text-xs text-[rgb(var(--color-text-secondary))]">Checking changes…</p>;
  }
  if (summary.documents.length === 0) {
    return <p className="px-3 py-2 text-xs text-[rgb(var(--color-text-secondary))]">Everything is saved as a version.</p>;
  }

  const filterProject = projectFilter === "all" ? null : projects.find((project) => project.path === projectFilter) ?? null;
  const documents = filterProject
    ? summary.documents.filter((doc) => fileBelongsToProject(draftlineToRepoPath(doc.path, currentProject), filterProject.path))
    : summary.documents;
  const chips = summaryChips(summary.totals);
  const count = summary.documents.length;

  const openDocument = (doc: DocumentChange) => {
    if (isDatabasePath(doc.path) && doc.status !== "deleted") {
      openDatabase(draftlineToRepoPath(doc.path, currentProject));
    } else {
      openTab({ type: "diff", path: doc.path, title: `${documentName(doc.path)} (diff)` });
    }
  };

  return (
    <div className="px-3 py-2">
      <div className="flex items-start gap-2">
        <button
          type="button"
          onClick={() => setExpanded((value) => !value)}
          aria-expanded={expanded}
          aria-controls="changes-popover-documents"
          className="flex min-w-0 flex-1 flex-wrap items-center gap-1 rounded-control text-left focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[rgb(var(--color-accent))]"
          data-testid="changes-summary-toggle"
        >
          {expanded ? <ChevronDown className="h-3.5 w-3.5 shrink-0" aria-hidden="true" /> : <ChevronRight className="h-3.5 w-3.5 shrink-0" aria-hidden="true" />}
          <span className="sr-only">{expanded ? "Hide" : "Show"} {count} changed documents:</span>
          <ChangeChips chips={chips} />
        </button>
        <button
          type="button"
          onClick={() => discard(count)}
          className="inline-flex h-6 shrink-0 items-center gap-1 rounded-control px-1.5 text-2xs text-[rgb(var(--color-text-secondary))] hover:bg-fill-hover hover:text-error focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[rgb(var(--color-accent))]"
          title="Discard every change. You can undo this."
        >
          <Undo2 className="h-3 w-3" aria-hidden="true" />
          Discard all
        </button>
      </div>
      {expanded && (
        <div id="changes-popover-documents" className="mt-2">
          {isMultiProject && projects.length > 1 && (
            <label className="mb-1 flex items-center gap-2 text-2xs text-[rgb(var(--color-text-secondary))]">
              Show
              <select
                value={projectFilter}
                onChange={(event) => setProjectFilter(event.target.value)}
                className="h-6 min-w-0 flex-1 rounded-control border border-[rgb(var(--color-border))] bg-[rgb(var(--color-surface))] px-1 text-2xs text-[rgb(var(--color-text))]"
                title="Filter visible changes by project. Save and Discard all still apply to the whole workspace."
              >
                <option value="all">All projects</option>
                {projects.map((project) => (
                  <option key={project.path} value={project.path}>{project.name}</option>
                ))}
              </select>
            </label>
          )}
          <ul className="max-h-56 overflow-y-auto" aria-label="Changed documents">
            {documents.map((doc) => (
              <li key={doc.path} className="group flex items-center gap-1 rounded-control hover:bg-fill-hover">
                <button
                  type="button"
                  onClick={() => openDocument(doc)}
                  className="flex min-w-0 flex-1 items-center gap-2 px-1.5 py-1 text-left focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[rgb(var(--color-accent))]"
                  title={`View diff: ${doc.path}`}
                  aria-label={`View diff: ${doc.path}`}
                >
                  <span aria-hidden="true" className="w-3 shrink-0 text-center font-mono text-2xs text-[rgb(var(--color-text-secondary))]">
                    {STATUS_MARK[doc.status]}
                  </span>
                  <span className="min-w-0 flex-1">
                    <span className="block truncate text-xs font-medium text-[rgb(var(--color-text))]">{documentName(doc.path)}</span>
                    <span className="block truncate text-2xs text-[rgb(var(--color-text-secondary))]">{describeChange(doc)}</span>
                  </span>
                </button>
                <button
                  type="button"
                  onClick={() => discard(1, doc.path)}
                  className="shrink-0 rounded p-1 text-[rgb(var(--color-text-secondary))] opacity-0 hover:text-error focus-visible:opacity-100 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[rgb(var(--color-accent))] group-hover:opacity-100 group-focus-within:opacity-100"
                  title={`Discard changes to ${doc.path}`}
                  aria-label={`Discard changes to ${doc.path}`}
                >
                  <X className="h-3 w-3" aria-hidden="true" />
                </button>
              </li>
            ))}
          </ul>
        </div>
      )}
    </div>
  );
}
