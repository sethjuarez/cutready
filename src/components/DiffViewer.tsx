import { useEffect, useMemo, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { Columns2, Rows2 } from "lucide-react";

interface FileDiffContent {
  path: string;
  head_content: string | null;
  working_content: string | null;
}

interface DiffLine {
  type: "context" | "added" | "removed";
  oldNum: number | null;
  newNum: number | null;
  text: string;
}

type ViewMode = "split" | "unified";

function computeDiffLines(oldText: string, newText: string): DiffLine[] {
  const oldLines = oldText.split("\n");
  const newLines = newText.split("\n");
  const m = oldLines.length;
  const n = newLines.length;

  // For very large files, show simple before/after
  if (m + n > 5000) {
    const lines: DiffLine[] = [];
    oldLines.forEach((text, i) => lines.push({ type: "removed", oldNum: i + 1, newNum: null, text }));
    newLines.forEach((text, i) => lines.push({ type: "added", oldNum: null, newNum: i + 1, text }));
    return lines;
  }

  // LCS-based diff
  const dp: number[][] = Array.from({ length: m + 1 }, () => Array(n + 1).fill(0));
  for (let i = 1; i <= m; i++) {
    for (let j = 1; j <= n; j++) {
      dp[i][j] = oldLines[i - 1] === newLines[j - 1] ? dp[i - 1][j - 1] + 1 : Math.max(dp[i - 1][j], dp[i][j - 1]);
    }
  }

  const result: DiffLine[] = [];
  let i = m, j = n;
  while (i > 0 || j > 0) {
    if (i > 0 && j > 0 && oldLines[i - 1] === newLines[j - 1]) {
      result.push({ type: "context", oldNum: i, newNum: j, text: oldLines[i - 1] });
      i--; j--;
    } else if (j > 0 && (i === 0 || dp[i][j - 1] >= dp[i - 1][j])) {
      result.push({ type: "added", oldNum: null, newNum: j, text: newLines[j - 1] });
      j--;
    } else {
      result.push({ type: "removed", oldNum: i, newNum: null, text: oldLines[i - 1] });
      i--;
    }
  }
  result.reverse();
  return result;
}

/** Group diff lines into hunks with context lines around changes */
function groupIntoHunks(lines: DiffLine[], contextSize = 3): DiffLine[][] {
  const hunks: DiffLine[][] = [];
  let currentHunk: DiffLine[] = [];
  let contextAfter = 0;
  let inChange = false;

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    if (line.type !== "context") {
      // If we haven't started a hunk, grab preceding context
      if (!inChange && currentHunk.length === 0) {
        const start = Math.max(0, i - contextSize);
        for (let k = start; k < i; k++) currentHunk.push(lines[k]);
      }
      currentHunk.push(line);
      inChange = true;
      contextAfter = 0;
    } else {
      if (inChange) {
        contextAfter++;
        currentHunk.push(line);
        if (contextAfter >= contextSize) {
          // Check if next change is close enough to merge
          const nextChange = lines.slice(i + 1, i + 1 + contextSize + 1).findIndex(l => l.type !== "context");
          if (nextChange === -1 || nextChange > contextSize) {
            hunks.push(currentHunk);
            currentHunk = [];
            inChange = false;
            contextAfter = 0;
          }
        }
      }
    }
  }
  if (currentHunk.length > 0) hunks.push(currentHunk);
  // If no changes at all, return all as one hunk
  if (hunks.length === 0 && lines.length > 0) hunks.push(lines.slice(0, Math.min(10, lines.length)));
  return hunks;
}

