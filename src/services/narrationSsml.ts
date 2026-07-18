const DISALLOWED_ELEMENT_NAMES = new Set([
  "audio",
  "lexicon",
  "bookmark",
  "backgroundaudio",
  "viseme",
  "voiceconversion",
  "ttsembedding",
]);

export function validateGeneratedSsml(ssml: string, voice: string): string {
  const trimmed = ssml.trim();
  if (!/^<speak[\s>]/i.test(trimmed)) throw new Error("Narration agent returned SSML without a speak root.");

  const document = new DOMParser().parseFromString(trimmed, "application/xml");
  if (document.querySelector("parsererror")) throw new Error("Narration agent returned malformed SSML.");
  if (document.documentElement.localName !== "speak") throw new Error("Narration agent returned SSML without a speak root.");

  const elements = Array.from(document.getElementsByTagName("*"));
  const hasDisallowedElement = elements.some((element) =>
    DISALLOWED_ELEMENT_NAMES.has(element.localName.toLowerCase()),
  );
  if (hasDisallowedElement) throw new Error("Narration agent returned unsupported SSML elements.");

  const voices = elements.filter((element) => element.localName.toLowerCase() === "voice");
  if (voices.length !== 1 || voices[0].getAttribute("name") !== voice) {
    throw new Error("Narration agent returned SSML for an unexpected voice.");
  }
  return trimmed;
}
