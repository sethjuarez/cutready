import { useCallback, useState } from "react";
import { useAppStore } from "../stores/appStore";
import { SketchCard, SketchPickerItem } from "./SketchCard";

/**
 * StoryboardView — displays the active storyboard's items
 * with sketch cards, section headers, and add buttons.
 */
export function StoryboardView() {
  const activeStoryboard = useAppStore((s) => s.activeStoryboard);
  const sketches = useAppStore((s) => s.sketches);
  const openSketch = useAppStore((s) => s.openSketch);
  const createSketch = useAppStore((s) => s.createSketch);
  const addSketchToStoryboard = useAppStore((s) => s.addSketchToStoryboard);
  const removeFromStoryboard = useAppStore((s) => s.removeFromStoryboard);
  const addSectionToStoryboard = useAppStore((s) => s.addSectionToStoryboard);
  const updateStoryboard = useAppStore((s) => s.updateStoryboard);
  const loadSketches = useAppStore((s) => s.loadSketches);

  const [showPicker, setShowPicker] = useState<number | null>(null);
  const [pickerSearch, setPickerSearch] = useState("");
  const [showSectionInput, setShowSectionInput] = useState<number | null>(null);
  const [sectionTitle, setSectionTitle] = useState("");

  const sketchMap = new Map(sketches.map((s) => [s.path, s]));

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

  const handleAddSection = useCallback(
    async (position?: number) => {
      if (!sectionTitle.trim()) return;
      await addSectionToStoryboard(sectionTitle.trim(), position);
      setShowSectionInput(null);
      setSectionTitle("");
    },
    [sectionTitle, addSectionToStoryboard],
  );

  if (!activeStoryboard) return null;

  const filteredSketches = sketches.filter((s) =>
    s.title.toLowerCase().includes(pickerSearch.toLowerCase()),
  );

  return (
    <div className="flex-1 overflow-y-auto">
      <div className="max-w-3xl mx-auto px-6 py-8">
        {/* Storyboard header */}
        <input
          type="text"
          defaultValue={activeStoryboard.title}
          onBlur={(e) => {
            const val = e.target.value.trim();
            if (val && val !== activeStoryboard.title) {
              updateStoryboard({ title: val });
            }
          }}
          className="w-full text-2xl font-semibold bg-transparent text-[var(--color-text)] placeholder:text-[var(--color-text-secondary)]/40 outline-none border-none mb-2"
          placeholder="Storyboard title..."
        />
        <textarea
          defaultValue={activeStoryboard.description}
          onBlur={(e) => {
            if (e.target.value !== activeStoryboard.description) {
              updateStoryboard({ description: e.target.value });
            }
          }}
          placeholder="Describe this storyboard..."
          rows={2}
          className="w-full text-sm bg-transparent text-[var(--color-text-secondary)] placeholder:text-[var(--color-text-secondary)]/40 outline-none border-none resize-none mb-8"
        />

        {/* Items */}
        {activeStoryboard.items.length === 0 ? (
          <EmptyState
            onAddNew={() => handleAddNewSketch()}
            onPickExisting={() => setShowPicker(0)}
            onAddSection={() => setShowSectionInput(0)}
          />
        ) : (
          <div className="space-y-2">
            {activeStoryboard.items.map((item, idx) => (
              <div key={idx}>
                {item.type === "sketch_ref" ? (
                  <SketchCard
                    sketch={sketchMap.get(item.path) ?? makePlaceholder(item.path)}
                    onOpen={() => openSketch(item.path)}
                    onRemove={() => removeFromStoryboard(idx)}
                  />
                ) : (
                  <SectionHeader
                    title={item.title}
                    sketchPaths={item.sketches}
                    sketchMap={sketchMap}
                    onOpenSketch={openSketch}
                  />
                )}

                {/* Add button between items */}
                <AddItemButton
                  position={idx + 1}
                  onAddNew={handleAddNewSketch}
                  showPicker={showPicker}
                  setShowPicker={setShowPicker}
                  showSectionInput={showSectionInput}
                  setShowSectionInput={setShowSectionInput}
                  filteredSketches={filteredSketches}
                  pickerSearch={pickerSearch}
                  setPickerSearch={setPickerSearch}
                  onPickExisting={handlePickExisting}
                  sectionTitle={sectionTitle}
                  setSectionTitle={setSectionTitle}
                  onAddSection={handleAddSection}
                />
              </div>
            ))}
          </div>
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

        {/* Section input (when shown) */}
        {showSectionInput !== null && activeStoryboard.items.length === 0 && (
          <SectionInput
            value={sectionTitle}
            onChange={setSectionTitle}
            onSubmit={() => handleAddSection(showSectionInput)}
            onCancel={() => { setShowSectionInput(null); setSectionTitle(""); }}
          />
        )}
      </div>
    </div>
  );
}

function EmptyState({
  onAddNew,
  onPickExisting,
  onAddSection,
}: {
  onAddNew: () => void;
  onPickExisting: () => void;
  onAddSection: () => void;
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
        <button
          onClick={onAddSection}
          className="flex items-center gap-2 px-4 py-2.5 text-xs font-medium rounded-xl border border-[var(--color-border)] text-[var(--color-text-secondary)] hover:text-[var(--color-text)] hover:border-[var(--color-accent)]/40 transition-colors"
        >
          Add Section
        </button>
      </div>
    </div>
  );
}

function SectionHeader({
  title,
  sketchPaths,
  sketchMap,
  onOpenSketch,
}: {
  title: string;
  sketchPaths: string[];
  sketchMap: Map<string, import("../types/sketch").SketchSummary>;
  onOpenSketch: (path: string) => void;
}) {
  return (
    <div className="mt-4 mb-2">
      <div className="flex items-center gap-2 mb-2">
        <div className="h-px flex-1 bg-[var(--color-border)]" />
        <span className="text-xs font-medium text-[var(--color-text-secondary)] uppercase tracking-wider px-2">
          {title}
        </span>
        <div className="h-px flex-1 bg-[var(--color-border)]" />
      </div>
      {sketchPaths.length > 0 && (
        <div className="space-y-2 ml-4">
          {sketchPaths.map((sp) => {
            const sketch = sketchMap.get(sp);
            if (!sketch) return null;
            return (
              <SketchCard
                key={sp}
                sketch={sketch}
                onOpen={() => onOpenSketch(sp)}
              />
            );
          })}
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
  showSectionInput,
  setShowSectionInput,
  filteredSketches,
  pickerSearch,
  setPickerSearch,
  onPickExisting,
  sectionTitle,
  setSectionTitle,
  onAddSection,
}: {
  position: number;
  onAddNew: (pos: number) => void;
  showPicker: number | null;
  setShowPicker: (v: number | null) => void;
  showSectionInput: number | null;
  setShowSectionInput: (v: number | null) => void;
  filteredSketches: import("../types/sketch").SketchSummary[];
  pickerSearch: string;
  setPickerSearch: (v: string) => void;
  onPickExisting: (path: string, pos: number) => void;
  sectionTitle: string;
  setSectionTitle: (v: string) => void;
  onAddSection: (pos: number) => void;
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
        <button
          onClick={() => setShowSectionInput(showSectionInput === position ? null : position)}
          className="px-2 py-1 text-[10px] rounded-md text-[var(--color-text-secondary)] hover:text-[var(--color-accent)] hover:bg-[var(--color-accent)]/10 transition-colors"
          title="Add section divider"
        >
          + Section
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

      {showSectionInput === position && (
        <div className="absolute top-full left-1/2 -translate-x-1/2 z-10 mt-1">
          <SectionInput
            value={sectionTitle}
            onChange={setSectionTitle}
            onSubmit={() => onAddSection(position)}
            onCancel={() => { setShowSectionInput(null); setSectionTitle(""); }}
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

function SectionInput({
  value,
  onChange,
  onSubmit,
  onCancel,
}: {
  value: string;
  onChange: (v: string) => void;
  onSubmit: () => void;
  onCancel: () => void;
}) {
  return (
    <div className="w-64 rounded-xl border border-[var(--color-border)] bg-[var(--color-surface)] shadow-lg p-3">
      <input
        type="text"
        value={value}
        onChange={(e) => onChange(e.target.value)}
        placeholder="Section title..."
        autoFocus
        onKeyDown={(e) => {
          if (e.key === "Enter") onSubmit();
          if (e.key === "Escape") onCancel();
        }}
        className="w-full px-2 py-1.5 text-xs bg-transparent text-[var(--color-text)] placeholder:text-[var(--color-text-secondary)]/50 outline-none border border-[var(--color-border)] rounded-md focus:ring-1 focus:ring-[var(--color-accent)]/40 mb-2"
      />
      <div className="flex gap-2">
        <button
          onClick={onSubmit}
          className="flex-1 py-1.5 text-xs rounded-md bg-[var(--color-accent)] text-white hover:bg-[var(--color-accent-hover)] transition-colors"
        >
          Add
        </button>
        <button
          onClick={onCancel}
          className="flex-1 py-1.5 text-xs rounded-md border border-[var(--color-border)] text-[var(--color-text-secondary)] hover:text-[var(--color-text)] transition-colors"
        >
          Cancel
        </button>
      </div>
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
