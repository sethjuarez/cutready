import { describe, expect, test } from "vitest";
import { buildPlainSsml, inferSpeechEndpoint } from "../services/narrationSpeech";
import { validateGeneratedSsml } from "../services/narrationSsml";

describe("narration speech helpers", () => {
  test("derives the Azure Speech endpoint from a Foundry endpoint", () => {
    expect(inferSpeechEndpoint("https://cutready-eastus.services.ai.azure.com")).toBe(
      "https://cutready-eastus.cognitiveservices.azure.com",
    );
  });

  test("escapes sample text in generated SSML", () => {
    expect(buildPlainSsml("Plan & ship <confidently>", "en-US-Harper:MAI-Voice-2")).toContain(
      "Plan &amp; ship &lt;confidently&gt;",
    );
  });

  test("rejects prohibited SSML elements regardless of namespace prefix", () => {
    const voice = "en-US-Harper:MAI-Voice-2";
    const ssml = `<speak xmlns="http://www.w3.org/2001/10/synthesis" xmlns:x="https://www.w3.org/2001/mstts"><voice name="${voice}"><x:backgroundaudio src="https://example.invalid/audio.mp3" /></voice></speak>`;

    expect(() => validateGeneratedSsml(ssml, voice)).toThrow("unsupported SSML elements");
  });

  test("rejects multiple voice elements regardless of namespace prefix", () => {
    const voice = "en-US-Harper:MAI-Voice-2";
    const ssml = `<speak xmlns="http://www.w3.org/2001/10/synthesis" xmlns:s="http://www.w3.org/2001/10/synthesis"><voice name="${voice}">Configured voice.</voice><s:voice name="en-US-OtherNeural">Unexpected voice.</s:voice></speak>`;

    expect(() => validateGeneratedSsml(ssml, voice)).toThrow("unexpected voice");
  });
});
