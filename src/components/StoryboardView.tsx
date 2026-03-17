import { useCallback, useEffect, useRef, useState } from "react";
import {
  DndContext,
  closestCenter,
  PointerSensor,
  useSensor,
  useSensors,
  type DragEndEvent,
} from "@dnd-kit/core";
import {
  SortableContext,
  useSortable,
  verticalListSortingStrategy,
} from "@dnd-kit/sortable";
import { CSS } from "@dnd-kit/utilities";
import { invoke } from "@tauri-apps/api/core";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";
import rehypeRaw from "rehype-raw";
import { useAppStore } from "../stores/appStore";
import { useToastStore } from "../stores/toastStore";
import { SketchPickerItem } from "./SketchCard";
import { ScriptTable } from "./ScriptTable";
import { exportStoryboardToWord } from "../utils/exportToWord";
import { ExportWordButton } from "./ExportWordButton";
import type { Sketch, SketchSummary } from "../types/sketch";
import type { PreviewSlide } from "./SketchPreview";

interface MonitorInfo {
  id: number;
  name: string;
  x: number;
  y: number;
  width: number;
  height: number;
  is_primary: boolean;
}

const PREVIEW_DATA_KEY = "cutready:preview-data";

/**
 * StoryboardView — displays the active storyboard's items
 * with sketch cards, section headers, and add buttons.
 */
