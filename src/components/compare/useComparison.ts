import { useEffect, useState } from "react";
import {
  listComparedFiles,
  loadFileComparison,
  projectImageReader,
  type ComparedFile,
  type LoadedComparison,
} from "../../services/versionCompare";
import { useAppStore } from "../../stores/appStore";
import { draftlineToProjectPath } from "../../utils/draftlinePaths";
import { comparePaths, type CompareTarget } from "../../domain/compare/compareTarget";

type Load<T> = { state: "loading" } | { state: "error"; message: string } | { state: "ready"; value: T };

const message = (err: unknown) => (err instanceof Error ? err.message : String(err));

/** The files that differ between the target's two sides. */
export function useComparedFiles(target: CompareTarget): Load<ComparedFile[]> {
  const [result, setResult] = useState<Load<ComparedFile[]>>({ state: "loading" });
  const paths = comparePaths(target).join("\n");
  useEffect(() => {
    let cancelled = false;
    setResult({ state: "loading" });
    listComparedFiles(target.from, target.to, paths ? paths.split("\n") : [])
      .then((value) => { if (!cancelled) setResult({ state: "ready", value }); })
      .catch((err) => { if (!cancelled) setResult({ state: "error", message: message(err) }); });
    return () => { cancelled = true; };
  }, [target.from, target.to, paths]);
  return result;
}

/** One file's document-aware comparison, reloaded when the selection changes. */
export function useFileComparison(target: CompareTarget, file: ComparedFile | null): Load<LoadedComparison> | null {
  const project = useAppStore((s) => s.currentProject);
  const [result, setResult] = useState<Load<LoadedComparison>>({ state: "loading" });
  const aliases = comparePaths(target).join("\n");
  useEffect(() => {
    if (!file) return;
    let cancelled = false;
    setResult({ state: "loading" });
    const reader = projectImageReader((path) => draftlineToProjectPath(path, project));
    loadFileComparison(target.from, target.to, file, reader, aliases ? aliases.split("\n") : [])
      .then((value) => { if (!cancelled) setResult({ state: "ready", value }); })
      .catch((err) => { if (!cancelled) setResult({ state: "error", message: message(err) }); });
    return () => { cancelled = true; };
  }, [target.from, target.to, file, project, aliases]);
  return file ? result : null;
}
