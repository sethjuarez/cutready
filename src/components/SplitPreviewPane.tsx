import { useEffect, useRef, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { XMarkIcon, ExclamationTriangleIcon } from "@heroicons/react/24/outline";
import { useAppStore } from "../stores/appStore";
import type { Sketch, Storyboard } from "../types/sketch";
import type { PlanningRow } from "../types/sketch";
import { ScriptTable } from "./ScriptTable";
import { MarkdownEditor } from "./MarkdownEditor";

/**
 * SplitPreviewPane — renders an independently editable pane for a tab's content.
 * Sketch and note tabs are fully editable; storyboard tabs are read-only.
 * Each editor loads and saves independently from the primary pane.
 */
export function SplitPreviewPane() {
  const splitTabId = useAppStore((s) => s.splitTabId);
  const openTabs = useAppStore((s) => s.openTabs);
  const activeTabId = useAppStore((s) => s.activeTabId);
  const closeSplit = useAppStore((s) => s.closeSplit);

  const tab = openTabs.find((t) => t.id === splitTabId);
  const activeTab = openTabs.find((t) => t.id === activeTabId);
  const sameFile = tab && activeTab && tab.path === activeTab.path && tab.id !== activeTab.id;

  if (!tab) return null;

  return (
    <div className="flex flex-col h-full min-w-0">
      {/* Split pane header */}
      <div className="flex items-center justify-between px-3 h-[36px] bg-[rgb(var(--color-surface-alt))] border-b border-[rgb(var(--color-border))] shrink-0">
        <span className="text-[12px] text-[rgb(var(--color-text-secondary))] truncate">
          {tab.title}
        </span>
        <button
          className="flex items-center justify-center w-5 h-5 rounded text-[rgb(var(--color-text-secondary))] hover:text-[rgb(var(--color-text))] hover:bg-[rgb(var(--color-surface))] transition-colors"
          onClick={closeSplit}
          title="Close split"
        >
          <XMarkIcon className="w-2.5 h-2.5" />
        </button>
      </div>

      {/* Same-file warning */}
      {sameFile && (
        <div className="flex items-center gap-2 px-3 py-1.5 bg-warning/10 border-b border-warning/30 text-[11px] text-warning shrink-0">
          <ExclamationTriangleIcon className="w-3.5 h-3.5 shrink-0" />
          Same file open in both panes — last save wins
        </div>
      )}

      {/* Content */}
      <div className="flex-1 overflow-y-auto min-h-0">
        {tab.type === "sketch" && <SketchSplitEditor path={tab.path} />}
        {tab.type === "note" && <NoteSplitEditor path={tab.path} />}
        {tab.type === "storyboard" && <StoryboardPreviewContent path={tab.path} />}
        {tab.type === "history" && (
          <div className="flex items-center justify-center h-full text-[rgb(var(--color-text-secondary))] text-sm">
            History cannot be split
          </div>
        )}
      </div>
    </div>
  );
}

/** Fully editable sketch editor for the split pane — loads/saves independently. */
function SketchSplitEditor({ path }: { path: string }) {
  const [sketch, setSketch] = useState<Sketch | null>(null);
  const [localRows, setLocalRows] = useState<PlanningRow[]>([]);
  const [error, setError] = useState(false);
  const projectRoot = useAppStore((s) => s.currentProject?.root ?? "");
  const saveTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(() => {
    let cancelled = false;
    invoke<Sketch>("get_sketch", { relativePath: path })
      .then((s) => {
        if (!cancelled) {
          setSketch(s);
          setLocalRows(s.rows ?? []);
        }
      })
      .catch(() => { if (!cancelled) setError(true); });
    return () => { cancelled = true; };
  }, [path]);

  // Re-load when primary pane saves (so split stays in sync if primary edits)
  useEffect(() => {
    const handler = () => {
      invoke<Sketch>("get_sketch", { relativePath: path })
        .then((s) => { setSketch(s); setLocalRows(s.rows ?? []); })
        .catch(() => {});
    };
    window.addEventListener("cutready:sketch-saved", handler);
    window.addEventListener("cutready:ai-sketch-updated", handler);
    return () => {
      window.removeEventListener("cutready:sketch-saved", handler);
      window.removeEventListener("cutready:ai-sketch-updated", handler);
    };
  }, [path]);

  const handleRowsChange = (rows: PlanningRow[]) => {
    setLocalRows(rows);
    if (saveTimerRef.current) clearTimeout(saveTimerRef.current);
    saveTimerRef.current = setTimeout(() => {
      invoke("update_sketch", { relativePath: path, rows }).catch(() => {});
      window.dispatchEvent(new CustomEvent("cutready:sketch-saved"));
    }, 800);
  };

  if (error) return <div className="p-4 text-sm text-[rgb(var(--color-error))]">Failed to load sketch</div>;
  if (!sketch) return <LoadingSpinner />;

  return (
    <div className="flex flex-col h-full">
      <div className="px-4 pt-4 pb-2 shrink-0">
        <h2 className="text-base font-semibold text-[rgb(var(--color-text))] truncate">{sketch.title || "Untitled"}</h2>
        {sketch.description ? (
          <p className="text-xs text-[rgb(var(--color-text-secondary))] mt-1 line-clamp-2">{String(sketch.description)}</p>
        ) : null}
      </div>
      <div className="flex-1 overflow-auto px-2 pb-4">
        <ScriptTable
          rows={localRows}
          onChange={handleRowsChange}
          projectRoot={projectRoot}
          sketchPath={path}
        />
      </div>
    </div>
  );
}

/** Fully editable note editor for the split pane — loads/saves independently. */
function NoteSplitEditor({ path }: { path: string }) {
  const [content, setContent] = useState<string | null>(null);
  const [error, setError] = useState(false);
  const projectRoot = useAppStore((s) => s.currentProject?.root ?? "");
  const saveTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(() => {
    let cancelled = false;
    invoke<string>("get_note", { relativePath: path })
      .then((c) => { if (!cancelled) setContent(c); })
      .catch(() => { if (!cancelled) setError(true); });
    return () => { cancelled = true; };
  }, [path]);

  // Re-load when AI updates
  useEffect(() => {
    const handler = () => {
      invoke<string>("get_note", { relativePath: path })
        .then((c) => setContent(c))
        .catch(() => {});
    };
    window.addEventListener("cutready:ai-note-updated", handler);
    return () => window.removeEventListener("cutready:ai-note-updated", handler);
  }, [path]);

  const handleChange = (value: string) => {
    setContent(value);
    if (saveTimerRef.current) clearTimeout(saveTimerRef.current);
    saveTimerRef.current = setTimeout(() => {
      invoke("update_note", { relativePath: path, content: value }).catch(() => {});
    }, 800);
  };

  if (error) return <div className="p-4 text-sm text-[rgb(var(--color-error))]">Failed to load note</div>;
  if (content === null) return <LoadingSpinner />;

  return (
    <div className="px-4 h-full">
      <MarkdownEditor
        key={path}
        editorKey={path}
        value={content}
        onChange={handleChange}
        placeholder="Start writing..."
        saveImages={!!projectRoot}
      />
    </div>
  );
}

function StoryboardPreviewContent({ path }: { path: string }) {
  const [storyboard, setStoryboard] = useState<Storyboard | null>(null);
  const [error, setError] = useState(false);

  useEffect(() => {
    let cancelled = false;
    invoke<Storyboard>("get_storyboard", { relativePath: path })
      .then((s) => { if (!cancelled) setStoryboard(s); })
      .catch(() => { if (!cancelled) setError(true); });
    return () => { cancelled = true; };
  }, [path]);

  if (error) return <div className="p-4 text-sm text-[rgb(var(--color-error))]">Failed to load storyboard</div>;
  if (!storyboard) return <LoadingSpinner />;

  return (
    <div className="p-4">
      <h2 className="text-lg font-semibold text-[rgb(var(--color-text))] mb-3">{storyboard.title || "Untitled"}</h2>
      <div className="flex flex-col gap-2">
        {storyboard.items.map((item, i) => (
          <div
            key={i}
            className="flex items-center gap-2 px-3 py-2 rounded-lg bg-[rgb(var(--color-surface-alt))] border border-[rgb(var(--color-border))] text-sm"
          >
            <span className="text-[rgb(var(--color-text-secondary))] text-xs w-5">{i + 1}</span>
            <span className="text-[rgb(var(--color-text))]">
              {item.type === "section" ? item.title : item.path}
            </span>
            {item.type === "section" && (
              <span className="text-[10px] px-1.5 py-0.5 rounded bg-[rgb(var(--color-accent))]/10 text-[rgb(var(--color-accent))]">
                Section · {item.sketches.length} sketches
              </span>
            )}
          </div>
        ))}
      </div>
    </div>
  );
}


function LoadingSpinner() {
  return (
    <div className="flex items-center justify-center h-32 text-[rgb(var(--color-text-secondary))]">
      <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" className="animate-spin">
        <path d="M21 12a9 9 0 1 1-6.219-8.56" />
      </svg>
    </div>
  );
}
