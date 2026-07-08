import { useCallback, useEffect, useRef, useState, type ReactNode } from "react";
import { MarkdownPreview, continueMarkdownList } from "./MarkdownText";

interface InlineDescriptionEditorProps {
  value: string;
  placeholder: string;
  disabled?: boolean;
  rows?: number;
  className?: string;
  previewClassName?: string;
  textareaClassName?: string;
  action?: ReactNode;
  onDraftChange: (value: string) => void;
  onSave: (value: string) => void | Promise<void>;
  onEditingChange?: (editing: boolean) => void;
}

export function InlineDescriptionEditor({
  value,
  placeholder,
  disabled = false,
  rows = 4,
  className = "",
  previewClassName = "",
  textareaClassName = "",
  action,
  onDraftChange,
  onSave,
  onEditingChange,
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
    pendingRef.current = null;

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
      pendingRef.current = nextValue;
      setStatus("error");
      setEditingState(true);
      return false;
    }
  }, [clearSaveTimer, onSave, setEditingState, value]);

  useEffect(() => {
    saveDraftRef.current = saveDraft;
  }, [saveDraft]);

  const handleChange = useCallback((nextValue: string) => {
    if (disabled) return;
    onDraftChange(nextValue);
    pendingRef.current = nextValue;
    setStatus("idle");
    clearSaveTimer();
    saveTimerRef.current = setTimeout(() => {
      void saveDraft(false);
    }, 800);
  }, [clearSaveTimer, disabled, onDraftChange, saveDraft]);

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
          onClick={() => { if (!disabled) setEditingState(true); }}
          onFocus={() => { if (!disabled) setEditingState(true); }}
          className={previewClassName}
        >
          <MarkdownPreview value={value} placeholder={placeholder} />
        </div>
      )}
      {!editing && !disabled && action}
    </div>
  );
}
