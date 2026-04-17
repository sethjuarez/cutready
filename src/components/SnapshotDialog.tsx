import { useCallback, useEffect, useRef, useState } from "react";
import { Download, AlertCircle } from "lucide-react";
import { useAppStore } from "../stores/appStore";
import { Dialog } from "./Dialog";
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

  const [label, setLabel] = useState("");
  const [forkLabel, setForkLabel] = useState("");
  const [saving, setSaving] = useState(false);
  const inputRef = useRef<HTMLInputElement>(null);

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
    useAppStore.setState({ snapshotPromptOpen: false, pendingNavAfterSave: null });
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
      close();
    } catch (err) {
      console.error("Snapshot save failed:", err);
      const { useToastStore } = await import("../stores/toastStore");
      useToastStore.getState().show(`Snapshot failed: ${err}`, 5000, "error");
      setSaving(false);
    }
  }, [label, forkLabel, isRewound, saveVersion, loadGraphData, loadTimelines, close]);

  // Auto-focus and select input when opened
  useEffect(() => {
    if (snapshotPromptOpen) {
      requestAnimationFrame(() => {
        inputRef.current?.focus();
        inputRef.current?.select();
      });
    }
  }, [snapshotPromptOpen]);

  if (!snapshotPromptOpen) return null;

  const willFork = isRewound;

  return (
    <Dialog isOpen={snapshotPromptOpen} onClose={close} align="top" topOffset="20vh" width="w-full max-w-md mx-4" backdropClass="bg-black/40">
      <div className="bg-[rgb(var(--color-surface))] border border-[rgb(var(--color-border))] rounded-xl shadow-2xl overflow-hidden">
        {/* Header */}
        <div className="flex items-center gap-2.5 px-5 pt-5 pb-3">
          <div className="p-2 rounded-lg bg-[rgb(var(--color-accent))]/10">
            <Download className="w-5 h-5" style={{ stroke: "rgb(var(--color-accent))" }} />
          </div>
          <div>
            <h2 className="text-sm font-semibold text-[rgb(var(--color-text))]">Save Snapshot</h2>
            <p className="text-[11px] text-[rgb(var(--color-text-secondary))]">
              Save the current state of your project
            </p>
          </div>
        </div>

        {/* Body */}
        <div className="px-5 pb-5 flex flex-col gap-3">
          {/* Fork warning */}
          {willFork && (
            <div className="flex items-start gap-2 px-3 py-2.5 rounded-lg bg-[rgb(var(--color-accent))]/10 border border-[rgb(var(--color-accent))]/20">
              <AlertCircle className="w-3.5 h-3.5 text-[rgb(var(--color-accent))] shrink-0 mt-0.5" />
              <div className="flex-1">
                <div className="text-[11px] font-medium text-[rgb(var(--color-accent))] mb-0.5">
                  Creating a new branch
                </div>
                <div className="text-[10px] text-[rgb(var(--color-text-secondary))] mb-2">
                  Your changes will be saved on a separate timeline, so the original history stays safe.
                </div>
                <input
                  type="text"
                  value={forkLabel}
                  onChange={(e) => setForkLabel(e.target.value)}
                  placeholder="e.g. Alternative intro, V2 approach..."
                  className="w-full px-2.5 py-1.5 rounded-md bg-[rgb(var(--color-surface))] border border-[rgb(var(--color-accent))]/20 text-xs text-[rgb(var(--color-text))] placeholder:text-[rgb(var(--color-text-secondary))]/50 focus:outline-none focus:ring-1 focus:ring-[rgb(var(--color-accent))]/40"
                />
              </div>
            </div>
          )}

          {/* Snapshot name */}
          <div>
            <label className="block text-xs font-medium text-[rgb(var(--color-text-secondary))] mb-1.5">
              Snapshot name
            </label>
            <input
              ref={inputRef}
              type="text"
              value={label}
              onChange={(e) => setLabel(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === "Enter") handleSave();
              }}
              placeholder="e.g. Added intro sketch, refined transitions..."
              className="w-full px-3 py-2 rounded-lg bg-[rgb(var(--color-surface-alt))] border border-[rgb(var(--color-border))] text-sm text-[rgb(var(--color-text))] placeholder:text-[rgb(var(--color-text-secondary))]/40 focus:outline-none focus:ring-2 focus:ring-[rgb(var(--color-accent))]/40"
            />
          </div>

          {/* Actions */}
          <div className="flex items-center justify-end gap-2 pt-1">
            <button
              onClick={close}
              className="px-3 py-1.5 rounded-lg text-xs text-[rgb(var(--color-text-secondary))] hover:text-[rgb(var(--color-text))] transition-colors"
            >
              Cancel
            </button>
            <button
              onClick={handleSave}
              disabled={!label.trim() || (willFork && !forkLabel.trim()) || saving}
              className="px-4 py-1.5 rounded-lg text-xs font-medium bg-[rgb(var(--color-accent))] text-white hover:bg-[rgb(var(--color-accent-hover))] disabled:opacity-40 transition-colors"
            >
              {saving ? "Saving..." : "Save Snapshot"}
            </button>
          </div>
        </div>
      </div>
    </Dialog>
  );
}