export function DiffViewer({ filePath }: { filePath: string }) {
  const [diff, setDiff] = useState<FileDiffContent | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [viewMode, setViewMode] = useState<ViewMode>("split");

  useEffect(() => {
    setLoading(true);
    setError(null);
    invoke<FileDiffContent>("get_file_diff_content", { filePath })
      .then(setDiff)
      .catch((e) => setError(String(e)))
      .finally(() => setLoading(false));
  }, [filePath]);

  if (loading) {
    return (
      <div className="flex h-full items-center justify-center text-[rgb(var(--color-text-secondary))]">
        <span className="text-sm">Loading diff…</span>
      </div>
    );
  }

  if (error) {
    return (
      <div className="flex h-full items-center justify-center text-error">
        <span className="text-sm">{error}</span>
      </div>
    );
  }

  if (!diff) return null;

  const filename = filePath.split("/").pop() ?? filePath;
  const isNew = diff.head_content === null;
  const isDeleted = diff.working_content === null;
  const oldText = diff.head_content ?? "";
  const newText = diff.working_content ?? "";
  const isStructured = filePath.endsWith(".sk") || filePath.endsWith(".sb");

  // For .sk/.sb files, show a semantic field-level diff
  if (isStructured) {
    return (
      <div className="flex h-full flex-col bg-[rgb(var(--color-surface))]">
        <DiffToolbar
          filename={filename}
          status={isNew ? "added" : isDeleted ? "deleted" : "modified"}
          viewMode={viewMode}
          onViewModeChange={setViewMode}
          showToggle={false}
        />
        <div className="flex-1 overflow-auto p-4">
          <StructuredDiff oldJson={oldText} newJson={newText} isNew={isNew} />
        </div>
      </div>
    );
  }

  const status = isNew ? "added" : isDeleted ? "deleted" : "modified";

  return (
    <div className="flex h-full flex-col bg-[rgb(var(--color-surface))]">
      <DiffToolbar
        filename={filename}
        status={status}
        viewMode={viewMode}
        onViewModeChange={setViewMode}
        showToggle={!isNew && !isDeleted}
        additions={newText.split("\n").length - (isNew ? 0 : oldText.split("\n").length)}
      />
      <div className="flex-1 overflow-auto">
        {isNew ? (
          <NewFileView text={newText} />
        ) : isDeleted ? (
          <DeletedFileView text={oldText} />
        ) : viewMode === "split" ? (
          <SplitDiffView oldText={oldText} newText={newText} />
        ) : (
          <UnifiedDiffView oldText={oldText} newText={newText} />
        )}
      </div>
    </div>
  );
}

// --- Toolbar ---

function DiffToolbar({ filename, status, viewMode, onViewModeChange, showToggle, additions }: {
  filename: string;
  status: "added" | "deleted" | "modified";
  viewMode: ViewMode;
  onViewModeChange: (mode: ViewMode) => void;
  showToggle: boolean;
  additions?: number;
}) {
  const badge = status === "added" ? { label: "New file", cls: "bg-success/15 text-success" } :
                status === "deleted" ? { label: "Deleted", cls: "bg-error/15 text-error" } :
                { label: "Modified", cls: "bg-warning/15 text-warning" };
  return (
    <div className="flex items-center gap-3 border-b border-[rgb(var(--color-border))] px-4 py-2 bg-[rgb(var(--color-surface-inset))]">
      <span className="font-mono text-[12px] font-medium text-[rgb(var(--color-text))]">{filename}</span>
      <span className={`rounded px-1.5 py-0.5 text-[10px] font-medium ${badge.cls}`}>{badge.label}</span>
      {additions !== undefined && additions !== 0 && (
        <span className={`text-[10px] ${additions > 0 ? "text-success" : "text-error"}`}>
          {additions > 0 ? `+${additions}` : additions} lines
        </span>
      )}
      <div className="flex-1" />
      {showToggle && (
        <div className="flex items-center rounded-md border border-[rgb(var(--color-border))] overflow-hidden">
          <button
            onClick={() => onViewModeChange("split")}
            className={`flex items-center gap-1 px-2 py-1 text-[10px] transition-colors ${
              viewMode === "split"
                ? "bg-[rgb(var(--color-accent))]/15 text-[rgb(var(--color-accent))]"
                : "text-[rgb(var(--color-text-secondary))] hover:text-[rgb(var(--color-text))]"
            }`}
            title="Side by side"
          >
            <Columns2 className="w-3 h-3" />
            Split
          </button>
          <button
            onClick={() => onViewModeChange("unified")}
            className={`flex items-center gap-1 px-2 py-1 text-[10px] border-l border-[rgb(var(--color-border))] transition-colors ${
              viewMode === "unified"
                ? "bg-[rgb(var(--color-accent))]/15 text-[rgb(var(--color-accent))]"
                : "text-[rgb(var(--color-text-secondary))] hover:text-[rgb(var(--color-text))]"
            }`}
            title="Unified"
          >
            <Rows2 className="w-3 h-3" />
            Unified
          </button>
        </div>
      )}
    </div>
  );
}

