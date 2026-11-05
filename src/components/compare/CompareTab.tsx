import { useEffect, useMemo, useState } from "react";
import { ArrowRight, GitCompare } from "lucide-react";
import type { CompareTarget } from "../../domain/compare/compareTarget";
import type { ComparedFile, LoadedComparison } from "../../services/versionCompare";
import { MediaCompareView } from "./MediaCompareView";
import { NoteCompareView } from "./NoteCompareView";
import { SketchCompareView } from "./SketchCompareView";
import { StoryboardCompareView } from "./StoryboardCompareView";
import { useComparedFiles, useFileComparison } from "./useComparison";

const STATUS_LABEL: Record<ComparedFile["status"], string> = {
  added: "Added",
  modified: "Changed",
  deleted: "Deleted",
  renamed: "Renamed",
  conflicted: "Conflicted",
};

const fileName = (path: string) => path.split("/").pop() || path;

function Note({ children, tone = "muted" }: { children: React.ReactNode; tone?: "muted" | "error" }) {
  return <p className={`p-4 text-sm ${tone === "error" ? "text-error" : "text-text-secondary"}`}>{children}</p>;
}

function ComparisonBody({ comparison, target }: { comparison: LoadedComparison; target: CompareTarget }) {
  switch (comparison.view) {
    case "sketch":
      return <SketchCompareView comparison={comparison.comparison} />;
    case "storyboard":
      return <StoryboardCompareView comparison={comparison.comparison} />;
    case "note":
    case "text":
      return <NoteCompareView comparison={comparison.comparison} beforeLabel={target.fromLabel} afterLabel={target.toLabel} />;
    case "media":
      return <MediaCompareView before={comparison.before} after={comparison.after} beforeLabel={target.fromLabel} afterLabel={target.toLabel} />;
    case "unavailable":
      return <Note>{comparison.reason}</Note>;
  }
}

function FileComparisonPanel({ target, file }: { target: CompareTarget; file: ComparedFile }) {
  const result = useFileComparison(target, file);
  if (!result || result.state === "loading") return <Note>Loading changes…</Note>;
  if (result.state === "error") return <Note tone="error">Couldn't compare this document: {result.message}</Note>;
  return <ComparisonBody comparison={result.value} target={target} />;
}

/** A Compare document tab: what changed between two versions, or a version and now, document by document. */
export function CompareTab({ target }: { target: CompareTarget }) {
  const files = useComparedFiles(target);
  const list = useMemo(() => (files.state === "ready" ? files.value : []), [files]);
  const [selected, setSelected] = useState<string | null>(null);
  useEffect(() => {
    if (!list.some((file) => file.path === selected)) setSelected(list[0]?.path ?? null);
  }, [list, selected]);
  const file = list.find((f) => f.path === selected) ?? null;
  const showList = !target.path && list.length > 1;

  let body: React.ReactNode;
  if (files.state === "loading") body = <Note>Loading changes…</Note>;
  else if (files.state === "error") body = <Note tone="error">Couldn't load changes: {files.message}</Note>;
  else if (!file) body = <Note>{target.documentTitle ? `${target.documentTitle} didn't change.` : "Nothing changed between these versions."}</Note>;
  else body = <FileComparisonPanel key={file.path} target={target} file={file} />;

  return (
    <section className="flex min-h-0 flex-1 flex-col" aria-labelledby="compare-tab-title" data-testid="compare-tab">
      <header className="flex shrink-0 flex-wrap items-center gap-2 border-b border-border-subtle px-4 py-2 text-sm">
        <h2 id="compare-tab-title" className="flex items-center gap-2 font-semibold text-text">
          <GitCompare className="h-4 w-4 text-text-secondary" aria-hidden />
          {target.documentTitle ? `Compare ${target.documentTitle}` : "Compare"}
        </h2>
        <span className="flex min-w-0 items-center gap-1.5 text-text-secondary" data-testid="compare-sides">
          <span className="max-w-[16rem] truncate">{target.fromLabel}</span>
          <ArrowRight className="h-3.5 w-3.5 shrink-0" aria-hidden /><span className="sr-only">to</span>
          <span className="max-w-[16rem] truncate">{target.toLabel}</span>
        </span>
      </header>
      <div className="flex min-h-0 flex-1">
        {showList && (
          <nav aria-label="Changed documents" className="w-60 shrink-0 overflow-y-auto border-r border-border-subtle p-2">
            <ul className="space-y-0.5">
              {list.map((f) => (
                <li key={f.path}>
                  <button
                    type="button"
                    aria-current={f.path === selected ? "true" : undefined}
                    onClick={() => setSelected(f.path)}
                    title={f.path}
                    className={`flex w-full items-center justify-between gap-2 rounded px-2 py-1 text-left text-sm focus-visible:outline focus-visible:outline-2 focus-visible:outline-accent ${f.path === selected ? "bg-fill-selected text-text" : "text-text-secondary hover:bg-fill-hover"}`}
                  >
                    <span className="truncate">{fileName(f.path)}</span>
                    <span className="shrink-0 text-2xs">{STATUS_LABEL[f.status]}</span>
                  </button>
                </li>
              ))}
            </ul>
          </nav>
        )}
        <div className="min-w-0 flex-1 overflow-y-auto p-4">{body}</div>
      </div>
    </section>
  );
}
