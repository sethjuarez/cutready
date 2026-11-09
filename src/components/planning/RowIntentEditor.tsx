import { useEffect, useRef, useState } from "react";
import type { DemoStep, FramingBeat, InteractionBounds, PlanningRow } from "../../types/sketch";

const DEMO_STEP_KINDS = new Set(["navigate", "click", "type", "select", "wait_for", "highlight"]);
const FRAMING_BEAT_KINDS = new Set(["full_screen", "zoom_to", "hold"]);
const CAPTURE_POLICIES = ["before_after", "before_after_and_motion"] as const;
const WAIT_EDIT_POLICIES = ["keep_natural", "compress_wait", "show_start_and_end", "cut_to_completion", "keep_visible"] as const;
const FRAMING_EASINGS = ["linear", "ease_in_out", "ease_out"] as const;

function formatIntentJson<T>(value: T[] | null | undefined): string {
  return JSON.stringify(value ?? [], null, 2);
}

function parseIntentJson<T extends { kind: string }>(
  raw: string,
  allowedKinds: Set<string>,
  label: string,
): { value: T[] | null; error: string | null } {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw.trim() || "[]");
  } catch (error) {
    return { value: null, error: error instanceof Error ? error.message : `Invalid ${label} JSON` };
  }
  if (!Array.isArray(parsed)) return { value: null, error: `${label} must be a JSON array.` };
  for (const [index, entry] of parsed.entries()) {
    if (!entry || typeof entry !== "object" || Array.isArray(entry)) {
      return { value: null, error: `${label} item ${index + 1} must be an object.` };
    }
    const kind = (entry as { kind?: unknown }).kind;
    if (typeof kind !== "string" || !allowedKinds.has(kind)) {
      return { value: null, error: `${label} item ${index + 1} needs a known kind.` };
    }
    const error = validateIntentEntry(entry as Record<string, unknown>, label, index + 1);
    if (error) return { value: null, error };
  }
  return { value: parsed.length > 0 ? parsed as T[] : null, error: null };
}

function validateIntentEntry(entry: Record<string, unknown>, label: string, itemNumber: number): string | null {
  const prefix = `${label} item ${itemNumber}`;
  const requireString = (field: string) => (
    typeof entry[field] === "string" && entry[field].trim() ? null : `${prefix} needs "${field}".`
  );
  const isU32 = (value: unknown) => (
    typeof value === "number" && Number.isInteger(value) && value >= 0 && value <= 4294967295
  );
  const requireNumber = (field: string) => (
    isU32(entry[field]) ? null : `${prefix} needs "${field}" as a whole number of milliseconds (0 or more).`
  );
  const optionalNumber = (field: string) => (
    entry[field] == null || isU32(entry[field])
      ? null
      : `${prefix} needs "${field}" as a whole number of milliseconds (0 or more).`
  );
  const optionalBoolean = (field: string) => (
    entry[field] == null || typeof entry[field] === "boolean" ? null : `${prefix} needs boolean "${field}".`
  );
  const optionalEnum = (field: string, allowed: readonly string[]) => (
    entry[field] == null || (typeof entry[field] === "string" && allowed.includes(entry[field]))
      ? null
      : `${prefix} needs "${field}" as one of: ${allowed.join(", ")}.`
  );

  switch (entry.kind) {
    case "navigate":
      return requireString("target");
    case "click":
      return requireString("target") ?? validateOptionalInteractionBounds(entry.target_bounds, prefix) ?? optionalEnum("capture", CAPTURE_POLICIES);
    case "highlight":
      return requireString("target") ?? validateOptionalInteractionBounds(entry.target_bounds, prefix);
    case "type":
      return requireString("text") ?? validateOptionalInteractionBounds(entry.target_bounds, prefix) ?? optionalBoolean("clear_first");
    case "select":
      return requireString("target") ?? requireString("value") ?? validateOptionalInteractionBounds(entry.target_bounds, prefix);
    case "wait_for":
      return requireString("condition") ?? optionalNumber("timeout_ms") ?? optionalEnum("edit_policy", WAIT_EDIT_POLICIES);
    case "full_screen":
      return optionalNumber("at_ms");
    case "zoom_to":
      return optionalNumber("at_ms") ?? optionalNumber("duration_ms") ?? validateOptionalFramingRect(entry.rect, prefix) ?? optionalEnum("easing", FRAMING_EASINGS);
    case "hold":
      return optionalNumber("at_ms") ?? requireNumber("duration_ms");
    default:
      return null;
  }
}