// --- Split (side-by-side) view ---

function SplitDiffView({ oldText, newText }: { oldText: string; newText: string }) {
  const diffLines = useMemo(() => computeDiffLines(oldText, newText), [oldText, newText]);
  const hunks = useMemo(() => groupIntoHunks(diffLines), [diffLines]);

  // Build left (old) and right (new) line pairs for side-by-side display
  const pairs = useMemo(() => {
    const result: { left: DiffLine | null; right: DiffLine | null }[] = [];
    for (const hunk of hunks) {
      // Collect removals and additions in sequence, pair them
      let i = 0;
      while (i < hunk.length) {
        const line = hunk[i];
        if (line.type === "context") {
          result.push({ left: line, right: line });
          i++;
        } else if (line.type === "removed") {
          // Collect consecutive removals
          const removals: DiffLine[] = [];
          while (i < hunk.length && hunk[i].type === "removed") {
            removals.push(hunk[i]);
            i++;
          }
          // Collect consecutive additions after
          const additions: DiffLine[] = [];
          while (i < hunk.length && hunk[i].type === "added") {
            additions.push(hunk[i]);
            i++;
          }
          // Pair them up
          const maxLen = Math.max(removals.length, additions.length);
          for (let k = 0; k < maxLen; k++) {
            result.push({
              left: k < removals.length ? removals[k] : null,
              right: k < additions.length ? additions[k] : null,
            });
          }
        } else if (line.type === "added") {
          result.push({ left: null, right: line });
          i++;
        }
      }
      // Add separator between hunks
      result.push({ left: { type: "context", oldNum: null, newNum: null, text: "⋯" }, right: { type: "context", oldNum: null, newNum: null, text: "⋯" } });
    }
    // Remove trailing separator
    if (result.length > 0 && result[result.length - 1].left?.text === "⋯") result.pop();
    return result;
  }, [hunks]);

  return (
    <div className="font-mono text-[12px] leading-5 min-w-fit">
      {/* Header row */}
      <div className="flex sticky top-0 z-10 border-b border-[rgb(var(--color-border))] bg-[rgb(var(--color-surface-inset))]">
        <div className="flex-1 px-3 py-1 text-[10px] font-medium text-[rgb(var(--color-text-secondary))] uppercase tracking-wider border-r border-[rgb(var(--color-border))]">
          Last Snapshot
        </div>
        <div className="flex-1 px-3 py-1 text-[10px] font-medium text-[rgb(var(--color-text-secondary))] uppercase tracking-wider">
          Working Copy
        </div>
      </div>
      {pairs.map((pair, i) => {
        const isSeparator = pair.left?.text === "⋯" && pair.left?.oldNum === null;
        if (isSeparator) {
          return (
            <div key={i} className="flex border-y border-[rgb(var(--color-border))]/50 bg-[rgb(var(--color-surface-inset))]">
              <div className="flex-1 px-3 py-0.5 text-center text-[10px] text-[rgb(var(--color-text-secondary))]/50 border-r border-[rgb(var(--color-border))]/50">⋯</div>
              <div className="flex-1 px-3 py-0.5 text-center text-[10px] text-[rgb(var(--color-text-secondary))]/50">⋯</div>
            </div>
          );
        }
        return (
          <div key={i} className="flex">
            <SplitLine line={pair.left} side="left" />
            <SplitLine line={pair.right} side="right" />
          </div>
        );
      })}
    </div>
  );
}

