import { useCallback, useEffect, useMemo, useRef, useState, type Dispatch, type SetStateAction } from "react";
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
import { invoke, listen } from "../services/tauri";
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
import { useConfirmDialog } from "./ConfirmDialog";
import { exportStoryboardToWord, type WordOrientation } from "../utils/exportToWord";
import { DocumentToolbar, documentToolbarIcons, type DocumentToolbarAction } from "./DocumentToolbar";
import type { Sketch, SketchSummary, StoryboardItem } from "../types/sketch";
import type { RecordingTake } from "../types/recording";
import type { PreviewSlide, PresentationMode } from "./presentation/types";
import {
  appendSketchToSection,
  getStoryboardItemRenderKey,
  getStoryboardSketchPaths,
  removeSketchFromSection,
  updateStoryboardSection,
} from "../utils/storyboard";

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

type PickerTarget =
  | { type: "top"; position?: number }
  | { type: "section"; sectionIndex: number };

function getTopLevelCollapseKey(index: number): string {
  return `storyboard-item:${index}`;
}

function getNestedSketchCollapseKey(sectionIndex: number, sketchIndex: number): string {
  return `storyboard-item:${sectionIndex}:sketch:${sketchIndex}`;
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
  const addSectionToStoryboard = useAppStore((s) => s.addSectionToStoryboard);
  const reorderStoryboardItems = useAppStore((s) => s.reorderStoryboardItems);
  const updateStoryboard = useAppStore((s) => s.updateStoryboard);
  const setStoryboardLocked = useAppStore((s) => s.setStoryboardLocked);
  const { settings } = useSettings();
  const loadSketches = useAppStore((s) => s.loadSketches);
  const sendChatPrompt = useAppStore((s) => s.sendChatPrompt);

  const [pickerTarget, setPickerTarget] = useState<PickerTarget | null>(null);
  const [pickerSearch, setPickerSearch] = useState("");
  const { confirm, confirmationDialog } = useConfirmDialog();

  // Cache of full sketch data keyed by path
  const [sketchCache, setSketchCache] = useState<Map<string, Sketch>>(new Map());
  const loadingRef = useRef<Set<string>>(new Set());
  const [collapsedItems, setCollapsedItems] = useState<Set<string>>(new Set());
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
    for (const path of getStoryboardSketchPaths(activeStoryboard)) {
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
          subtitle: item.description ?? "",
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
    const missingPaths = getStoryboardSketchPaths(activeStoryboard).filter((path) => !nextCache.has(path));
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
    async (target?: PickerTarget) => {
      const title = `Sketch ${sketches.length + 1}`;
      if (storyboardLocked) return;
      await createSketch(title);
      // The created sketch is now active; get its path from the store
      const { activeSketchPath } = useAppStore.getState();
      if (activeSketchPath) {
        if (target?.type === "section" && activeStoryboard) {
          await reorderStoryboardItems(appendSketchToSection(activeStoryboard.items, target.sectionIndex, activeSketchPath));
        } else {
          await addSketchToStoryboard(activeSketchPath, target?.type === "top" ? target.position : undefined);
        }
        await loadSketches();
      }
    },
    [activeStoryboard, sketches.length, createSketch, addSketchToStoryboard, loadSketches, reorderStoryboardItems, storyboardLocked],
  );

  const handlePickExisting = useCallback(
    async (sketchPath: string, target?: PickerTarget) => {
      if (storyboardLocked) return;
      if (target?.type === "section" && activeStoryboard) {
        await reorderStoryboardItems(appendSketchToSection(activeStoryboard.items, target.sectionIndex, sketchPath));
      } else {
        await addSketchToStoryboard(sketchPath, target?.type === "top" ? target.position : undefined);
      }
      setPickerTarget(null);
      setPickerSearch("");
    },
    [activeStoryboard, addSketchToStoryboard, reorderStoryboardItems, storyboardLocked],
  );

  const confirmRemoveFromStoryboard = useCallback(async (index: number) => {
    const confirmed = await confirm({
      title: "Remove sketch?",
      message: "Remove this sketch from the storyboard?",
      confirmLabel: "Remove",
      variant: "warning",
    });
    if (confirmed) removeFromStoryboard(index);
  }, [confirm, removeFromStoryboard]);

  const confirmRemoveFromSection = useCallback(async (sectionIndex: number, sketchIndex: number) => {
    if (!activeStoryboard) return;
    const confirmed = await confirm({
      title: "Remove sketch?",
      message: "Remove this sketch from the section?",
      confirmLabel: "Remove",
      variant: "warning",
    });
    if (confirmed) {
      await reorderStoryboardItems(removeSketchFromSection(activeStoryboard.items, sectionIndex, sketchIndex));
    }
  }, [activeStoryboard, confirm, reorderStoryboardItems]);

  const handleAddSection = useCallback((position?: number) => {
    if (storyboardLocked) return;
    addSectionToStoryboard("New Section", position);
  }, [addSectionToStoryboard, storyboardLocked]);

  const handleUpdateSection = useCallback((sectionIndex: number, update: { title?: string; description?: string }) => {
    if (storyboardLocked) return;
    const storyboard = useAppStore.getState().activeStoryboard;
    if (!storyboard) return;
    reorderStoryboardItems(updateStoryboardSection(storyboard.items, sectionIndex, update));
  }, [reorderStoryboardItems, storyboardLocked]);

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

  const storyboardItems = activeStoryboard?.items ?? [];
  const filteredSketches = sketches.filter((s) =>
    s.title.toLowerCase().includes(pickerSearch.toLowerCase()),
  );
  const hasStoryboardItems = storyboardItems.length > 0;
  const sectionCollapseKeys = useMemo(
    () => storyboardItems.flatMap((item, index) =>
      item.type === "section" ? [getTopLevelCollapseKey(index)] : [],
    ),
    [storyboardItems],
  );
  const sketchCollapseKeys = useMemo(() => storyboardItems.flatMap((item, index) => {
    if (item.type === "sketch_ref") return [getTopLevelCollapseKey(index)];
    return item.sketches.map((_, sketchIndex) => getNestedSketchCollapseKey(index, sketchIndex));
  }), [storyboardItems]);
  const canCollapseOutline = sketchCollapseKeys.some((key) => !collapsedItems.has(key))
    || sectionCollapseKeys.some((key) => !collapsedItems.has(key));
  const canExpandOutline = sectionCollapseKeys.some((key) => collapsedItems.has(key))
    || sketchCollapseKeys.some((key) => collapsedItems.has(key));
  const expandOutlineLevel = useCallback(() => {
    setCollapsedItems((prev) => {
      const next = new Set(prev);
      const collapsedSections = sectionCollapseKeys.filter((key) => next.has(key));
      if (collapsedSections.length > 0) {
        collapsedSections.forEach((key) => next.delete(key));
        return next;
      }
      sketchCollapseKeys.forEach((key) => next.delete(key));
      return next;
    });
  }, [sectionCollapseKeys, sketchCollapseKeys]);
  const collapseOutlineLevel = useCallback(() => {
    setCollapsedItems((prev) => {
      const hasExpandedSketches = sketchCollapseKeys.some((key) => !prev.has(key));
      if (hasExpandedSketches) {
        return new Set([...prev, ...sketchCollapseKeys]);
      }
      return new Set([...prev, ...sectionCollapseKeys]);
    });
  }, [sectionCollapseKeys, sketchCollapseKeys]);

  if (!activeStoryboard) return null;

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

        {hasStoryboardItems && (
          <div className="mb-4 flex items-center justify-between border-y border-[rgb(var(--color-border-subtle))] py-2">
            <span className="text-[10px] font-semibold uppercase tracking-[0.24em] text-[rgb(var(--color-text-secondary))]/60">
              Outline
            </span>
            <div className="flex gap-1">
              <button
                onClick={expandOutlineLevel}
                disabled={!canExpandOutline}
                title="Expand one outline level"
                aria-label="Expand one outline level"
                className="rounded-full px-3 py-1 text-[10px] font-medium uppercase tracking-[0.14em] text-[rgb(var(--color-text-secondary))] transition-colors hover:bg-[rgb(var(--color-accent))]/10 hover:text-[rgb(var(--color-accent))] disabled:cursor-default disabled:opacity-35 disabled:hover:bg-transparent disabled:hover:text-[rgb(var(--color-text-secondary))]"
              >
                Expand level
              </button>
              <button
                onClick={collapseOutlineLevel}
                disabled={!canCollapseOutline}
                title="Collapse one outline level"
                aria-label="Collapse one outline level"
                className="rounded-full px-3 py-1 text-[10px] font-medium uppercase tracking-[0.14em] text-[rgb(var(--color-text-secondary))] transition-colors hover:bg-[rgb(var(--color-accent))]/10 hover:text-[rgb(var(--color-accent))] disabled:cursor-default disabled:opacity-35 disabled:hover:bg-transparent disabled:hover:text-[rgb(var(--color-text-secondary))]"
              >
                Collapse level
              </button>
            </div>
          </div>
        )}

        {/* Items */}
        {activeStoryboard.items.length === 0 ? (
          <EmptyState
            onAddNew={() => handleAddNewSketch()}
            onPickExisting={() => setPickerTarget({ type: "top", position: 0 })}
            onAddSection={() => handleAddSection()}
            locked={storyboardLocked}
          />
        ) : (
          <>
          <DndContext sensors={sensors} collisionDetection={closestCenter} onDragEnd={handleDragEnd}>
            <SortableContext items={activeStoryboard.items.map((_, i) => i)} strategy={verticalListSortingStrategy}>
              <div className="space-y-7">
                {activeStoryboard.items.map((item, idx) => {
                  const itemKey = getTopLevelCollapseKey(idx);
                  return (
                  <div key={getStoryboardItemRenderKey(item, idx)} className="group/story-item">
                    <SortableStoryboardItem id={idx} disabled={storyboardLocked}>
                      {(dragListeners) => item.type === "sketch_ref" ? (
                        <ExpandableSketchCard
                          sketch={sketchMap.get(item.path) ?? makePlaceholder(item.path)}
                          fullSketch={sketchCache.get(item.path)}
                          onOpen={() => openSketch(item.path)}
                          onRemove={() => void confirmRemoveFromStoryboard(idx)}
                          projectRoot={currentProject?.root}
                          dragListeners={dragListeners}
                          locked={storyboardLocked}
                          outlineLevel="top"
                          collapsed={collapsedItems.has(itemKey)}
                          onToggleCollapse={() => setCollapsedItems((prev) => {
                            const next = new Set(prev);
                            if (next.has(itemKey)) next.delete(itemKey); else next.add(itemKey);
                            return next;
                          })}
                        />
                      ) : (
                        <StoryboardSectionBlock
                          item={item}
                          index={idx}
                          sketchMap={sketchMap}
                          sketchCache={sketchCache}
                          projectRoot={currentProject?.root}
                          dragListeners={dragListeners}
                          locked={storyboardLocked}
                          collapsed={collapsedItems.has(itemKey)}
                          onToggleCollapse={() => setCollapsedItems((prev) => {
                            const next = new Set(prev);
                            if (next.has(itemKey)) next.delete(itemKey); else next.add(itemKey);
                            return next;
                          })}
                          collapsedItems={collapsedItems}
                          setCollapsedItems={setCollapsedItems}
                          onOpenSketch={openSketch}
                          onRemoveSketch={(sketchIndex) => void confirmRemoveFromSection(idx, sketchIndex)}
                          onUpdateSection={handleUpdateSection}
                          onAddNewSketch={() => handleAddNewSketch({ type: "section", sectionIndex: idx })}
                          onPickExisting={() => setPickerTarget({ type: "section", sectionIndex: idx })}
                        />
                      )}
                    </SortableStoryboardItem>

                    {/* Add button between items */}
                    {!storyboardLocked && (
                      <AddItemButton
                        position={idx + 1}
                        onAddNew={handleAddNewSketch}
                        onAddSection={handleAddSection}
                        pickerTarget={pickerTarget}
                        setPickerTarget={setPickerTarget}
                        filteredSketches={filteredSketches}
                        pickerSearch={pickerSearch}
                        setPickerSearch={setPickerSearch}
                        onPickExisting={handlePickExisting}
                      />
                    )}
                  </div>
                  );
                })}
              </div>
            </SortableContext>
          </DndContext>

          {/* Always-visible add bar at end */}
          {!storyboardLocked && (
            <AddBar
              onAddNew={() => handleAddNewSketch()}
              onPickExisting={() => setPickerTarget({ type: "top" })}
              onAddSection={() => handleAddSection()}
            />
          )}

          {/* Picker/section input for the bottom bar */}
          {pickerTarget?.type === "top" && pickerTarget.position === undefined && !storyboardLocked && (
            <SketchPicker
              sketches={filteredSketches}
              search={pickerSearch}
              onSearchChange={setPickerSearch}
              onSelect={(path) => handlePickExisting(path, pickerTarget)}
              onClose={() => { setPickerTarget(null); setPickerSearch(""); }}
            />
          )}
          {pickerTarget?.type === "section" && !storyboardLocked && (
            <SketchPicker
              sketches={filteredSketches}
              search={pickerSearch}
              onSearchChange={setPickerSearch}
              onSelect={(path) => handlePickExisting(path, pickerTarget)}
              onClose={() => { setPickerTarget(null); setPickerSearch(""); }}
            />
          )}
        </>
        )}

        {/* Picker overlay (when shown at a position) */}
        {pickerTarget !== null && activeStoryboard.items.length === 0 && !storyboardLocked && (
          <SketchPicker
            sketches={filteredSketches}
            search={pickerSearch}
            onSearchChange={setPickerSearch}
            onSelect={(path) => handlePickExisting(path, pickerTarget)}
            onClose={() => { setPickerTarget(null); setPickerSearch(""); }}
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
        {confirmationDialog}
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

function ExpandableSketchCard({
  sketch,
  fullSketch,
  onOpen,
  onRemove,
  projectRoot,
  dragListeners,
  locked,
  outlineLevel = "top",
  collapsed,
  onToggleCollapse,
}: {
  sketch: SketchSummary;
  fullSketch?: Sketch;
  onOpen: () => void;
  onRemove: () => void;
  projectRoot?: string;
  dragListeners?: Record<string, any>;
  locked?: boolean;
  outlineLevel?: "top" | "nested";
  collapsed: boolean;
  onToggleCollapse: () => void;
}) {
  const isTopLevel = outlineLevel === "top";

  return (
    <div className={`group/sketch ${isTopLevel ? "rounded-2xl border border-[rgb(var(--color-border-subtle))] bg-[rgb(var(--color-surface))]/35 p-3" : "rounded-xl bg-[rgb(var(--color-surface))]/35 px-3 py-2"}`}>
      <div className={`flex items-start gap-3 ${isTopLevel ? "" : "py-1"}`}>
        {!locked && dragListeners && (
          <div
            {...dragListeners}
            className="mt-1 shrink-0 cursor-grab text-[rgb(var(--color-text-secondary))]/25 opacity-0 transition-opacity hover:text-[rgb(var(--color-text-secondary))]/60 hover:opacity-100 active:cursor-grabbing group-hover/sketch:opacity-100"
            title="Drag to reorder"
          >
            <svg width="8" height="14" viewBox="0 0 8 14" fill="currentColor">
              <circle cx="2" cy="2" r="1.2" />
              <circle cx="6" cy="2" r="1.2" />
              <circle cx="2" cy="7" r="1.2" />
              <circle cx="6" cy="7" r="1.2" />
              <circle cx="2" cy="12" r="1.2" />
              <circle cx="6" cy="12" r="1.2" />
            </svg>
          </div>
        )}

        <div className="min-w-0 flex-1">
          {isTopLevel && (
            <div className="mb-1 flex items-center gap-2 text-[10px] font-semibold uppercase tracking-[0.24em] text-[rgb(var(--color-text-secondary))]/60">
              <span>Sketch</span>
              <span className="h-px w-5 bg-[rgb(var(--color-border))]" />
              <span className="tracking-[0.14em]">
                {sketch.row_count} {sketch.row_count === 1 ? "row" : "rows"}
              </span>
            </div>
          )}

          <div className="flex items-center gap-2">
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

            <span className={`text-[10px] text-[rgb(var(--color-text-secondary))] shrink-0 ${isTopLevel ? "hidden" : ""}`}>
              {sketch.row_count} {sketch.row_count === 1 ? "row" : "rows"}
            </span>

            <button
              onClick={onOpen}
              className="shrink-0 p-1 rounded text-[rgb(var(--color-text-secondary))] opacity-0 group-hover/sketch:opacity-100 hover:text-[rgb(var(--color-accent))] transition-all"
              title="Open in editor"
            >
              <Pencil className="w-3.5 h-3.5" />
            </button>

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

          {fullSketch && typeof fullSketch.description === "string" && fullSketch.description.trim() && (
            <div className="prose-desc text-sm text-[rgb(var(--color-text-secondary))] mb-2 leading-relaxed">
              <SafeMarkdown>{fullSketch.description}</SafeMarkdown>
            </div>
          )}

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
      </div>
    </div>
  );
}

function StoryboardSectionBlock({
  item,
  index,
  sketchMap,
  sketchCache,
  projectRoot,
  dragListeners,
  locked,
  collapsed,
  onToggleCollapse,
  collapsedItems,
  setCollapsedItems,
  onOpenSketch,
  onRemoveSketch,
  onUpdateSection,
  onAddNewSketch,
  onPickExisting,
}: {
  item: Extract<StoryboardItem, { type: "section" }>;
  index: number;
  sketchMap: Map<string, SketchSummary>;
  sketchCache: Map<string, Sketch>;
  projectRoot?: string;
  dragListeners: Record<string, any>;
  locked?: boolean;
  collapsed: boolean;
  onToggleCollapse: () => void;
  collapsedItems: Set<string>;
  setCollapsedItems: Dispatch<SetStateAction<Set<string>>>;
  onOpenSketch: (path: string) => void;
  onRemoveSketch: (sketchIndex: number) => void;
  onUpdateSection: (sectionIndex: number, update: { title?: string; description?: string }) => void;
  onAddNewSketch: () => void;
  onPickExisting: () => void;
}) {
  const [draftTitle, setDraftTitle] = useState(item.title);
  const [draftDescription, setDraftDescription] = useState(item.description ?? "");
  const titleInputRef = useRef<HTMLInputElement>(null);
  const descriptionInputRef = useRef<HTMLTextAreaElement>(null);

  useEffect(() => {
    const activeElement = document.activeElement;
    if (activeElement === titleInputRef.current || activeElement === descriptionInputRef.current) {
      return;
    }
    setDraftTitle(item.title);
    setDraftDescription(item.description ?? "");
  }, [item.title, item.description]);

  useEffect(() => {
    const textarea = descriptionInputRef.current;
    if (!textarea) return;
    textarea.style.height = "auto";
    textarea.style.height = `${textarea.scrollHeight}px`;
  }, [draftDescription]);

  const flushSectionDraft = useCallback(() => {
    if (locked) return;
    const currentTitle = titleInputRef.current?.value ?? draftTitle;
    const title = currentTitle.trim() || item.title;
    const description = descriptionInputRef.current?.value ?? draftDescription;
    if (title !== currentTitle) setDraftTitle(title);
    if (title !== item.title || description !== (item.description ?? "")) {
      onUpdateSection(index, { title, description });
    }
  }, [draftDescription, draftTitle, index, item.description, item.title, locked, onUpdateSection]);
  const sketchCount = item.sketches.length;

  return (
    <section className="group/section rounded-2xl border border-[rgb(var(--color-border-subtle))] bg-[rgb(var(--color-surface))]/35 px-4 py-3">
      <div
        {...(!locked ? dragListeners : {})}
        className={`${locked ? "" : "cursor-grab active:cursor-grabbing"}`}
        title={locked ? undefined : "Drag to reorder section"}
      >
        <div className="flex items-start gap-3">
        {!locked && (
          <div className="mt-1 shrink-0 text-[rgb(var(--color-text-secondary))]/25 opacity-0 transition-opacity group-hover/section:opacity-100">
            <svg width="8" height="14" viewBox="0 0 8 14" fill="currentColor" aria-hidden="true">
              <circle cx="2" cy="2" r="1.2" />
              <circle cx="6" cy="2" r="1.2" />
              <circle cx="2" cy="7" r="1.2" />
              <circle cx="6" cy="7" r="1.2" />
              <circle cx="2" cy="12" r="1.2" />
              <circle cx="6" cy="12" r="1.2" />
            </svg>
          </div>
        )}
        <div className="min-w-0 flex-1">
          <div className="mb-1 flex items-center gap-2 text-[10px] font-semibold uppercase tracking-[0.24em] text-[rgb(var(--color-text-secondary))]/60">
            <span>Section</span>
            <span className="h-px w-5 bg-[rgb(var(--color-border))]" />
            <span className="tracking-[0.14em]">
              {sketchCount} {sketchCount === 1 ? "sketch" : "sketches"}
            </span>
          </div>
          <div className="flex items-center gap-2">
            <button
              onClick={(event) => {
                event.stopPropagation();
                onToggleCollapse();
              }}
              className="shrink-0 text-[rgb(var(--color-text-secondary))] hover:text-[rgb(var(--color-accent))] transition-colors"
              title={collapsed ? "Show sketches" : "Hide sketches"}
            >
              <ChevronRight className={`w-3.5 h-3.5 transition-transform ${collapsed ? "" : "rotate-90"}`} />
            </button>
            <input
              ref={titleInputRef}
              value={draftTitle}
              readOnly={locked}
              onChange={(event) => setDraftTitle(event.target.value)}
              onBlur={flushSectionDraft}
              className={`w-full bg-transparent text-lg font-semibold leading-tight text-[rgb(var(--color-text))] placeholder:text-[rgb(var(--color-text-secondary))]/35 outline-none ${locked ? "cursor-default" : ""}`}
              placeholder="Section title..."
            />
          </div>
          <textarea
            ref={descriptionInputRef}
            value={draftDescription}
            readOnly={locked}
            onChange={(event) => setDraftDescription(event.target.value)}
            onBlur={flushSectionDraft}
            rows={1}
            className="mt-2 w-full resize-none overflow-hidden bg-transparent text-sm leading-relaxed text-[rgb(var(--color-text-secondary))] placeholder:text-[rgb(var(--color-text-secondary))]/40 outline-none"
            placeholder="Add section framing..."
          />
        </div>
        </div>
      </div>

      {!collapsed && (
      <div className="mt-2 space-y-2 pl-6">
        {item.sketches.length === 0 ? (
          <p className="rounded-xl border border-dashed border-[rgb(var(--color-border-subtle))] bg-[rgb(var(--color-surface))]/35 px-4 py-4 text-center text-xs text-[rgb(var(--color-text-secondary))]">
            No sketches in this section yet.
          </p>
        ) : (
          item.sketches.map((path, sketchIndex) => {
            const collapseKey = getNestedSketchCollapseKey(index, sketchIndex);
            return (
              <ExpandableSketchCard
                key={`${path}-${sketchIndex}`}
                sketch={sketchMap.get(path) ?? makePlaceholder(path)}
                fullSketch={sketchCache.get(path)}
                onOpen={() => onOpenSketch(path)}
                onRemove={() => onRemoveSketch(sketchIndex)}
                projectRoot={projectRoot}
                dragListeners={undefined}
                locked={locked}
                outlineLevel="nested"
                collapsed={collapsedItems.has(collapseKey)}
                onToggleCollapse={() => setCollapsedItems((prev) => {
                  const next = new Set(prev);
                  if (next.has(collapseKey)) next.delete(collapseKey); else next.add(collapseKey);
                  return next;
                })}
              />
            );
          })
        )}
      </div>
      )}

      {!collapsed && !locked && (
        <div className="mt-2 flex gap-2 pl-6">
          <button
            onClick={onAddNewSketch}
            className="rounded-full border border-[rgb(var(--color-border-subtle))] px-3 py-1 text-[10px] font-medium uppercase tracking-[0.14em] text-[rgb(var(--color-text-secondary))] hover:border-[rgb(var(--color-accent))]/45 hover:text-[rgb(var(--color-accent))] transition-colors"
          >
            New sketch
          </button>
          <button
            onClick={onPickExisting}
            className="rounded-full border border-transparent px-3 py-1 text-[10px] font-medium uppercase tracking-[0.14em] text-[rgb(var(--color-text-secondary))] hover:bg-[rgb(var(--color-accent))]/10 hover:text-[rgb(var(--color-accent))] transition-colors"
          >
            Add existing sketch
          </button>
        </div>
      )}
    </section>
  );
}

function EmptyState({
  onAddNew,
  onPickExisting,
  onAddSection,
  locked,
}: {
  onAddNew: () => void;
  onPickExisting: () => void;
  onAddSection: () => void;
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
          <button
            onClick={onAddSection}
            className="flex items-center gap-2 px-4 py-2.5 text-xs font-medium rounded-xl border border-[rgb(var(--color-border))] text-[rgb(var(--color-text-secondary))] hover:text-[rgb(var(--color-text))] hover:border-[rgb(var(--color-accent))]/40 transition-colors"
          >
            Section
          </button>
        </div>
      )}
    </div>
  );
}

function AddItemButton({
  position,
  onAddNew,
  onAddSection,
  pickerTarget,
  setPickerTarget,
  filteredSketches,
  pickerSearch,
  setPickerSearch,
  onPickExisting,
}: {
  position: number;
  onAddNew: (target: PickerTarget) => void;
  onAddSection: (position: number) => void;
  pickerTarget: PickerTarget | null;
  setPickerTarget: (v: PickerTarget | null) => void;
  filteredSketches: import("../types/sketch").SketchSummary[];
  pickerSearch: string;
  setPickerSearch: (v: string) => void;
  onPickExisting: (path: string, target: PickerTarget) => void;
}) {
  const target: PickerTarget = { type: "top", position };
  const isOpen = pickerTarget?.type === "top" && pickerTarget.position === position;

  return (
    <div className="relative -mb-1 mt-2 flex h-9 items-center justify-center">
      <div className="absolute inset-x-12 top-1/2 h-px -translate-y-1/2 bg-gradient-to-r from-transparent via-[rgb(var(--color-border-subtle))] to-transparent opacity-0 transition-opacity group-hover/story-item:opacity-100" />
      <div className="relative left-1/2 flex -translate-x-1/2 gap-1 rounded-full border border-[rgb(var(--color-border-subtle))] bg-[rgb(var(--color-surface))]/95 px-1 py-0.5 opacity-0 shadow-sm backdrop-blur-sm transition-opacity hover:opacity-100 focus-within:opacity-100 group-hover/story-item:opacity-100">
        <button
          onClick={() => onAddNew(target)}
          className="rounded-full px-2.5 py-1 text-[10px] font-medium uppercase tracking-[0.12em] text-[rgb(var(--color-text-secondary))] hover:bg-[rgb(var(--color-accent))]/10 hover:text-[rgb(var(--color-accent))] transition-colors"
          title="New sketch"
        >
          + Sketch
        </button>
        <button
          onClick={() => setPickerTarget(isOpen ? null : target)}
          className="rounded-full px-2.5 py-1 text-[10px] font-medium uppercase tracking-[0.12em] text-[rgb(var(--color-text-secondary))] hover:bg-[rgb(var(--color-accent))]/10 hover:text-[rgb(var(--color-accent))] transition-colors"
          title="Add existing sketch"
        >
          + Existing
        </button>
        <button
          onClick={() => onAddSection(position)}
          className="rounded-full px-2.5 py-1 text-[10px] font-medium uppercase tracking-[0.12em] text-[rgb(var(--color-text-secondary))] hover:bg-[rgb(var(--color-accent))]/10 hover:text-[rgb(var(--color-accent))] transition-colors"
          title="Add section"
        >
          + Section
        </button>
      </div>

      {isOpen && (
        <div className="absolute top-full left-1/2 -translate-x-1/2 z-10 mt-1">
          <SketchPicker
            sketches={filteredSketches}
            search={pickerSearch}
            onSearchChange={setPickerSearch}
            onSelect={(path) => onPickExisting(path, target)}
            onClose={() => { setPickerTarget(null); setPickerSearch(""); }}
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
  onAddSection,
}: {
  onAddNew: () => void;
  onPickExisting: () => void;
  onAddSection: () => void;
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
        <button
          onClick={onAddSection}
          className="flex items-center gap-1.5 px-3 py-1.5 text-xs font-medium rounded-lg border border-[rgb(var(--color-border))] text-[rgb(var(--color-text-secondary))] hover:text-[rgb(var(--color-text))] hover:border-[rgb(var(--color-accent))]/40 transition-colors"
        >
          Section
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