function validateOptionalFramingRect(rect: unknown, prefix: string): string | null {
  if (rect == null) return null;
  if (!rect || typeof rect !== "object" || Array.isArray(rect)) return `${prefix} needs object "rect".`;
  const fields = ["x", "y", "width", "height"];
  for (const field of fields) {
    const value = (rect as Record<string, unknown>)[field];
    if (typeof value !== "number" || !Number.isFinite(value)) return `${prefix} rect needs numeric "${field}".`;
  }
  return null;
}

function validateOptionalInteractionBounds(bounds: unknown, prefix: string): string | null {
  if (bounds == null) return null;
  if (!bounds || typeof bounds !== "object" || Array.isArray(bounds)) return `${prefix} needs object "target_bounds".`;
  const fields = ["x", "y", "width", "height"];
  for (const field of fields) {
    const value = (bounds as Record<string, unknown>)[field];
    if (typeof value !== "number" || !Number.isFinite(value)) return `${prefix} target_bounds needs numeric "${field}".`;
    if (value < 0 || (field === "width" || field === "height") && value === 0) {
      return `${prefix} target_bounds needs non-negative x/y and positive width/height.`;
    }
  }
  return null;
}

function summarizeDemoStep(step: DemoStep): string {
  const boundsSummary = step.kind !== "navigate" && step.kind !== "wait_for" && step.target_bounds
    ? ` @ ${formatBounds(step.target_bounds)}`
    : "";
  switch (step.kind) {
    case "navigate":
      return `Navigate: ${step.target}`;
    case "click":
      return `Click: ${step.target}${boundsSummary}`;
    case "type":
      return `Type: ${step.target ? `${step.target} · ` : ""}${step.text}${boundsSummary}`;
    case "select":
      return `Select: ${step.target} → ${step.value}${boundsSummary}`;
    case "wait_for":
      return `Wait: ${step.condition}`;
    case "highlight":
      return `Highlight: ${step.target}${boundsSummary}`;
  }
}

function formatBounds(bounds: InteractionBounds): string {
  return `${Math.round(bounds.x)},${Math.round(bounds.y)} ${Math.round(bounds.width)}×${Math.round(bounds.height)}px`;
}

function summarizeFramingBeat(beat: FramingBeat): string {
  switch (beat.kind) {
    case "full_screen":
      return `Full screen${beat.at_ms != null ? ` @ ${beat.at_ms}ms` : ""}`;
    case "zoom_to":
      return `Zoom${beat.target ? `: ${beat.target}` : ""}${beat.at_ms != null ? ` @ ${beat.at_ms}ms` : ""}`;
    case "hold":
      return `Hold: ${beat.duration_ms}ms`;
  }
}