function SplitLine({ line, side }: { line: DiffLine | null; side: "left" | "right" }) {
  const borderCls = side === "left" ? "border-r border-[rgb(var(--color-border))]/50" : "";
  if (!line) {
    return <div className={`flex-1 ${borderCls} bg-[rgb(var(--color-surface-inset))]/50`}>&nbsp;</div>;
  }
  const bgCls = line.type === "removed" ? "bg-error/8" :
                line.type === "added" ? "bg-success/8" : "";
  const hoverCls = line.type === "removed" ? "hover:bg-error/12" :
                   line.type === "added" ? "hover:bg-success/12" :
                   "hover:bg-[rgb(var(--color-surface-alt))]";
  const num = side === "left" ? line.oldNum : line.newNum;

  return (
    <div className={`flex-1 flex min-w-0 ${bgCls} ${hoverCls} ${borderCls}`}>
      <span className="inline-block w-10 shrink-0 select-none pr-2 text-right text-[10px] text-[rgb(var(--color-text-secondary))]/40 border-r border-[rgb(var(--color-border))]/20 leading-5">
        {num ?? ""}
      </span>
      <span className="flex-1 px-2 whitespace-pre overflow-hidden text-ellipsis text-[rgb(var(--color-text))] leading-5">
        {line.text}
      </span>
    </div>
  );
}

// --- Unified view ---

function UnifiedDiffView({ oldText, newText }: { oldText: string; newText: string }) {
  const diffLines = useMemo(() => computeDiffLines(oldText, newText), [oldText, newText]);
  const hunks = useMemo(() => groupIntoHunks(diffLines), [diffLines]);

  return (
    <div className="font-mono text-[12px] leading-5 min-w-fit">
      {hunks.map((hunk, hi) => (
        <div key={hi}>
          {hi > 0 && (
            <div className="flex border-y border-[rgb(var(--color-border))]/50 bg-[rgb(var(--color-surface-inset))]">
              <span className="w-10 shrink-0" /><span className="w-10 shrink-0" />
              <span className="px-2 py-0.5 text-[10px] text-[rgb(var(--color-text-secondary))]/50">⋯</span>
            </div>
          )}
          {hunk.map((line, li) => (
            <div
              key={`${hi}-${li}`}
              className={`flex ${
                line.type === "added" ? "bg-success/8 hover:bg-success/12" :
                line.type === "removed" ? "bg-error/8 hover:bg-error/12" :
                "hover:bg-[rgb(var(--color-surface-alt))]"
              }`}
            >
              <span className="inline-block w-10 shrink-0 select-none pr-2 text-right text-[10px] text-[rgb(var(--color-text-secondary))]/40 border-r border-[rgb(var(--color-border))]/20">
                {line.oldNum ?? ""}
              </span>
              <span className="inline-block w-10 shrink-0 select-none pr-2 text-right text-[10px] text-[rgb(var(--color-text-secondary))]/40 border-r border-[rgb(var(--color-border))]/20">
                {line.newNum ?? ""}
              </span>
              <span className="flex-1 px-2 whitespace-pre text-[rgb(var(--color-text))]">
                <span className={`mr-1 select-none ${
                  line.type === "added" ? "text-success" :
                  line.type === "removed" ? "text-error" :
                  "text-transparent"
                }`}>
                  {line.type === "added" ? "+" : line.type === "removed" ? "−" : " "}
                </span>
                {line.text}
              </span>
            </div>
          ))}
        </div>
      ))}
    </div>
  );
}

// --- New / Deleted file views ---

