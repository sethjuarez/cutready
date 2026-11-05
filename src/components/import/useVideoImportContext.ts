// State for the "planning context" step a video import asks for before it runs.
import { useCallback, useMemo, useRef, useState } from "react";
import type { VideoImportPlanningContext, VideoImportPlanningContextReference } from "../../ipc/workspace";
import { useAppStore } from "../../stores/appStore";
import { applySidebarOrder } from "../../utils/sidebarOrder";
import { extractMentionKeys, mentionKey } from "./VideoImportDialogs";

export function useVideoImportContext() {
  const storyboards = useAppStore((s) => s.storyboards);
  const sketches = useAppStore((s) => s.sketches);
  const notes = useAppStore((s) => s.notes);
  const sidebarOrder = useAppStore((s) => s.sidebarOrder);
  const [open, setOpen] = useState(false);
  const [text, setText] = useState("");
  const resolverRef = useRef<((context: VideoImportPlanningContext | null) => void) | null>(null);

  const references = useMemo<VideoImportPlanningContextReference[]>(() => [
    ...applySidebarOrder(storyboards, sidebarOrder?.storyboards ?? []).map((s) => ({ kind: "storyboard" as const, path: s.path, title: s.title })),
    ...applySidebarOrder(sketches, sidebarOrder?.sketches ?? []).map((s) => ({ kind: "sketch" as const, path: s.path, title: s.title })),
    ...applySidebarOrder(notes, sidebarOrder?.notes ?? []).map((n) => ({ kind: "note" as const, path: n.path, title: n.title })),
  ], [storyboards, sketches, notes, sidebarOrder]);

  const settle = useCallback((context: VideoImportPlanningContext | null) => {
    resolverRef.current?.(context);
    resolverRef.current = null;
    setText("");
    setOpen(false);
  }, []);

  /** Opens the dialog; resolves the context, or null if the user cancels. */
  const request = useCallback(() => {
    setOpen(true);
    return new Promise<VideoImportPlanningContext | null>((resolve) => {
      resolverRef.current = resolve;
    });
  }, []);

  const proceed = useCallback(() => {
    const keys = extractMentionKeys(text);
    const mentioned = references.filter((reference) =>
      [mentionKey(reference.title), mentionKey(reference.path), mentionKey(reference.path.split("/").pop() ?? reference.path)]
        .some((key) => key && keys.has(key)));
    settle({ text: text.trim(), references: mentioned });
  }, [references, settle, text]);

  const insertMention = useCallback((reference: VideoImportPlanningContextReference) => {
    const mention = `@${mentionKey(reference.title || reference.path)}`;
    setText((current) => {
      if (current.includes(mention)) return current;
      const prefix = current.trimEnd();
      return `${prefix}${prefix ? " " : ""}${mention} `;
    });
  }, []);

  const cancel = useCallback(() => settle(null), [settle]);

  return { open, text, setText, references, request, proceed, cancel, insertMention };
}
