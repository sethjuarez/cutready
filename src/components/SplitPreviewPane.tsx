import { useEffect, useState } from "react";
import { invoke, convertFileSrc } from "@tauri-apps/api/core";
import { XMarkIcon } from "@heroicons/react/24/outline";
import { useAppStore } from "../stores/appStore";
import type { Sketch, Storyboard } from "../types/sketch";
import { SafeMarkdown } from "./SafeMarkdown";
/**
 * SplitPreviewPane — renders a read-only preview of a tab's content
 * in the split (right) pane. Loads data independently from the primary editor.
 */
export function SplitPreviewPane() {
  const splitTabId = useAppStore((s) => s.splitTabId);
  const openTabs = useAppStore((s) => s.openTabs);
  const closeSplit = useAppStore((s) => s.closeSplit);

  const tab = openTabs.find((t) => t.id === splitTabId);

  if (!tab) return null;

  return (
    <div className="flex flex-col h-full min-w-0">
      {/* Split pane header */}
      <div className="flex items-center justify-between px-3 h-[36px] bg-[var(--color-surface-alt)] border-b border-[var(--color-border)] shrink-0">
        <span className="text-[12px] text-[var(--color-text-secondary)] truncate">
          {tab.title}
        </span>
        <button
          className="flex items-center justify-center w-5 h-5 rounded text-[var(--color-text-secondary)] hover:text-[var(--color-text)] hover:bg-[var(--color-surface)] transition-colors"
          onClick={closeSplit}
          title="Close split"
        >
          <XMarkIcon className="w-2.5 h-2.5" />
        </button>
      </div>

      {/* Content */}
      <div className="flex-1 overflow-y-auto">
        {tab.type === "sketch" && <SketchPreviewContent path={tab.path} />}
        {tab.type === "note" && <NotePreviewContent path={tab.path} />}
        {tab.type === "storyboard" && <StoryboardPreviewContent path={tab.path} />}
        {tab.type === "history" && (
          <div className="flex items-center justify-center h-full text-[var(--color-text-secondary)] text-sm">
            History cannot be split
          </div>
        )}
      </div>
    </div>
  );
}

function SketchPreviewContent({ path }: { path: string }) {
  const [sketch, setSketch] = useState<Sketch | null>(null);
  const [error, setError] = useState(false);

  useEffect(() => {
    let cancelled = false;
    invoke<Sketch>("get_sketch", { relativePath: path })
      .then((s) => { if (!cancelled) setSketch(s); })
      .catch(() => { if (!cancelled) setError(true); });
    return () => { cancelled = true; };
  }, [path]);

  // Re-load when AI updates or sketch changes happen
  useEffect(() => {
    const handler = () => {
      invoke<Sketch>("get_sketch", { relativePath: path })
        .then((s) => setSketch(s))
        .catch(() => {});
    };
    window.addEventListener("cutready:ai-sketch-updated", handler);
    window.addEventListener("cutready:sketch-saved", handler);
    return () => {
      window.removeEventListener("cutready:ai-sketch-updated", handler);
      window.removeEventListener("cutready:sketch-saved", handler);
    };
  }, [path]);

  if (error) return <div className="p-4 text-sm text-[var(--color-error)]">Failed to load sketch</div>;
  if (!sketch) return <LoadingSpinner />;

  return (
    <div className="p-4">
      <h2 className="text-lg font-semibold text-[var(--color-text)] mb-1">{sketch.title || "Untitled"}</h2>
      {sketch.description ? (
        <p className="text-sm text-[var(--color-text-secondary)] mb-4">{String(sketch.description)}</p>
      ) : null}

      {/* Planning table */}
      {sketch.rows && sketch.rows.length > 0 && (
        <table className="w-full border-collapse text-[13px]">
          <thead>
            <tr>
              <th className="script-table-th">#</th>
              <th className="script-table-th">Narrative</th>
              <th className="script-table-th">Demo Actions</th>
              {sketch.rows.some((r) => r.screenshot) && <th className="script-table-th">Screenshot</th>}
            </tr>
          </thead>
          <tbody>
            {sketch.rows.map((row, i) => (
              <tr key={i} className="border-b border-[var(--color-border-subtle)]">
                <td className="script-table-td text-[var(--color-text-secondary)] w-8">{i + 1}</td>
                <td className="script-table-td">{row.narrative || <span className="text-[var(--color-text-secondary)]/40">—</span>}</td>
                <td className="script-table-td">{row.demo_actions || <span className="text-[var(--color-text-secondary)]/40">—</span>}</td>
                {sketch.rows.some((r) => r.screenshot) && (
                  <td className="script-table-td">
                    {row.screenshot && (
                      <img
                        src={convertFileSrc(row.screenshot)}
                        alt=""
                        className="w-24 h-auto rounded border border-[var(--color-border)]"
                      />
                    )}
                  </td>
                )}
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </div>
  );
}

function NotePreviewContent({ path }: { path: string }) {
  const [content, setContent] = useState<string | null>(null);
  const [error, setError] = useState(false);

  useEffect(() => {
    let cancelled = false;
    invoke<string>("get_note", { relativePath: path })
      .then((c) => { if (!cancelled) setContent(c); })
      .catch(() => { if (!cancelled) setError(true); });
    return () => { cancelled = true; };
  }, [path]);

  // Re-load when note changes
  useEffect(() => {
    const handler = () => {
      invoke<string>("get_note", { relativePath: path })
        .then((c) => setContent(c))
        .catch(() => {});
    };
    window.addEventListener("cutready:ai-note-updated", handler);
    return () => window.removeEventListener("cutready:ai-note-updated", handler);
  }, [path]);

  if (error) return <div className="p-4 text-sm text-[var(--color-error)]">Failed to load note</div>;
  if (content === null) return <LoadingSpinner />;

  return (
    <div className="p-4 prose-cutready">
      <SafeMarkdown rehypePlugins={[]}>{content}</SafeMarkdown>
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

  if (error) return <div className="p-4 text-sm text-[var(--color-error)]">Failed to load storyboard</div>;
  if (!storyboard) return <LoadingSpinner />;

  return (
    <div className="p-4">
      <h2 className="text-lg font-semibold text-[var(--color-text)] mb-3">{storyboard.title || "Untitled"}</h2>
      <div className="flex flex-col gap-2">
        {storyboard.items.map((item, i) => (
          <div
            key={i}
            className="flex items-center gap-2 px-3 py-2 rounded-lg bg-[var(--color-surface-alt)] border border-[var(--color-border)] text-sm"
          >
            <span className="text-[var(--color-text-secondary)] text-xs w-5">{i + 1}</span>
            <span className="text-[var(--color-text)]">
              {item.type === "section" ? item.title : item.path}
            </span>
            {item.type === "section" && (
              <span className="text-[10px] px-1.5 py-0.5 rounded bg-[var(--color-accent)]/10 text-[var(--color-accent)]">
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
    <div className="flex items-center justify-center h-32 text-[var(--color-text-secondary)]">
      <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" className="animate-spin">
        <path d="M21 12a9 9 0 1 1-6.219-8.56" />
      </svg>
    </div>
  );
}