export function StoryboardView() {
  const activeStoryboard = useAppStore((s) => s.activeStoryboard);
  const activeStoryboardPath = useAppStore((s) => s.activeStoryboardPath);
  const sketches = useAppStore((s) => s.sketches);
  const currentProject = useAppStore((s) => s.currentProject);
  const openSketch = useAppStore((s) => s.openSketch);
  const createSketch = useAppStore((s) => s.createSketch);
  const addSketchToStoryboard = useAppStore((s) => s.addSketchToStoryboard);
  const removeFromStoryboard = useAppStore((s) => s.removeFromStoryboard);
  const reorderStoryboardItems = useAppStore((s) => s.reorderStoryboardItems);
  const updateStoryboard = useAppStore((s) => s.updateStoryboard);
  const loadSketches = useAppStore((s) => s.loadSketches);
  const sendChatPrompt = useAppStore((s) => s.sendChatPrompt);

  const [showPicker, setShowPicker] = useState<number | null>(null);
  const [pickerSearch, setPickerSearch] = useState("");

  // Cache of full sketch data keyed by path
  const [sketchCache, setSketchCache] = useState<Map<string, Sketch>>(new Map());
  const loadingRef = useRef<Set<string>>(new Set());
  const [collapsedItems, setCollapsedItems] = useState<Set<number>>(new Set());
  const [showMonitorPicker, setShowMonitorPicker] = useState(false);
  const [editingDesc, setEditingDesc] = useState(false);
  const [localDesc, setLocalDesc] = useState(activeStoryboard?.description ?? "");
  const descRef = useRef<HTMLTextAreaElement>(null);
  const [availableMonitors, setAvailableMonitors] = useState<MonitorInfo[]>([]);

  const sketchMap = new Map(sketches.map((s) => [s.path, s]));

  // Sync local desc when storyboard changes
  useEffect(() => {
    setLocalDesc(activeStoryboard?.description ?? "");
    setEditingDesc(false);
  }, [activeStoryboard?.description]);

  useEffect(() => {
    if (editingDesc && descRef.current) {
      descRef.current.focus();
      descRef.current.selectionStart = descRef.current.value.length;
    }
  }, [editingDesc]);

  // Eagerly load all referenced sketches
  useEffect(() => {
    if (!activeStoryboard) return;
    for (const item of activeStoryboard.items) {
      if (item.type === "sketch_ref" && !sketchCache.has(item.path) && !loadingRef.current.has(item.path)) {
        loadingRef.current.add(item.path);
        invoke<Sketch>("get_sketch", { relativePath: item.path })
          .then((sketch) => setSketchCache((prev) => new Map(prev).set(item.path, sketch)))
          .catch((err) => console.error("Failed to load sketch:", err))
          .finally(() => loadingRef.current.delete(item.path));
      }
    }
  }, [activeStoryboard, sketchCache]);

  /** Build typed slides for preview: storyboard title → (sketch title → sketch rows)... */
  const buildPreviewSlides = useCallback((): PreviewSlide[] => {
    if (!activeStoryboard) return [];
    const slides: PreviewSlide[] = [];
    const sbTitle = activeStoryboard.title || "Untitled Storyboard";
    // Storyboard title slide
    slides.push({
      type: "title",
      heading: sbTitle,
      subtitle: activeStoryboard.description || "",
      context: sbTitle,
    });
    // Each sketch
    for (const item of activeStoryboard.items) {
      if (item.type !== "sketch_ref") continue;
      const full = sketchCache.get(item.path);
      if (!full) continue;
      const skTitle = full.title || "Untitled Sketch";
      const context = `${sbTitle} › ${skTitle}`;
      const desc = typeof full.description === "string" ? full.description : "";
      // Sketch title slide
      slides.push({
        type: "title",
        heading: skTitle,
        subtitle: desc,
        context,
      });
      // Sketch rows
      for (const row of full.rows) {
        slides.push({ type: "row", row, context });
      }
    }
    return slides;
  }, [activeStoryboard, sketchCache]);

  const launchPreviewOnMonitor = useCallback(async (monitor: MonitorInfo) => {
    setShowMonitorPicker(false);
    const slides = buildPreviewSlides();
    localStorage.setItem(PREVIEW_DATA_KEY, JSON.stringify({
      rows: [],
      slides,
      projectRoot: currentProject?.root ?? "",
      title: activeStoryboard?.title ?? "Storyboard",
    }));
    try {
      await invoke("open_preview_window", {
        physX: monitor.x,
        physY: monitor.y,
        physW: monitor.width,
        physH: monitor.height,
      });
    } catch (e) {
      console.error("[StoryboardView] Failed to open preview window:", e);
    }
  }, [buildPreviewSlides, currentProject, activeStoryboard]);

  const handlePreviewClick = useCallback(async () => {
    try {
      const monitors: MonitorInfo[] = await invoke("list_monitors");
      if (monitors.length === 1) {
        await launchPreviewOnMonitor(monitors[0]);
      } else {
        setAvailableMonitors(monitors);
        setShowMonitorPicker(true);
      }
    } catch (e) {
      console.error("[StoryboardView] Failed to list monitors:", e);
    }
  }, [launchPreviewOnMonitor]);

  // DnD
  const sensors = useSensors(useSensor(PointerSensor, { activationConstraint: { distance: 5 } }));

  const handleDragEnd = useCallback((event: DragEndEvent) => {
    const { active, over } = event;
    if (!over || !activeStoryboard || active.id === over.id) return;
    const items = activeStoryboard.items;
    const oldIdx = Number(active.id);
    const newIdx = Number(over.id);
    if (isNaN(oldIdx) || isNaN(newIdx)) return;
    const reordered = [...items];
    const [moved] = reordered.splice(oldIdx, 1);
    reordered.splice(newIdx, 0, moved);
    reorderStoryboardItems(reordered);
  }, [activeStoryboard, reorderStoryboardItems]);

  const handleAddNewSketch = useCallback(
    async (position?: number) => {
      const title = `Sketch ${sketches.length + 1}`;
      await createSketch(title);
      // The created sketch is now active; get its path from the store
      const { activeSketchPath } = useAppStore.getState();
      if (activeSketchPath) {
        await addSketchToStoryboard(activeSketchPath, position);
        await loadSketches();
      }
    },
    [sketches.length, createSketch, addSketchToStoryboard, loadSketches],
  );

  const handlePickExisting = useCallback(
    async (sketchPath: string, position?: number) => {
      await addSketchToStoryboard(sketchPath, position);
      setShowPicker(null);
      setPickerSearch("");
    },
    [addSketchToStoryboard],
  );

  if (!activeStoryboard) return null;

  const filteredSketches = sketches.filter((s) =>
    s.title.toLowerCase().includes(pickerSearch.toLowerCase()),
  );

  return (
    <div className="flex-1 overflow-y-auto">
      <div className="max-w-3xl mx-auto px-6 py-8">
        {/* Storyboard header */}
        <div className="flex items-center gap-3 mb-2">
          <input
            type="text"
            defaultValue={activeStoryboard.title}
            onBlur={(e) => {
              const val = e.target.value.trim();
              if (val && val !== activeStoryboard.title) {
                updateStoryboard({ title: val });
              }
            }}
            className="flex-1 text-2xl font-semibold bg-transparent text-[var(--color-text)] placeholder:text-[var(--color-text-secondary)]/40 outline-none border-none"
            placeholder="Storyboard title..."
          />
          {activeStoryboard.items.length > 0 && (
            <div className="relative flex items-center gap-2">
              <ExportWordButton
                showLabel
                onExport={(orientation) => {
                  if (!activeStoryboard) return;
                  return exportStoryboardToWord(activeStoryboard, currentProject?.root ?? "", async (paths) => {
                    const map = new Map<string, Sketch>();
                    await Promise.all(paths.map(async (p) => {
                      const cached = sketchCache.get(p);
                      if (cached) { map.set(p, cached); return; }
                      try {
                        const sk = await invoke<Sketch>("get_sketch", { relativePath: p });
                        map.set(p, sk);
                      } catch { /* skip missing */ }
                    }));
                    return map;
                  }, orientation).then(() => {
                    useToastStore.getState().show("Export complete");
                    useAppStore.getState().addActivityEntries([{ id: crypto.randomUUID(), timestamp: new Date(), source: "export", content: `Exported "${activeStoryboard.title}" to Word`, level: "success" }]);
                  }).catch(err => console.error("Word export failed:", err));
                }}
              />
              <button
                onClick={handlePreviewClick}
                className="flex items-center gap-1.5 shrink-0 text-xs text-[var(--color-text-secondary)] hover:text-[var(--color-accent)] px-3 py-1.5 rounded-lg border border-[var(--color-border)] hover:border-[var(--color-accent)]/40 hover:bg-[var(--color-accent)]/5 transition-colors"
                title="Preview storyboard (presentation mode)"
              >
                <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round">
                  <polygon points="5 3 19 12 5 21 5 3" />
                </svg>
                Preview
              </button>

              {/* Monitor picker dropdown */}
              {showMonitorPicker && (
                <>
                  <div className="fixed inset-0 z-40" onClick={() => setShowMonitorPicker(false)} />
                  <div className="absolute right-0 top-full mt-2 z-50 bg-[var(--color-surface)] border border-[var(--color-border)] rounded-lg shadow-lg py-1 min-w-[200px]">
                    <div className="px-3 py-2 text-xs font-medium text-[var(--color-text-secondary)] uppercase tracking-wider border-b border-[var(--color-border)]">
                      Present on
                    </div>
                    {availableMonitors.map((m) => (
                      <button
                        key={m.id}
                        onClick={() => launchPreviewOnMonitor(m)}
                        className="w-full px-3 py-2 text-left text-sm text-[var(--color-text)] hover:bg-[var(--color-surface-alt)] transition-colors flex items-center gap-2"
                      >
                        <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round">
                          <rect x="2" y="3" width="20" height="14" rx="2" ry="2" />
                          <line x1="8" y1="21" x2="16" y2="21" />
                          <line x1="12" y1="17" x2="12" y2="21" />
                        </svg>
                        <span>{m.name || `Monitor ${m.id}`}</span>
                        {m.is_primary && (
                          <span className="text-[10px] text-[var(--color-accent)] font-medium ml-auto">Primary</span>
                        )}
                      </button>
                    ))}
                  </div>
                </>
              )}
            </div>
          )}
        </div>
        {/* Description — markdown preview, click to edit */}
        <div className="relative group/desc mb-2">
          {editingDesc ? (
            <textarea
              ref={descRef}
              value={localDesc}
              onChange={(e) => {
                setLocalDesc(e.target.value);
                updateStoryboard({ description: e.target.value });
              }}
              onBlur={() => setEditingDesc(false)}
              placeholder="Describe this storyboard..."
              rows={3}
              className="w-full text-sm bg-transparent text-[var(--color-text)] placeholder:text-[var(--color-text-secondary)]/40 outline-none border border-[var(--color-border)] rounded-lg px-3 py-2 resize-none focus:ring-1 focus:ring-[var(--color-accent)]/40 transition-colors"
              autoFocus
            />
          ) : (
            <div
              tabIndex={0}
              onClick={() => setEditingDesc(true)}
              onFocus={() => setEditingDesc(true)}
              className="min-h-[2rem] rounded-lg px-3 py-2 text-sm cursor-text border border-transparent hover:border-[var(--color-border)] transition-colors"
            >
              {localDesc ? (
                <div className="prose-desc text-[var(--color-text-secondary)] leading-relaxed">
                  <ReactMarkdown remarkPlugins={[remarkGfm]} rehypePlugins={[rehypeRaw]}>{localDesc}</ReactMarkdown>
                </div>
              ) : (
                <span className="text-[var(--color-text-secondary)]/40">
                  Describe this storyboard...
                </span>
              )}
            </div>
          )}
          {/* Description sparkle */}
          <button
            onClick={() => sendChatPrompt(
              localDesc
                ? `Improve the description of the storyboard "${activeStoryboard.title}" (path: "${activeStoryboardPath}"). Current description: "${localDesc}". Write a clearer, more compelling description that summarizes the demo flow. Keep it concise (2-3 sentences). Use the update_storyboard tool to save the new description.`
                : `Write a description for the storyboard "${activeStoryboard.title}" (path: "${activeStoryboardPath}"). Look at the sketches to understand the demo flow and write a concise (2-3 sentence) description. Use the update_storyboard tool to save the description.`,
              { silent: true }
            )}
            className="absolute right-1 top-1 opacity-60 hover:opacity-100 p-1 rounded text-[var(--color-accent)] hover:bg-[var(--color-accent)]/10 transition-all"
            title={localDesc ? "Improve description with AI" : "Generate description with AI"}
          >
            <svg width="12" height="12" viewBox="0 0 24 24" fill="currentColor">
              <path d="M12 2l2.09 6.26L20.18 10l-6.09 1.74L12 18l-2.09-6.26L3.82 10l6.09-1.74L12 2z" />
            </svg>
          </button>
        </div>

        {/* AI actions */}
        <div className="flex items-center gap-1.5 mb-8">
          <button
            onClick={() => sendChatPrompt(
              `Review the storyboard "${activeStoryboard.title}" and suggest improvements. List the current sketches, then recommend any changes to ordering, pacing, or suggest new sketches that would strengthen the demo flow. Read each sketch first to understand the content.`,
              { silent: true }
            )}
            className="flex items-center gap-1 text-xs text-[var(--color-text-secondary)] hover:text-[var(--color-accent)] px-2 py-1 rounded-md hover:bg-[var(--color-accent)]/10 transition-colors"
            title="Review storyboard with AI"
          >
            <svg width="12" height="12" viewBox="0 0 24 24" fill="currentColor"><path d="M12 2l2.09 6.26L20.18 10l-6.09 1.74L12 18l-2.09-6.26L3.82 10l6.09-1.74L12 2z" /></svg>
            Review flow
          </button>
          <button
            onClick={() => sendChatPrompt(
              `Generate a new sketch for the storyboard "${activeStoryboard.title}". Look at the existing sketches to understand the demo flow, then create a new sketch that would complement them. Pick an appropriate name and generate 3-5 planning rows.`,
              { silent: true }
            )}
            className="flex items-center gap-1 text-xs text-[var(--color-text-secondary)] hover:text-[var(--color-accent)] px-2 py-1 rounded-md hover:bg-[var(--color-accent)]/10 transition-colors"
            title="Generate a new sketch with AI"
          >
            <svg width="12" height="12" viewBox="0 0 24 24" fill="currentColor"><path d="M12 2l2.09 6.26L20.18 10l-6.09 1.74L12 18l-2.09-6.26L3.82 10l6.09-1.74L12 2z" /></svg>
            Generate sketch
          </button>
        </div>

        {/* Items */}
        {activeStoryboard.items.length === 0 ? (
          <EmptyState
            onAddNew={() => handleAddNewSketch()}
            onPickExisting={() => setShowPicker(0)}
          />
        ) : (
          <>
          <DndContext sensors={sensors} collisionDetection={closestCenter} onDragEnd={handleDragEnd}>
            <SortableContext items={activeStoryboard.items.map((_, i) => i)} strategy={verticalListSortingStrategy}>
              <div className="divide-y divide-[var(--color-border)]">
                {activeStoryboard.items.map((item, idx) => (
                  <div key={idx} className="py-6 first:pt-0">
                    <SortableStoryboardItem id={idx}>
                      {(dragListeners) => item.type === "sketch_ref" ? (
                        <ExpandableSketchCard
                          sketch={sketchMap.get(item.path) ?? makePlaceholder(item.path)}
                          fullSketch={sketchCache.get(item.path)}
                          onOpen={() => openSketch(item.path)}
                          onRemove={() => { if (confirm("Remove this sketch from the storyboard?")) removeFromStoryboard(idx); }}
                          projectRoot={currentProject?.root}
                          dragListeners={dragListeners}
                          collapsed={collapsedItems.has(idx)}
                          onToggleCollapse={() => setCollapsedItems((prev) => {
                            const next = new Set(prev);
                            if (next.has(idx)) next.delete(idx); else next.add(idx);
                            return next;
                          })}
                        />
                      ) : (
                        /* Legacy section — render title only */
                        <div className="text-xs font-medium text-[var(--color-text-secondary)] uppercase tracking-wider py-2">
                          {item.title}
                        </div>
                      )}
                    </SortableStoryboardItem>

                    {/* Add button between items */}
                    <AddItemButton
                      position={idx + 1}
                      onAddNew={handleAddNewSketch}
                      showPicker={showPicker}
                      setShowPicker={setShowPicker}
                      filteredSketches={filteredSketches}
                      pickerSearch={pickerSearch}
                      setPickerSearch={setPickerSearch}
                      onPickExisting={handlePickExisting}
                    />
                  </div>
                ))}
              </div>
            </SortableContext>
          </DndContext>

          {/* Always-visible add bar at end */}
          <AddBar
            onAddNew={() => handleAddNewSketch()}
            onPickExisting={() => setShowPicker(-1)}
          />

          {/* Picker/section input for the bottom bar */}
          {showPicker === -1 && (
            <SketchPicker
              sketches={filteredSketches}
              search={pickerSearch}
              onSearchChange={setPickerSearch}
              onSelect={(path) => handlePickExisting(path)}
              onClose={() => { setShowPicker(null); setPickerSearch(""); }}
            />
          )}
        </>
        )}

        {/* Picker overlay (when shown at a position) */}
        {showPicker !== null && activeStoryboard.items.length === 0 && (
          <SketchPicker
            sketches={filteredSketches}
            search={pickerSearch}
            onSearchChange={setPickerSearch}
            onSelect={(path) => handlePickExisting(path, showPicker)}
            onClose={() => { setShowPicker(null); setPickerSearch(""); }}
          />
        )}
      </div>
    </div>
  );
}

