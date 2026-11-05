// Dialogs shown while a demo video is imported: planning context before, progress during.
import { AtSign, FileInput } from "lucide-react";
import { Dialog } from "../Dialog";
import type { VideoImportPlanningContextReference, VideoImportProgress } from "../../ipc/workspace";

const videoImportPhaseDetails: Record<string, string> = {
  preparing: "Getting the importer ready and checking project settings.",
  validating: "Checking the video file and looking for a matching transcript sidecar.",
  transcript: "Reading timestamps so every sketch row can stay tied to the original recording.",
  audio: "Extracting a local audio reference for review and future editing.",
  grouping: "Building a first-pass scene map from pauses, timing, and transcript length.",
  llm: "The Video Import Scene Analyst is reviewing transcript boundaries before screenshots are extracted. Larger transcripts and reasoning models can take a few minutes.",
  screenshots: "Pulling representative frames from the final scene boundaries.",
  saving: "Writing the imported sketch and manifest back into the project.",
  complete: "Sketch import is done. Opening the new editable sketch next.",
  failed: "Import stopped before a sketch could be created.",
};

const videoImportAnalystActivity = [
  "Finding the cuts a demo producer would keep",
  "Matching narration beats to screenshot-worthy moments",
  "Keeping every transcript segment in order",
  "Sharpening the scene boundaries before frames are pulled",
];

export function mentionKey(value: string) {
  return value
    .toLowerCase()
    .replace(/\.(sk|sb|md)$/i, "")
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
}

export function extractMentionKeys(text: string) {
  const keys = new Set<string>();
  for (const match of text.matchAll(/@([a-zA-Z0-9][a-zA-Z0-9._/-]*)/g)) {
    const key = mentionKey(match[1]);
    if (key) keys.add(key);
  }
  return keys;
}

export function VideoImportProgressDialog({
  progress,
  onClose,
}: {
  progress: VideoImportProgress | null;
  onClose: () => void;
}) {
  if (!progress) return null;

  const total = Math.max(1, progress.total);
  const current = Math.min(Math.max(0, progress.current), total);
  const percent = Math.round((current / total) * 100);
  const isLlmPhase = progress.phase === "llm";
  const isComplete = progress.phase === "complete";
  const isFailed = progress.phase === "failed";
  const phaseDetail = videoImportPhaseDetails[progress.phase]
    ?? "CutReady is parsing the transcript, aligning scene ranges, extracting frames, and saving an editable sketch.";

  return (
    <Dialog
      isOpen={progress !== null}
      onClose={isFailed ? onClose : () => {}}
      align="top"
      topOffset="18vh"
      width={`w-full ${isFailed ? "max-w-lg" : "max-w-md"} mx-4`}
      labelledBy="video-import-progress-title"
    >
      <div className="cr-modal-surface overflow-hidden">
        <div className="px-5 py-5">
          <div className="flex items-start gap-3">
            <div className="relative grid h-10 w-10 shrink-0 place-items-center rounded-xl bg-[rgb(var(--color-accent))]/10 text-[rgb(var(--color-accent))]">
              <FileInput className="h-4 w-4" />
              <span className="absolute -right-0.5 -top-0.5 h-2.5 w-2.5 animate-pulse rounded-full bg-[rgb(var(--color-accent))]" />
            </div>
            <div className="min-w-0 flex-1">
              <h2 id="video-import-progress-title" className="text-sm font-semibold text-[rgb(var(--color-text))]">
                {isFailed ? "Video import needs attention" : "Importing demo video"}
              </h2>
              <p className={`mt-1 text-xs leading-5 text-[rgb(var(--color-text-secondary))] ${isFailed ? "whitespace-pre-wrap" : ""}`}>
                {progress.message}
              </p>
            </div>
          </div>

          <div className="mt-5">
            <div className="mb-2 flex items-center justify-between text-xs font-medium uppercase tracking-[0.14em] text-[rgb(var(--color-text-secondary))]">
              <span>{isComplete ? "Wrapping up" : `Step ${current} of ${total}`}</span>
              <span>{percent}%</span>
            </div>
            <div className="h-2 overflow-hidden rounded-full bg-[rgb(var(--color-surface-alt))]">
              <div
                className="h-full rounded-full bg-[rgb(var(--color-accent))] transition-all duration-300 ease-out"
                style={{ width: `${percent}%` }}
              />
            </div>
          </div>

          <div className="mt-4 rounded-xl border border-[rgb(var(--color-border))] bg-[rgb(var(--color-surface-alt))]/60 px-3 py-2 text-xs leading-5 text-[rgb(var(--color-text-secondary))]">
            {phaseDetail}
          </div>

          {isLlmPhase && (
            <div
              className="mt-3 rounded-xl border border-[rgb(var(--color-accent))]/20 bg-[rgb(var(--color-accent))]/[0.06] px-3 py-3"
              aria-live="polite"
            >
              <div className="mb-2 flex items-center justify-between text-2xs font-semibold uppercase tracking-[0.16em] text-[rgb(var(--color-accent))]">
                <span>Analyst scratchpad</span>
                <span className="flex items-center gap-1 text-[rgb(var(--color-text-secondary))]">
                  thinking
                  <span className="h-1 w-1 animate-pulse rounded-full bg-[rgb(var(--color-accent))]" />
                  <span className="h-1 w-1 animate-pulse rounded-full bg-[rgb(var(--color-accent))]" style={{ animationDelay: "180ms" }} />
                  <span className="h-1 w-1 animate-pulse rounded-full bg-[rgb(var(--color-accent))]" style={{ animationDelay: "360ms" }} />
                </span>
              </div>
              <div className="space-y-1.5">
                {videoImportAnalystActivity.map((line, index) => (
                  <div
                    key={line}
                    className="flex items-center gap-2 text-xs leading-4 text-[rgb(var(--color-text-secondary))]"
                    style={{ opacity: 0.72 + (index * 0.07) }}
                  >
                    <span
                      className="h-1.5 w-1.5 shrink-0 animate-pulse rounded-full bg-[rgb(var(--color-accent))]/70"
                      style={{ animationDelay: `${index * 220}ms` }}
                    />
                    <span>{line}</span>
                  </div>
                ))}
              </div>
            </div>
          )}

          {isFailed && (
            <div className="mt-5 flex justify-end">
              <button
                type="button"
                onClick={onClose}
                className="rounded-lg bg-[rgb(var(--color-accent))] px-4 py-2 text-xs font-medium text-accent-fg transition-colors hover:bg-[rgb(var(--color-accent-hover))]"
              >
                Got it
              </button>
            </div>
          )}
        </div>
      </div>
    </Dialog>
  );
}

