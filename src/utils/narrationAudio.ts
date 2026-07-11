const DEFAULT_NARRATION_MIME_CANDIDATES = [
  "audio/webm;codecs=opus",
  "audio/webm",
  "audio/mp4",
  "audio/ogg;codecs=opus",
  "audio/ogg",
];

const APPLE_NARRATION_MIME_CANDIDATES = [
  "audio/mp4",
  "audio/webm;codecs=opus",
  "audio/webm",
  "audio/ogg;codecs=opus",
  "audio/ogg",
];

export function isAppleMediaPlatform(platform = navigator.platform): boolean {
  return /^(Mac|iPhone|iPad|iPod)/i.test(platform);
}

export function preferredNarrationMimeType(
  isTypeSupported = MediaRecorder.isTypeSupported.bind(MediaRecorder),
  platform = navigator.platform,
): string {
  const candidates = isAppleMediaPlatform(platform)
    ? APPLE_NARRATION_MIME_CANDIDATES
    : DEFAULT_NARRATION_MIME_CANDIDATES;
  return candidates.find((candidate) => isTypeSupported(candidate)) ?? "";
}
