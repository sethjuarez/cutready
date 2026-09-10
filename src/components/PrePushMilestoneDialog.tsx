import { useCallback, useEffect, useState } from "react";
import { AlertCircle, GitPullRequestArrow } from "lucide-react";
import { useAppStore } from "../stores/appStore";
import { PromptDialog } from "./PromptDialog";

export function PrePushMilestoneDialog() {
  const prompt = useAppStore((s) => s.prePushMilestonePrompt);
  const resolvePrePushMilestone = useAppStore((s) => s.resolvePrePushMilestone);
  const [label, setLabel] = useState("");

  useEffect(() => {
    if (!prompt) return;
    setLabel(prompt.suggestedLabel);
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
    <PromptDialog
      open={!!prompt}
      title="Name this shared milestone"
      description={`You have ${prompt.snapshotCount} local snapshots ready to share. CutReady can publish them as one clean milestone on ${prompt.remoteName}.`}
      icon={<GitPullRequestArrow className="h-5 w-5" />}
      onClose={close}
      focusKey={prompt.suggestedLabel}
      notice={(
        <div className="flex items-start gap-2 text-[11px] leading-relaxed text-[rgb(var(--color-text-secondary))]">
          <AlertCircle className="mt-0.5 h-3.5 w-3.5 shrink-0 text-[rgb(var(--color-accent))]" />
          <span>
            This label becomes part of shared history. Collaborators will see it instead of the local save names like "{prompt.latestSnapshotLabel}".
          </span>
        </div>
      )}
      fields={[{
        id: "pre-push-milestone-label",
        label: "Milestone label",
        value: label,
        onChange: setLabel,
        placeholder: "e.g. Finalize onboarding walkthrough",
      }]}
      actions={[
        { id: "push-as-is", label: "Push snapshots as-is", onSelect: pushAsIs },
        { id: "cancel", label: "Cancel", onSelect: close },
        {
          id: "create",
          label: "Create milestone and push",
          onSelect: createMilestone,
          variant: "primary",
          disabled: !label.trim(),
        },
      ]}
    />
  );
}
