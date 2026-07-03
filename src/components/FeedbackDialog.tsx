import { useState, useRef, useEffect } from "react";
import { invoke } from "../services/tauri";
import {
  AlertCircle,
  MessageSquare,
  Bug,
  Image,
  Star,
  Pencil,
  Paperclip,
  Send,
  Check,
  Trash2,
  X,
} from "lucide-react";
import { Dialog } from "./Dialog";
import { sanitizeDiagnosticsLog } from "../utils/diagnosticsSanitizer";
import {
  appendFeedbackAttachmentsSection,
  fileToFeedbackAttachmentPayload,
  formatFeedbackAttachmentSize,
  type FeedbackAttachmentMetadata,
  type FeedbackAttachmentPayload,
  validateFeedbackAttachmentFiles,
} from "../utils/feedbackAttachments";

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

interface FeedbackSystemInfo {
  app_version: string;
  os: string;
  os_family: string;
  arch: string;
}

interface PendingFeedbackAttachment {
  id: string;
  file: File;
  previewUrl: string;
}

interface FeedbackEntry {
  category: string;
  feedback: string;
  date: string;
  debug_log?: string;
  system_info?: FeedbackSystemInfo;
  attachments?: FeedbackAttachmentMetadata[];
}

export function FeedbackDialog({ isOpen, onClose }: FeedbackDialogProps) {
  const [feedback, setFeedback] = useState("");
  const [category, setCategory] = useState<Category>("general");
  const [includeDebug, setIncludeDebug] = useState(true);
  const [includeSystemInfo, setIncludeSystemInfo] = useState(true);
  const [copied, setCopied] = useState(false);
  const [attachments, setAttachments] = useState<PendingFeedbackAttachment[]>([]);
  const [attachmentErrors, setAttachmentErrors] = useState<string[]>([]);
  const [submitError, setSubmitError] = useState("");
  const [submitting, setSubmitting] = useState(false);
  const textareaRef = useRef<HTMLTextAreaElement>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);
  const attachmentsRef = useRef<PendingFeedbackAttachment[]>([]);

  useEffect(() => {
    if (isOpen) {
      setFeedback("");
      setCategory("general");
      setIncludeDebug(true);
      setIncludeSystemInfo(true);
      setCopied(false);
      setAttachmentErrors([]);
      setSubmitError("");
      setSubmitting(false);
      setAttachments((prev) => {
        prev.forEach((attachment) => URL.revokeObjectURL(attachment.previewUrl));
        return [];
      });
      requestAnimationFrame(() => textareaRef.current?.focus());
    }
  }, [isOpen]);

  useEffect(() => {
    attachmentsRef.current = attachments;
  }, [attachments]);

  useEffect(() => {
    return () => {
      attachmentsRef.current.forEach((attachment) => URL.revokeObjectURL(attachment.previewUrl));
    };
  }, []);

  const handleAttachmentFiles = (files: FileList | null) => {
    if (!files) return;
    const { accepted, errors } = validateFeedbackAttachmentFiles(attachments.length, Array.from(files));
    setAttachmentErrors(errors);
    if (fileInputRef.current) fileInputRef.current.value = "";
    if (accepted.length === 0) return;

    setAttachments((prev) => [
      ...prev,
      ...accepted.map((file) => ({
        id: typeof crypto !== "undefined" && "randomUUID" in crypto ? crypto.randomUUID() : `${Date.now()}-${file.name}`,
        file,
        previewUrl: URL.createObjectURL(file),
      })),
    ]);
  };

  const removeAttachment = (id: string) => {
    setAttachments((prev) => {
      const removed = prev.find((attachment) => attachment.id === id);
      if (removed) URL.revokeObjectURL(removed.previewUrl);
      return prev.filter((attachment) => attachment.id !== id);
    });
    setAttachmentErrors([]);
  };

  const handleSubmit = async () => {
    if (!feedback.trim() || submitting) return;
    setSubmitting(true);
    setSubmitError("");

    let debugLogText: string | undefined;
    if (includeDebug) {
      debugLogText = await invoke<unknown>("get_auditaur_diagnostics")
        .then((diagnostics) => sanitizeDiagnosticsLog(JSON.stringify(diagnostics, null, 2)))
        .catch((error) => sanitizeDiagnosticsLog(JSON.stringify({
          error: error instanceof Error ? error.message : String(error),
        }, null, 2)));
    }

    let systemInfo: FeedbackSystemInfo | undefined;
    if (includeSystemInfo) {
      systemInfo = await invoke<FeedbackSystemInfo>("get_feedback_system_info")
        .catch(() => undefined);
    }

    let attachmentPayloads: FeedbackAttachmentPayload[] = [];
    try {
      attachmentPayloads = await Promise.all(
        attachments.map((attachment) => fileToFeedbackAttachmentPayload(attachment.file)),
      );
    } catch (error) {
      setSubmitError(`Could not read screenshots: ${error instanceof Error ? error.message : String(error)}`);
      setSubmitting(false);
      return;
    }

    const entry = {
      category: categories[category].label,
      feedback: feedback.trim(),
      date: new Date().toISOString(),
      ...(debugLogText ? { debug_log: debugLogText } : {}),
      ...(systemInfo ? { system_info: systemInfo } : {}),
      ...(attachmentPayloads.length > 0 ? { attachments: attachmentPayloads } : {}),
    };

    let savedEntry: FeedbackEntry;
    try {
      savedEntry = await invoke<FeedbackEntry>("save_feedback", { entry });
    } catch (error) {
      setSubmitError(`Could not save feedback: ${error instanceof Error ? error.message : String(error)}`);
      setSubmitting(false);
      return;
    }

    const text = appendFeedbackAttachmentsSection([
      `## CutReady Feedback`,
      `**Category:** ${savedEntry.category}`,
      `**Date:** ${savedEntry.date.split("T")[0]}`,
      ``,
      savedEntry.feedback,
      ...(systemInfo
        ? [
          ``,
          `---`,
          `### OS details`,
          `- App Version: ${systemInfo.app_version}`,
          `- OS: ${systemInfo.os} (${systemInfo.os_family})`,
          `- Architecture: ${systemInfo.arch}`,
        ]
        : []),
      ...(debugLogText
        ? [``, `---`, `### Debug diagnostics`, `\`\`\`json`, debugLogText, `\`\`\``]
        : []),
    ].join("\n"), savedEntry.attachments);

    await navigator.clipboard.writeText(text).catch(() => {});
    setSubmitting(false);
    setCopied(true);
    setTimeout(() => {
      setCopied(false);
      onClose();
    }, 1200);
  };

  return (
    <Dialog isOpen={isOpen} onClose={onClose} align="top" topOffset="16vh" width="w-[460px] max-w-[92vw]">
      <div className="cr-modal-surface rounded-xl p-4 space-y-3">
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

        <div className="space-y-2">
          <input
            ref={fileInputRef}
            type="file"
            accept="image/png,image/jpeg"
            multiple
            className="hidden"
            onChange={(event) => handleAttachmentFiles(event.currentTarget.files)}
          />
          <div className="flex items-center justify-between gap-3">
            <button
              type="button"
              onClick={() => fileInputRef.current?.click()}
              className="inline-flex items-center gap-1.5 rounded-lg border border-[rgb(var(--color-border))] bg-[rgb(var(--color-surface-alt))] px-2.5 py-1.5 text-[11px] font-medium text-[rgb(var(--color-text-secondary))] transition-colors hover:border-[rgb(var(--color-accent))]/40 hover:text-[rgb(var(--color-text))]"
            >
              <Paperclip className="h-3.5 w-3.5" />
              Attach screenshots
            </button>
            <span className="text-[10px] text-[rgb(var(--color-text-secondary))]">
              PNG/JPEG, up to 3 files, 5 MB each
            </span>
          </div>

          {attachmentErrors.length > 0 && (
            <div className="rounded-lg border border-error/20 bg-error/10 px-2.5 py-2 text-[11px] text-error">
              {attachmentErrors.map((error) => (
                <div key={error} className="flex items-start gap-1.5">
                  <AlertCircle className="mt-0.5 h-3 w-3 shrink-0" />
                  <span>{error}</span>
                </div>
              ))}
            </div>
          )}

          {attachments.length > 0 && (
            <div className="grid gap-2">
              {attachments.map((attachment) => (
                <div
                  key={attachment.id}
                  className="flex items-center gap-2 rounded-lg border border-[rgb(var(--color-border))] bg-[rgb(var(--color-surface-alt))]/70 p-2"
                >
                  <div className="flex h-11 w-14 shrink-0 items-center justify-center overflow-hidden rounded-md border border-[rgb(var(--color-border))] bg-[rgb(var(--color-surface))]">
                    <img src={attachment.previewUrl} alt="" className="h-full w-full object-cover" />
                  </div>
                  <div className="min-w-0 flex-1">
                    <div className="flex items-center gap-1.5 text-[11px] font-medium text-[rgb(var(--color-text))]">
                      <Image className="h-3 w-3 shrink-0 text-[rgb(var(--color-accent))]" />
                      <span className="truncate">{attachment.file.name}</span>
                    </div>
                    <div className="mt-0.5 text-[10px] text-[rgb(var(--color-text-secondary))]">
                      {attachment.file.type.replace("image/", "").toUpperCase()} · {formatFeedbackAttachmentSize(attachment.file.size)}
                    </div>
                  </div>
                  <button
                    type="button"
                    onClick={() => removeAttachment(attachment.id)}
                    className="flex h-6 w-6 shrink-0 items-center justify-center rounded-md text-[rgb(var(--color-text-secondary))] transition-colors hover:bg-[rgb(var(--color-surface))] hover:text-error"
                    title="Remove screenshot"
                  >
                    <Trash2 className="h-3.5 w-3.5" />
                  </button>
                </div>
              ))}
            </div>
          )}
        </div>

        {submitError && (
          <div className="rounded-lg border border-error/20 bg-error/10 px-2.5 py-2 text-[11px] text-error">
            {submitError}
          </div>
        )}

        {/* Footer: opt-in details + submit */}
        <div className="flex items-end justify-between gap-3">
          <div className="space-y-1.5">
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
              Include debug diagnostics
            </span>
          </label>
          <label className="flex items-center gap-1.5 cursor-pointer group">
            <button
              type="button"
              role="switch"
              aria-checked={includeSystemInfo}
              onClick={() => setIncludeSystemInfo(!includeSystemInfo)}
              className={`relative inline-flex h-[16px] w-[28px] shrink-0 rounded-full border transition-colors ${
                includeSystemInfo
                  ? "bg-[rgb(var(--color-accent))] border-[rgb(var(--color-accent))]"
                  : "bg-[rgb(var(--color-surface-alt))] border-[rgb(var(--color-border))]"
              }`}
            >
              <span
                className={`pointer-events-none block h-[12px] w-[12px] rounded-full bg-[rgb(var(--color-surface))] shadow-sm transition-transform mt-[1px] ${
                  includeSystemInfo ? "translate-x-[13px]" : "translate-x-[1px]"
                }`}
              />
            </button>
            <span className="text-[11px] text-[rgb(var(--color-text-secondary))] group-hover:text-[rgb(var(--color-text))] transition-colors select-none">
              Include OS details
            </span>
          </label>
          </div>

          <button
            onClick={handleSubmit}
            disabled={!feedback.trim() || submitting}
            className={`inline-flex items-center gap-1.5 px-3 py-1.5 text-[12px] font-medium rounded-lg transition-colors ${
              !feedback.trim() || submitting
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
                {submitting ? "Saving..." : "Submit"}
              </>
            )}
          </button>
        </div>
      </div>
    </Dialog>
  );
}
