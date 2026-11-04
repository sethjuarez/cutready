import { useCallback, useEffect, useRef, useState } from "react";
import type { ChangeSummary } from "../../domain/changes";
import { applySuggestion, type VersionSuggestion } from "../../domain/versioning";

export interface SuggestFields {
  name: string;
  comment: string;
}

export interface VersionSuggestDeps {
  isConfigured: () => Promise<boolean>;
  suggest: (summary: ChangeSummary) => Promise<VersionSuggestion | null>;
  getSummary: () => ChangeSummary | null;
  isOnline: () => boolean;
}

export type SuggestStatus = "idle" | "running" | "failed";

/**
 * ✨ Suggest for the Version form: runs only on click, ignores stale replies
 * (a newer click or Esc wins), fills empty fields, and holds a suggestion for
 * a "Replace?" confirmation when the user has typed.
 */
export function useVersionSuggest(
  fields: SuggestFields,
  setFields: (fields: SuggestFields) => void,
  deps: VersionSuggestDeps,
) {
  const [configured, setConfigured] = useState(false);
  const [status, setStatus] = useState<SuggestStatus>("idle");
  const [pending, setPending] = useState<SuggestFields | null>(null);
  const generation = useRef(0);
  const lastSuggested = useRef<SuggestFields | null>(null);
  const depsRef = useRef(deps);
  depsRef.current = deps;
  const fieldsRef = useRef(fields);
  fieldsRef.current = fields;

  useEffect(() => {
    let live = true;
    void depsRef.current.isConfigured().then((ok) => {
      if (live) setConfigured(ok);
    });
    return () => {
      live = false;
      generation.current++;
    };
  }, []);

  const fill = useCallback((next: SuggestFields) => {
    lastSuggested.current = next;
    setFields(next);
  }, [setFields]);

  const run = useCallback(async () => {
    const summary = depsRef.current.getSummary();
    if (!summary) return;
    const summaryKey = JSON.stringify(summary);
    const current = ++generation.current;
    setPending(null);
    setStatus("running");
    try {
      const suggestion = await depsRef.current.suggest(summary);
      if (current !== generation.current) return;
      // The changes moved on while the model was thinking; this name describes old work.
      const latest = depsRef.current.getSummary();
      if (!latest || JSON.stringify(latest) !== summaryKey) {
        setStatus("idle");
        return;
      }
      if (!suggestion) {
        setStatus("failed");
        return;
      }
      setStatus("idle");
      const result = applySuggestion(fieldsRef.current, suggestion, lastSuggested.current);
      const next = { name: result.name, comment: result.comment };
      if (result.kind === "fill") fill(next);
      else setPending(next);
    } catch (err) {
      if (current !== generation.current) return;
      console.warn("Version suggestion failed:", err);
      setStatus("failed");
    }
  }, [fill]);

  /** Cancels a running suggestion; returns whether there was one. */
  const cancel = useCallback(() => {
    if (status !== "running") return false;
    generation.current++;
    setStatus("idle");
    return true;
  }, [status]);

  const confirmReplace = useCallback(() => {
    if (pending) fill(pending);
    setPending(null);
  }, [fill, pending]);

  const online = deps.isOnline();
  const disabledReason = !configured
    ? "Connect a model in Settings to suggest names"
    : !online
      ? "Suggestions need a connection"
      : null;

  return {
    run,
    cancel,
    status,
    pending,
    confirmReplace,
    keepMine: () => setPending(null),
    disabledReason,
  };
}
