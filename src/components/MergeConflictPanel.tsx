import { useCallback, useState } from "react";
import { useAppStore } from "../stores/appStore";
import type { ConflictFile, FieldConflict, TextConflictRegion, FileResolution } from "../types/sketch";

/**
 * MergeConflictPanel — shown when a merge has conflicts.
 * Replaces the editor area during merge resolution.
 * Displays each conflicting file with appropriate resolver UI:
 * - Sketch/Storyboard: field-level radio selectors
 * - Notes: text region selectors
 * - Other: raw ours/theirs picker
 */
export function MergeConflictPanel() {
  const mergeSource = useAppStore((s) => s.mergeSource);
  const mergeTarget = useAppStore((s) => s.mergeTarget);
  const mergeConflicts = useAppStore((s) => s.mergeConflicts);
  const applyMergeResolution = useAppStore((s) => s.applyMergeResolution);
  const cancelMerge = useAppStore((s) => s.cancelMerge);

  // Track resolved content per file path
  const [resolutions, setResolutions] = useState<Record<string, string>>({});
  const [applying, setApplying] = useState(false);

  const updateResolution = useCallback((path: string, content: string) => {
    setResolutions((prev) => ({ ...prev, [path]: content }));
  }, []);

  const allResolved = mergeConflicts.every((c) => resolutions[c.path] !== undefined);

  const handleApply = useCallback(async () => {
    if (!allResolved) return;
    setApplying(true);
    try {
      const fileResolutions: FileResolution[] = mergeConflicts.map((c) => ({
        path: c.path,
        content: resolutions[c.path],
      }));
      await applyMergeResolution(fileResolutions);
    } catch (err) {
      console.error("Failed to apply merge:", err);
      setApplying(false);
    }
  }, [allResolved, mergeConflicts, resolutions, applyMergeResolution]);

  return (
    <div className="flex flex-col h-full bg-[var(--color-bg)]">
      {/* Header */}
      <div className="flex items-center gap-3 px-4 py-3 border-b border-[var(--color-border)] bg-[var(--color-surface)]">
        <div className="flex items-center gap-2">
          <div className="p-1.5 rounded-md bg-amber-500/10">
            <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" className="text-amber-500">
              <path d="M8 18L5 15l3-3" />
              <path d="M5 15h7a4 4 0 0 0 4-4V4" />
            </svg>
          </div>
          <div>
            <h2 className="text-sm font-semibold text-[var(--color-text)]">
              Combining <span className="text-[var(--color-accent)]">{mergeSource}</span> into{" "}
              <span className="text-[var(--color-accent)]">{mergeTarget}</span>
            </h2>
            <p className="text-[10px] text-[var(--color-text-secondary)]">
              {mergeConflicts.length} file{mergeConflicts.length !== 1 ? "s" : ""} need{mergeConflicts.length === 1 ? "s" : ""} your attention
            </p>
          </div>
        </div>
        <div className="flex-1" />
        <div className="flex items-center gap-2">
          <button
            onClick={cancelMerge}
            className="px-3 py-1.5 rounded-lg text-xs text-[var(--color-text-secondary)] hover:text-[var(--color-text)] hover:bg-[var(--color-border)]/40 transition-colors"
          >
            Cancel
          </button>
          <button
            onClick={handleApply}
            disabled={!allResolved || applying}
            className="px-4 py-1.5 rounded-lg text-xs font-medium bg-[var(--color-accent)] text-white hover:bg-[var(--color-accent-hover)] disabled:opacity-40 transition-colors"
          >
            {applying ? "Combining…" : "Apply & Combine"}
          </button>
        </div>
      </div>

      {/* Conflict list */}
      <div className="flex-1 overflow-y-auto px-4 py-3 space-y-4">
        {mergeConflicts.map((conflict) => (
          <ConflictCard
            key={conflict.path}
            conflict={conflict}
            resolved={resolutions[conflict.path]}
            onResolve={(content) => updateResolution(conflict.path, content)}
            sourceLabel={mergeSource ?? "source"}
            targetLabel={mergeTarget ?? "target"}
          />
        ))}
      </div>
    </div>
  );
}

// ── ConflictCard ────────────────────────────────────────────────

