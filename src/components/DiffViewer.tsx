import { useEffect, useState } from "react";
import { invoke } from "@tauri-apps/api/core";

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

function computeUnifiedDiff(oldText: string, newText: string): DiffLine[] {
  const oldLines = oldText.split("\n");
  const newLines = newText.split("\n");

  // Simple LCS-based diff
  const m = oldLines.length;
  const n = newLines.length;

  // For very large files, fall back to showing both sides
  if (m + n > 5000) {
    const lines: DiffLine[] = [];
    oldLines.forEach((text, i) => lines.push({ type: "removed", oldNum: i + 1, newNum: null, text }));
    newLines.forEach((text, i) => lines.push({ type: "added", oldNum: null, newNum: i + 1, text }));
    return lines;
  }

  // Build LCS table
  const dp: number[][] = Array.from({ length: m + 1 }, () => Array(n + 1).fill(0));
  for (let i = 1; i <= m; i++) {
    for (let j = 1; j <= n; j++) {
      dp[i][j] = oldLines[i - 1] === newLines[j - 1] ? dp[i - 1][j - 1] + 1 : Math.max(dp[i - 1][j], dp[i][j - 1]);
    }
  }

  // Backtrack to build diff
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

export function DiffViewer({ filePath }: { filePath: string }) {
  const [diff, setDiff] = useState<FileDiffContent | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

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

  if (isNew) {
    // New file — just show all lines as added
    const lines = newText.split("\n");
    return (
      <div className="flex h-full flex-col bg-[rgb(var(--color-surface))]">
        <DiffHeader filename={filename} status="added" />
        <div className="flex-1 overflow-auto font-mono text-[12px] leading-5">
          {lines.map((line, i) => (
            <div key={i} className="flex bg-success/8 hover:bg-success/12">
              <LineNum num={null} />
              <LineNum num={i + 1} />
              <span className="flex-1 px-2 text-[rgb(var(--color-text))]">
                <span className="mr-2 select-none text-success">+</span>{line}
              </span>
            </div>
          ))}
        </div>
      </div>
    );
  }

  if (isDeleted) {
    const lines = oldText.split("\n");
    return (
      <div className="flex h-full flex-col bg-[rgb(var(--color-surface))]">
        <DiffHeader filename={filename} status="deleted" />
        <div className="flex-1 overflow-auto font-mono text-[12px] leading-5">
          {lines.map((line, i) => (
            <div key={i} className="flex bg-error/8 hover:bg-error/12">
              <LineNum num={i + 1} />
              <LineNum num={null} />
              <span className="flex-1 px-2 text-[rgb(var(--color-text))]">
                <span className="mr-2 select-none text-error">-</span>{line}
              </span>
            </div>
          ))}
        </div>
      </div>
    );
  }

  // Modified file — unified diff
  const diffLines = computeUnifiedDiff(oldText, newText);

  return (
    <div className="flex h-full flex-col bg-[rgb(var(--color-surface))]">
      <DiffHeader filename={filename} status="modified" />
      <div className="flex-1 overflow-auto font-mono text-[12px] leading-5">
        {diffLines.map((line, i) => (
          <div
            key={i}
            className={`flex ${
              line.type === "added" ? "bg-success/8 hover:bg-success/12" :
              line.type === "removed" ? "bg-error/8 hover:bg-error/12" :
              "hover:bg-[rgb(var(--color-surface-alt))]"
            }`}
          >
            <LineNum num={line.oldNum} dimmed={line.type === "added"} />
            <LineNum num={line.newNum} dimmed={line.type === "removed"} />
            <span className="flex-1 px-2 text-[rgb(var(--color-text))]">
              <span className={`mr-2 select-none ${
                line.type === "added" ? "text-success" :
                line.type === "removed" ? "text-error" :
                "text-transparent"
              }`}>
                {line.type === "added" ? "+" : line.type === "removed" ? "-" : " "}
              </span>
              {line.text}
            </span>
          </div>
        ))}
      </div>
    </div>
  );
}

function DiffHeader({ filename, status }: { filename: string; status: "added" | "deleted" | "modified" }) {
  const badge = status === "added" ? { label: "New", cls: "bg-success/15 text-success" } :
                status === "deleted" ? { label: "Deleted", cls: "bg-error/15 text-error" } :
                { label: "Modified", cls: "bg-warning/15 text-warning" };
  return (
    <div className="flex items-center gap-2 border-b border-[rgb(var(--color-border))] px-4 py-2">
      <span className="font-mono text-[12px] font-medium text-[rgb(var(--color-text))]">{filename}</span>
      <span className={`rounded px-1.5 py-0.5 text-[10px] font-medium ${badge.cls}`}>{badge.label}</span>
    </div>
  );
}

function LineNum({ num, dimmed }: { num: number | null; dimmed?: boolean }) {
  return (
    <span className={`inline-block w-10 shrink-0 select-none border-r border-[rgb(var(--color-border))]/30 pr-2 text-right text-[10px] ${
      dimmed ? "text-transparent" : "text-[rgb(var(--color-text-secondary))]/50"
    }`}>
      {num ?? ""}
    </span>
  );
}