/* ── Sortable wrapper for storyboard items ─────────────── */

function SortableStoryboardItem({ id, children }: { id: number; children: (dragListeners: Record<string, any>) => React.ReactNode }) {
  const { attributes, listeners, setNodeRef, transform, transition, isDragging } = useSortable({ id });
  const style = {
    transform: CSS.Transform.toString(transform),
    transition,
    opacity: isDragging ? 0.4 : 1,
  };
  return (
    <div ref={setNodeRef} style={style} {...attributes} className="outline-none">
      {children(listeners ?? {})}
    </div>
  );
}

/* ── Expandable sketch card with inline read-only preview ─ */

const stateLabels: Record<string, string> = {
  draft: "Draft",
  recording_enriched: "Recording",
  refined: "Refined",
  final: "Final",
};

function ExpandableSketchCard({
  sketch,
  fullSketch,
  onOpen,
  onRemove,
  projectRoot,
  dragListeners,
  collapsed,
  onToggleCollapse,
}: {
  sketch: SketchSummary;
  fullSketch?: Sketch;
  onOpen: () => void;
  onRemove: () => void;
  projectRoot?: string;
  dragListeners: Record<string, any>;
  collapsed: boolean;
  onToggleCollapse: () => void;
}) {
  return (
    <div className="group/sketch">
      {/* Title row — document sub-heading style */}
      <div className="flex items-center gap-2 py-1">
        {/* Drag handle — grip dots before title */}
        <div
          {...dragListeners}
          className="shrink-0 cursor-grab active:cursor-grabbing opacity-30 hover:opacity-100 transition-opacity"
          title="Drag to reorder"
        >
          <svg width="8" height="14" viewBox="0 0 8 14" fill="currentColor" className="text-[var(--color-text-secondary)]">
            <circle cx="2" cy="2" r="1.2" />
            <circle cx="6" cy="2" r="1.2" />
            <circle cx="2" cy="7" r="1.2" />
            <circle cx="6" cy="7" r="1.2" />
            <circle cx="2" cy="12" r="1.2" />
            <circle cx="6" cy="12" r="1.2" />
          </svg>
        </div>

        {/* Collapse toggle */}
        <button
          onClick={onToggleCollapse}
          className="shrink-0 text-[var(--color-text-secondary)] hover:text-[var(--color-accent)] transition-colors"
          title={collapsed ? "Show table" : "Hide table"}
        >
          <svg
            width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor"
            strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"
            className={`transition-transform ${collapsed ? "" : "rotate-90"}`}
          >
            <polyline points="9 18 15 12 9 6" />
          </svg>
        </button>

        <h3 className="text-base font-semibold text-[var(--color-text)] truncate">
          {sketch.title}
        </h3>

        <span className="text-[10px] px-1.5 py-0.5 rounded-full bg-[var(--color-accent)]/10 text-[var(--color-accent)] shrink-0">
          {stateLabels[sketch.state] ?? sketch.state}
        </span>

        <span className="text-[10px] text-[var(--color-text-secondary)] shrink-0">
          {sketch.row_count} {sketch.row_count === 1 ? "row" : "rows"}
        </span>

        {/* Edit pencil */}
        <button
          onClick={onOpen}
          className="shrink-0 p-1 rounded text-[var(--color-text-secondary)] opacity-0 group-hover/sketch:opacity-100 hover:text-[var(--color-accent)] transition-all"
          title="Open in editor"
        >
          <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
            <path d="M17 3a2.828 2.828 0 1 1 4 4L7.5 20.5 2 22l1.5-5.5L17 3z" />
          </svg>
        </button>

        {/* Remove */}
        <button
          onClick={onRemove}
          className="shrink-0 p-1 rounded text-[var(--color-text-secondary)] opacity-0 group-hover/sketch:opacity-100 hover:text-red-400 transition-all"
          title="Remove from storyboard"
        >
          <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
            <line x1="18" y1="6" x2="6" y2="18" />
            <line x1="6" y1="6" x2="18" y2="18" />
          </svg>
        </button>
      </div>

      {/* Description (from full sketch if loaded) */}
      {fullSketch && typeof fullSketch.description === "string" && fullSketch.description.trim() && (
        <div className="prose-desc text-sm text-[var(--color-text-secondary)] mb-2 leading-relaxed">
          <ReactMarkdown remarkPlugins={[remarkGfm]} rehypePlugins={[rehypeRaw]}>{fullSketch.description}</ReactMarkdown>
        </div>
      )}

      {/* Table — collapsible */}
      {!collapsed && (fullSketch ? (
        fullSketch.rows.length > 0 ? (
          <ScriptTable
            rows={fullSketch.rows}
            onChange={() => {}}
            readOnly
            projectRoot={projectRoot}
          />
        ) : (
          <p className="text-xs text-[var(--color-text-secondary)] py-2">No rows yet</p>
        )
      ) : (
        <div className="flex items-center gap-2 py-3">
          <div className="w-3 h-3 border-2 border-[var(--color-text-secondary)]/30 border-t-[var(--color-accent)] rounded-full animate-spin" />
          <span className="text-xs text-[var(--color-text-secondary)]">Loading sketch…</span>
        </div>
      ))}
    </div>
  );
}

