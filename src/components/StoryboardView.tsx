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
import { listen } from "@tauri-apps/api/event";
import { SafeMarkdown } from "./SafeMarkdown";
import {
  Play,
  Monitor,
  Sparkles,
  ChevronRight,
  Pencil,
  X,
  Plus,
  FileText,
} from "lucide-react";
import { shouldSuppressEditorFlush, useAppStore } from "../stores/appStore";
import { useToastStore } from "../stores/toastStore";
import { useSettings } from "../hooks/useSettings";
import { SketchPickerItem } from "./SketchCard";
import { SketchPreview } from "./SketchPreview";
import { ScriptTable } from "./ScriptTable";
import { exportStoryboardToWord, type WordOrientation } from "../utils/exportToWord";
import { DocumentToolbar, documentToolbarIcons, type DocumentToolbarAction } from "./DocumentToolbar";
import type { Sketch, SketchSummary, Storyboard } from "../types/sketch";
import type { RecordingTake } from "../types/recording";
import type { PreviewSlide, PresentationMode } from "./presentation/types";

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

function collectStoryboardSketchPaths(storyboard: Storyboard): string[] {
  const paths: string[] = [];
  for (const item of storyboard.items) {
    if (item.type === "sketch_ref") {
      paths.push(item.path);
    } else {
      paths.push(...item.sketches);
    }
  }
  return paths;
}

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
  const setStoryboardLocked = useAppStore((s) => s.setStoryboardLocked);
  const { settings } = useSettings();
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
  const descSaveTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const pendingDescRef = useRef<string | null>(null);
  const [availableMonitors, setAvailableMonitors] = useState<MonitorInfo[]>([]);
  const [previewSlides, setPreviewSlides] = useState<PreviewSlide[]>([]);
  const [showPreview, setShowPreview] = useState(false);
  const [previewMode, setPreviewMode] = useState<PresentationMode>("slides");

  const sketchMap = new Map(sketches.map((s) => [s.path, s]));
  const storyboardLocked = activeStoryboard?.locked ?? false;

  // Reset the local description when switching storyboards.
  useEffect(() => {
    setLocalDesc(activeStoryboard?.description ?? "");
    setEditingDesc(false);
    pendingDescRef.current = null;
    if (descSaveTimerRef.current) {
      clearTimeout(descSaveTimerRef.current);
      descSaveTimerRef.current = null;
    }
  }, [activeStoryboardPath]);

  // External updates can refresh the preview, but must not overwrite active typing.
  useEffect(() => {
    if (!editingDesc && pendingDescRef.current === null) {
      setLocalDesc(activeStoryboard?.description ?? "");
    }
  }, [activeStoryboard?.description, editingDesc]);

  useEffect(() => {
    if (editingDesc && descRef.current) {
      descRef.current.focus();
      descRef.current.selectionStart = descRef.current.value.length;
    }
  }, [editingDesc]);

  const flushDescription = useCallback(() => {
    if (descSaveTimerRef.current) {
      clearTimeout(descSaveTimerRef.current);
      descSaveTimerRef.current = null;
    }
    const pending = pendingDescRef.current;
    if (pending === null) return;
    pendingDescRef.current = null;
    if (shouldSuppressEditorFlush(activeStoryboardPath)) return;
    if (storyboardLocked) return;
    updateStoryboard({ description: pending });
  }, [activeStoryboardPath, storyboardLocked, updateStoryboard]);

  const handleDescriptionChange = useCallback((value: string) => {
    if (storyboardLocked) return;
    setLocalDesc(value);
    pendingDescRef.current = value;
    if (descSaveTimerRef.current) clearTimeout(descSaveTimerRef.current);
    descSaveTimerRef.current = setTimeout(flushDescription, 800);
  }, [flushDescription, storyboardLocked]);

  useEffect(() => {
    return () => flushDescription();
  }, [flushDescription]);

  // Eagerly load all referenced sketches
  useEffect(() => {
    if (!activeStoryboard) return;
    for (const path of collectStoryboardSketchPaths(activeStoryboard)) {
      if (sketchCache.has(path) || loadingRef.current.has(path)) continue;
      loadingRef.current.add(path);
      invoke<Sketch>("get_sketch", { relativePath: path })
        .then((sketch) => setSketchCache((prev) => new Map(prev).set(path, sketch)))
        .catch((err) => console.error("Failed to load sketch:", err))
        .finally(() => loadingRef.current.delete(path));
    }
  }, [activeStoryboard, sketchCache]);

  /** Build typed slides for preview: storyboard title → (sketch title → sketch rows)... */
  const buildPreviewSlides = useCallback((cache = sketchCache): PreviewSlide[] => {
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
    const addSketchSlides = (path: string, sectionTitle?: string) => {
      const full = cache.get(path);
      if (!full) return;
      const skTitle = full.title || "Untitled Sketch";
      const context = sectionTitle ? `${sbTitle} › ${sectionTitle} › ${skTitle}` : `${sbTitle} › ${skTitle}`;
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
    };
    // Each sketch
    for (const item of activeStoryboard.items) {
      if (item.type === "sketch_ref") {
        addSketchSlides(item.path);
      } else {
        slides.push({
          type: "title",
          heading: item.title,
          subtitle: "",
          context: sbTitle,
        });
        for (const path of item.sketches) {
          addSketchSlides(path, item.title);
        }
      }
    }
    return slides;
  }, [activeStoryboard, sketchCache]);

  const resolvePreviewSketches = useCallback(async () => {
    if (!activeStoryboard) return sketchCache;
    const nextCache = new Map(sketchCache);
    const missingPaths = collectStoryboardSketchPaths(activeStoryboard).filter((path) => !nextCache.has(path));
    if (missingPaths.length === 0) return nextCache;

    const loaded = await Promise.all(missingPaths.map(async (path) => {
      const sketch = await invoke<Sketch>("get_sketch", { relativePath: path });
      return [path, sketch] as const;
    }));
    for (const [path, sketch] of loaded) {
      nextCache.set(path, sketch);
    }
    setSketchCache(nextCache);
    return nextCache;
  }, [activeStoryboard, sketchCache]);

  const launchPreviewOnMonitor = useCallback(async (monitor: MonitorInfo | null, mode: PresentationMode = "slides", slides = previewSlides) => {
    setShowMonitorPicker(false);
    localStorage.setItem(PREVIEW_DATA_KEY, JSON.stringify({
      rows: [],
      slides,
      projectRoot: currentProject?.root ?? "",
      title: activeStoryboard?.title ?? "Storyboard",
      initialMode: mode,
    }));
    try {
      await invoke("open_preview_window", {
        physX: monitor?.x ?? 0,
        physY: monitor?.y ?? 0,
        physW: monitor?.width ?? 0,
        physH: monitor?.height ?? 0,
      });
    } catch (e) {
      console.error("[StoryboardView] Failed to open preview window:", e);
      setPreviewMode(mode);
      setShowPreview(true);
    }
  }, [currentProject, activeStoryboard, previewSlides]);

  /** Launch presentation in fullscreen for any mode */
  const launchPresentation = useCallback(async (mode: PresentationMode) => {
    try {
      const cache = await resolvePreviewSketches();
      const slides = buildPreviewSlides(cache);
      setPreviewSlides(slides);
      const monitors: MonitorInfo[] = await invoke("list_monitors");
      if (monitors.length > 1) {
        setPreviewMode(mode);
        setAvailableMonitors(monitors);
        setShowMonitorPicker(true);
      } else {
        await launchPreviewOnMonitor(monitors[0] ?? null, mode, slides);
      }
    } catch (e) {
      console.error("[StoryboardView] list_monitors failed, launching directly:", e);
      // Resolve sketches and launch without coordinates
      try {
        const cache = await resolvePreviewSketches();
        const slides = buildPreviewSlides(cache);
        setPreviewSlides(slides);
        await launchPreviewOnMonitor(null, mode, slides);
      } catch (inner) {
        console.error("[StoryboardView] Fallback failed:", inner);
        setPreviewMode(mode);
        setShowPreview(true);
      }
    }
  }, [buildPreviewSlides, launchPreviewOnMonitor, resolvePreviewSketches]);

  // DnD
  const sensors = useSensors(useSensor(PointerSensor, { activationConstraint: { distance: 5 } }));

  const handleDragEnd = useCallback((event: DragEndEvent) => {
    const { active, over } = event;
    if (storyboardLocked) return;
    if (!over || !activeStoryboard || active.id === over.id) return;
    const items = activeStoryboard.items;
    const oldIdx = Number(active.id);
    const newIdx = Number(over.id);
    if (isNaN(oldIdx) || isNaN(newIdx)) return;
    const reordered = [...items];
    const [moved] = reordered.splice(oldIdx, 1);
    reordered.splice(newIdx, 0, moved);
    reorderStoryboardItems(reordered);
  }, [activeStoryboard, reorderStoryboardItems, storyboardLocked]);

  const handleAddNewSketch = useCallback(
    async (position?: number) => {
      const title = `Sketch ${sketches.length + 1}`;
      if (storyboardLocked) return;
      await createSketch(title);
      // The created sketch is now active; get its path from the store
      const { activeSketchPath } = useAppStore.getState();
      if (activeSketchPath) {
        await addSketchToStoryboard(activeSketchPath, position);
        await loadSketches();
      }
    },
    [sketches.length, createSketch, addSketchToStoryboard, loadSketches, storyboardLocked],
  );

  const handlePickExisting = useCallback(
    async (sketchPath: string, position?: number) => {
      if (storyboardLocked) return;
      await addSketchToStoryboard(sketchPath, position);
      setShowPicker(null);
      setPickerSearch("");
    },
    [addSketchToStoryboard, storyboardLocked],
  );

  const handleExportWord = useCallback((orientation: WordOrientation) => {
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
  }, [activeStoryboard, currentProject, sketchCache]);

  const handleRecord = useCallback(async () => {
    if (!activeStoryboardPath) return;
    try {
      await invoke("open_recorder_window", {
        scope: { kind: "storyboard", path: activeStoryboardPath },
        documentTitle: activeStoryboard?.title || "Untitled storyboard",
      });
    } catch (err) {
      useToastStore.getState().show(`Could not open recorder: ${err}`, 5000, "error");
    }
  }, [activeStoryboard?.title, activeStoryboardPath]);

  useEffect(() => {
    if (!activeStoryboardPath || !activeStoryboard) return;
    const unlistenStarted = listen<RecordingTake>("recording-control-started", (event) => {
      if (event.payload.scope.kind !== "storyboard" || event.payload.scope.path !== activeStoryboardPath) return;
      useAppStore.getState().addActivityEntries([{ id: crypto.randomUUID(), timestamp: new Date(), source: "recording", content: `Started recording take ${event.payload.id} for "${activeStoryboard.title || "Untitled storyboard"}"`, level: "info" }]);
    });
    const unlistenStopped = listen<RecordingTake>("recording-control-stopped", (event) => {
      if (event.payload.scope.kind !== "storyboard" || event.payload.scope.path !== activeStoryboardPath) return;
      useAppStore.getState().addActivityEntries([{ id: crypto.randomUUID(), timestamp: new Date(), source: "recording", content: `Saved recording take ${event.payload.id} for "${activeStoryboard.title || "Untitled storyboard"}"`, level: event.payload.status === "finalized" ? "success" : "error" }]);
    });
    const unlistenDiscarded = listen<RecordingTake>("recording-control-discarded", (event) => {
      if (event.payload.scope.kind !== "storyboard" || event.payload.scope.path !== activeStoryboardPath) return;
      useAppStore.getState().addActivityEntries([{ id: crypto.randomUUID(), timestamp: new Date(), source: "recording", content: `Discarded recording take ${event.payload.id} for "${activeStoryboard.title || "Untitled storyboard"}"`, level: "info" }]);
    });
    return () => {
      unlistenStarted.then((fn) => fn());
      unlistenStopped.then((fn) => fn());
      unlistenDiscarded.then((fn) => fn());
    };
  }, [activeStoryboard, activeStoryboardPath]);

  if (!activeStoryboard) return null;

  const filteredSketches = sketches.filter((s) =>
    s.title.toLowerCase().includes(pickerSearch.toLowerCase()),
  );
  const hasStoryboardItems = activeStoryboard.items.length > 0;
  const canRecord = hasStoryboardItems && !!activeStoryboardPath;
  const presentActions: DocumentToolbarAction[] = hasStoryboardItems ? [
    {
      id: "slide-only",
      label: "Slide-only view",
      icon: documentToolbarIcons.playCircle,
      onSelect: () => launchPresentation("slide-only"),
    },
    {
      id: "teleprompter",
      label: "Teleprompter",
      icon: documentToolbarIcons.monitorPlay,
      onSelect: () => launchPresentation("teleprompter"),
    },
    {
      id: "preview",
      label: "Preview",
      icon: documentToolbarIcons.monitor,
      onSelect: () => launchPresentation("slides"),
    },
  ] : [];
  const aiActions: DocumentToolbarAction[] = !storyboardLocked ? [
    {
      id: "review-flow",
      label: "Review flow",
      icon: documentToolbarIcons.sparkles,
      onSelect: () => sendChatPrompt(
        `Review the storyboard "${activeStoryboard.title}" and suggest improvements. List the current sketches, then recommend any changes to ordering, pacing, or suggest new sketches that would strengthen the demo flow. Read each sketch first to understand the content.`,
        { silent: true },
      ),
    },
    {
      id: "generate-sketch",
      label: "Generate sketch",
      icon: documentToolbarIcons.sparkles,
      onSelect: () => sendChatPrompt(
        `Generate a new sketch for the storyboard "${activeStoryboard.title}". Look at the existing sketches to understand the demo flow, then create a new sketch that would complement them. Pick an appropriate name and generate 3-5 planning rows.`,
        { silent: true },
      ),
    },
  ] : [];
  const exportActions: DocumentToolbarAction[] = hasStoryboardItems ? [
    {
      id: "word-landscape",
      label: "Word - Landscape",
      icon: documentToolbarIcons.fileText,
      onSelect: () => handleExportWord("landscape"),
    },
    {
      id: "word-portrait",
      label: "Word - Portrait",
      icon: documentToolbarIcons.fileText,
      onSelect: () => handleExportWord("portrait"),
    },
  ] : [];

  return (
    <div className="flex-1 overflow-y-auto">
      <div className="max-w-3xl mx-auto px-6 py-8">
        {/* Storyboard header */}
        <div className="flex items-center gap-3 mb-2">
          <input
            type="text"
            defaultValue={activeStoryboard.title}
            readOnly={storyboardLocked}
            onBlur={(e) => {
              const val = e.target.value.trim();
              if (!storyboardLocked && val && val !== activeStoryboard.title) {
                updateStoryboard({ title: val });
              }
            }}
            className={`flex-1 text-2xl font-semibold bg-transparent text-[rgb(var(--color-text))] placeholder:text-[rgb(var(--color-text-secondary))]/40 outline-none border-none ${storyboardLocked ? "cursor-default" : ""}`}
            placeholder="Storyboard title..."
          />
          <div className="relative">
            <DocumentToolbar
              canRecord={canRecord}
              onRecord={handleRecord}
              showRecord={settings.featureRecording}
              presentActions={presentActions}
              aiActions={aiActions}
              exportActions={exportActions}
              locked={storyboardLocked}
              onToggleLock={() => setStoryboardLocked(!storyboardLocked)}
              lockLabel="Lock storyboard"
              unlockLabel="Unlock storyboard"
            />
            {showMonitorPicker && (
              <>
                <div className="fixed inset-0 z-dropdown" onClick={() => setShowMonitorPicker(false)} />
                <div className="absolute right-0 top-full mt-2 z-modal bg-[rgb(var(--color-surface))] border border-[rgb(var(--color-border))] rounded-lg shadow-lg py-1 min-w-[200px]">
                  <div className="px-3 py-2 text-xs font-medium text-[rgb(var(--color-text-secondary))] uppercase tracking-wider border-b border-[rgb(var(--color-border))]">
                    Present on
                  </div>
                  {availableMonitors.map((m) => (
                    <button
                      key={m.id}
                      onClick={() => launchPreviewOnMonitor(m, previewMode, previewSlides)}
                      className="w-full px-3 py-2 text-left text-sm text-[rgb(var(--color-text))] hover:bg-[rgb(var(--color-surface-alt))] transition-colors flex items-center gap-2"
                    >
                      <Monitor className="w-3.5 h-3.5" />
                      <span>{m.name || `Monitor ${m.id}`}</span>
                      {m.is_primary && (
                        <span className="text-[10px] text-[rgb(var(--color-accent))] font-medium ml-auto">Primary</span>
                      )}
                    </button>
                  ))}
                </div>
              </>
            )}
          </div>
        </div>
        {/* Description — markdown preview, click to edit */}
        <div className="relative group/desc mb-2">
          {editingDesc ? (
            <textarea
              ref={descRef}
              value={localDesc}
              onChange={(e) => handleDescriptionChange(e.target.value)}
              onBlur={() => {
                flushDescription();
                setEditingDesc(false);
              }}
              placeholder="Describe this storyboard..."
              rows={4}
              readOnly={storyboardLocked}
              className="w-full text-sm bg-transparent text-[rgb(var(--color-text))] placeholder:text-[rgb(var(--color-text-secondary))]/40 outline-none border border-[rgb(var(--color-border))] rounded-lg px-3 py-2 resize-none focus:ring-1 focus:ring-[rgb(var(--color-accent))]/40 transition-colors"
              autoFocus
            />
          ) : (
            <div
               tabIndex={0}
              onClick={() => { if (!storyboardLocked) setEditingDesc(true); }}
              onFocus={() => { if (!storyboardLocked) setEditingDesc(true); }}
              className={`min-h-[2rem] rounded-lg px-3 py-2 text-sm border border-transparent hover:border-[rgb(var(--color-border))] transition-colors ${!storyboardLocked ? "pr-24 cursor-text" : "cursor-default"}`}
            >
              {localDesc ? (
                <div className="prose-desc text-[rgb(var(--color-text))] leading-relaxed">
                  <SafeMarkdown>{localDesc}</SafeMarkdown>
                </div>
              ) : (
                <span className="text-[rgb(var(--color-text-secondary))]/40">
                  Describe this storyboard...
                </span>
              )}
            </div>
          )}
          {/* Description sparkle */}
          {!editingDesc && !storyboardLocked && (
            <button
              onClick={() => sendChatPrompt(
                localDesc
                  ? `Improve the description of the storyboard "${activeStoryboard.title}" (path: "${activeStoryboardPath}"). Current description: "${localDesc}". Write a clearer, more compelling description that summarizes the demo flow. Keep it concise (2-3 sentences). Use the write_storyboard tool to save the new description.`
                  : `Write a description for the storyboard "${activeStoryboard.title}" (path: "${activeStoryboardPath}"). Look at the sketches to understand the demo flow and write a concise (2-3 sentence) description. Use the write_storyboard tool to save the description.`,
                { silent: true }
              )}
              className="absolute right-2 top-2 flex items-center gap-1 opacity-0 group-hover/desc:opacity-100 group-focus-within/desc:opacity-100 p-1 rounded text-[rgb(var(--color-accent))] hover:bg-[rgb(var(--color-accent))]/10 transition-all"
              title={localDesc ? "Improve description with AI" : "Generate description with AI"}
            >
              <Sparkles className="w-3 h-3" />
              <span className="text-[10px]">{localDesc ? "Improve" : "Generate"}</span>
            </button>
          )}
        </div>

        <div className="mb-8" />

        {/* Items */}
        {activeStoryboard.items.length === 0 ? (
          <EmptyState
            onAddNew={() => handleAddNewSketch()}
            onPickExisting={() => setShowPicker(0)}
            locked={storyboardLocked}
          />
        ) : (
          <>
          <DndContext sensors={sensors} collisionDetection={closestCenter} onDragEnd={handleDragEnd}>
            <SortableContext items={activeStoryboard.items.map((_, i) => i)} strategy={verticalListSortingStrategy}>
              <div className="divide-y divide-[rgb(var(--color-border))]">
                {activeStoryboard.items.map((item, idx) => (
                  <div key={idx} className="py-6 first:pt-0">
                    <SortableStoryboardItem id={idx} disabled={storyboardLocked}>
                      {(dragListeners) => item.type === "sketch_ref" ? (
                        <ExpandableSketchCard
                          sketch={sketchMap.get(item.path) ?? makePlaceholder(item.path)}
                          fullSketch={sketchCache.get(item.path)}
                          onOpen={() => openSketch(item.path)}
                          onRemove={() => { if (confirm("Remove this sketch from the storyboard?")) removeFromStoryboard(idx); }}
                          projectRoot={currentProject?.root}
                          dragListeners={dragListeners}
                          locked={storyboardLocked}
                          collapsed={collapsedItems.has(idx)}
                          onToggleCollapse={() => setCollapsedItems((prev) => {
                            const next = new Set(prev);
                            if (next.has(idx)) next.delete(idx); else next.add(idx);
                            return next;
                          })}
                        />
                      ) : (
                        /* Legacy section — render title only */
                        <div className="text-xs font-medium text-[rgb(var(--color-text-secondary))] uppercase tracking-wider py-2">
                          {item.title}
                        </div>
                      )}
                    </SortableStoryboardItem>

                    {/* Add button between items */}
                    {!storyboardLocked && (
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
                    )}
                  </div>
                ))}
              </div>
            </SortableContext>
          </DndContext>

          {/* Always-visible add bar at end */}
          {!storyboardLocked && (
            <AddBar
              onAddNew={() => handleAddNewSketch()}
              onPickExisting={() => setShowPicker(-1)}
            />
          )}

          {/* Picker/section input for the bottom bar */}
          {showPicker === -1 && !storyboardLocked && (
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
        {showPicker !== null && activeStoryboard.items.length === 0 && !storyboardLocked && (
          <SketchPicker
            sketches={filteredSketches}
            search={pickerSearch}
            onSearchChange={setPickerSearch}
            onSelect={(path) => handlePickExisting(path, showPicker)}
            onClose={() => { setShowPicker(null); setPickerSearch(""); }}
          />
        )}

        {showPreview && (
          <SketchPreview
            rows={[]}
            projectRoot={currentProject?.root ?? ""}
            title={activeStoryboard.title || "Untitled Storyboard"}
            slides={previewSlides}
            initialMode={previewMode}
            onClose={() => { setShowPreview(false); setPreviewMode("slides"); }}
          />
        )}
      </div>
    </div>
  );
}

/* ── Sortable wrapper for storyboard items ─────────────── */

function SortableStoryboardItem({ id, disabled, children }: { id: number; disabled?: boolean; children: (dragListeners: Record<string, any>) => React.ReactNode }) {
  const { attributes, listeners, setNodeRef, transform, transition, isDragging } = useSortable({ id, disabled });
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
  locked,
  collapsed,
  onToggleCollapse,
}: {
  sketch: SketchSummary;
  fullSketch?: Sketch;
  onOpen: () => void;
  onRemove: () => void;
  projectRoot?: string;
  dragListeners: Record<string, any>;
  locked?: boolean;
  collapsed: boolean;
  onToggleCollapse: () => void;
}) {
  return (
    <div className="group/sketch">
      {/* Title row — document sub-heading style */}
      <div className="flex items-center gap-2 py-1">
        {/* Drag handle — grip dots before title */}
        {!locked && (
          <div
            {...dragListeners}
            className="shrink-0 cursor-grab active:cursor-grabbing opacity-30 hover:opacity-100 transition-opacity"
            title="Drag to reorder"
          >
            <svg width="8" height="14" viewBox="0 0 8 14" fill="currentColor" className="text-[rgb(var(--color-text-secondary))]">
              <circle cx="2" cy="2" r="1.2" />
              <circle cx="6" cy="2" r="1.2" />
              <circle cx="2" cy="7" r="1.2" />
              <circle cx="6" cy="7" r="1.2" />
              <circle cx="2" cy="12" r="1.2" />
              <circle cx="6" cy="12" r="1.2" />
            </svg>
          </div>
        )}

        {/* Collapse toggle */}
        <button
          onClick={onToggleCollapse}
          className="shrink-0 text-[rgb(var(--color-text-secondary))] hover:text-[rgb(var(--color-accent))] transition-colors"
          title={collapsed ? "Show table" : "Hide table"}
        >
          <ChevronRight className={`w-3.5 h-3.5 transition-transform ${collapsed ? "" : "rotate-90"}`} />
        </button>

        <h3 className="text-base font-semibold text-[rgb(var(--color-text))] truncate">
          {sketch.title}
        </h3>

        <span className="text-[10px] px-1.5 py-0.5 rounded-full bg-[rgb(var(--color-accent))]/10 text-[rgb(var(--color-accent))] shrink-0">
          {stateLabels[sketch.state] ?? sketch.state}
        </span>

        <span className="text-[10px] text-[rgb(var(--color-text-secondary))] shrink-0">
          {sketch.row_count} {sketch.row_count === 1 ? "row" : "rows"}
        </span>

        {/* Edit pencil */}
        <button
          onClick={onOpen}
          className="shrink-0 p-1 rounded text-[rgb(var(--color-text-secondary))] opacity-0 group-hover/sketch:opacity-100 hover:text-[rgb(var(--color-accent))] transition-all"
          title="Open in editor"
        >
          <Pencil className="w-3.5 h-3.5" />
        </button>

        {/* Remove */}
        {!locked && (
          <button
            onClick={onRemove}
            className="shrink-0 p-1 rounded text-[rgb(var(--color-text-secondary))] opacity-0 group-hover/sketch:opacity-100 hover:text-error transition-all"
            title="Remove from storyboard"
          >
            <X className="w-3 h-3" />
          </button>
        )}
      </div>

      {/* Description (from full sketch if loaded) */}
      {fullSketch && typeof fullSketch.description === "string" && fullSketch.description.trim() && (
        <div className="prose-desc text-sm text-[rgb(var(--color-text-secondary))] mb-2 leading-relaxed">
          <SafeMarkdown>{fullSketch.description}</SafeMarkdown>
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
          <p className="text-xs text-[rgb(var(--color-text-secondary))] py-2">No rows yet</p>
        )
      ) : (
        <div className="flex items-center gap-2 py-3">
          <div className="w-3 h-3 border-2 border-[rgb(var(--color-text-secondary))]/30 border-t-[rgb(var(--color-accent))] rounded-full animate-spin" />
          <span className="text-xs text-[rgb(var(--color-text-secondary))]">Loading sketch…</span>
        </div>
      ))}
    </div>
  );
}

