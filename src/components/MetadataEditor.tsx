import { useEffect, useMemo, useRef, useState } from "react";
import { ChevronRight, Plus } from "lucide-react";
import type { DocumentMetadata } from "../types/sketch";
import {
  formatDurationSummary,
  normalizeMetadata,
  type DurationDisplayMode,
  type DurationSummary,
} from "../utils/documentMetadata";

interface MetadataEditorProps {
  metadata?: DocumentMetadata;
  onChange: (metadata: DocumentMetadata) => void;
  disabled?: boolean;
}

export function MetadataEditor({ metadata, onChange, disabled = false }: MetadataEditorProps) {
  const fields = useMemo(
    () => Object.entries(metadata?.fields ?? {}).filter(([key]) => key.trim().length > 0),
    [metadata],
  );
  const [localFields, setLocalFields] = useState<Record<string, string>>(() => Object.fromEntries(fields));
  const [draftKey, setDraftKey] = useState("");
  const [draftValue, setDraftValue] = useState("");
  const [expanded, setExpanded] = useState(true);
  const commitTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const pendingFieldsRef = useRef<Record<string, string> | null>(null);
  const onChangeRef = useRef(onChange);
  onChangeRef.current = onChange;

  useEffect(() => {
    setLocalFields(Object.fromEntries(fields));
  }, [fields]);

  useEffect(() => () => {
    if (commitTimerRef.current) clearTimeout(commitTimerRef.current);
    if (pendingFieldsRef.current) onChangeRef.current(normalizeMetadata({ fields: pendingFieldsRef.current }));
  }, []);

  const commitFields = (next: Record<string, string>, immediate = false) => {
    pendingFieldsRef.current = next;
    if (commitTimerRef.current) clearTimeout(commitTimerRef.current);
    const commit = () => {
      pendingFieldsRef.current = null;
      onChangeRef.current(normalizeMetadata({ fields: next }));
    };
    if (immediate) {
      commit();
    } else {
      commitTimerRef.current = setTimeout(commit, 500);
    }
  };

  const updateField = (previousKey: string, nextKey: string, nextValue: string) => {
    const next = { ...localFields };
    delete next[previousKey];
    if (nextKey.trim()) next[nextKey.trim()] = nextValue;
    setLocalFields(next);
    commitFields(next);
  };

  const addField = () => {
    if (!draftKey.trim() || !draftValue.trim()) return;
    const next = { ...localFields, [draftKey]: draftValue };
    setLocalFields(next);
    commitFields(next, true);
    setDraftKey("");
    setDraftValue("");
  };
  const entries = Object.entries(localFields);
  const hasFields = entries.length > 0;
  const visiblePreview = entries.slice(0, 3);

  return (
    <section className={`group/metadata text-xs ${expanded ? "rounded-xl border border-[rgb(var(--color-border))]/35 bg-[rgb(var(--color-surface-alt))]/10 p-2" : "px-1 py-0.5"}`}>
      <button
        type="button"
        className="flex w-full min-w-0 items-center gap-1.5 rounded-md py-0.5 text-left text-[11px] text-[rgb(var(--color-text-tertiary))] transition-colors hover:text-[rgb(var(--color-text-secondary))]"
        onClick={() => setExpanded((value) => !value)}
        aria-expanded={expanded}
      >
        <ChevronRight className={`h-3 w-3 shrink-0 opacity-60 transition-transform ${expanded ? "rotate-90" : ""}`} />
        <span className="shrink-0 uppercase tracking-[0.16em]">Properties</span>
        {hasFields ? (
          <span className="text-[10px] text-[rgb(var(--color-text-tertiary))]">
            {entries.length} {entries.length === 1 ? "field" : "fields"}
          </span>
        ) : (
          <span className="inline-flex items-center gap-1 text-[rgb(var(--color-text-tertiary))]/80">
            <Plus className="h-2.5 w-2.5" />
            Add a property
          </span>
        )}
      </button>

      {!expanded && hasFields && (
        <div className="mt-1 space-y-0.5 pl-4">
          {visiblePreview.map(([key, value]) => (
            <button
              type="button"
              key={key}
              className="grid w-full grid-cols-[minmax(5.5rem,0.35fr)_1fr] gap-3 rounded-md px-1 py-0.5 text-left hover:bg-[rgb(var(--color-surface-alt))]/30"
              onClick={() => setExpanded(true)}
              title={`${key}: ${value}`}
            >
              <span className="truncate text-[11px] text-[rgb(var(--color-text-tertiary))]">{key}</span>
              <span className="truncate text-[11px] text-[rgb(var(--color-text-secondary))]">{value}</span>
            </button>
          ))}
          {entries.length > visiblePreview.length && (
            <button
              type="button"
              className="rounded-md px-1 py-0.5 text-[11px] text-[rgb(var(--color-text-tertiary))] hover:text-[rgb(var(--color-text-secondary))]"
              onClick={() => setExpanded(true)}
            >
              {entries.length - visiblePreview.length} more
            </button>
          )}
        </div>
      )}

      {expanded && (
      <div className="mt-2 space-y-1">
        {entries.map(([key, value]) => (
          <div key={key} className="grid gap-2 sm:grid-cols-[minmax(7rem,0.34fr)_1fr_auto]">
            <input
              className="rounded-md border border-transparent bg-transparent px-2 py-1 text-xs text-[rgb(var(--color-text-tertiary))] hover:border-[rgb(var(--color-border))]/35 focus:border-[rgb(var(--color-border))]/55 focus:bg-[rgb(var(--color-surface))] focus:text-[rgb(var(--color-text-secondary))] focus:outline-none focus:ring-1 focus:ring-[rgb(var(--color-accent))]/20"
              value={key}
              disabled={disabled}
              aria-label="Metadata key"
              onChange={(event) => updateField(key, event.target.value, value)}
            />
            <input
              className="rounded-md border border-transparent bg-transparent px-2 py-1 text-xs text-[rgb(var(--color-text-secondary))] hover:border-[rgb(var(--color-border))]/35 focus:border-[rgb(var(--color-border))]/55 focus:bg-[rgb(var(--color-surface))] focus:text-[rgb(var(--color-text))] focus:outline-none focus:ring-1 focus:ring-[rgb(var(--color-accent))]/20"
              value={value}
              disabled={disabled}
              aria-label={`Metadata value for ${key}`}
              onChange={(event) => updateField(key, key, event.target.value)}
            />
            <button
              type="button"
              className="rounded-md px-2 text-[11px] text-[rgb(var(--color-text-tertiary))] opacity-0 transition-opacity hover:bg-[rgb(var(--color-surface-hover))] hover:text-[rgb(var(--color-text-secondary))] group-hover/metadata:opacity-70 disabled:opacity-50"
              disabled={disabled}
              onClick={() => updateField(key, "", "")}
            >
              Remove
            </button>
          </div>
        ))}
        <div className="grid gap-2 sm:grid-cols-[minmax(7rem,0.34fr)_1fr_auto]">
          <input
            className="rounded-md border border-dashed border-transparent bg-transparent px-2 py-1 text-xs text-[rgb(var(--color-text-tertiary))] hover:border-[rgb(var(--color-border))]/35 focus:border-[rgb(var(--color-border))]/55 focus:bg-[rgb(var(--color-surface))] focus:text-[rgb(var(--color-text-secondary))] focus:outline-none focus:ring-1 focus:ring-[rgb(var(--color-accent))]/20"
            value={draftKey}
            disabled={disabled}
            placeholder="Property"
            aria-label="New metadata key"
            onChange={(event) => setDraftKey(event.target.value)}
          />
          <input
            className="rounded-md border border-dashed border-transparent bg-transparent px-2 py-1 text-xs text-[rgb(var(--color-text-secondary))] hover:border-[rgb(var(--color-border))]/35 focus:border-[rgb(var(--color-border))]/55 focus:bg-[rgb(var(--color-surface))] focus:text-[rgb(var(--color-text))] focus:outline-none focus:ring-1 focus:ring-[rgb(var(--color-accent))]/20"
            value={draftValue}
            disabled={disabled}
            placeholder="Value"
            aria-label="New metadata value"
            onChange={(event) => setDraftValue(event.target.value)}
            onKeyDown={(event) => {
              if (event.key === "Enter") addField();
            }}
          />
          <button
            type="button"
            className="rounded-md px-2 py-1 text-[11px] font-medium text-[rgb(var(--color-text-tertiary))] transition-colors hover:bg-[rgb(var(--color-surface-hover))] hover:text-[rgb(var(--color-accent))] disabled:opacity-50"
            disabled={disabled || !draftKey.trim() || !draftValue.trim()}
            onClick={addField}
          >
            Add
          </button>
        </div>
      </div>
      )}
    </section>
  );
}

