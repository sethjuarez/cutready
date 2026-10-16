import { useCallback, useEffect, useRef, useState } from "react";
import { getContributorIdentity, type ResolvedIdentity } from "../services/identity";

/** Loads the acting identity whenever `enabled` becomes true. */
export function useContributorIdentity(enabled = true) {
  const [identity, setResolvedIdentity] = useState<ResolvedIdentity | null>(null);
  const [error, setError] = useState<string | null>(null);
  // Bumped on close and on explicit sets so a stale load can't land afterwards.
  const generation = useRef(0);

  useEffect(() => {
    if (!enabled) return;
    const request = ++generation.current;
    const isCurrent = () => generation.current === request;
    getContributorIdentity()
      .then((resolved) => {
        if (isCurrent()) setResolvedIdentity(resolved);
      })
      .catch((err) => {
        if (isCurrent()) setError(errorText(err));
      });
    return () => {
      generation.current++;
      // Drop the identity when closing so a reopen never acts on a stale one.
      setResolvedIdentity(null);
      setError(null);
    };
  }, [enabled]);

  // A freshly saved identity supersedes any earlier or in-flight load.
  const setIdentity = useCallback((next: ResolvedIdentity) => {
    generation.current++;
    setError(null);
    setResolvedIdentity(next);
  }, []);

  const loading = enabled && identity === null && error === null;
  return { identity, setIdentity, error, loading };
}

function errorText(err: unknown) {
  if (err instanceof Error) return err.message;
  return typeof err === "string" ? err : String(err);
}
