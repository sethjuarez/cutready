import { useState } from "react";
import { Plus } from "lucide-react";
import { timelineNameProblem } from "../../domain/versioning";
import {
  isDraftlineVariationCreateConflictError,
  type DraftlineVariationCreatePreflight,
} from "../../services/draftlineVersioning";
import { useVersioningStore } from "../../stores/versioningStore";
import { menuInputClass, menuRowClass } from "./TimelineRows";

interface NewTimelineFormProps {
  onCreated: () => void;
  /** Adopt the remote timeline that already has this name. */
  onAdopt: (name: string) => void;
}

/** "New timeline…": starts a timeline at the current version. */
export function NewTimelineForm({ onCreated, onAdopt }: NewTimelineFormProps) {
  const timelines = useVersioningStore((s) => s.timelines);
  const graphNodes = useVersioningStore((s) => s.graphNodes);
  const createTimeline = useVersioningStore((s) => s.createTimeline);
  const [open, setOpen] = useState(false);
  const [name, setName] = useState("");
  const [conflict, setConflict] = useState<DraftlineVariationCreatePreflight | null>(null);
  const problem = name.trim() ? timelineNameProblem(name, timelines) : null;

  const reset = () => {
    setOpen(false);
    setName("");
    setConflict(null);
  };

  const create = async () => {
    const head = graphNodes.find((node) => node.is_head);
    if (!head || !name.trim() || problem) return;
    try {
      await createTimeline(head.id, name.trim());
      reset();
      onCreated();
    } catch (error) {
      if (isDraftlineVariationCreateConflictError(error)) setConflict(error.preflight);
      else console.error("Failed to create timeline:", error);
    }
  };

  if (!open) {
    return (
      <button type="button" onClick={() => setOpen(true)} className={`${menuRowClass} text-[rgb(var(--color-accent))]`}>
        <Plus className="h-3 w-3 shrink-0" aria-hidden="true" />
        New timeline…
      </button>
    );
  }

  return (
    <div className="px-2 py-1.5">
      <div className="flex items-center gap-1.5">
        <input
          value={name}
          onChange={(event) => {
            setConflict(null);
            setName(event.target.value);
          }}
          onKeyDown={(event) => {
            if (event.key === "Enter") void create();
            if (event.key === "Escape") {
              event.stopPropagation();
              reset();
            }
          }}
          placeholder="Timeline name…"
          aria-label="New timeline name"
          aria-invalid={!!problem}
          className={menuInputClass}
          autoFocus
        />
        <button
          type="button"
          onClick={() => void create()}
          disabled={!name.trim() || !!problem}
          className="shrink-0 rounded-control bg-[rgb(var(--color-accent))] px-2 py-1 text-xs font-medium text-[rgb(var(--color-accent-fg))] hover:bg-[rgb(var(--color-accent-hover))] disabled:opacity-50"
        >
          Create
        </button>
      </div>
      {problem && <p className="mt-1 text-2xs text-error">{problem}</p>}
      {conflict && (
        <CreateConflict
          preflight={conflict}
          onUseSuggestion={(suggestion) => {
            setConflict(null);
            setName(suggestion);
          }}
          onAdopt={() => {
            const target = conflict.variation;
            reset();
            onAdopt(target);
          }}
          onCancel={reset}
        />
      )}
    </div>
  );
}

function CreateConflict({ preflight, onUseSuggestion, onAdopt, onCancel }: {
  preflight: DraftlineVariationCreatePreflight;
  onUseSuggestion: (name: string) => void;
  onAdopt: () => void;
  onCancel: () => void;
}) {
  const remote = preflight.remote ?? "remote";
  const canAdopt = preflight.remote_collision || preflight.remote_only_collision;
  const message = canAdopt
    ? `${remote}/${preflight.variation} already exists${preflight.existing_remote_head?.label ? ` at "${preflight.existing_remote_head.label}"` : ""}.`
    : `Timeline "${preflight.variation}" already exists locally.`;
  const buttonClass = "rounded-control px-2 py-1 font-medium";

  return (
    <div role="alert" className="mt-2 rounded-control border border-warning/25 bg-warning/5 p-2 text-2xs text-[rgb(var(--color-text-secondary))]">
      <div className="font-medium text-warning">{message}</div>
      <div className="mt-1">Choose another name, adopt the remote timeline, or cancel.</div>
      <div className="mt-2 flex flex-wrap items-center gap-1.5">
        {preflight.suggested_alternative && (
          <button
            type="button"
            onClick={() => onUseSuggestion(preflight.suggested_alternative!)}
            className={`${buttonClass} border border-[rgb(var(--color-border))] text-[rgb(var(--color-text))] hover:bg-fill-hover`}
          >
            Use {preflight.suggested_alternative}
          </button>
        )}
        {canAdopt && (
          <button type="button" onClick={onAdopt} className={`${buttonClass} bg-[rgb(var(--color-accent))] text-[rgb(var(--color-accent-fg))]`}>
            Adopt and switch
          </button>
        )}
        <button type="button" onClick={onCancel} className={`${buttonClass} text-[rgb(var(--color-text-secondary))] hover:text-[rgb(var(--color-text))]`}>
          Cancel
        </button>
      </div>
    </div>
  );
}