function EmptyState({
  onAddNew,
  onPickExisting,
  locked,
}: {
  onAddNew: () => void;
  onPickExisting: () => void;
  locked?: boolean;
}) {
  return (
    <div className="flex flex-col items-center justify-center py-16 text-center">
      <div className="w-12 h-12 rounded-full bg-[rgb(var(--color-accent))]/10 flex items-center justify-center mb-4">
        <Play className="w-6 h-6 text-[rgb(var(--color-accent))]" />
      </div>
      <p className="text-sm font-medium text-[rgb(var(--color-text))] mb-1">No sketches yet</p>
      <p className="text-xs text-[rgb(var(--color-text-secondary))] max-w-[280px] leading-relaxed mb-6">
        A storyboard sequences your sketches into a complete demo flow. Add sketches to build your narrative.
      </p>
      {!locked && (
        <div className="flex gap-3">
          <button
            onClick={onAddNew}
            className="flex items-center gap-2 px-4 py-2.5 text-xs font-medium rounded-xl bg-[rgb(var(--color-accent))] text-[rgb(var(--color-accent-fg))] hover:bg-[rgb(var(--color-accent-hover))] transition-colors"
          >
            <Plus className="w-3.5 h-3.5" />
            New Sketch
          </button>
          <button
            onClick={onPickExisting}
            className="flex items-center gap-2 px-4 py-2.5 text-xs font-medium rounded-xl border border-[rgb(var(--color-border))] text-[rgb(var(--color-text-secondary))] hover:text-[rgb(var(--color-text))] hover:border-[rgb(var(--color-accent))]/40 transition-colors"
          >
            Add Existing
          </button>
        </div>
      )}
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
          className="px-2 py-1 text-[10px] rounded-md text-[rgb(var(--color-text-secondary))] hover:text-[rgb(var(--color-accent))] hover:bg-[rgb(var(--color-accent))]/10 transition-colors"
          title="New sketch"
        >
          + Sketch
        </button>
        <button
          onClick={() => setShowPicker(showPicker === position ? null : position)}
          className="px-2 py-1 text-[10px] rounded-md text-[rgb(var(--color-text-secondary))] hover:text-[rgb(var(--color-accent))] hover:bg-[rgb(var(--color-accent))]/10 transition-colors"
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
    <div className="w-64 rounded-xl border border-[rgb(var(--color-border))] bg-[rgb(var(--color-surface))] shadow-lg overflow-hidden">
      <div className="p-2 border-b border-[rgb(var(--color-border))]">
        <input
          type="text"
          value={search}
          onChange={(e) => onSearchChange(e.target.value)}
          placeholder="Search sketches..."
          autoFocus
          onKeyDown={(e) => { if (e.key === "Escape") onClose(); }}
          className="w-full px-2 py-1.5 text-xs bg-transparent text-[rgb(var(--color-text))] placeholder:text-[rgb(var(--color-text-secondary))]/50 outline-none"
        />
      </div>
      <div className="max-h-48 overflow-y-auto p-1">
        {sketches.length === 0 ? (
          <p className="text-xs text-[rgb(var(--color-text-secondary))] text-center py-4">
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
      <div className="h-px flex-1 bg-[rgb(var(--color-border))]" />
      <div className="flex gap-1.5">
        <button
          onClick={onAddNew}
          className="flex items-center gap-1.5 px-3 py-1.5 text-xs font-medium rounded-lg bg-[rgb(var(--color-accent))] text-[rgb(var(--color-accent-fg))] hover:bg-[rgb(var(--color-accent-hover))] transition-colors"
        >
          <Plus className="w-3 h-3" />
          New Sketch
        </button>
        <button
          onClick={onPickExisting}
          className="flex items-center gap-1.5 px-3 py-1.5 text-xs font-medium rounded-lg border border-[rgb(var(--color-border))] text-[rgb(var(--color-text-secondary))] hover:text-[rgb(var(--color-text))] hover:border-[rgb(var(--color-accent))]/40 transition-colors"
        >
          <FileText className="w-3 h-3" />
          Add Existing
        </button>
      </div>
      <div className="h-px flex-1 bg-[rgb(var(--color-border))]" />
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
