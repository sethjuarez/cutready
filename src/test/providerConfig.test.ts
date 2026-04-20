import { describe, test, expect } from "vitest";
import { buildProviderConfig, canFetchModelsFor, CUTREADY_FEEDBACK_REPO } from "../components/SettingsPanel";

// ── buildProviderConfig ─────────────────────────────────────────

describe("buildProviderConfig", () => {
  const base = {
    aiProvider: "openai",
    aiEndpoint: "https://api.openai.com",
    aiApiKey: "sk-test",
    aiModel: "gpt-4o",
    aiAuthMode: "api_key",
    aiAccessToken: "",
  };

  test("OpenAI: bearer_token is null in api_key mode", () => {
    const cfg = buildProviderConfig(base);
    expect(cfg.provider).toBe("openai");
    expect(cfg.api_key).toBe("sk-test");
    expect(cfg.bearer_token).toBeNull();
  });

  test("Azure OAuth: bearer_token is the access token", () => {
    const cfg = buildProviderConfig({
      ...base,
      aiProvider: "azure_openai",
      aiAuthMode: "azure_oauth",
      aiAccessToken: "eyJ-token",
    });
    expect(cfg.bearer_token).toBe("eyJ-token");
  });

  test("Foundry OAuth: bearer_token is the access token", () => {
    const cfg = buildProviderConfig({
      ...base,
      aiProvider: "microsoft_foundry",
      aiAuthMode: "azure_oauth",
      aiAccessToken: "foundry-token",
    });
    expect(cfg.provider).toBe("microsoft_foundry");
    expect(cfg.bearer_token).toBe("foundry-token");
  });

  test("empty model defaults to 'unused'", () => {
    const cfg = buildProviderConfig({ ...base, aiModel: "" });
    expect(cfg.model).toBe("unused");
  });

  test("includes model capability settings for agent routing", () => {
    const cfg = buildProviderConfig({
      ...base,
      aiContextLength: 128000,
      aiVisionMode: "notes_and_sketches",
      aiModelSupportsVision: "true",
    });

    expect(cfg.context_length).toBe(128000);
    expect(cfg.vision_mode).toBe("notes_and_sketches");
    expect(cfg.model_supports_vision).toBe(true);
  });

  test("includes web access setting for agent tool availability", () => {
    const cfg = buildProviderConfig({
      ...base,
      aiWebAccess: "enabled",
    });

    expect(cfg.web_access).toBe("enabled");
  });

  test("Anthropic in api_key mode: bearer_token null", () => {
    const cfg = buildProviderConfig({
      ...base,
      aiProvider: "anthropic",
      aiApiKey: "sk-ant-xxx",
    });
    expect(cfg.provider).toBe("anthropic");
    expect(cfg.bearer_token).toBeNull();
  });
});

describe("feedback issue target", () => {
  test("always targets the CutReady product repository", () => {
    expect(CUTREADY_FEEDBACK_REPO).toBe("sethjuarez/cutready");
  });
});

// ── canFetchModelsFor ───────────────────────────────────────────

describe("canFetchModelsFor", () => {
  const base = {
    aiProvider: "openai",
    aiAuthMode: "api_key",
    aiApiKey: "",
    aiAccessToken: "",
    aiEndpoint: "",
  };

  test("OpenAI: false when no API key", () => {
    expect(canFetchModelsFor(base)).toBe(false);
  });

  test("OpenAI: true when API key set", () => {
    expect(canFetchModelsFor({ ...base, aiApiKey: "sk-test" })).toBe(true);
  });

  test("Anthropic: always true (hardcoded models)", () => {
    expect(canFetchModelsFor({ ...base, aiProvider: "anthropic" })).toBe(true);
  });

  test("Azure OAuth: true when access token exists", () => {
    expect(
      canFetchModelsFor({
        ...base,
        aiProvider: "azure_openai",
        aiAuthMode: "azure_oauth",
        aiAccessToken: "token",
      })
    ).toBe(true);
  });

  test("Azure OAuth: false when no access token", () => {
    expect(
      canFetchModelsFor({
        ...base,
        aiProvider: "azure_openai",
        aiAuthMode: "azure_oauth",
      })
    ).toBe(false);
  });

  test("Foundry api_key: true when endpoint set (even without key)", () => {
    expect(
      canFetchModelsFor({
        ...base,
        aiProvider: "microsoft_foundry",
        aiEndpoint: "https://resource.ai.azure.com",
      })
    ).toBe(true);
  });

  test("Foundry api_key: true when API key set", () => {
    expect(
      canFetchModelsFor({
        ...base,
        aiProvider: "microsoft_foundry",
        aiApiKey: "my-key",
      })
    ).toBe(true);
  });

  test("Foundry OAuth: true when access token exists", () => {
    expect(
      canFetchModelsFor({
        ...base,
        aiProvider: "microsoft_foundry",
        aiAuthMode: "azure_oauth",
        aiAccessToken: "token",
      })
    ).toBe(true);
  });
});