export function VideoImportPlanningContextDialog({
  open,
  value,
  references,
  onChange,
  onInsertMention,
  onContinue,
  onCancel,
}: {
  open: boolean;
  value: string;
  references: VideoImportPlanningContextReference[];
  onChange: (value: string) => void;
  onInsertMention: (reference: VideoImportPlanningContextReference) => void;
  onContinue: () => void;
  onCancel: () => void;
}) {
  if (!open) return null;

  return (
    <Dialog
      isOpen={open}
      onClose={onCancel}
      align="top"
      topOffset="14vh"
      width="w-full max-w-xl mx-4"
      labelledBy="video-import-context-title"
    >
      <div className="cr-modal-surface overflow-hidden">
        <div className="px-5 py-5">
          <div className="flex items-start gap-3">
            <div className="grid h-10 w-10 shrink-0 place-items-center rounded-xl bg-[rgb(var(--color-accent))]/10 text-[rgb(var(--color-accent))]">
              <AtSign className="h-4 w-4" />
            </div>
            <div className="min-w-0 flex-1">
              <h2 id="video-import-context-title" className="text-sm font-semibold text-[rgb(var(--color-text))]">
                Planning context
              </h2>
              <p className="mt-1 text-xs leading-5 text-[rgb(var(--color-text-secondary))]">
                Guide how CutReady splits the video into rows and labels sections. Transcript text stays verbatim, and Actions are not inferred.
              </p>
            </div>
          </div>

          <textarea
            value={value}
            onChange={(event) => onChange(event.target.value)}
            placeholder="Example: This is a launch demo for developers. Keep setup, auth, deployment, and payoff as separate beats. Use @launch-plan for structure."
            className="mt-4 h-32 w-full resize-none rounded-xl border border-[rgb(var(--color-border))] bg-[rgb(var(--color-surface))] px-3 py-2 text-xs leading-5 text-[rgb(var(--color-text))] placeholder:text-[rgb(var(--color-text-secondary))]/60 focus:outline-none focus:ring-1 focus:ring-[rgb(var(--color-accent))]/50"
            autoFocus
          />

          {references.length > 0 && (
            <div className="mt-3">
              <p className="mb-2 text-2xs font-semibold uppercase tracking-[0.16em] text-[rgb(var(--color-text-secondary))]">
                Insert reference
              </p>
              <div className="flex max-h-24 flex-wrap gap-1.5 overflow-y-auto">
                {references.map((reference) => (
                  <button
                    key={`${reference.kind}:${reference.path}`}
                    type="button"
                    onClick={() => onInsertMention(reference)}
                    className="rounded-full border border-[rgb(var(--color-border))] bg-[rgb(var(--color-surface-alt))] px-2 py-1 text-xs text-[rgb(var(--color-text-secondary))] transition-colors hover:border-[rgb(var(--color-accent))]/50 hover:text-[rgb(var(--color-accent))]"
                    title={reference.path}
                  >
                    @{mentionKey(reference.title || reference.path)}
                  </button>
                ))}
              </div>
            </div>
          )}

          <div className="mt-5 flex justify-end gap-2">
            <button
              type="button"
              onClick={onCancel}
              className="rounded-lg border border-[rgb(var(--color-border))] px-4 py-2 text-xs font-medium text-[rgb(var(--color-text-secondary))] transition-colors hover:text-[rgb(var(--color-text))]"
            >
              Cancel
            </button>
            <button
              type="button"
              onClick={onContinue}
              className="rounded-lg bg-[rgb(var(--color-accent))] px-4 py-2 text-xs font-medium text-accent-fg transition-colors hover:bg-[rgb(var(--color-accent-hover))]"
            >
              Continue import
            </button>
          </div>
        </div>
      </div>
    </Dialog>
  );
}
