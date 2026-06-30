import { describe, expect, test } from "vitest";
import {
  appendFeedbackAttachmentsSection,
  FEEDBACK_ATTACHMENT_LIMITS,
  formatFeedbackAttachmentSize,
  validateFeedbackAttachmentFiles,
} from "../utils/feedbackAttachments";

describe("feedback screenshot attachments", () => {
  test("accepts PNG and JPEG files within limits", () => {
    const { accepted, errors } = validateFeedbackAttachmentFiles(0, [
      { name: "screen.png", type: "image/png", size: 1024 },
      { name: "screen.jpg", type: "image/jpeg", size: 2048 },
    ]);

    expect(accepted.map((file) => file.name)).toEqual(["screen.png", "screen.jpg"]);
    expect(errors).toEqual([]);
  });

  test("rejects unsupported types, oversized files, and excess count", () => {
    const { accepted, errors } = validateFeedbackAttachmentFiles(2, [
      { name: "notes.txt", type: "text/plain", size: 100 },
      { name: "huge.png", type: "image/png", size: FEEDBACK_ATTACHMENT_LIMITS.maxBytesPerFile + 1 },
      { name: "ok.jpeg", type: "image/jpeg", size: 100 },
      { name: "extra.png", type: "image/png", size: 100 },
    ]);

    expect(accepted.map((file) => file.name)).toEqual(["ok.jpeg"]);
    expect(errors).toEqual([
      "notes.txt is not a PNG or JPEG screenshot.",
      `huge.png is too large. Keep screenshots under ${formatFeedbackAttachmentSize(FEEDBACK_ATTACHMENT_LIMITS.maxBytesPerFile)}.`,
      `Only ${FEEDBACK_ATTACHMENT_LIMITS.maxFiles} screenshots can be attached.`,
    ]);
  });

  test("formats issue fallback metadata without local absolute paths", () => {
    const body = appendFeedbackAttachmentsSection("## Bug\n\nDetails", [{
      id: "attachment-id",
      file_name: "screen.png",
      content_type: "image/png",
      size_bytes: 2048,
      stored_path: "feedback-attachments/attachment-id/screen.png",
      sha256: "abc123",
    }]);

    expect(body).toContain("GitHub CLI issue creation cannot upload local image files");
    expect(body).toContain("feedback-attachments/attachment-id/screen.png");
    expect(body).not.toContain("C:\\");
    expect(body).not.toContain("/Users/");
  });
});
