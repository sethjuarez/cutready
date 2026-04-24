import { AlertTriangle, CheckCircle2, Sparkles } from "lucide-react";
import type { Storyboard } from "../types/sketch";
import type { StoryboardReadinessSummary } from "../utils/storyboardReadiness";

interface StoryboardReadinessPanelProps {
  storyboard: Storyboard;
  readiness: StoryboardReadinessSummary;
  locked: boolean;
  onFixWithAi: () => void;
}

export function StoryboardReadinessPanel({
  storyboard,
  readiness,
  locked,
  onFixWithAi,
}: StoryboardReadinessPanelProps) {
  const ready = readiness.status === "ready";

  return (
    <section className="mb-6 rounded-2xl border border-[rgb(var(--color-border))] bg-[rgb(var(--color-surface-alt))]/55 p-4">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div className="flex items-start gap-3">
          <div className={`mt-0.5 rounded-full p-1.5 ${ready ? "bg-[rgb(var(--color-success))]/10 text-[rgb(var(--color-success))]" : "bg-[rgb(var(--color-warning))]/10 text-[rgb(var(--color-warning))]"}`}>
            {ready ? <CheckCircle2 className="h-4 w-4" /> : <AlertTriangle className="h-4 w-4" />}
          </div>
          <div>
            <div className="flex flex-wrap items-center gap-2">
              <h2 className="text-sm font-semibold text-[rgb(var(--color-text))]">Readiness Check</h2>
              <span className={`rounded-full px-2 py-0.5 text-[10px] font-medium ${ready ? "bg-[rgb(var(--color-success))]/10 text-[rgb(var(--color-success))]" : "bg-[rgb(var(--color-warning))]/10 text-[rgb(var(--color-warning))]"}`}>
                {ready ? "Ready" : "Needs Work"}
              </span>
            </div>
            <p className="mt-1 text-xs leading-relaxed text-[rgb(var(--color-text-secondary))]">
              {ready
                ? `${storyboard.title} has ${readiness.totalRows} ready-to-record rows.`
                : `${readiness.incompleteSketches.length + readiness.unloadedSketches.length} sketch${readiness.incompleteSketches.length + readiness.unloadedSketches.length === 1 ? "" : "es"} need attention before recording.`}
            </p>
          </div>
        </div>

        {!ready && !locked && (
          <button
            type="button"
            onClick={onFixWithAi}
            className="flex items-center gap-1.5 rounded-lg px-3 py-1.5 text-xs font-medium text-[rgb(var(--color-accent))] hover:bg-[rgb(var(--color-accent))]/10 transition-colors"
            title="Ask the AI assistant to fix readiness gaps without touching locked rows"
          >
            <Sparkles className="h-3.5 w-3.5" />
            Fix gaps with AI
          </button>
        )}
      </div>

      <div className="mt-4 grid grid-cols-2 gap-2 sm:grid-cols-3 lg:grid-cols-6">
        <Metric label="Rows" value={readiness.totalRows} />
        <Metric label="No timing" value={readiness.missingTiming} warn={readiness.missingTiming > 0} />
        <Metric label="No narration" value={readiness.missingNarration} warn={readiness.missingNarration > 0} />
        <Metric label="No actions" value={readiness.missingDemoActions} warn={readiness.missingDemoActions > 0} />
        <Metric label="Vague actions" value={readiness.vagueDemoActions} warn={readiness.vagueDemoActions > 0} />
        <Metric label="No visual" value={readiness.missingVisuals} warn={readiness.missingVisuals > 0} />
      </div>

      {!ready && (
        <div className="mt-4 grid gap-3 md:grid-cols-[1.25fr_1fr]">
          <div>
            <h3 className="mb-2 text-[11px] font-medium uppercase tracking-wide text-[rgb(var(--color-text-secondary))]">
              Incomplete sketches
            </h3>
            <div className="space-y-1.5">
              {[...readiness.incompleteSketches, ...readiness.unloadedSketches].slice(0, 4).map((sketch) => (
                <div key={`${sketch.path}-${sketch.loaded ? "loaded" : "loading"}`} className="flex items-center justify-between gap-3 rounded-lg border border-[rgb(var(--color-border))]/70 bg-[rgb(var(--color-surface))]/65 px-3 py-2">
                  <span className="truncate text-xs font-medium text-[rgb(var(--color-text))]">{sketch.title}</span>
                  <span className="shrink-0 text-[10px] text-[rgb(var(--color-text-secondary))]">
                    {sketch.loaded ? `${sketch.issueCount} gap${sketch.issueCount === 1 ? "" : "s"}` : "loading"}
                  </span>
                </div>
              ))}
            </div>
          </div>
          <div>
            <h3 className="mb-2 text-[11px] font-medium uppercase tracking-wide text-[rgb(var(--color-text-secondary))]">
              Next steps
            </h3>
            <ul className="space-y-1.5">
              {readiness.nextSteps.map((step) => (
                <li key={step} className="text-xs leading-relaxed text-[rgb(var(--color-text-secondary))]">
                  {step}
                </li>
              ))}
            </ul>
            {readiness.lockedIssueRows > 0 && (
              <p className="mt-2 text-[11px] leading-relaxed text-[rgb(var(--color-warning))]">
                {readiness.lockedIssueRows} row{readiness.lockedIssueRows === 1 ? "" : "s"} with gaps are locked and will be skipped by AI fixes.
              </p>
            )}
          </div>
        </div>
      )}
    </section>
  );
}

function Metric({ label, value, warn = false }: { label: string; value: number; warn?: boolean }) {
  return (
    <div className="rounded-xl border border-[rgb(var(--color-border))]/70 bg-[rgb(var(--color-surface))]/65 px-3 py-2">
      <div className={`text-lg font-semibold ${warn ? "text-[rgb(var(--color-warning))]" : "text-[rgb(var(--color-text))]"}`}>
        {value}
      </div>
      <div className="text-[10px] font-medium uppercase tracking-wide text-[rgb(var(--color-text-secondary))]">
        {label}
      </div>
    </div>
  );
}