export function DurationBadge({
  summary,
  mode = "minutes",
  onModeChange,
}: {
  summary: DurationSummary;
  mode?: DurationDisplayMode;
  onModeChange?: (mode: DurationDisplayMode) => void;
}) {
  const toggleClass = (value: DurationDisplayMode) =>
    `rounded-full px-1.5 py-0.5 transition-colors ${
      mode === value
        ? "bg-[rgb(var(--color-accent))] text-[rgb(var(--color-accent-fg))]"
        : "text-[rgb(var(--color-text-tertiary))] hover:text-[rgb(var(--color-text))]"
    }`;

  return (
    <div className="inline-flex items-center gap-2 rounded-full border border-[rgb(var(--color-border))] bg-[rgb(var(--color-surface-alt))] px-2.5 py-1 text-xs font-medium text-[rgb(var(--color-text-secondary))]">
      <span>Total time: {formatDurationSummary(summary, mode)}</span>
      {onModeChange && (
        <span className="inline-flex rounded-full border border-[rgb(var(--color-border))] bg-[rgb(var(--color-surface))] p-0.5 text-[10px] uppercase tracking-[0.14em]">
          <button type="button" className={toggleClass("seconds")} onClick={() => onModeChange("seconds")}>
            sec
          </button>
          <button type="button" className={toggleClass("minutes")} onClick={() => onModeChange("minutes")}>
            min
          </button>
        </span>
      )}
    </div>
  );
}
