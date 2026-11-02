import { useCallback, useEffect, useRef, useState, type MutableRefObject, type ReactNode } from "react";
import remarkBreaks from "remark-breaks";
import remarkGfm from "remark-gfm";
import { SafeMarkdown } from "./SafeMarkdown";
import { continueMarkdownList } from "../utils/markdownList";

/** Holds a function that saves the unsaved draft now, or null when there is no draft. */
export type DraftFlushRef = MutableRefObject<(() => Promise<void>) | null>;

interface InlineDescriptionEditorProps {
  value: string;
  placeholder: string;
  /** Accessible name for the preview and the textarea. */
  label?: string;
  disabled?: boolean;
  rows?: number;
  className?: string;
  previewClassName?: string;
  textareaClassName?: string;
  action?: ReactNode;
  onDraftChange: (value: string) => void;
  onSave: (value: string) => void | Promise<void>;
  onEditingChange?: (editing: boolean) => void;
  draftRef?: DraftFlushRef;
}

export function InlineDescriptionEditor({
  value,
  placeholder,
  label,
  disabled = false,
  rows = 4,
  className = "",
  previewClassName = "",
  textareaClassName = "",
  action,
  onDraftChange,
  onSave,
  onEditingChange,
  draftRef,
}: InlineDescriptionEditorProps) {
  const [editing, setEditing] = useState(false);
  const [status, setStatus] = useState<"idle" | "saving" | "saved" | "error">("idle");
  const textareaRef = useRef<HTMLTextAreaElement>(null);
  const saveTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const pendingRef = useRef<string | null>(null);
  const savedValueRef = useRef(value);
  const editingRef = useRef(editing);
  const saveDraftRef = useRef<(exitAfterSave: boolean) => Promise<boolean>>(async () => true);
  const cursorRef = useRef<number | null>(null);
  const draftRefRef = useRef(draftRef);
  draftRefRef.current = draftRef;

  const setPending = useCallback((next: string | null) => {
    pendingRef.current = next;
    if (!draftRefRef.current) return;
    draftRefRef.current.current = next === null ? null : async () => {
      if (!(await saveDraftRef.current(false))) throw new Error("Couldn't save the description");
    };
  }, []);

  const clearSaveTimer = useCallback(() => {
    if (saveTimerRef.current) {
      clearTimeout(saveTimerRef.current);
      saveTimerRef.current = null;
    }
  }, []);

  const setEditingState = useCallback((next: boolean) => {
    editingRef.current = next;
    setEditing(next);
    onEditingChange?.(next);
  }, [onEditingChange]);

  const resizeTextarea = useCallback(() => {
    const textarea = textareaRef.current;
    if (!textarea) return;
    textarea.style.height = "auto";
    textarea.style.height = `${textarea.scrollHeight}px`;
  }, []);

  useEffect(() => {
    editingRef.current = editing;
  }, [editing]);

  useEffect(() => {
    if (editing || pendingRef.current !== null) return;
    savedValueRef.current = value;
  }, [editing, value]);

  useEffect(() => {
    if (!editing) return;
    requestAnimationFrame(() => {
      const textarea = textareaRef.current;
      if (!textarea) return;
      textarea.focus();
      textarea.selectionStart = textarea.value.length;
      textarea.selectionEnd = textarea.value.length;
      resizeTextarea();
    });
  }, [editing, resizeTextarea]);

  useEffect(() => {
    resizeTextarea();
  }, [resizeTextarea, value, editing]);

  useEffect(() => {
    if (cursorRef.current === null || !textareaRef.current) return;
    textareaRef.current.selectionStart = textareaRef.current.selectionEnd = cursorRef.current;
    cursorRef.current = null;
  }, [value]);

  const saveDraft = useCallback(async (exitAfterSave: boolean) => {
    clearSaveTimer();
    const nextValue = pendingRef.current ?? value;
    setPending(null);

    if (nextValue === savedValueRef.current) {
      if (exitAfterSave) setEditingState(false);
      return true;
    }

    setStatus("saving");
    try {
      await onSave(nextValue);
      savedValueRef.current = nextValue;
      setStatus("saved");
      if (exitAfterSave) setEditingState(false);
      return true;
    } catch (error) {
      console.error("[InlineDescriptionEditor] Failed to save description:", error);
      setPending(nextValue);
      setStatus("error");
      setEditingState(true);
      return false;
    }
  }, [clearSaveTimer, onSave, setEditingState, setPending, value]);

  useEffect(() => {
    saveDraftRef.current = saveDraft;
  }, [saveDraft]);

  const handleChange = useCallback((nextValue: string) => {
    if (disabled) return;
    onDraftChange(nextValue);
    setPending(nextValue);
    setStatus("idle");
    clearSaveTimer();
    saveTimerRef.current = setTimeout(() => {
      void saveDraft(false);
    }, 800);
  }, [clearSaveTimer, disabled, onDraftChange, saveDraft, setPending]);

  const exitEdit = useCallback(() => {
    setEditingState(false);
  }, [setEditingState]);

  useEffect(() => {
    return () => {
      if (pendingRef.current === null) return;
      void saveDraftRef.current(false);
    };
  }, []);

  return (
    <div className={`relative group/inline-desc ${className}`}>
      {editing ? (
        <>
          <textarea
            ref={textareaRef}
            value={value}
            onChange={(event) => handleChange(event.target.value)}
            onBlur={() => void saveDraft(true)}
            onKeyDown={(event) => {
              if (event.key === "Escape") {
                event.preventDefault();
                exitEdit();
              } else if (event.key === "Enter" && (event.metaKey || event.ctrlKey)) {
                event.preventDefault();
                void saveDraft(true);
              } else if (event.key === "Enter") {
                if (continueMarkdownList({
                  value,
                  selectionStart: event.currentTarget.selectionStart,
                  selectionEnd: event.currentTarget.selectionEnd,
                  onChange: handleChange,
                  setCursor: (position) => { cursorRef.current = position; },
                })) {
                  event.preventDefault();
                }
              }
            }}
            placeholder={placeholder}
            aria-label={label}
            rows={rows}
            readOnly={disabled}
            className={textareaClassName}
            autoFocus
          />
          {status !== "idle" && (
            <span
              className={`pointer-events-none absolute right-2 top-2 rounded-full bg-[rgb(var(--color-surface))]/90 px-2 py-0.5 text-[10px] font-medium uppercase tracking-[0.14em] ${
                status === "error"
                  ? "text-error"
                  : "text-[rgb(var(--color-text-secondary))]/65"
              }`}
            >
              {status === "saving" ? "Saving" : status === "saved" ? "Saved" : "Not saved"}
            </span>
          )}
        </>
      ) : (
        <div
          tabIndex={disabled ? -1 : 0}
          role={disabled ? undefined : "button"}
          aria-label={label}
          onClick={() => { if (!disabled) setEditingState(true); }}
          onFocus={() => { if (!disabled) setEditingState(true); }}
          className={previewClassName}
        >
          <SafeMarkdown placeholder={placeholder} remarkPlugins={[remarkGfm, remarkBreaks]}>
            {value}
          </SafeMarkdown>
        </div>
      )}
      {!editing && !disabled && action}
    </div>
  );
}