function EmptyState({
  onAddNew,
  onPickExisting,
}: {
  onAddNew: () => void;
  onPickExisting: () => void;
}) {
  return (
    <div className="flex flex-col items-center justify-center py-16">
      <div className="text-4xl mb-4">🎬</div>
      <p className="text-sm text-[var(--color-text-secondary)] mb-6">
        Start building your storyboard
      </p>
      <div className="flex gap-3">
        <button
          onClick={onAddNew}
          className="flex items-center gap-2 px-4 py-2.5 text-xs font-medium rounded-xl bg-[var(--color-accent)] text-white hover:bg-[var(--color-accent-hover)] transition-colors"
        >
          <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
            <line x1="12" y1="5" x2="12" y2="19" />
            <line x1="5" y1="12" x2="19" y2="12" />
          </svg>
          New Sketch
        </button>
        <button
          onClick={onPickExisting}
          className="flex items-center gap-2 px-4 py-2.5 text-xs font-medium rounded-xl border border-[var(--color-border)] text-[var(--color-text-secondary)] hover:text-[var(--color-text)] hover:border-[var(--color-accent)]/40 transition-colors"
        >
          Add Existing
        </button>
      </div>
    </div>
  );
}

function AddItemButton({
  position,
  onAddNew,
  showPicker,
  setShowPicker,
  filteredSketches,
  pickerSearch,
  setPickerSearch,
  onPickExisting,
}: {
  position: number;
  onAddNew: (pos: number) => void;
  showPicker: number | null;
  setShowPicker: (v: number | null) => void;
  filteredSketches: import("../types/sketch").SketchSummary[];
  pickerSearch: string;
  setPickerSearch: (v: string) => void;
  onPickExisting: (path: string, pos: number) => void;
}) {
  return (
    <div className="relative flex items-center justify-center py-1">
      <div className="flex gap-1 opacity-0 hover:opacity-100 focus-within:opacity-100 transition-opacity">
        <button
          onClick={() => onAddNew(position)}
          className="px-2 py-1 text-[10px] rounded-md text-[var(--color-text-secondary)] hover:text-[var(--color-accent)] hover:bg-[var(--color-accent)]/10 transition-colors"
          title="New sketch"
        >
          + Sketch
        </button>
        <button
          onClick={() => setShowPicker(showPicker === position ? null : position)}
          className="px-2 py-1 text-[10px] rounded-md text-[var(--color-text-secondary)] hover:text-[var(--color-accent)] hover:bg-[var(--color-accent)]/10 transition-colors"
          title="Add existing sketch"
        >
          + Existing
        </button>
      </div>

      {showPicker === position && (
        <div className="absolute top-full left-1/2 -translate-x-1/2 z-10 mt-1">
          <SketchPicker
            sketches={filteredSketches}
            search={pickerSearch}
            onSearchChange={setPickerSearch}
            onSelect={(path) => onPickExisting(path, position)}
            onClose={() => { setShowPicker(null); setPickerSearch(""); }}
          />
        </div>
      )}
    </div>
  );
}

