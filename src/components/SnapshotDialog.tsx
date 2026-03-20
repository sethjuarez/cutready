import { useCallback, useEffect, useRef, useState } from "react";
import { ArrowDownTrayIcon, ExclamationCircleIcon } from "@heroicons/react/24/outline";
import { useAppStore } from "../stores/appStore";

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

  // Auto-generate a snapshot name when the dialog opens
  useEffect(() => {
    if (snapshotPromptOpen && !label) {
      const now = new Date();
      const h = now.getHours();
      const m = String(now.getMinutes()).padStart(2, "0");
      const period = h < 12 ? "morning" : h < 17 ? "afternoon" : "evening";
      const dayNames = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];
      const day = dayNames[now.getDay()];
      setLabel(`${day} ${period} ${h % 12 || 12}:${m}`);
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
      useToastStore.getState().show(`Snapshot failed: ${err}`, 5000);
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

  // Close on Escape
  useEffect(() => {
    if (!snapshotPromptOpen) return;
    const handler = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        e.preventDefault();
        close();
      }
    };
    window.addEventListener("keydown", handler);
    return () => window.removeEventListener("keydown", handler);
  }, [snapshotPromptOpen, close]);

  if (!snapshotPromptOpen) return null;

  const willFork = isRewound;

  return (
    <div className="fixed inset-0 z-[9999] flex items-start justify-center pt-[20vh]">
      {/* Backdrop */}
      <div className="absolute inset-0 bg-black/40" onClick={close} />

      {/* Dialog */}
      <div className="relative bg-[var(--color-surface)] border border-[var(--color-border)] rounded-xl shadow-2xl w-full max-w-md mx-4 overflow-hidden">
        {/* Header */}
        <div className="flex items-center gap-2.5 px-5 pt-5 pb-3">
          <div className="p-2 rounded-lg bg-[var(--color-accent)]/10">
            <ArrowDownTrayIcon className="w-5 h-5" style={{ stroke: "var(--color-accent)" }} />
          </div>
          <div>
            <h2 className="text-sm font-semibold text-[var(--color-text)]">Save Snapshot</h2>
            <p className="text-[11px] text-[var(--color-text-secondary)]">
              Save the current state of your project
            </p>
          </div>
        </div>

        {/* Body */}
        <div className="px-5 pb-5 flex flex-col gap-3">
          {/* Fork warning */}
          {willFork && (
            <div className="flex items-start gap-2 px-3 py-2.5 rounded-lg bg-warning/10 border border-warning/20">
              <ExclamationCircleIcon className="w-3.5 h-3.5 text-warning shrink-0 mt-0.5" />
              <div className="flex-1">
                <div className="text-[11px] font-medium text-warning mb-1.5">
                  You're starting a new direction from an older snapshot
                </div>
                <input
                  type="text"
                  value={forkLabel}
                  onChange={(e) => setForkLabel(e.target.value)}
                  placeholder="Name this line of thinking..."
                  className="w-full px-2.5 py-1.5 rounded-md bg-[var(--color-surface)] border border-warning/30 text-xs text-[var(--color-text)] placeholder:text-[var(--color-text-secondary)]/50 focus:outline-none focus:ring-1 focus:ring-warning/40"
                />
              </div>
            </div>
          )}

          {/* Snapshot name */}
          <div>
            <label className="block text-xs font-medium text-[var(--color-text-secondary)] mb-1.5">
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
              className="w-full px-3 py-2 rounded-lg bg-[var(--color-surface-alt)] border border-[var(--color-border)] text-sm text-[var(--color-text)] placeholder:text-[var(--color-text-secondary)]/40 focus:outline-none focus:ring-2 focus:ring-[var(--color-accent)]/40"
            />
          </div>

          {/* Actions */}
          <div className="flex items-center justify-end gap-2 pt-1">
            <button
              onClick={close}
              className="px-3 py-1.5 rounded-lg text-xs text-[var(--color-text-secondary)] hover:text-[var(--color-text)] transition-colors"
            >
              Cancel
            </button>
            <button
              onClick={handleSave}
              disabled={!label.trim() || (willFork && !forkLabel.trim()) || saving}
              className="px-4 py-1.5 rounded-lg text-xs font-medium bg-[var(--color-accent)] text-white hover:bg-[var(--color-accent-hover)] disabled:opacity-40 transition-colors"
            >
              {saving ? "Saving..." : "Save Snapshot"}
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}
