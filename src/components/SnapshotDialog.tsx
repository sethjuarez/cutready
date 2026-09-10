import { useCallback, useEffect, useState } from "react";
import { Download, AlertCircle } from "lucide-react";
import { useAppStore } from "../stores/appStore";
import { PromptDialog } from "./PromptDialog";
import { generateSnapshotName } from "../utils/snapshotName";

/**
 * Modal dialog for naming a snapshot (Ctrl+S).
 * Appears centered on screen regardless of which panel is active.
 */
export function SnapshotDialog() {
  const snapshotPromptOpen = useAppStore((s) => s.snapshotPromptOpen);
  const isRewound = useAppStore((s) => s.isRewound);
  const saveVersion = useAppStore((s) => s.saveVersion);
  const loadGraphData = useAppStore((s) => s.loadGraphData);
  const loadTimelines = useAppStore((s) => s.loadTimelines);
  const navigateToSnapshot = useAppStore((s) => s.navigateToSnapshot);
  const pendingNavAfterSave = useAppStore((s) => s.pendingNavAfterSave);
  const pendingTimelineAfterSave = useAppStore((s) => s.pendingTimelineAfterSave);
  const switchTimeline = useAppStore((s) => s.switchTimeline);
  const isMultiProject = useAppStore((s) => s.isMultiProject);

  const [label, setLabel] = useState("");
  const [forkLabel, setForkLabel] = useState("");
  const [saving, setSaving] = useState(false);

  // Auto-generate a snapshot name (and fork label when rewound) on open
  useEffect(() => {
    if (snapshotPromptOpen) {
      if (!label) {
        setLabel(generateSnapshotName());
      }
      if (isRewound && !forkLabel) {
        setForkLabel("New direction");
      }
    }
  }, [snapshotPromptOpen]);

  const close = useCallback(() => {
    useAppStore.setState({
      snapshotPromptOpen: false,
      pendingNavAfterSave: null,
      pendingTimelineAfterSave: null,
    });
    setLabel("");
    setForkLabel("");
    setSaving(false);
  }, []);

  const handleSave = useCallback(async () => {
    const name = label.trim();
    if (!name) return;
    if (isRewound && !forkLabel.trim()) return;
    setSaving(true);
    try {
      await saveVersion(name, isRewound ? forkLabel.trim() : undefined);
      await loadGraphData();
      await loadTimelines();
      // If we were saving before navigating to another snapshot, navigate now
      if (pendingNavAfterSave) {
        await navigateToSnapshot(pendingNavAfterSave);
        await loadGraphData();
        await loadTimelines();
      }
      if (pendingTimelineAfterSave) {
        await switchTimeline(pendingTimelineAfterSave);
      }
      close();
    } catch (err) {
      console.error("Snapshot save failed:", err);
      const { useToastStore } = await import("../stores/toastStore");
      useToastStore.getState().show(`Snapshot failed: ${err}`, 5000, "error");
      setSaving(false);
    }
  }, [label, forkLabel, isRewound, saveVersion, loadGraphData, loadTimelines, pendingNavAfterSave, pendingTimelineAfterSave, navigateToSnapshot, switchTimeline, close]);

  if (!snapshotPromptOpen) return null;

  const willFork = isRewound;

  return (
    <PromptDialog
      open={snapshotPromptOpen}
      title="Save Snapshot"
      description={`Save the current state of ${isMultiProject ? "this workspace" : "this project"}`}
      icon={<Download className="h-5 w-5" />}
      onClose={close}
      focusKey={`${snapshotPromptOpen}:${isRewound}`}
      noticeTone="accent"
      notice={willFork ? (
        <div className="flex items-start gap-2 text-[11px] leading-relaxed text-[rgb(var(--color-text-secondary))]">
          <AlertCircle className="mt-0.5 h-3.5 w-3.5 shrink-0 text-[rgb(var(--color-accent))]" />
          <span>
            <span className="mb-0.5 block font-medium text-[rgb(var(--color-accent))]">Creating a new branch</span>
            Your changes will be saved on a separate timeline, so the original history stays safe.
          </span>
        </div>
      ) : undefined}
      fields={[
        {
          id: "snapshot-name-input",
          label: "Snapshot name",
          value: label,
          onChange: setLabel,
          placeholder: "e.g. Added intro sketch, refined transitions...",
        },
        ...(willFork ? [{
          id: "snapshot-fork-label-input",
          label: "New timeline name",
          value: forkLabel,
          onChange: setForkLabel,
          placeholder: "e.g. Alternative intro, V2 approach...",
        }] : []),
      ]}
      actions={[
        { id: "cancel", label: "Cancel", onSelect: close },
        {
          id: "save",
          label: saving ? "Saving..." : "Save Snapshot",
          onSelect: handleSave,
          variant: "primary",
          disabled: !label.trim() || (willFork && !forkLabel.trim()) || saving,
        },
      ]}
    />
  );
}
