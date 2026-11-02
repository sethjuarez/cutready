import { useCallback, useEffect, useRef, useState } from "react";
import { readDocument, registerDocumentEditor, type DocumentEditor, type DocumentRefreshedDetail } from "../services/documentSaves";
import type { DocumentKind } from "../ipc/documents";

interface DocumentReloadOptions<T> {
  /** The editor, from useDocumentEditor. */
  editor: DocumentEditor;
  kind: DocumentKind;
  path: string;
  /** Window events that make the editor re-read the document. */
  events: string[];
  /** Whether a reload event applies to this editor (default: every event). */
  accepts?: (event: Event) => boolean;
  /** Whether the editor has edits that aren't saved yet. */
  hasPending: () => boolean;
  /** Shows a document in the editor. */
  apply: (document: T) => void;
}

/**
 * Keeps a split editor in sync with its document without replacing typing.
 * `cutready:document-refreshed` carries the refreshed document, which is shown
 * at once, or refused (the event is cancelled) while edits are pending. Other
 * reload events re-read the document and show it only if nothing was typed
 * meanwhile. Call the returned function on every local edit.
 */
/** Counts a split editor as showing `path` while it is mounted; returns the identity its installs acknowledge with. */
export function useDocumentEditor(path: string): DocumentEditor {
  const [editor] = useState<DocumentEditor>(() => Symbol("split editor"));
  useEffect(() => registerDocumentEditor(path, editor), [path, editor]);
  return editor;
}

export function useDocumentReload<T>({ editor, kind, path, events, accepts, hasPending, apply }: DocumentReloadOptions<T>): () => void {
  const editGeneration = useRef(0);
  const latest = useRef({ accepts, hasPending, apply });
  latest.current = { accepts, hasPending, apply };

  useEffect(() => {
    const reload = (event: Event) => {
      if (latest.current.accepts && !latest.current.accepts(event)) return;
      const generation = editGeneration.current;
      readDocument<T>(kind, path)
        .then(({ document, installed }) => {
          if (editGeneration.current !== generation || latest.current.hasPending()) return;
          editGeneration.current += 1;
          latest.current.apply(document);
          installed(editor);
        })
        .catch(() => {});
    };
    const refreshed = (event: Event) => {
      const detail = (event as CustomEvent<DocumentRefreshedDetail>).detail;
      if (detail?.path !== path) return;
      if (latest.current.hasPending()) {
        event.preventDefault();
        return;
      }
      editGeneration.current += 1;
      latest.current.apply(detail.document as T);
      detail.acknowledge(editor);
    };
    for (const name of events) window.addEventListener(name, reload);
    window.addEventListener("cutready:document-refreshed", refreshed);
    return () => {
      for (const name of events) window.removeEventListener(name, reload);
      window.removeEventListener("cutready:document-refreshed", refreshed);
    };
    // `events` is a fixed list per editor.
  }, [editor, kind, path]);

  return useCallback(() => {
    editGeneration.current += 1;
  }, []);
}
