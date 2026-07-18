import { describe, expect, test } from "vitest";
import { buildPlainSsml, inferSpeechEndpoint } from "../services/narrationSpeech";

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
});