function SketchPicker({
  sketches,
  search,
  onSearchChange,
  onSelect,
  onClose,
}: {
  sketches: import("../types/sketch").SketchSummary[];
  search: string;
  onSearchChange: (v: string) => void;
  onSelect: (path: string) => void;
  onClose: () => void;
}) {
  return (
    <div className="w-64 rounded-xl border border-[var(--color-border)] bg-[var(--color-surface)] shadow-lg overflow-hidden">
      <div className="p-2 border-b border-[var(--color-border)]">
        <input
          type="text"
          value={search}
          onChange={(e) => onSearchChange(e.target.value)}
          placeholder="Search sketches..."
          autoFocus
          onKeyDown={(e) => { if (e.key === "Escape") onClose(); }}
          className="w-full px-2 py-1.5 text-xs bg-transparent text-[var(--color-text)] placeholder:text-[var(--color-text-secondary)]/50 outline-none"
        />
      </div>
      <div className="max-h-48 overflow-y-auto p-1">
        {sketches.length === 0 ? (
          <p className="text-xs text-[var(--color-text-secondary)] text-center py-4">
            No sketches found
          </p>
        ) : (
          sketches.map((s) => (
            <SketchPickerItem key={s.path} sketch={s} onSelect={() => onSelect(s.path)} />
          ))
        )}
      </div>
    </div>
  );
}