function IntentTextarea<T extends { kind: string }>({
  id,
  label,
  value,
  allowedKinds,
  readOnly,
  onCommit,
}: {
  id: string;
  label: string;
  value: T[] | null | undefined;
  allowedKinds: Set<string>;
  readOnly: boolean;
  onCommit: (value: T[] | null) => void;
}) {
  const serializedValue = formatIntentJson(value);
  const [localValue, setLocalValue] = useState(serializedValue);
  const [error, setError] = useState<string | null>(null);
  const focused = useRef(false);
  const lastCommittedValue = useRef(serializedValue);

  // Resync only when the stored value changes; leaving the field must not wipe an invalid draft or its error.
  useEffect(() => {
    lastCommittedValue.current = serializedValue;
    if (focused.current) return;
    setLocalValue(serializedValue);
    setError(null);
  }, [serializedValue]);

  const commit = () => {
    if (localValue === lastCommittedValue.current) {
      setError(null);
      return;
    }
    const parsed = parseIntentJson<T>(localValue, allowedKinds, label);
    setError(parsed.error);
    if (!parsed.error) {
      lastCommittedValue.current = formatIntentJson(parsed.value);
      onCommit(parsed.value);
    }
  };

  return (
    <div className="space-y-1">
      <label htmlFor={id} className="text-[10px] font-semibold uppercase tracking-[0.12em] text-[rgb(var(--color-text-secondary))]">
        {label}
      </label>
      <textarea
        id={id}
        value={localValue}
        readOnly={readOnly}
        rows={Math.max(2, Math.min(7, localValue.split("\n").length))}
        onChange={(event) => {
          setLocalValue(event.target.value);
          if (error) setError(null);
        }}
        onFocus={() => { focused.current = true; }}
        onBlur={() => {
          focused.current = false;
          commit();
        }}
        className="w-full resize-y rounded-md border border-[rgb(var(--color-border))] bg-[rgb(var(--color-surface-inset))]/70 px-2 py-1 font-mono text-[11px] leading-4 text-[rgb(var(--color-text))] outline-none transition-colors focus:border-[rgb(var(--color-accent))]/45 focus:ring-1 focus:ring-[rgb(var(--color-accent))]/20 read-only:cursor-default"
        spellCheck={false}
      />
      {error && (
        <div className="rounded border border-[rgb(var(--color-warning))]/25 bg-[rgb(var(--color-warning))]/10 px-2 py-1 text-[10px] text-[rgb(var(--color-warning))]">
          {error}
        </div>
      )}
    </div>
  );
}

export function RowIntentEditor({
  rowIndex,
  row,
  demoStepsReadOnly,
  framingBeatsReadOnly,
  onDemoStepsChange,
  onFramingBeatsChange,
}: {
  rowIndex: number;
  row: PlanningRow;
  demoStepsReadOnly: boolean;
  framingBeatsReadOnly: boolean;
  onDemoStepsChange: (steps: DemoStep[] | null) => void;
  onFramingBeatsChange: (beats: FramingBeat[] | null) => void;
}) {
  const demoSteps = row.demo_steps ?? [];
  const framingBeats = row.framing_beats ?? [];
  const hasIntent = demoSteps.length > 0 || framingBeats.length > 0;

  return (
    <details data-row-intent-editor className={`mt-2 rounded-lg border border-[rgb(var(--color-border))] bg-[rgb(var(--color-surface))]/55 ${hasIntent ? "shadow-[inset_3px_0_0_rgb(var(--color-accent))]" : ""}`}>
      <summary className="flex cursor-pointer select-none items-center justify-between gap-2 px-2.5 py-1.5 text-[11px] font-medium text-[rgb(var(--color-text-secondary))] marker:hidden">
        <span className="text-[rgb(var(--color-text))]">Row intent</span>
        <span className="rounded-full bg-[rgb(var(--color-surface-alt))] px-2 py-0.5 text-[10px]">
          {demoSteps.length} steps · {framingBeats.length} frames
        </span>
      </summary>
      <div className="space-y-2 border-t border-[rgb(var(--color-border))] p-2">
        {hasIntent && (
          <div className="flex flex-wrap gap-1.5">
            {demoSteps.map((step, stepIndex) => (
              <span key={`step-${stepIndex}`} className="rounded-full bg-[rgb(var(--color-accent))]/10 px-2 py-0.5 text-[10px] text-[rgb(var(--color-accent))]">
                {summarizeDemoStep(step)}
              </span>
            ))}
            {framingBeats.map((beat, beatIndex) => (
              <span key={`beat-${beatIndex}`} className="rounded-full bg-[rgb(var(--color-surface-alt))] px-2 py-0.5 text-[10px] text-[rgb(var(--color-text-secondary))]">
                {summarizeFramingBeat(beat)}
              </span>
            ))}
          </div>
        )}
        <IntentTextarea<DemoStep>
          id={`demo-steps-row-${rowIndex}`}
          label="Demo steps"
          value={row.demo_steps}
          allowedKinds={DEMO_STEP_KINDS}
          readOnly={demoStepsReadOnly}
          onCommit={onDemoStepsChange}
        />
        <IntentTextarea<FramingBeat>
          id={`framing-beats-row-${rowIndex}`}
          label="Framing beats"
          value={row.framing_beats}
          allowedKinds={FRAMING_BEAT_KINDS}
          readOnly={framingBeatsReadOnly}
          onCommit={onFramingBeatsChange}
        />
      </div>
    </details>
  );
}
