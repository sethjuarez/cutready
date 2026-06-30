export const FEEDBACK_ATTACHMENT_LIMITS = {
  maxFiles: 3,
  maxBytesPerFile: 5 * 1024 * 1024,
  acceptedTypes: new Set(["image/png", "image/jpeg"]),
} as const;

export interface FeedbackAttachmentCandidate {
  name: string;
  type: string;
  size: number;
}

export interface FeedbackAttachmentPayload {
  file_name: string;
  content_type: string;
  size_bytes: number;
  data_base64: string;
}

export interface FeedbackAttachmentMetadata {
  id: string;
  file_name: string;
  content_type: string;
  size_bytes: number;
  stored_path: string;
  sha256: string;
}

export function formatFeedbackAttachmentSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(bytes >= 10 * 1024 ? 1 : 2)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(bytes >= 10 * 1024 * 1024 ? 1 : 2)} MB`;
}

export function validateFeedbackAttachmentFiles<T extends FeedbackAttachmentCandidate>(
  existingCount: number,
  files: T[],
): { accepted: T[]; errors: string[] } {
  const accepted: T[] = [];
  const errors: string[] = [];
  let remaining = Math.max(0, FEEDBACK_ATTACHMENT_LIMITS.maxFiles - existingCount);

  for (const file of files) {
    if (remaining <= 0) {
      errors.push(`Only ${FEEDBACK_ATTACHMENT_LIMITS.maxFiles} screenshots can be attached.`);
      break;
    }

    if (!FEEDBACK_ATTACHMENT_LIMITS.acceptedTypes.has(file.type)) {
      errors.push(`${file.name} is not a PNG or JPEG screenshot.`);
      continue;
    }

    if (file.size > FEEDBACK_ATTACHMENT_LIMITS.maxBytesPerFile) {
      errors.push(`${file.name} is too large. Keep screenshots under ${formatFeedbackAttachmentSize(FEEDBACK_ATTACHMENT_LIMITS.maxBytesPerFile)}.`);
      continue;
    }

    accepted.push(file);
    remaining -= 1;
  }

  return { accepted, errors: [...new Set(errors)] };
}

export async function fileToFeedbackAttachmentPayload(file: File): Promise<FeedbackAttachmentPayload> {
  const bytes = new Uint8Array(await file.arrayBuffer());
  return {
    file_name: file.name,
    content_type: file.type,
    size_bytes: file.size,
    data_base64: uint8ArrayToBase64(bytes),
  };
}

function uint8ArrayToBase64(bytes: Uint8Array): string {
  let binary = "";
  const chunkSize = 0x8000;
  for (let offset = 0; offset < bytes.length; offset += chunkSize) {
    binary += String.fromCharCode(...bytes.subarray(offset, offset + chunkSize));
  }
  return btoa(binary);
}

export function formatFeedbackAttachmentsMarkdown(attachments?: FeedbackAttachmentMetadata[]): string[] {
  if (!attachments || attachments.length === 0) return [];
  return [
    "",
    "## Screenshots",
    "GitHub CLI issue creation cannot upload local image files from this flow, so CutReady preserved sanitized local copies for manual upload.",
    ...attachments.map((attachment) =>
      `- ${attachment.file_name} (${attachment.content_type}, ${formatFeedbackAttachmentSize(attachment.size_bytes)}) stored as \`${attachment.stored_path}\``,
    ),
  ];
}

export function appendFeedbackAttachmentsSection(body: string, attachments?: FeedbackAttachmentMetadata[]): string {
  const lines = formatFeedbackAttachmentsMarkdown(attachments);
  if (lines.length === 0) return body;
  return [body.trim(), ...lines].join("\n");
}
