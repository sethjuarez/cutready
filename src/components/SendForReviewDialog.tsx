import { useCallback, useEffect, useState } from "react";
import { GitPullRequest } from "lucide-react";
import { useAppStore } from "../stores/appStore";
import { PromptDialog } from "./PromptDialog";

/**
 * Hybrid projects: asks for a pull request title before CutReady pushes its
 * branch and opens (or updates) a pull request on the code host.
 */
export function SendForReviewDialog() {
  const prompt = useAppStore((s) => s.sendForReviewPrompt);
  const sendForReview = useAppStore((s) => s.sendForReview);
  const cancelSendForReview = useAppStore((s) => s.cancelSendForReview);

  const [title, setTitle] = useState("");
  const [body, setBody] = useState("");

  useEffect(() => {
    if (prompt) {
      setTitle(prompt.defaultTitle);
      setBody("");
    }
  }, [prompt]);

  const close = useCallback(() => {
    cancelSendForReview();
  }, [cancelSendForReview]);

  const handleSend = useCallback(async () => {
    const trimmed = title.trim();
    if (!trimmed) return;
    await sendForReview(trimmed, body.trim() || undefined);
  }, [title, body, sendForReview]);

  if (!prompt) return null;

  return (
    <PromptDialog
      open
      title="Send for review"
      description="Push your CutReady changes to their own branch and open a pull request in the code repository."
      icon={<GitPullRequest className="h-5 w-5" />}
      onClose={close}
      focusKey={prompt.defaultTitle}
      fields={[
        {
          id: "send-for-review-title-input",
          label: "Pull request title",
          value: title,
          onChange: setTitle,
          placeholder: "e.g. Update launch demo script",
        },
        {
          id: "send-for-review-body-input",
          label: "Description (optional)",
          value: body,
          onChange: setBody,
          placeholder: "What should reviewers look at?",
        },
      ]}
      actions={[
        { id: "cancel", label: "Cancel", onSelect: close },
        {
          id: "send",
          label: "Send for review",
          onSelect: handleSend,
          variant: "primary",
          disabled: !title.trim(),
        },
      ]}
    />
  );
}