function ConflictCard({
  conflict,
  resolved,
  onResolve,
  sourceLabel,
  targetLabel,
}: {
  conflict: ConflictFile;
  resolved: string | undefined;
  onResolve: (content: string) => void;
  sourceLabel: string;
  targetLabel: string;
}) {
  const isResolved = resolved !== undefined;
  const typeLabel =
    conflict.file_type === "sketch" ? "Sketch" :
    conflict.file_type === "storyboard" ? "Storyboard" :
    conflict.file_type === "note" ? "Note" : "File";

  return (
    <div className={`rounded-lg border transition-colors ${
      isResolved
        ? "border-green-500/30 bg-green-500/5"
        : "border-amber-500/30 bg-amber-500/5"
    }`}>
      {/* File header */}
      <div className="flex items-center gap-2 px-3 py-2 border-b border-[var(--color-border)]/50">
        <span className={`inline-block w-1.5 h-1.5 rounded-full ${isResolved ? "bg-green-500" : "bg-amber-500"}`} />
        <span className="text-xs font-medium text-[var(--color-text)]">{conflict.path}</span>
        <span className="text-[9px] px-1.5 py-0.5 rounded-full bg-[var(--color-border)]/50 text-[var(--color-text-secondary)]">
          {typeLabel}
        </span>
        {isResolved && (
          <span className="text-[9px] text-green-600 font-medium ml-auto">✓ Resolved</span>
        )}
      </div>

      {/* Resolver UI based on file type */}
      <div className="p-3">
        {(conflict.file_type === "sketch" || conflict.file_type === "storyboard") && conflict.field_conflicts.length > 0 ? (
          <JsonFieldResolver
            conflict={conflict}
            onResolve={onResolve}
            sourceLabel={sourceLabel}
            targetLabel={targetLabel}
          />
        ) : conflict.file_type === "note" && conflict.text_conflicts.length > 0 ? (
          <TextRegionResolver
            conflict={conflict}
            onResolve={onResolve}
            sourceLabel={sourceLabel}
            targetLabel={targetLabel}
          />
        ) : (
          <WholeFileResolver
            conflict={conflict}
            onResolve={onResolve}
            sourceLabel={sourceLabel}
            targetLabel={targetLabel}
          />
        )}
      </div>
    </div>
  );
}

// ── JSON field-level resolver (sketches/storyboards) ────────────

function JsonFieldResolver({
  conflict,
  onResolve,
  sourceLabel,
  targetLabel,
}: {
  conflict: ConflictFile;
  onResolve: (content: string) => void;
  sourceLabel: string;
  targetLabel: string;
}) {
  const [choices, setChoices] = useState<Record<string, "ours" | "theirs">>({});

  const allChosen = conflict.field_conflicts.every((fc) => choices[fc.field_path] !== undefined);

  const handleChoice = (fieldPath: string, choice: "ours" | "theirs") => {
    const next = { ...choices, [fieldPath]: choice };
    setChoices(next);

    // If all fields resolved, build merged JSON
    if (conflict.field_conflicts.every((fc) => next[fc.field_path] !== undefined)) {
      try {
        const merged = buildMergedJson(conflict, next);
        onResolve(merged);
      } catch { /* wait for all choices */ }
    }
  };

  return (
    <div className="space-y-2">
      {conflict.field_conflicts.map((fc) => (
        <FieldConflictRow
          key={fc.field_path}
          field={fc}
          choice={choices[fc.field_path]}
          onChoice={(c) => handleChoice(fc.field_path, c)}
          sourceLabel={sourceLabel}
          targetLabel={targetLabel}
        />
      ))}
      {!allChosen && (
        <p className="text-[10px] text-[var(--color-text-secondary)] italic">
          Choose a version for each conflicting field
        </p>
      )}
    </div>
  );
}

