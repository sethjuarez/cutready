import { useState, useRef, useEffect } from "react";
import { invoke } from "@tauri-apps/api/core";
import {
  MessageSquare,
  Bug,
  Star,
  Pencil,
  Send,
  Check,
  X,
} from "lucide-react";
import { useAppStore } from "../stores/appStore";
import { Dialog } from "./Dialog";

interface FeedbackDialogProps {
  isOpen: boolean;
  onClose: () => void;
}

const categories = {
  general: { label: "General", Icon: MessageSquare },
  bug: { label: "Bug", Icon: Bug },
  feature: { label: "Feature", Icon: Star },
  ux: { label: "Design", Icon: Pencil },
} as const;

type Category = keyof typeof categories;

export function FeedbackDialog({ isOpen, onClose }: FeedbackDialogProps) {
  const [feedback, setFeedback] = useState("");
  const [category, setCategory] = useState<Category>("general");
  const [includeDebug, setIncludeDebug] = useState(false);
  const [copied, setCopied] = useState(false);
  const textareaRef = useRef<HTMLTextAreaElement>(null);

  useEffect(() => {
    if (isOpen) {
      setFeedback("");
      setCategory("general");
      setIncludeDebug(false);
      setCopied(false);
      requestAnimationFrame(() => textareaRef.current?.focus());
    }
  }, [isOpen]);


  const handleSubmit = async () => {
    if (!feedback.trim()) return;

    let debugLogText: string | undefined;
    if (includeDebug) {
      const entries = useAppStore.getState().debugLog;
      if (entries.length > 0) {
        debugLogText = entries
          .map(
            (e) =>
              `[${e.timestamp.toISOString()}] [${e.level.toUpperCase().padEnd(7)}] [${e.source}] ${e.content}`,
          )
          .join("\n");
      }
    }

    const entry = {
      category: categories[category].label,
      feedback: feedback.trim(),
      date: new Date().toISOString(),
      ...(debugLogText ? { debug_log: debugLogText } : {}),
    };

    await invoke("save_feedback", { entry }).catch(() => {});

    const text = [
      `## CutReady Feedback`,
      `**Category:** ${entry.category}`,
      `**Date:** ${entry.date.split("T")[0]}`,
      ``,
      entry.feedback,
      ...(debugLogText
        ? [``, `---`, `### Debug Log`, `\`\`\``, debugLogText, `\`\`\``]
        : []),
    ].join("\n");

    await navigator.clipboard.writeText(text).catch(() => {});
    setCopied(true);
    setTimeout(() => {
      setCopied(false);
      onClose();
    }, 1200);
  };

  return (
    <Dialog isOpen={isOpen} onClose={onClose} align="top" topOffset="20vh" width="w-[360px] max-w-[90vw]">
      <div className="bg-[rgb(var(--color-surface))] border border-[rgb(var(--color-border))] rounded-xl shadow-2xl p-4 space-y-3">
        {/* Header */}
        <div className="flex items-center justify-between">
          <h3 className="text-sm font-medium text-[rgb(var(--color-text))]">
            Send Feedback
          </h3>
          <button
            className="flex items-center justify-center w-6 h-6 rounded text-[rgb(var(--color-text-secondary))] hover:text-[rgb(var(--color-text))] hover:bg-[rgb(var(--color-surface-alt))] transition-colors"
            onClick={onClose}
          >
            <X className="w-3.5 h-3.5" />
          </button>
        </div>

        {/* Category pills */}
        <div className="flex gap-1.5">
          {(Object.keys(categories) as Category[]).map((key) => {
            const { label, Icon } = categories[key];
            return (
              <button
                key={key}
                onClick={() => setCategory(key)}
                className={`inline-flex items-center gap-1 px-2.5 py-1 text-[11px] rounded-md border transition-colors ${
                  category === key
                    ? "bg-[rgb(var(--color-surface-alt))] text-[rgb(var(--color-accent))] border-[rgb(var(--color-accent))]/30"
                    : "bg-[rgb(var(--color-surface))] text-[rgb(var(--color-text-secondary))] border-[rgb(var(--color-border))] hover:text-[rgb(var(--color-text))]"
                }`}
              >
                <Icon className="w-3 h-3" />
                {label}
              </button>
            );
          })}
        </div>

        {/* Text */}
        <textarea
          ref={textareaRef}
          value={feedback}
          onChange={(e) => setFeedback(e.target.value)}
          placeholder="What's on your mind?"
          rows={4}
          className="w-full px-3 py-2.5 rounded-lg bg-[rgb(var(--color-surface-alt))] border border-[rgb(var(--color-border))] text-[13px] text-[rgb(var(--color-text))] placeholder:text-[rgb(var(--color-text-secondary))]/50 focus:outline-none focus:ring-1 focus:ring-[rgb(var(--color-accent))]/40 resize-none"
        />

        {/* Footer: debug toggle + submit */}
        <div className="flex items-center justify-between">
          <label className="flex items-center gap-1.5 cursor-pointer group">
            <button
              type="button"
              role="switch"
              aria-checked={includeDebug}
              onClick={() => setIncludeDebug(!includeDebug)}
              className={`relative inline-flex h-[16px] w-[28px] shrink-0 rounded-full border transition-colors ${
                includeDebug
                  ? "bg-[rgb(var(--color-accent))] border-[rgb(var(--color-accent))]"
                  : "bg-[rgb(var(--color-surface-alt))] border-[rgb(var(--color-border))]"
              }`}
            >
              <span
                className={`pointer-events-none block h-[12px] w-[12px] rounded-full bg-[rgb(var(--color-surface))] shadow-sm transition-transform mt-[1px] ${
                  includeDebug ? "translate-x-[13px]" : "translate-x-[1px]"
                }`}
              />
            </button>
            <span className="text-[11px] text-[rgb(var(--color-text-secondary))] group-hover:text-[rgb(var(--color-text))] transition-colors select-none">
              Include debug log
            </span>
          </label>

          <button
            onClick={handleSubmit}
            disabled={!feedback.trim()}
            className={`inline-flex items-center gap-1.5 px-3 py-1.5 text-[12px] font-medium rounded-lg transition-colors ${
              !feedback.trim()
                ? "text-[rgb(var(--color-text-secondary))]/30 bg-[rgb(var(--color-surface-alt))] cursor-not-allowed"
                : copied
                  ? "text-success bg-success/15"
                  : "text-[rgb(var(--color-accent-fg))] bg-[rgb(var(--color-accent))] hover:bg-[rgb(var(--color-accent-hover))]"
            }`}
          >
            {copied ? (
              <>
                <Check className="w-3.5 h-3.5" />
                Copied!
              </>
            ) : (
              <>
                <Send className="w-3.5 h-3.5" />
                Submit
              </>
            )}
          </button>
        </div>
      </div>
    </Dialog>
  );
}