function NewFileView({ text }: { text: string }) {
  const lines = text.split("\n");
  return (
    <div className="font-mono text-[12px] leading-5 min-w-fit">
      {lines.map((line, i) => (
        <div key={i} className="flex bg-success/6 hover:bg-success/10">
          <span className="inline-block w-10 shrink-0 select-none pr-2 text-right text-[10px] text-[rgb(var(--color-text-secondary))]/40 border-r border-[rgb(var(--color-border))]/20">
            {i + 1}
          </span>
          <span className="flex-1 px-2 whitespace-pre text-[rgb(var(--color-text))]">
            <span className="mr-1 select-none text-success">+</span>{line}
          </span>
        </div>
      ))}
    </div>
  );
}

function DeletedFileView({ text }: { text: string }) {
  const lines = text.split("\n");
  return (
    <div className="font-mono text-[12px] leading-5 min-w-fit">
      {lines.map((line, i) => (
        <div key={i} className="flex bg-error/6 hover:bg-error/10">
          <span className="inline-block w-10 shrink-0 select-none pr-2 text-right text-[10px] text-[rgb(var(--color-text-secondary))]/40 border-r border-[rgb(var(--color-border))]/20">
            {i + 1}
          </span>
          <span className="flex-1 px-2 whitespace-pre text-[rgb(var(--color-text))]">
            <span className="mr-1 select-none text-error">−</span>{line}
          </span>
        </div>
      ))}
    </div>
  );
}

// --- Structured diff for .sk / .sb files ---

interface FieldChange {
  path: string;
  type: "changed" | "added" | "removed";
  oldValue?: string;
  newValue?: string;
}

function collectChanges(oldObj: unknown, newObj: unknown, path: string = ""): FieldChange[] {
  const changes: FieldChange[] = [];

  if (oldObj === newObj) return changes;
  if (oldObj === null || oldObj === undefined) {
    changes.push({ path: path || "(root)", type: "added", newValue: summarize(newObj) });
    return changes;
  }
  if (newObj === null || newObj === undefined) {
    changes.push({ path: path || "(root)", type: "removed", oldValue: summarize(oldObj) });
    return changes;
  }

  if (Array.isArray(oldObj) && Array.isArray(newObj)) {
    const maxLen = Math.max(oldObj.length, newObj.length);
    for (let i = 0; i < maxLen; i++) {
      const childPath = `${path}[${i}]`;
      if (i >= oldObj.length) {
        changes.push({ path: childPath, type: "added", newValue: summarize(newObj[i]) });
      } else if (i >= newObj.length) {
        changes.push({ path: childPath, type: "removed", oldValue: summarize(oldObj[i]) });
      } else {
        changes.push(...collectChanges(oldObj[i], newObj[i], childPath));
      }
    }
    return changes;
  }

  if (typeof oldObj === "object" && typeof newObj === "object" && oldObj !== null && newObj !== null) {
    const allKeys = new Set([...Object.keys(oldObj as Record<string, unknown>), ...Object.keys(newObj as Record<string, unknown>)]);
    for (const key of allKeys) {
      const childPath = path ? `${path}.${key}` : key;
      const oldVal = (oldObj as Record<string, unknown>)[key];
      const newVal = (newObj as Record<string, unknown>)[key];
      if (oldVal === undefined) {
        changes.push({ path: childPath, type: "added", newValue: summarize(newVal) });
      } else if (newVal === undefined) {
        changes.push({ path: childPath, type: "removed", oldValue: summarize(oldVal) });
      } else {
        changes.push(...collectChanges(oldVal, newVal, childPath));
      }
    }
    return changes;
  }

  // Primitive change
  if (oldObj !== newObj) {
    changes.push({ path: path || "(root)", type: "changed", oldValue: summarize(oldObj), newValue: summarize(newObj) });
  }
  return changes;
}

function summarize(val: unknown): string {
  if (val === null || val === undefined) return "null";
  if (typeof val === "string") return val.length > 80 ? `"${val.slice(0, 77)}…"` : `"${val}"`;
  if (typeof val === "number" || typeof val === "boolean") return String(val);
  if (Array.isArray(val)) return `[${val.length} item${val.length !== 1 ? "s" : ""}]`;
  if (typeof val === "object") {
    const keys = Object.keys(val);
    return `{${keys.slice(0, 3).join(", ")}${keys.length > 3 ? ", …" : ""}}`;
  }
  return String(val);
}