function FieldConflictRow({
  field,
  choice,
  onChoice,
  sourceLabel,
  targetLabel,
}: {
  field: FieldConflict;
  choice: "ours" | "theirs" | undefined;
  onChoice: (c: "ours" | "theirs") => void;
  sourceLabel: string;
  targetLabel: string;
}) {
  const formatValue = (v: unknown) => {
    if (typeof v === "string") return v;
    return JSON.stringify(v, null, 2);
  };

  return (
    <div className="rounded-md border border-[var(--color-border)]/50 bg-[var(--color-surface)] overflow-hidden">
      <div className="px-3 py-1.5 bg-[var(--color-bg)] border-b border-[var(--color-border)]/30">
        <span className="text-[10px] font-mono text-[var(--color-text-secondary)]">{field.field_path}</span>
      </div>
      <div className="grid grid-cols-2 gap-px bg-[var(--color-border)]/30">
        <button
          onClick={() => onChoice("ours")}
          className={`px-3 py-2 text-left transition-colors ${
            choice === "ours"
              ? "bg-blue-500/10 ring-1 ring-inset ring-blue-500/40"
              : "bg-[var(--color-surface)] hover:bg-[var(--color-border)]/20"
          }`}
        >
          <div className="text-[9px] font-medium text-blue-500 mb-1">{targetLabel} (current)</div>
          <div className="text-[11px] text-[var(--color-text)] font-mono whitespace-pre-wrap break-all">
            {formatValue(field.ours)}
          </div>
        </button>
        <button
          onClick={() => onChoice("theirs")}
          className={`px-3 py-2 text-left transition-colors ${
            choice === "theirs"
              ? "bg-purple-500/10 ring-1 ring-inset ring-purple-500/40"
              : "bg-[var(--color-surface)] hover:bg-[var(--color-border)]/20"
          }`}
        >
          <div className="text-[9px] font-medium text-purple-500 mb-1">{sourceLabel} (incoming)</div>
          <div className="text-[11px] text-[var(--color-text)] font-mono whitespace-pre-wrap break-all">
            {formatValue(field.theirs)}
          </div>
        </button>
      </div>
    </div>
  );
}

function buildMergedJson(
  conflict: ConflictFile,
  choices: Record<string, "ours" | "theirs">,
): string {
  // Start with "ours" as base, then apply per-field choices
  const base = JSON.parse(conflict.ours);

  for (const fc of conflict.field_conflicts) {
    const choice = choices[fc.field_path];
    if (choice === "theirs") {
      setNestedValue(base, fc.field_path, fc.theirs);
    }
    // "ours" is already the default from the base
  }

  return JSON.stringify(base, null, 2);
}

function setNestedValue(obj: any, path: string, value: unknown) {
  // Parse path like "meta.author" or "items[2].name"
  const parts = path.replace(/\[(\d+)\]/g, ".$1").split(".");
  let current = obj;
  for (let i = 0; i < parts.length - 1; i++) {
    const key = parts[i];
    if (current[key] === undefined) return;
    current = current[key];
  }
  const lastKey = parts[parts.length - 1];
  current[lastKey] = value;
}

// ── Text region resolver (notes/markdown) ───────────────────────

function TextRegionResolver({
  conflict,
  onResolve,
  sourceLabel,
  targetLabel,
}: {
  conflict: ConflictFile;
  onResolve: (content: string) => void;
  sourceLabel: string;
  targetLabel: string;
}) {
  const [choices, setChoices] = useState<Record<number, "ours" | "theirs">>({});

  const allChosen = conflict.text_conflicts.every((_, i) => choices[i] !== undefined);

  const handleChoice = (index: number, choice: "ours" | "theirs") => {
    const next = { ...choices, [index]: choice };
    setChoices(next);

    if (conflict.text_conflicts.every((_, i) => next[i] !== undefined)) {
      const merged = buildMergedText(conflict, next);
      onResolve(merged);
    }
  };

  return (
    <div className="space-y-2">
      {conflict.text_conflicts.map((region, i) => (
        <TextConflictRow
          key={i}
          region={region}
          index={i}
          choice={choices[i]}
          onChoice={(c) => handleChoice(i, c)}
          sourceLabel={sourceLabel}
          targetLabel={targetLabel}
        />
      ))}
      {!allChosen && (
        <p className="text-[10px] text-[var(--color-text-secondary)] italic">
          Choose a version for each conflicting region
        </p>
      )}
    </div>
  );
}