function AddBar({
  onAddNew,
  onPickExisting,
}: {
  onAddNew: () => void;
  onPickExisting: () => void;
}) {
  return (
    <div className="flex items-center gap-2 pt-4 pb-2">
      <div className="h-px flex-1 bg-[var(--color-border)]" />
      <div className="flex gap-1.5">
        <button
          onClick={onAddNew}
          className="flex items-center gap-1.5 px-3 py-1.5 text-xs font-medium rounded-lg bg-[var(--color-accent)] text-white hover:bg-[var(--color-accent-hover)] transition-colors"
        >
          <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round">
            <line x1="12" y1="5" x2="12" y2="19" />
            <line x1="5" y1="12" x2="19" y2="12" />
          </svg>
          New Sketch
        </button>
        <button
          onClick={onPickExisting}
          className="flex items-center gap-1.5 px-3 py-1.5 text-xs font-medium rounded-lg border border-[var(--color-border)] text-[var(--color-text-secondary)] hover:text-[var(--color-text)] hover:border-[var(--color-accent)]/40 transition-colors"
        >
          <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
            <path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z" />
            <polyline points="14 2 14 8 20 8" />
          </svg>
          Add Existing
        </button>
      </div>
      <div className="h-px flex-1 bg-[var(--color-border)]" />
    </div>
  );
}

function makePlaceholder(path: string): import("../types/sketch").SketchSummary {
  return {
    path,
    title: "(Missing sketch)",
    state: "draft",
    row_count: 0,
    created_at: "",
    updated_at: "",
  };
}
