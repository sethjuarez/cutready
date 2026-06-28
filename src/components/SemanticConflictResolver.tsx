import { useEffect, useMemo, useRef, useState } from "react";
import type { ReactNode } from "react";
import type { ConflictFile, FieldConflict, TextConflictRegion } from "../types/sketch";

export type SemanticChoice = "ours" | "theirs" | "custom";

interface SemanticField {
  path: string;
  label: string;
  group: string;
  ours: unknown;
  theirs: unknown;
  ancestor: unknown;
  kind: "text" | "json";
}

export interface SemanticResolution {
  choice: SemanticChoice;
  customValue?: string;
}

export function SemanticConflictResolver({
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
  const fields = useMemo(() => buildSemanticFields(conflict), [conflict]);
  const [choices, setChoices] = useState<Record<string, SemanticResolution>>({});
  const [fullEdit, setFullEdit] = useState(false);
  const [fullContent, setFullContent] = useState(conflict.ours);
  const fullEditInitialized = useRef(false);

  useEffect(() => {
    fullEditInitialized.current = false;
    setFullEdit(false);
    setFullContent(conflict.ours);
  }, [conflict.path, conflict.ours]);

  if (conflict.file_type === "note") {
    return conflict.text_conflicts.length > 0 ? (
      <MarkdownTextConflictResolver
        conflict={conflict}
        onResolve={onResolve}
        sourceLabel={sourceLabel}
        targetLabel={targetLabel}
      />
    ) : (
      <FullContentComposer
        conflict={conflict}
        onResolve={onResolve}
        sourceLabel={sourceLabel}
        targetLabel={targetLabel}
        title="Markdown resolution"
      />
    );
  }

  if (fields.length === 0) {
    return (
      <FullContentComposer
        conflict={conflict}
        onResolve={onResolve}
        sourceLabel={sourceLabel}
        targetLabel={targetLabel}
        title="File resolution"
      />
    );
  }

  const resolvedCount = fields.filter((field) => choices[field.path]).length;
  const allChosen = resolvedCount === fields.length;
  const typeLabel = conflict.file_type === "sketch" ? "Sketch-aware resolution" : "Storyboard-aware resolution";

  const updateChoice = (field: SemanticField, resolution: SemanticResolution) => {
    const next = { ...choices, [field.path]: resolution };
    setChoices(next);
    if (fields.every((candidate) => next[candidate.path])) {
      onResolve(buildSemanticResolvedJson(conflict, fields, next));
    }
  };

  const chooseAll = (choice: Exclude<SemanticChoice, "custom">) => {
    const next: Record<string, SemanticResolution> = {};
    fields.forEach((field) => {
      next[field.path] = { choice };
    });
    setChoices(next);
    onResolve(buildSemanticResolvedJson(conflict, fields, next));
  };

  const grouped = groupFields(fields);

  return (
    <div className="space-y-3">
      <div className="rounded-xl border border-[rgb(var(--color-border))]/60 bg-[rgb(var(--color-surface))] p-3">
        <div className="flex flex-wrap items-center gap-2">
          <div className="mr-auto">
            <div className="text-xs font-semibold text-[rgb(var(--color-text))]">{typeLabel}</div>
            <div className="text-[10px] text-[rgb(var(--color-text-secondary))]">
              {resolvedCount} of {fields.length} document field{fields.length === 1 ? "" : "s"} chosen
            </div>
          </div>
          <button
            type="button"
            onClick={() => chooseAll("ours")}
            className="rounded-lg border border-[rgb(var(--color-border))]/70 px-2.5 py-1 text-[10px] text-[rgb(var(--color-text-secondary))] transition-colors hover:bg-[rgb(var(--color-surface-alt))] hover:text-[rgb(var(--color-text))]"
          >
            Use all current
          </button>
          <button
            type="button"
            onClick={() => chooseAll("theirs")}
            className="rounded-lg border border-[rgb(var(--color-border))]/70 px-2.5 py-1 text-[10px] text-[rgb(var(--color-text-secondary))] transition-colors hover:bg-[rgb(var(--color-surface-alt))] hover:text-[rgb(var(--color-text))]"
          >
            Use all incoming
          </button>
          <button
            type="button"
            onClick={() => {
              if (!fullEdit && !fullEditInitialized.current) {
                const resolvedContent = allChosen
                  ? buildSemanticResolvedJson(conflict, fields, choices)
                  : conflict.ours;
                fullEditInitialized.current = true;
                setFullContent(resolvedContent);
                onResolve(resolvedContent);
              }
              setFullEdit((open) => !open);
            }}
            className="rounded-lg bg-[rgb(var(--color-accent))] px-2.5 py-1 text-[10px] font-medium text-[rgb(var(--color-accent-fg))] transition-colors hover:bg-[rgb(var(--color-accent-hover))]"
          >
            Edit full result
          </button>
        </div>

        {fullEdit && (
          <textarea
            value={fullContent}
            onChange={(event) => {
              setFullContent(event.target.value);
              onResolve(event.target.value);
            }}
            spellCheck={false}
            className="mt-3 h-56 w-full resize-y rounded-lg border border-[rgb(var(--color-border))] bg-[rgb(var(--color-surface-alt))] p-3 font-mono text-[11px] text-[rgb(var(--color-text))] outline-none focus:border-[rgb(var(--color-accent))]"
          />
        )}

        {!allChosen && !fullEdit && (
          <p className="mt-2 text-[10px] italic text-[rgb(var(--color-text-secondary))]">
            Choose current, incoming, or customize each field. Custom choices can combine both sides before applying.
          </p>
        )}
      </div>

      {!fullEdit && Object.entries(grouped).map(([group, groupFields]) => (
        <div key={group} className="rounded-xl border border-[rgb(var(--color-border))]/60 bg-[rgb(var(--color-surface))]">
          <div className="border-b border-[rgb(var(--color-border))]/50 px-3 py-2">
            <div className="text-[10px] font-semibold uppercase tracking-wide text-[rgb(var(--color-text-secondary))]">{group}</div>
          </div>
          <div className="divide-y divide-[rgb(var(--color-border))]/40">
            {groupFields.map((field) => (
              <SemanticFieldRow
                key={field.path}
                field={field}
                resolution={choices[field.path]}
                onResolve={(resolution) => updateChoice(field, resolution)}
                sourceLabel={sourceLabel}
                targetLabel={targetLabel}
                fileType={conflict.file_type}
              />
            ))}
          </div>
        </div>
      ))}
    </div>
  );
}

function SemanticFieldRow({
  field,
  resolution,
  onResolve,
  sourceLabel,
  targetLabel,
  fileType,
}: {
  field: SemanticField;
  resolution: SemanticResolution | undefined;
  onResolve: (resolution: SemanticResolution) => void;
  sourceLabel: string;
  targetLabel: string;
  fileType: ConflictFile["file_type"];
}) {
  const [customValue, setCustomValue] = useState(() => valueToEditable(field.ours));
  const isCustom = resolution?.choice === "custom";

  return (
    <div className="p-3">
      <div className="mb-2 flex items-center gap-2">
        <div className="mr-auto">
          <div className="text-xs font-medium text-[rgb(var(--color-text))]">{field.label}</div>
          <div className="text-[10px] text-[rgb(var(--color-text-secondary))]">{changeSummary(field)}</div>
        </div>
        <ChoiceButton active={resolution?.choice === "ours"} onClick={() => onResolve({ choice: "ours" })}>
          Current
        </ChoiceButton>
        <ChoiceButton active={resolution?.choice === "theirs"} onClick={() => onResolve({ choice: "theirs" })}>
          Incoming
        </ChoiceButton>
        <ChoiceButton active={isCustom} onClick={() => onResolve({ choice: "custom", customValue })}>
          Custom
        </ChoiceButton>
      </div>
      {field.ancestor !== undefined && !valuesEqual(field.ancestor, field.ours) && !valuesEqual(field.ancestor, field.theirs) && (
        <div className="mb-2 rounded-lg border border-[rgb(var(--color-border))]/50 bg-[rgb(var(--color-surface-alt))]/70 px-2.5 py-2">
          <div className="mb-1 text-[9px] font-semibold uppercase tracking-wide text-[rgb(var(--color-text-secondary))]">Before both changes</div>
          <div className="whitespace-pre-wrap text-[11px] leading-relaxed text-[rgb(var(--color-text-secondary))]">{formatDisplayValue(field.ancestor)}</div>
        </div>
      )}
      <div className="grid gap-2 lg:grid-cols-2">
        <SemanticPreviewPanel
          field={field}
          label={`${targetLabel} (current)`}
          value={field.ours}
          active={resolution?.choice === "ours"}
          fileType={fileType}
        />
        <SemanticPreviewPanel
          field={field}
          label={`${sourceLabel} (incoming)`}
          value={field.theirs}
          active={resolution?.choice === "theirs"}
          fileType={fileType}
        />
      </div>
      {isCustom && (
        <textarea
          value={customValue}
          onChange={(event) => {
            setCustomValue(event.target.value);
            onResolve({ choice: "custom", customValue: event.target.value });
          }}
          className="mt-2 min-h-24 w-full resize-y rounded-lg border border-[rgb(var(--color-accent))]/50 bg-[rgb(var(--color-surface-alt))] p-2 text-xs text-[rgb(var(--color-text))] outline-none focus:border-[rgb(var(--color-accent))]"
        />
      )}
    </div>
  );
}

function MarkdownTextConflictResolver({
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
  const [choices, setChoices] = useState<Record<number, SemanticResolution>>({});
  const [fullEdit, setFullEdit] = useState(false);
  const [fullContent, setFullContent] = useState(conflict.ours);
  const fullEditInitialized = useRef(false);
  const resolvedCount = conflict.text_conflicts.filter((_, index) => choices[index]).length;
  const allChosen = resolvedCount === conflict.text_conflicts.length;

  useEffect(() => {
    fullEditInitialized.current = false;
    setFullEdit(false);
    setFullContent(conflict.ours);
  }, [conflict.path, conflict.ours]);

  const updateChoice = (index: number, resolution: SemanticResolution) => {
    const next = { ...choices, [index]: resolution };
    setChoices(next);
    if (conflict.text_conflicts.every((_, regionIndex) => next[regionIndex])) {
      onResolve(buildSemanticResolvedText(conflict, next));
    }
  };

  const chooseAll = (choice: Exclude<SemanticChoice, "custom">) => {
    const next: Record<number, SemanticResolution> = {};
    conflict.text_conflicts.forEach((_, index) => {
      next[index] = { choice };
    });
    setChoices(next);
    onResolve(buildSemanticResolvedText(conflict, next));
  };

  return (
    <div className="space-y-3">
      <div className="rounded-xl border border-[rgb(var(--color-border))]/60 bg-[rgb(var(--color-surface))] p-3">
        <div className="flex flex-wrap items-center gap-2">
          <div className="mr-auto">
            <div className="text-xs font-semibold text-[rgb(var(--color-text))]">Markdown-aware resolution</div>
            <div className="text-[10px] text-[rgb(var(--color-text-secondary))]">
              {resolvedCount} of {conflict.text_conflicts.length} changed region{conflict.text_conflicts.length === 1 ? "" : "s"} chosen
            </div>
          </div>
          <button
            type="button"
            onClick={() => chooseAll("ours")}
            className="rounded-lg border border-[rgb(var(--color-border))]/70 px-2.5 py-1 text-[10px] text-[rgb(var(--color-text-secondary))] transition-colors hover:bg-[rgb(var(--color-surface-alt))] hover:text-[rgb(var(--color-text))]"
          >
            Use all current
          </button>
          <button
            type="button"
            onClick={() => chooseAll("theirs")}
            className="rounded-lg border border-[rgb(var(--color-border))]/70 px-2.5 py-1 text-[10px] text-[rgb(var(--color-text-secondary))] transition-colors hover:bg-[rgb(var(--color-surface-alt))] hover:text-[rgb(var(--color-text))]"
          >
            Use all incoming
          </button>
          <button
            type="button"
            onClick={() => {
              if (!fullEdit && !fullEditInitialized.current) {
                const resolvedContent = allChosen
                  ? buildSemanticResolvedText(conflict, choices)
                  : conflict.ours;
                fullEditInitialized.current = true;
                setFullContent(resolvedContent);
                onResolve(resolvedContent);
              }
              setFullEdit((open) => !open);
            }}
            className="rounded-lg bg-[rgb(var(--color-accent))] px-2.5 py-1 text-[10px] font-medium text-[rgb(var(--color-accent-fg))] transition-colors hover:bg-[rgb(var(--color-accent-hover))]"
          >
            Edit full result
          </button>
        </div>
        {!allChosen && !fullEdit && (
          <p className="mt-2 text-[10px] italic text-[rgb(var(--color-text-secondary))]">
            Resolve each Markdown region independently, or customize the final wording where both sides need to be combined.
          </p>
        )}
        {fullEdit && (
          <textarea
            value={fullContent}
            onChange={(event) => {
              setFullContent(event.target.value);
              onResolve(event.target.value);
            }}
            spellCheck
            className="mt-3 h-56 w-full resize-y rounded-lg border border-[rgb(var(--color-border))] bg-[rgb(var(--color-surface-alt))] p-3 font-mono text-[11px] text-[rgb(var(--color-text))] outline-none focus:border-[rgb(var(--color-accent))]"
          />
        )}
      </div>

      {!fullEdit && conflict.text_conflicts.map((region, index) => (
        <MarkdownRegionRow
          key={`${region.start_line}-${index}`}
          region={region}
          index={index}
          resolution={choices[index]}
          onResolve={(resolution) => updateChoice(index, resolution)}
          sourceLabel={sourceLabel}
          targetLabel={targetLabel}
        />
      ))}
    </div>
  );
}

function MarkdownRegionRow({
  region,
  index,
  resolution,
  onResolve,
  sourceLabel,
  targetLabel,
}: {
  region: TextConflictRegion;
  index: number;
  resolution: SemanticResolution | undefined;
  onResolve: (resolution: SemanticResolution) => void;
  sourceLabel: string;
  targetLabel: string;
}) {
  const [customValue, setCustomValue] = useState(() => region.ours_lines.join("\n"));
  const isCustom = resolution?.choice === "custom";

  return (
    <div className="rounded-xl border border-[rgb(var(--color-border))]/60 bg-[rgb(var(--color-surface))] p-3">
      <div className="mb-2 flex items-center gap-2">
        <div className="mr-auto">
          <div className="text-xs font-medium text-[rgb(var(--color-text))]">Changed region {index + 1}</div>
          <div className="text-[10px] text-[rgb(var(--color-text-secondary))]">Starts near line {region.start_line + 1}</div>
        </div>
        <ChoiceButton active={resolution?.choice === "ours"} onClick={() => onResolve({ choice: "ours" })}>
          Current
        </ChoiceButton>
        <ChoiceButton active={resolution?.choice === "theirs"} onClick={() => onResolve({ choice: "theirs" })}>
          Incoming
        </ChoiceButton>
        <ChoiceButton active={isCustom} onClick={() => onResolve({ choice: "custom", customValue })}>
          Custom
        </ChoiceButton>
      </div>
      {region.ancestor_lines.length > 0 && (
        <div className="mb-2 rounded-lg border border-[rgb(var(--color-border))]/50 bg-[rgb(var(--color-surface-alt))]/70 px-2.5 py-2">
          <div className="mb-1 text-[9px] font-semibold uppercase tracking-wide text-[rgb(var(--color-text-secondary))]">Before both changes</div>
          <MarkdownLines lines={region.ancestor_lines} tone="muted" />
        </div>
      )}
      <div className="grid gap-2 lg:grid-cols-2">
        <MarkdownRegionPreview
          label={`${targetLabel} (current)`}
          lines={region.ours_lines}
          compareTo={region.ancestor_lines}
          active={resolution?.choice === "ours"}
          tone="current"
        />
        <MarkdownRegionPreview
          label={`${sourceLabel} (incoming)`}
          lines={region.theirs_lines}
          compareTo={region.ancestor_lines}
          active={resolution?.choice === "theirs"}
          tone="incoming"
        />
      </div>
      {isCustom && (
        <textarea
          value={customValue}
          onChange={(event) => {
            setCustomValue(event.target.value);
            onResolve({ choice: "custom", customValue: event.target.value });
          }}
          spellCheck
          className="mt-2 min-h-24 w-full resize-y rounded-lg border border-[rgb(var(--color-accent))]/50 bg-[rgb(var(--color-surface-alt))] p-2 text-xs text-[rgb(var(--color-text))] outline-none focus:border-[rgb(var(--color-accent))]"
        />
      )}
    </div>
  );
}

function MarkdownRegionPreview({
  label,
  lines,
  compareTo,
  active,
  tone,
}: {
  label: string;
  lines: string[];
  compareTo: string[];
  active: boolean;
  tone: "current" | "incoming";
}) {
  return (
    <PreviewShell label={label} active={active}>
      <div className="rounded-lg border border-[rgb(var(--color-border))]/60 bg-[rgb(var(--color-surface))] p-2">
        <MarkdownLines lines={lines} compareTo={compareTo} tone={tone} />
      </div>
    </PreviewShell>
  );
}

function MarkdownLines({
  lines,
  compareTo,
  tone,
}: {
  lines: string[];
  compareTo?: string[];
  tone: "current" | "incoming" | "muted";
}) {
  const markerClass = tone === "incoming"
    ? "bg-[rgb(var(--color-success))]/10 text-[rgb(var(--color-success))]"
    : tone === "current"
      ? "bg-[rgb(var(--color-accent))]/10 text-[rgb(var(--color-accent))]"
      : "bg-[rgb(var(--color-surface-alt))] text-[rgb(var(--color-text-secondary))]";

  return (
    <div className="space-y-1 font-mono text-[11px] leading-relaxed">
      {lines.length === 0 ? (
        <div className="italic text-[rgb(var(--color-text-secondary))]">(empty)</div>
      ) : lines.map((line, index) => (
        <div key={`${index}-${line}`} className="grid grid-cols-[1.5rem_1fr] gap-2">
          <span className={`rounded px-1 text-center text-[9px] ${markerClass}`}>
            {tone === "muted" ? "=" : "+"}
          </span>
          <span className="whitespace-pre-wrap text-[rgb(var(--color-text))]">
            <HighlightedValue value={line} compareTo={compareTo?.[index]} />
          </span>
        </div>
      ))}
    </div>
  );
}

function ChoiceButton({ active, onClick, children }: { active: boolean; onClick: () => void; children: string }) {
  return (
    <button
      type="button"
      onClick={onClick}
      className={`rounded-full px-2.5 py-1 text-[10px] font-medium transition-colors ${
        active
          ? "bg-[rgb(var(--color-accent))] text-[rgb(var(--color-accent-fg))]"
          : "bg-[rgb(var(--color-surface-alt))] text-[rgb(var(--color-text-secondary))] hover:text-[rgb(var(--color-text))]"
      }`}
    >
      {children}
    </button>
  );
}

function SemanticPreviewPanel({
  field,
  label,
  value,
  active,
  fileType,
}: {
  field: SemanticField;
  label: string;
  value: unknown;
  active: boolean;
  fileType: ConflictFile["file_type"];
}) {
  if (field.group === "Planning table") {
    if (field.path === "rows") {
      return <SketchRowSequencePreview field={field} label={label} value={value} active={active} />;
    }
    return <SketchRowPreview field={field} label={label} value={value} active={active} />;
  }

  if (field.group === "Sketch" || field.group === "Document fields") {
    return <SketchDocumentPreview field={field} label={label} value={value} active={active} fileType={fileType} />;
  }

  if (field.group === "Storyboard structure") {
    return <StoryboardPreview field={field} label={label} value={value} active={active} />;
  }

  return <PreviewPanel label={label} value={value} active={active} />;
}

function SketchDocumentPreview({
  field,
  label,
  value,
  active,
  fileType,
}: {
  field: SemanticField;
  label: string;
  value: unknown;
  active: boolean;
  fileType: ConflictFile["file_type"];
}) {
  const documentLabel = fileType === "storyboard" ? "Storyboard" : "Sketch";

  return (
    <PreviewShell label={label} active={active}>
      <div className="rounded-lg border border-[rgb(var(--color-border))]/60 bg-[rgb(var(--color-surface))] shadow-sm">
        <div className="border-b border-[rgb(var(--color-border))]/50 px-3 py-2">
          <div className="text-[9px] font-semibold uppercase tracking-wide text-[rgb(var(--color-text-secondary))]">
            {documentLabel}
          </div>
          <div className="mt-0.5 text-xs font-semibold text-[rgb(var(--color-text))]">{field.label}</div>
        </div>
        <div className="p-3">
          {field.path === "description" ? (
            <div className="rounded-md border-l-2 border-[rgb(var(--color-accent))]/70 bg-[rgb(var(--color-surface-alt))] px-3 py-2 text-[11px] leading-relaxed text-[rgb(var(--color-text))]">
              <HighlightedValue value={value} compareTo={field.ancestor} />
            </div>
          ) : (
            <div className="text-lg font-semibold text-[rgb(var(--color-text))]">
              <HighlightedValue value={value} compareTo={field.ancestor} />
            </div>
          )}
        </div>
      </div>
    </PreviewShell>
  );
}

function SketchRowPreview({
  field,
  label,
  value,
  active,
}: {
  field: SemanticField;
  label: string;
  value: unknown;
  active: boolean;
}) {
  const rowNumber = rowNumberFromPath(field.path);
  const pathParts = field.path.split(".");
  const column = pathParts[pathParts.length - 1] ?? field.label;
  const columnLabel = friendlyFieldLabel(column);

  return (
    <PreviewShell label={label} active={active}>
      <div className="overflow-hidden rounded-lg border border-[rgb(var(--color-border))]/60 bg-[rgb(var(--color-surface))] shadow-sm">
        <div className="flex items-center gap-2 border-b border-[rgb(var(--color-border))]/50 px-3 py-2">
          <span className="rounded-full bg-[rgb(var(--color-surface-alt))] px-2 py-0.5 text-[9px] font-semibold text-[rgb(var(--color-text-secondary))]">
            Row {rowNumber}
          </span>
          <span className="text-xs font-semibold text-[rgb(var(--color-text))]">{columnLabel}</span>
        </div>
        <div className="grid grid-cols-[4.5rem_1fr] border-b border-[rgb(var(--color-border))]/40 text-[9px] font-semibold uppercase tracking-wide text-[rgb(var(--color-text-secondary))]">
          <div className="border-r border-[rgb(var(--color-border))]/40 px-2 py-1.5">Time</div>
          <div className="px-2 py-1.5">{columnLabel}</div>
        </div>
        <div className="grid grid-cols-[4.5rem_1fr] text-[11px] text-[rgb(var(--color-text))]">
          <div className="border-r border-[rgb(var(--color-border))]/40 bg-[rgb(var(--color-surface-alt))] px-2 py-2 text-[rgb(var(--color-text-secondary))]">
            Row {rowNumber}
          </div>
          <div className="min-h-20 whitespace-pre-wrap px-2 py-2 leading-relaxed">
            <HighlightedValue value={value} compareTo={field.ancestor} />
          </div>
        </div>
      </div>
    </PreviewShell>
  );
}

function SketchRowSequencePreview({
  field,
  label,
  value,
  active,
}: {
  field: SemanticField;
  label: string;
  value: unknown;
  active: boolean;
}) {
  const rows = Array.isArray(value) ? value.filter(isRecord) : [];
  const ancestorRows = Array.isArray(field.ancestor) ? field.ancestor.filter(isRecord) : [];
  const missingAncestorRows = ancestorRows.filter((row) =>
    !rows.some((candidate) => rowFingerprint(candidate) === rowFingerprint(row)),
  );

  return (
    <PreviewShell label={label} active={active}>
      <div className="overflow-hidden rounded-lg border border-[rgb(var(--color-border))]/60 bg-[rgb(var(--color-surface))] shadow-sm">
        <div className="flex items-center gap-2 border-b border-[rgb(var(--color-border))]/50 px-3 py-2">
          <span className="rounded-full bg-[rgb(var(--color-surface-alt))] px-2 py-0.5 text-[9px] font-semibold text-[rgb(var(--color-text-secondary))]">
            {rows.length} row{rows.length === 1 ? "" : "s"}
          </span>
          <span className="text-xs font-semibold text-[rgb(var(--color-text))]">Planning table sequence</span>
        </div>
        <div className="divide-y divide-[rgb(var(--color-border))]/40">
          {rows.map((row, index) => (
            <SketchSequenceRow
              key={`${rowFingerprint(row)}-${index}`}
              row={row}
              index={index}
              ancestorRows={ancestorRows}
            />
          ))}
          {missingAncestorRows.map((row, index) => (
            <div key={`deleted-${rowFingerprint(row)}-${index}`} className="grid grid-cols-[4rem_1fr] bg-[rgb(var(--color-error))]/6 text-[11px] opacity-80">
              <div className="border-r border-[rgb(var(--color-border))]/40 px-2 py-2 text-[rgb(var(--color-error))]">Deleted</div>
              <div className="px-2 py-2 text-[rgb(var(--color-text-secondary))] line-through">
                {rowLabel(row)}
              </div>
            </div>
          ))}
        </div>
      </div>
    </PreviewShell>
  );
}

function SketchSequenceRow({
  row,
  index,
  ancestorRows,
}: {
  row: Record<string, unknown>;
  index: number;
  ancestorRows: Record<string, unknown>[];
}) {
  const fingerprint = rowFingerprint(row);
  const ancestorIndex = ancestorRows.findIndex((candidate) => rowFingerprint(candidate) === fingerprint);
  const marker = ancestorIndex === -1
    ? "Added"
    : ancestorIndex === index
      ? `Row ${index + 1}`
      : `Moved ${ancestorIndex + 1} -> ${index + 1}`;
  const markerClass = ancestorIndex === -1
    ? "text-[rgb(var(--color-success))]"
    : ancestorIndex === index
      ? "text-[rgb(var(--color-text-secondary))]"
      : "text-[rgb(var(--color-accent))]";

  return (
    <div className="grid grid-cols-[4rem_1fr] text-[11px]">
      <div className={`border-r border-[rgb(var(--color-border))]/40 px-2 py-2 font-medium ${markerClass}`}>
        {marker}
      </div>
      <div className="space-y-1 px-2 py-2">
        <div className="font-medium text-[rgb(var(--color-text))]">{rowLabel(row)}</div>
        <div className="truncate text-[rgb(var(--color-text-secondary))]">{valueToSingleLine(row.demo_actions)}</div>
      </div>
    </div>
  );
}

function StoryboardPreview({
  field,
  label,
  value,
  active,
}: {
  field: SemanticField;
  label: string;
  value: unknown;
  active: boolean;
}) {
  if (field.path === "items" || field.path === "sketches") {
    return <StoryboardStructurePreview field={field} label={label} value={value} active={active} />;
  }

  return (
    <PreviewShell label={label} active={active}>
      <div className="rounded-lg border border-[rgb(var(--color-border))]/60 bg-[rgb(var(--color-surface))] p-3 shadow-sm">
        <div className="mb-2 text-[9px] font-semibold uppercase tracking-wide text-[rgb(var(--color-text-secondary))]">
          Storyboard · {field.label}
        </div>
        <div className="rounded-md bg-[rgb(var(--color-surface-alt))] p-2 text-[11px] text-[rgb(var(--color-text))]">
          <HighlightedValue value={value} compareTo={field.ancestor} />
        </div>
      </div>
    </PreviewShell>
  );
}

function StoryboardStructurePreview({
  field,
  label,
  value,
  active,
}: {
  field: SemanticField;
  label: string;
  value: unknown;
  active: boolean;
}) {
  const items = storyboardPreviewItems(value);
  const ancestorItems = storyboardPreviewItems(field.ancestor);
  const missingAncestorItems = ancestorItems.filter((item) =>
    !items.some((candidate) => candidate.fingerprint === item.fingerprint),
  );

  return (
    <PreviewShell label={label} active={active}>
      <div className="overflow-hidden rounded-lg border border-[rgb(var(--color-border))]/60 bg-[rgb(var(--color-surface))] shadow-sm">
        <div className="flex items-center gap-2 border-b border-[rgb(var(--color-border))]/50 px-3 py-2">
          <span className="rounded-full bg-[rgb(var(--color-surface-alt))] px-2 py-0.5 text-[9px] font-semibold text-[rgb(var(--color-text-secondary))]">
            {items.length} item{items.length === 1 ? "" : "s"}
          </span>
          <span className="text-xs font-semibold text-[rgb(var(--color-text))]">Storyboard order</span>
        </div>
        <div className="divide-y divide-[rgb(var(--color-border))]/40">
          {items.map((item, index) => (
            <StoryboardStructureItem
              key={`${item.fingerprint}-${index}`}
              item={item}
              index={index}
              ancestorItems={ancestorItems}
            />
          ))}
          {missingAncestorItems.map((item, index) => (
            <div key={`deleted-${item.fingerprint}-${index}`} className="grid grid-cols-[4rem_1fr] bg-[rgb(var(--color-error))]/6 text-[11px] opacity-80">
              <div className="border-r border-[rgb(var(--color-border))]/40 px-2 py-2 text-[rgb(var(--color-error))]">Deleted</div>
              <div className="px-2 py-2 text-[rgb(var(--color-text-secondary))] line-through">{item.title}</div>
            </div>
          ))}
        </div>
      </div>
    </PreviewShell>
  );
}

interface StoryboardPreviewItem {
  type: "sketch" | "section";
  title: string;
  description?: string;
  sketches: string[];
  fingerprint: string;
}

function StoryboardStructureItem({
  item,
  index,
  ancestorItems,
}: {
  item: StoryboardPreviewItem;
  index: number;
  ancestorItems: StoryboardPreviewItem[];
}) {
  const ancestorIndex = ancestorItems.findIndex((candidate) => candidate.fingerprint === item.fingerprint);
  const marker = ancestorIndex === -1
    ? "Added"
    : ancestorIndex === index
      ? `${index + 1}`
      : `Moved ${ancestorIndex + 1} -> ${index + 1}`;
  const markerClass = ancestorIndex === -1
    ? "text-[rgb(var(--color-success))]"
    : ancestorIndex === index
      ? "text-[rgb(var(--color-text-secondary))]"
      : "text-[rgb(var(--color-accent))]";

  return (
    <div className="grid grid-cols-[4rem_1fr] text-[11px]">
      <div className={`border-r border-[rgb(var(--color-border))]/40 px-2 py-2 font-medium ${markerClass}`}>
        {marker}
      </div>
      <div className="space-y-1 px-2 py-2">
        <div className="flex items-center gap-2">
          <span className="rounded-full bg-[rgb(var(--color-surface-alt))] px-1.5 py-px text-[9px] uppercase tracking-wide text-[rgb(var(--color-text-secondary))]">
            {item.type}
          </span>
          <span className="font-medium text-[rgb(var(--color-text))]">{item.title}</span>
        </div>
        {item.description && (
          <div className="truncate text-[rgb(var(--color-text-secondary))]">{item.description}</div>
        )}
        {item.sketches.length > 0 && (
          <div className="flex flex-wrap gap-1">
            {item.sketches.map((path) => (
              <span key={path} className="rounded-full border border-[rgb(var(--color-border))]/50 px-1.5 py-px text-[10px] text-[rgb(var(--color-text-secondary))]">
                {path}
              </span>
            ))}
          </div>
        )}
      </div>
    </div>
  );
}

function PreviewPanel({ label, value, active }: { label: string; value: unknown; active: boolean }) {
  return (
    <PreviewShell label={label} active={active}>
      <div className="max-h-40 overflow-y-auto whitespace-pre-wrap break-words text-[11px] leading-relaxed text-[rgb(var(--color-text))]">
        <HighlightedValue value={value} compareTo={undefined} />
      </div>
    </PreviewShell>
  );
}

function PreviewShell({ label, active, children }: { label: string; active: boolean; children: ReactNode }) {
  return (
    <div className={`rounded-lg border p-2 ${active ? "border-[rgb(var(--color-accent))]/60 bg-[rgb(var(--color-accent))]/10" : "border-[rgb(var(--color-border))]/60 bg-[rgb(var(--color-surface-alt))]"}`}>
      <div className="mb-1 text-[9px] font-semibold uppercase tracking-wide text-[rgb(var(--color-text-secondary))]">{label}</div>
      {children}
    </div>
  );
}

function HighlightedValue({ value, compareTo }: { value: unknown; compareTo: unknown }) {
  const text = formatDisplayValue(value);
  const base = compareTo === undefined ? "" : formatDisplayValue(compareTo);
  if (!base || text === base) return <>{text}</>;

  const prefixLength = commonPrefixLength(text, base);
  const suffixLength = commonSuffixLength(text.slice(prefixLength), base.slice(prefixLength));
  const before = text.slice(0, prefixLength);
  const changed = text.slice(prefixLength, text.length - suffixLength);
  const removed = base.slice(prefixLength, base.length - suffixLength);
  const after = suffixLength > 0 ? text.slice(text.length - suffixLength) : "";

  if (!changed.trim() && !removed.trim()) return <>{text}</>;

  return (
    <>
      {before}
      {removed.trim() && (
        <mark className="mx-0.5 rounded border border-[rgb(var(--color-error))]/25 bg-[rgb(var(--color-error))]/10 px-1 text-[rgb(var(--color-error))] line-through decoration-[rgb(var(--color-error))]/70">
          {removed}
        </mark>
      )}
      {changed.trim() && (
        <mark className="mx-0.5 rounded border border-[rgb(var(--color-success))]/25 bg-[rgb(var(--color-success))]/10 px-1 text-[rgb(var(--color-success))]">
          {changed}
        </mark>
      )}
      {after}
    </>
  );
}

function FullContentComposer({
  conflict,
  onResolve,
  sourceLabel,
  targetLabel,
  title,
}: {
  conflict: ConflictFile;
  onResolve: (content: string) => void;
  sourceLabel: string;
  targetLabel: string;
  title: string;
}) {
  const [content, setContent] = useState(conflict.ours);
  const initializedKey = useRef<string | null>(null);

  useEffect(() => {
    const key = `${conflict.path}:${conflict.ours}`;
    if (initializedKey.current === key) return;
    initializedKey.current = key;
    setContent(conflict.ours);
    onResolve(conflict.ours);
  }, [conflict.ours, conflict.path, onResolve]);

  const setResolvedContent = (next: string) => {
    setContent(next);
    onResolve(next);
  };

  return (
    <div className="space-y-3">
      <div className="rounded-xl border border-[rgb(var(--color-border))]/60 bg-[rgb(var(--color-surface))] p-3">
        <div className="mb-2 flex flex-wrap items-center gap-2">
          <div className="mr-auto">
            <div className="text-xs font-semibold text-[rgb(var(--color-text))]">{title}</div>
            <div className="text-[10px] text-[rgb(var(--color-text-secondary))]">Edit the combined result directly, then apply the merge.</div>
          </div>
          <button type="button" onClick={() => setResolvedContent(conflict.ours)} className="rounded-lg border border-[rgb(var(--color-border))]/70 px-2.5 py-1 text-[10px] text-[rgb(var(--color-text-secondary))] transition-colors hover:bg-[rgb(var(--color-surface-alt))] hover:text-[rgb(var(--color-text))]">
            Start current
          </button>
          <button type="button" onClick={() => setResolvedContent(conflict.theirs)} className="rounded-lg border border-[rgb(var(--color-border))]/70 px-2.5 py-1 text-[10px] text-[rgb(var(--color-text-secondary))] transition-colors hover:bg-[rgb(var(--color-surface-alt))] hover:text-[rgb(var(--color-text))]">
            Start incoming
          </button>
        </div>
        <textarea
          value={content}
          onChange={(event) => setResolvedContent(event.target.value)}
          spellCheck={conflict.file_type === "note"}
          className="h-64 w-full resize-y rounded-lg border border-[rgb(var(--color-border))] bg-[rgb(var(--color-surface-alt))] p-3 font-mono text-[11px] text-[rgb(var(--color-text))] outline-none focus:border-[rgb(var(--color-accent))]"
        />
      </div>
      <div className="grid gap-2 lg:grid-cols-2">
        <PreviewPanel label={`${targetLabel} (current)`} value={conflict.ours} active={false} />
        <PreviewPanel label={`${sourceLabel} (incoming)`} value={conflict.theirs} active={false} />
      </div>
    </div>
  );
}

export function buildSemanticFields(conflict: ConflictFile): SemanticField[] {
  if (conflict.file_type !== "sketch" && conflict.file_type !== "storyboard") return [];
  if (conflict.field_conflicts.length > 0) {
    return conflict.field_conflicts.map(fieldConflictToSemanticField);
  }

  const ours = parseJsonRecord(conflict.ours);
  const theirs = parseJsonRecord(conflict.theirs);
  const ancestor = parseJsonRecord(conflict.ancestor);
  if (!ours || !theirs) return [];

  if (conflict.file_type === "sketch") return buildSketchFields(ours, theirs, ancestor);
  return buildStoryboardFields(ours, theirs, ancestor);
}

export function buildSemanticResolvedJson(
  conflict: ConflictFile,
  fields: SemanticField[],
  choices: Record<string, SemanticResolution>,
): string {
  const base = parseJsonRecord(conflict.ours);
  if (!base) return conflict.ours;

  fields.forEach((field) => {
    const resolution = choices[field.path];
    if (!resolution || resolution.choice === "ours") return;
    const value = resolution.choice === "theirs" ? field.theirs : parseCustomValue(resolution.customValue ?? "", field.kind);
    setPathValue(base, field.path, value);
  });

  return JSON.stringify(base, null, 2);
}

export function buildSemanticResolvedText(
  conflict: ConflictFile,
  choices: Record<number, SemanticResolution>,
): string {
  const regions = conflict.text_conflicts
    .map((region, index) => ({ region, index }))
    .sort((left, right) => left.region.start_line - right.region.start_line);
  const allOurs = regions.every(({ index }) => choices[index]?.choice === "ours");
  if (allOurs) return conflict.ours;

  const allTheirs = regions.every(({ index }) => choices[index]?.choice === "theirs");
  if (allTheirs) return conflict.theirs;

  const ancestorLines = conflict.ancestor.split("\n");
  const result: string[] = [];
  let cursor = 0;

  regions.forEach(({ region, index }) => {
    while (cursor < region.start_line) {
      result.push(ancestorLines[cursor]);
      cursor++;
    }

    const resolution = choices[index];
    if (resolution?.choice === "theirs") {
      result.push(...region.theirs_lines);
    } else if (resolution?.choice === "custom") {
      result.push(...(resolution.customValue ?? "").split("\n"));
    } else {
      result.push(...region.ours_lines);
    }

    cursor += region.ancestor_lines.length;
  });

  while (cursor < ancestorLines.length) {
    result.push(ancestorLines[cursor]);
    cursor++;
  }

  return result.join("\n");
}

function buildSketchFields(ours: Record<string, unknown>, theirs: Record<string, unknown>, ancestor: Record<string, unknown> | null): SemanticField[] {
  const fields: SemanticField[] = [];
  addChangedField(fields, "title", "Title", "Sketch", ours.title, theirs.title, ancestor?.title, "text");
  addChangedField(fields, "description", "Description", "Sketch", ours.description, theirs.description, ancestor?.description, "text");
  addMetadataFields(fields, ours, theirs, ancestor);

  const oursRows = Array.isArray(ours.rows) ? ours.rows : [];
  const theirsRows = Array.isArray(theirs.rows) ? theirs.rows : [];
  const ancestorRows = ancestor && Array.isArray(ancestor.rows) ? ancestor.rows : [];
  if (rowStructureChanged(oursRows, theirsRows, ancestorRows)) {
    addChangedField(fields, "rows", "Planning table sequence", "Planning table", oursRows, theirsRows, ancestorRows, "json");
    return fields;
  }
  const rowCount = Math.max(oursRows.length, theirsRows.length);
  const rowFields = ["time", "duration_seconds", "narrative", "demo_actions", "screenshot", "visual", "design_plan"];
  for (let rowIndex = 0; rowIndex < rowCount; rowIndex++) {
    const oursRow = recordAt(oursRows, rowIndex);
    const theirsRow = recordAt(theirsRows, rowIndex);
    const ancestorRow = recordAt(ancestorRows, rowIndex);
    if (!oursRow || !theirsRow) {
      addChangedField(fields, `rows[${rowIndex}]`, `Row ${rowIndex + 1}`, "Planning table", oursRow, theirsRow, ancestorRow, "json");
      continue;
    }
    rowFields.forEach((key) => {
      addChangedField(fields, `rows[${rowIndex}].${key}`, `Row ${rowIndex + 1} · ${friendlyFieldLabel(key)}`, "Planning table", oursRow[key], theirsRow[key], ancestorRow?.[key], key === "visual" ? "json" : "text");
    });
  }
  return fields;
}

function buildStoryboardFields(ours: Record<string, unknown>, theirs: Record<string, unknown>, ancestor: Record<string, unknown> | null): SemanticField[] {
  const fields: SemanticField[] = [];
  addChangedField(fields, "title", "Title", "Storyboard", ours.title, theirs.title, ancestor?.title, "text");
  addChangedField(fields, "description", "Description", "Storyboard", ours.description, theirs.description, ancestor?.description, "text");
  addMetadataFields(fields, ours, theirs, ancestor);
  addChangedField(fields, "items", "Storyboard items", "Storyboard structure", ours.items, theirs.items, ancestor?.items, "json");
  addChangedField(fields, "sketches", "Sketches", "Storyboard structure", ours.sketches, theirs.sketches, ancestor?.sketches, "json");
  return fields;
}

function addMetadataFields(fields: SemanticField[], ours: Record<string, unknown>, theirs: Record<string, unknown>, ancestor: Record<string, unknown> | null) {
  const oursFields = metadataFields(ours.metadata);
  const theirsFields = metadataFields(theirs.metadata);
  const ancestorFields = metadataFields(ancestor?.metadata);
  const keys = new Set([...Object.keys(oursFields), ...Object.keys(theirsFields)]);
  keys.forEach((key) => {
    addChangedField(fields, `metadata.fields.${key}`, `Metadata · ${key}`, "Document fields", oursFields[key], theirsFields[key], ancestorFields[key], "text");
  });
}

function metadataFields(value: unknown): Record<string, unknown> {
  if (!isRecord(value) || !isRecord(value.fields)) return {};
  return value.fields;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === "object" && !Array.isArray(value);
}

function fieldConflictToSemanticField(field: FieldConflict): SemanticField {
  return {
    path: field.field_path,
    label: friendlyPath(field.field_path),
    group: field.field_path.startsWith("rows")
      ? "Planning table"
      : field.field_path === "items" || field.field_path === "sketches"
        ? "Storyboard structure"
        : "Document fields",
    ours: field.ours,
    theirs: field.theirs,
    ancestor: field.ancestor,
    kind: typeof field.ours === "string" || typeof field.theirs === "string" ? "text" : "json",
  };
}

function addChangedField(
  fields: SemanticField[],
  path: string,
  label: string,
  group: string,
  ours: unknown,
  theirs: unknown,
  ancestor: unknown,
  kind: SemanticField["kind"],
) {
  if (valuesEqual(ours, theirs)) return;
  fields.push({ path, label, group, ours, theirs, ancestor, kind });
}

function groupFields(fields: SemanticField[]): Record<string, SemanticField[]> {
  return fields.reduce<Record<string, SemanticField[]>>((groups, field) => {
    groups[field.group] ??= [];
    groups[field.group].push(field);
    return groups;
  }, {});
}

function parseJsonRecord(content: string): Record<string, unknown> | null {
  try {
    const parsed = JSON.parse(content);
    return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? parsed : null;
  } catch {
    return null;
  }
}

function recordAt(items: unknown[], index: number): Record<string, unknown> | undefined {
  const item = items[index];
  return item && typeof item === "object" && !Array.isArray(item) ? item as Record<string, unknown> : undefined;
}

function rowStructureChanged(oursRows: unknown[], theirsRows: unknown[], ancestorRows: unknown[]): boolean {
  if (oursRows.length !== theirsRows.length) return true;
  if (ancestorRows.length > 0 && (oursRows.length !== ancestorRows.length || theirsRows.length !== ancestorRows.length)) return true;
  if (isSameRowMultiset(oursRows, theirsRows) && !sameRowOrder(oursRows, theirsRows)) return true;
  if (ancestorRows.length === 0) return false;
  return (isSameRowMultiset(oursRows, ancestorRows) && !sameRowOrder(oursRows, ancestorRows))
    || (isSameRowMultiset(theirsRows, ancestorRows) && !sameRowOrder(theirsRows, ancestorRows));
}

function isSameRowMultiset(left: unknown[], right: unknown[]): boolean {
  if (left.length !== right.length) return false;
  const counts = new Map<string, number>();
  left.forEach((row) => counts.set(rowFingerprint(row), (counts.get(rowFingerprint(row)) ?? 0) + 1));
  for (const row of right) {
    const fingerprint = rowFingerprint(row);
    const count = counts.get(fingerprint) ?? 0;
    if (count === 0) return false;
    if (count === 1) counts.delete(fingerprint);
    else counts.set(fingerprint, count - 1);
  }
  return counts.size === 0;
}

function sameRowOrder(left: unknown[], right: unknown[]): boolean {
  return left.length === right.length
    && left.every((row, index) => rowFingerprint(row) === rowFingerprint(right[index]));
}

function rowFingerprint(row: unknown): string {
  return JSON.stringify(row ?? null);
}

function rowLabel(row: Record<string, unknown>): string {
  const time = valueToSingleLine(row.time);
  const narrative = valueToSingleLine(row.narrative);
  if (time && narrative) return `${time} - ${narrative}`;
  return narrative || time || "(empty row)";
}

function valueToSingleLine(value: unknown): string {
  if (value === undefined || value === null) return "";
  return String(value).replace(/\s+/g, " ").trim();
}

function storyboardPreviewItems(value: unknown): StoryboardPreviewItem[] {
  if (!Array.isArray(value)) return [];
  return value.map((item, index) => {
    if (typeof item === "string") {
      return {
        type: "sketch",
        title: item,
        sketches: [item],
        fingerprint: `sketch:${item}`,
      };
    }
    if (isRecord(item) && item.type === "section") {
      const sketches = Array.isArray(item.sketches)
        ? item.sketches.map((path) => String(path))
        : [];
      const title = valueToSingleLine(item.title) || `Section ${index + 1}`;
      return {
        type: "section",
        title,
        description: valueToSingleLine(item.description),
        sketches,
        fingerprint: `section:${title}:${JSON.stringify(sketches)}`,
      };
    }
    if (isRecord(item) && item.type === "sketch_ref") {
      const path = valueToSingleLine(item.path) || `Sketch ${index + 1}`;
      return {
        type: "sketch",
        title: path,
        sketches: [path],
        fingerprint: `sketch:${path}`,
      };
    }
    const title = `Item ${index + 1}`;
    return {
      type: "sketch",
      title,
      sketches: [],
      fingerprint: `${title}:${JSON.stringify(item)}`,
    };
  });
}

function parseCustomValue(value: string, kind: SemanticField["kind"]): unknown {
  if (kind === "text") return value;
  try {
    return JSON.parse(value);
  } catch {
    return value;
  }
}

function valueToEditable(value: unknown): string {
  return typeof value === "string" ? value : JSON.stringify(value, null, 2);
}

function formatDisplayValue(value: unknown): string {
  if (value === undefined) return "(missing)";
  if (value === null) return "(empty)";
  return valueToEditable(value);
}

function valuesEqual(left: unknown, right: unknown): boolean {
  return JSON.stringify(left) === JSON.stringify(right);
}

function changeSummary(field: SemanticField): string {
  const currentChanged = !valuesEqual(field.ancestor, field.ours);
  const incomingChanged = !valuesEqual(field.ancestor, field.theirs);
  if (currentChanged && incomingChanged) return "Current workspace and incoming both changed this field.";
  if (currentChanged) return "Only the current workspace changed this field.";
  if (incomingChanged) return "Only incoming changed this field.";
  return "Current workspace and incoming disagree on this field.";
}

function rowNumberFromPath(path: string): number {
  const match = path.match(/rows\[(\d+)\]/);
  return match ? Number(match[1]) + 1 : 1;
}

function commonPrefixLength(left: string, right: string): number {
  let index = 0;
  while (index < left.length && index < right.length && left[index] === right[index]) index++;
  return index;
}

function commonSuffixLength(left: string, right: string): number {
  let index = 0;
  while (
    index < left.length &&
    index < right.length &&
    left[left.length - 1 - index] === right[right.length - 1 - index]
  ) {
    index++;
  }
  return index;
}

function setPathValue(obj: Record<string, unknown>, path: string, value: unknown) {
  const parts = path.replace(/\[(\d+)\]/g, ".$1").split(".");
  let current: unknown = obj;
  for (let i = 0; i < parts.length - 1; i++) {
    if (!current || typeof current !== "object") return;
    const container = current as Record<string, unknown>;
    if (!container[parts[i]] || typeof container[parts[i]] !== "object") {
      container[parts[i]] = {};
    }
    current = container[parts[i]];
  }
  if (!current || typeof current !== "object") return;
  (current as Record<string, unknown>)[parts[parts.length - 1]] = value;
}

function friendlyPath(path: string): string {
  return path.replace(/\[(\d+)\]/g, ".$1").split(".").map((part) => {
    if (/^\d+$/.test(part)) return `Row ${Number(part) + 1}`;
    return friendlyFieldLabel(part);
  }).join(" · ");
}

function friendlyFieldLabel(key: string): string {
  const labels: Record<string, string> = {
    title: "Title",
    description: "Description",
    rows: "Planning table",
    sections: "Sections",
    sketches: "Sketches",
    time: "Time",
    duration_seconds: "Duration",
    metadata: "Metadata",
    fields: "Fields",
    narrative: "Narrative",
    demo_actions: "Actions",
    screenshot: "Screenshot",
    visual: "Visual",
    design_plan: "Visual plan",
  };
  return labels[key] ?? key.replace(/_/g, " ").replace(/\b\w/g, (letter) => letter.toUpperCase());
}