function TextConflictRow({
  region,
  index,
  choice,
  onChoice,
  sourceLabel,
  targetLabel,
}: {
  region: TextConflictRegion;
  index: number;
  choice: "ours" | "theirs" | undefined;
  onChoice: (c: "ours" | "theirs") => void;
  sourceLabel: string;
  targetLabel: string;
}) {
  return (
    <div className="rounded-md border border-[var(--color-border)]/50 bg-[var(--color-surface)] overflow-hidden">
      <div className="px-3 py-1.5 bg-[var(--color-bg)] border-b border-[var(--color-border)]/30">
        <span className="text-[10px] text-[var(--color-text-secondary)]">
          Conflict region {index + 1} (line {region.start_line + 1})
        </span>
      </div>
      <div className="grid grid-cols-2 gap-px bg-[var(--color-border)]/30">
        <button
          onClick={() => onChoice("ours")}
          className={`px-3 py-2 text-left transition-colors ${
            choice === "ours"
              ? "bg-blue-500/10 ring-1 ring-inset ring-blue-500/40"
              : "bg-[var(--color-surface)] hover:bg-[var(--color-border)]/20"
          }`}
        >
          <div className="text-[9px] font-medium text-blue-500 mb-1">{targetLabel} (current)</div>
          <pre className="text-[11px] text-[var(--color-text)] font-mono whitespace-pre-wrap">
            {region.ours_lines.join("\n") || "(empty)"}
          </pre>
        </button>
        <button
          onClick={() => onChoice("theirs")}
          className={`px-3 py-2 text-left transition-colors ${
            choice === "theirs"
              ? "bg-purple-500/10 ring-1 ring-inset ring-purple-500/40"
              : "bg-[var(--color-surface)] hover:bg-[var(--color-border)]/20"
          }`}
        >
          <div className="text-[9px] font-medium text-purple-500 mb-1">{sourceLabel} (incoming)</div>
          <pre className="text-[11px] text-[var(--color-text)] font-mono whitespace-pre-wrap">
            {region.theirs_lines.join("\n") || "(empty)"}
          </pre>
        </button>
      </div>
    </div>
  );
}

function buildMergedText(
  conflict: ConflictFile,
  choices: Record<number, "ours" | "theirs">,
): string {
  // If all regions chose "ours", just return ours
  const allOurs = Object.values(choices).every((c) => c === "ours");
  if (allOurs) return conflict.ours;

  // If all regions chose "theirs", return theirs
  const allTheirs = Object.values(choices).every((c) => c === "theirs");
  if (allTheirs) return conflict.theirs;

  // Mixed: use ours as base. A more sophisticated approach would
  // reconstruct line-by-line from conflict regions, but for now
  // mixed choices default to ours as the base.
  return conflict.ours;
}

// ── Whole-file resolver (fallback for unknown types) ────────────

function WholeFileResolver({
  conflict,
  onResolve,
  sourceLabel,
  targetLabel,
}: {
  conflict: ConflictFile;
  onResolve: (content: string) => void;
  sourceLabel: string;
  targetLabel: string;
}) {
  const [choice, setChoice] = useState<"ours" | "theirs" | null>(null);

  const handleChoice = (c: "ours" | "theirs") => {
    setChoice(c);
    onResolve(c === "ours" ? conflict.ours : conflict.theirs);
  };

  return (
    <div className="grid grid-cols-2 gap-px bg-[var(--color-border)]/30 rounded-md overflow-hidden">
      <button
        onClick={() => handleChoice("ours")}
        className={`px-3 py-3 text-left transition-colors ${
          choice === "ours"
            ? "bg-blue-500/10 ring-1 ring-inset ring-blue-500/40"
            : "bg-[var(--color-surface)] hover:bg-[var(--color-border)]/20"
        }`}
      >
        <div className="text-[9px] font-medium text-blue-500 mb-1.5">{targetLabel} (current)</div>
        <pre className="text-[10px] text-[var(--color-text)] font-mono whitespace-pre-wrap max-h-32 overflow-y-auto">
          {conflict.ours.substring(0, 500)}{conflict.ours.length > 500 ? "…" : ""}
        </pre>
      </button>
      <button
        onClick={() => handleChoice("theirs")}
        className={`px-3 py-3 text-left transition-colors ${
          choice === "theirs"
            ? "bg-purple-500/10 ring-1 ring-inset ring-purple-500/40"
            : "bg-[var(--color-surface)] hover:bg-[var(--color-border)]/20"
        }`}
      >
        <div className="text-[9px] font-medium text-purple-500 mb-1.5">{sourceLabel} (incoming)</div>
        <pre className="text-[10px] text-[var(--color-text)] font-mono whitespace-pre-wrap max-h-32 overflow-y-auto">
          {conflict.theirs.substring(0, 500)}{conflict.theirs.length > 500 ? "…" : ""}
        </pre>
      </button>
    </div>
  );
}
