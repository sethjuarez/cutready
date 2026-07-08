import { useCallback, useEffect, useRef, useState } from "react";
import { AlertCircle, GitPullRequestArrow } from "lucide-react";
import { useAppStore } from "../stores/appStore";
import { Dialog } from "./Dialog";

export function PrePushMilestoneDialog() {
  const prompt = useAppStore((s) => s.prePushMilestonePrompt);
  const resolvePrePushMilestone = useAppStore((s) => s.resolvePrePushMilestone);
  const [label, setLabel] = useState("");
  const inputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    if (!prompt) return;
    setLabel(prompt.suggestedLabel);
    requestAnimationFrame(() => {
      inputRef.current?.focus();
      inputRef.current?.select();
    });
  }, [prompt]);

  const close = useCallback(() => {
    resolvePrePushMilestone({ type: "cancel" });
  }, [resolvePrePushMilestone]);

  const createMilestone = useCallback(() => {
    const trimmed = label.trim();
    if (!trimmed) return;
    resolvePrePushMilestone({ type: "milestone", label: trimmed });
  }, [label, resolvePrePushMilestone]);

  const pushAsIs = useCallback(() => {
    resolvePrePushMilestone({ type: "pushAsIs" });
  }, [resolvePrePushMilestone]);

  if (!prompt) return null;

  return (
    <Dialog isOpen={!!prompt} onClose={close} align="top" topOffset="18vh" width="w-full max-w-lg mx-4">
      <div className="cr-modal-surface overflow-hidden rounded-2xl border border-[rgb(var(--color-accent))]/20">
        <div className="relative px-5 pb-5 pt-5">
          <div className="pointer-events-none absolute inset-x-0 top-0 h-1 bg-gradient-to-r from-[rgb(var(--color-accent))]/20 via-[rgb(var(--color-accent))] to-[rgb(var(--color-accent))]/20" />
          <div className="mb-4 flex items-start gap-3">
            <div className="rounded-xl border border-[rgb(var(--color-accent))]/20 bg-[rgb(var(--color-accent))]/10 p-2.5">
              <GitPullRequestArrow className="h-5 w-5 text-[rgb(var(--color-accent))]" />
            </div>
            <div className="min-w-0 flex-1">
              <h2 className="text-sm font-semibold text-[rgb(var(--color-text))]">
                Name this shared milestone
              </h2>
              <p className="mt-1 text-xs leading-relaxed text-[rgb(var(--color-text-secondary))]">
                You have {prompt.snapshotCount} local snapshots ready to share. CutReady can publish them as one clean milestone on {prompt.remoteName}.
              </p>
            </div>
          </div>

          <div className="mb-4 rounded-xl border border-[rgb(var(--color-border))] bg-[rgb(var(--color-surface-alt))]/80 p-3">
            <div className="mb-2 flex items-start gap-2 text-[11px] leading-relaxed text-[rgb(var(--color-text-secondary))]">
              <AlertCircle className="mt-0.5 h-3.5 w-3.5 shrink-0 text-[rgb(var(--color-accent))]" />
              <span>
                This label becomes part of shared history. Collaborators will see it instead of the local save names like "{prompt.latestSnapshotLabel}".
              </span>
            </div>
            <label htmlFor="pre-push-milestone-label" className="mb-1.5 block text-xs font-medium text-[rgb(var(--color-text-secondary))]">
              Milestone label
            </label>
            <input
              id="pre-push-milestone-label"
              ref={inputRef}
              value={label}
              onChange={(event) => setLabel(event.target.value)}
              onKeyDown={(event) => {
                if (event.key === "Enter") createMilestone();
              }}
              placeholder="e.g. Finalize onboarding walkthrough"
              className="w-full rounded-lg border border-[rgb(var(--color-border))] bg-[rgb(var(--color-surface))] px-3 py-2 text-sm text-[rgb(var(--color-text))] outline-none transition-colors placeholder:text-[rgb(var(--color-text-secondary))]/45 focus:border-[rgb(var(--color-accent))] focus:ring-2 focus:ring-[rgb(var(--color-accent))]/20"
            />
          </div>

          <div className="flex flex-col gap-2 sm:flex-row sm:items-center sm:justify-end">
            <button
              type="button"
              onClick={pushAsIs}
              className="rounded-lg px-3 py-1.5 text-xs font-medium text-[rgb(var(--color-text-secondary))] transition-colors hover:bg-[rgb(var(--color-surface-alt))] hover:text-[rgb(var(--color-text))]"
            >
              Push snapshots as-is
            </button>
            <button
              type="button"
              onClick={close}
              className="rounded-lg px-3 py-1.5 text-xs font-medium text-[rgb(var(--color-text-secondary))] transition-colors hover:text-[rgb(var(--color-text))]"
            >
              Cancel
            </button>
            <button
              type="button"
              onClick={createMilestone}
              disabled={!label.trim()}
              className="rounded-lg bg-[rgb(var(--color-accent))] px-4 py-1.5 text-xs font-semibold text-[rgb(var(--color-accent-fg))] transition-colors hover:bg-[rgb(var(--color-accent-hover))] disabled:pointer-events-none disabled:opacity-40"
            >
              Create milestone and push
            </button>
          </div>
        </div>
      </div>
    </Dialog>
  );
}