function humanizePath(path: string): string {
  return path
    .replace(/^rows\[(\d+)\]/, (_, i) => `Row ${+i + 1}`)
    .replace(/\.narrative$/, " → Narrative")
    .replace(/\.actions$/, " → Actions")
    .replace(/\.time$/, " → Time")
    .replace(/\.screenshot$/, " → Screenshot")
    .replace(/\.visual$/, " → Visual")
    .replace(/^title$/, "Title")
    .replace(/^description$/, "Description")
    .replace(/^items\[(\d+)\]/, (_, i) => `Item ${+i + 1}`)
    .replace(/^state$/, "State");
}

function StructuredDiff({ oldJson, newJson, isNew }: { oldJson: string; newJson: string; isNew?: boolean }) {
  let oldObj: unknown = null;
  let newObj: unknown;
  if (!isNew) {
    try { oldObj = JSON.parse(oldJson); } catch { return <FallbackMessage msg="Could not parse previous version" />; }
  }
  try { newObj = JSON.parse(newJson); } catch { return <FallbackMessage msg="Could not parse current version" />; }

  const changes = collectChanges(oldObj, newObj);

  if (changes.length === 0) {
    return (
      <div className="flex items-center justify-center py-8 text-[rgb(var(--color-text-secondary))] text-sm">
        No differences found
      </div>
    );
  }

  return (
    <div className="space-y-1.5">
      <div className="mb-3 text-[11px] text-[rgb(var(--color-text-secondary))]">
        {changes.length} field{changes.length !== 1 ? "s" : ""} {isNew ? "in new file" : "changed"}
      </div>
      {changes.map((change, i) => (
        <div key={i} className={`rounded-md border px-3 py-2 text-[12px] ${
          change.type === "added" ? "border-success/30 bg-success/5" :
          change.type === "removed" ? "border-error/30 bg-error/5" :
          "border-warning/30 bg-warning/5"
        }`}>
          <div className="flex items-center gap-2 mb-1">
            <span className={`inline-block w-1.5 h-1.5 rounded-full ${
              change.type === "added" ? "bg-success" :
              change.type === "removed" ? "bg-error" :
              "bg-warning"
            }`} />
            <span className="font-medium text-[rgb(var(--color-text))]">{humanizePath(change.path)}</span>
            <span className={`text-[10px] ${
              change.type === "added" ? "text-success" :
              change.type === "removed" ? "text-error" :
              "text-warning"
            }`}>
              {change.type}
            </span>
          </div>
          {change.type === "changed" && (
            <div className="ml-3.5 space-y-0.5">
              <div className="flex items-start gap-2">
                <span className="shrink-0 text-[10px] text-error font-medium">−</span>
                <span className="text-[rgb(var(--color-text-secondary))] break-all">{change.oldValue}</span>
              </div>
              <div className="flex items-start gap-2">
                <span className="shrink-0 text-[10px] text-success font-medium">+</span>
                <span className="text-[rgb(var(--color-text))] break-all">{change.newValue}</span>
              </div>
            </div>
          )}
          {change.type === "added" && change.newValue && (
            <div className="ml-3.5 text-[rgb(var(--color-text))] break-all">{change.newValue}</div>
          )}
          {change.type === "removed" && change.oldValue && (
            <div className="ml-3.5 text-[rgb(var(--color-text-secondary))] break-all line-through">{change.oldValue}</div>
          )}
        </div>
      ))}
    </div>
  );
}

function FallbackMessage({ msg }: { msg: string }) {
  return (
    <div className="flex items-center justify-center py-8 text-[rgb(var(--color-text-secondary))] text-sm">
      {msg}
    </div>
  );
}

