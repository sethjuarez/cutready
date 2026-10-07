import { describe, test, expect } from "vitest";
import { CUTREADY_FEEDBACK_REPO } from "../components/SettingsPanel";
import {
  activeProviderInput,
  buildProviderConfig,
  canFetchModelsFor,
  defaultProvider,
  filterAgentCompatibleModels,
  isAgentCompatibleModel,
  isAiProviderConfigured,
  isProviderInputConfigured,
  narrationProvider,
  needsResponsesApi,
  providerById,
  providerToConfigInput,
  supportsAgentReasoningEffort,
  supportedReasoningEfforts,
} from "../utils/providerConfig";
import type { AiProviderConfig } from "../hooks/useSettings";

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
    expect(cfg.execution_engine).toBe("prompty");
  });

  test("Prompty TurnEngine is the default engine", () => {
    expect(buildProviderConfig(base).execution_engine).toBe("prompty");
    expect(buildProviderConfig(base, "prompty").execution_engine).toBe("prompty");
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

  test("includes supported reasoning effort and drops unsupported selections", () => {
    expect(supportedReasoningEfforts("openai", "gpt-6.1-sol")).toContain("xhigh");

    const supported = buildProviderConfig({
      ...base,
      aiModel: "gpt-6.1-sol",
      aiReasoningEffort: "high",
    }, "agentive");
    expect(supported.reasoning_effort).toBe("high");

    const unsupported = buildProviderConfig({
      ...base,
      aiModel: "gpt-4o",
      aiReasoningEffort: "high",
    });
    expect(unsupported.reasoning_effort).toBeNull();
  });

  test("omits agent reasoning effort for chat-completions models", () => {
    expect(supportedReasoningEfforts("openai", "gpt-5.6-luna")).toContain("high");
    expect(needsResponsesApi("gpt-5.6-luna")).toBe(false);
    expect(supportsAgentReasoningEffort("gpt-5.6-luna")).toBe(false);

    const promptyChat = buildProviderConfig({
      ...base,
      aiModel: "gpt-5.6-luna",
      aiReasoningEffort: "high",
    });
    expect(promptyChat.reasoning_effort).toBeNull();

    const nonPromptyChat = buildProviderConfig({
      ...base,
      aiModel: "gpt-5.6-luna",
      aiReasoningEffort: "high",
    }, "agentive");
    expect(nonPromptyChat.reasoning_effort).toBeNull();

    const providerOwned = buildProviderConfig({
      ...base,
      aiModel: "gpt-6.1-sol",
      aiReasoningEffort: "high",
    }, "copilot-sdk");
    expect(providerOwned.reasoning_effort).toBeNull();
  });

  test("keeps agent reasoning effort for responses-routed models", () => {
    expect(needsResponsesApi("gpt-5.1-codex")).toBe(true);
    expect(supportsAgentReasoningEffort("gpt-5.1-codex")).toBe(true);
    expect(needsResponsesApi("gpt-6.1-sol")).toBe(true);
    expect(supportsAgentReasoningEffort("gpt-6.1-sol")).toBe(true);

    const cfg = buildProviderConfig({
      ...base,
      aiModel: "gpt-6.1-sol",
      aiReasoningEffort: "high",
    });
    expect(cfg.reasoning_effort).toBe("high");
  });

  test("uses discovered reasoning efforts for deployment aliases", () => {
    const cfg = buildProviderConfig({
      ...base,
      aiProvider: "microsoft_foundry",
      aiModel: "demo-deployment",
      aiModelBaseModel: "gpt-6-astra",
      aiModelReasoningEfforts: "low,medium,high",
      aiReasoningEffort: "medium",
    });

    expect(cfg.model_base_model).toBe("gpt-6-astra");
    expect(cfg.reasoning_effort).toBe("medium");
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

describe("agent model compatibility", () => {
  test("keeps chat and responses models that can run agents", () => {
    const models = filterAgentCompatibleModels([
      { id: "gpt-4o", capabilities: { chat_completion: "true", tool_calling: "true" }, context_length: 128000 },
      { id: "gpt-5-codex", capabilities: { responses_api: "true", tool_calling: "true" }, context_length: 272000 },
      { id: "text-embedding-3-large", capabilities: { chat_completion: "false", responses_api: "false" } },
      { id: "dall-e-3", capabilities: { chat_completion: "false", responses_api: "false" } },
      { id: "gpt-4o-transcribe", capabilities: { chat_completion: "false", responses_api: "false" } },
      { id: "gpt-4o-realtime-preview", capabilities: { chat_completion: "true", tool_calling: "true" } },
      { id: "gpt-realtime", capabilities: { chat_completion: "true", tool_calling: "true" } },
      { id: "gpt-4o-audio-preview", capabilities: { chat_completion: "true", tool_calling: "true" } },
    ], "openai");

    expect(models.map((model) => model.id)).toEqual(["gpt-4o", "gpt-5-codex"]);
  });

  test("uses deployment owned_by when classifying Foundry aliases", () => {
    expect(isAgentCompatibleModel({
      id: "demo-prod",
      owned_by: "gpt-6-astra",
      capabilities: { chat_completion: "true", tool_calling: "true" },
    }, "microsoft_foundry")).toBe(true);

    expect(isAgentCompatibleModel({
      id: "embedding-prod",
      owned_by: "text-embedding-3-large",
      capabilities: { chat_completion: "false", responses_api: "false" },
    }, "microsoft_foundry")).toBe(false);
  });

  test("drops models that explicitly do not support tool calling", () => {
    expect(isAgentCompatibleModel({
      id: "gpt-lite",
      capabilities: { chat_completion: "true", tool_calling: "false" },
    }, "openai")).toBe(false);
  });
});

describe("feedback issue target", () => {
  test("always targets the CutReady product repository", () => {
    expect(CUTREADY_FEEDBACK_REPO).toBe("sethjuarez/cutready");
  });

  describe("provider list resolution", () => {
    const openaiProvider: AiProviderConfig = {
      id: "openai-main",
      name: "OpenAI Main",
      provider: "openai",
      authMode: "api_key",
      endpoint: "",
      model: "gpt-4o",
      modelBaseModel: "",
      contextLength: 128000,
      modelSupportsVision: "true",
      tenantId: "",
      clientId: "",
      subscriptionId: "",
      resourceGroup: "",
      resourceName: "",
    };
    const anthropicProvider: AiProviderConfig = {
      ...openaiProvider,
      id: "anthropic-main",
      name: "Anthropic Main",
      provider: "anthropic",
      model: "claude-sonnet-4-6",
      contextLength: 200000,
      modelSupportsVision: "false",
    };

    test("activeProviderInput uses the active provider with active-provider secrets", () => {
      const input = activeProviderInput({
        aiProvider: "azure_openai",
        aiEndpoint: "legacy-endpoint",
        aiApiKey: "sk-openai",
        aiModel: "legacy-model",
        aiAuthMode: "api_key",
        aiAccessToken: "",
        aiProviders: [openaiProvider, anthropicProvider],
        aiActiveProviderId: "openai-main",
        aiDefaultProviderId: "anthropic-main",
      });

      expect(input.provider).toBe("openai");
      expect(input.providerId).toBe("openai-main");
      expect(input.providerName).toBe("OpenAI Main");
      expect(input.apiKey).toBe("sk-openai");
      expect(input.model).toBe("gpt-4o");
    });

    test("defaultProvider can resolve a configured non-active runtime provider", () => {
      const settings = {
        aiProvider: "azure_openai",
        aiEndpoint: "",
        aiApiKey: "",
        aiModel: "",
        aiAuthMode: "api_key",
        aiAccessToken: "",
        aiProviders: [openaiProvider, anthropicProvider],
        aiActiveProviderId: "openai-main",
        aiDefaultProviderId: "anthropic-main",
      };
      const runtimeProvider = defaultProvider(settings);

      expect(runtimeProvider?.id).toBe("anthropic-main");
      expect(isProviderInputConfigured(providerToConfigInput(runtimeProvider!, {
        aiVisionMode: "notes",
        aiWebAccess: "disabled",
      }, {
        apiKey: "sk-ant-test",
      }))).toBe(true);
    });

    test("providerToConfigInput builds a non-active provider request from scoped secrets", () => {
      const input = providerToConfigInput(anthropicProvider, {
        aiVisionMode: "notes",
        aiWebAccess: "enabled",
      }, {
        apiKey: "sk-ant-test",
      });
      const config = buildProviderConfig(input);

      expect(config.provider).toBe("anthropic");
      expect(config.provider_id).toBe("anthropic-main");
      expect(config.provider_name).toBe("Anthropic Main");
      expect(config.api_key).toBe("sk-ant-test");
      expect(config.model).toBe("claude-sonnet-4-6");
      expect(config.vision_mode).toBe("notes");
      expect(config.web_access).toBe("enabled");
      expect(config.model_supports_vision).toBe(false);
    });

    test("providerById returns null for missing overrides", () => {
      expect(providerById({
        aiProvider: "openai",
        aiEndpoint: "",
        aiApiKey: "",
        aiModel: "",
        aiAuthMode: "api_key",
        aiAccessToken: "",
        aiProviders: [openaiProvider],
      }, "missing")).toBeNull();
    });
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

  test("Anthropic: false when no API key", () => {
    expect(canFetchModelsFor({ ...base, aiProvider: "anthropic" })).toBe(false);
  });

  test("Anthropic: true when API key set", () => {
    expect(canFetchModelsFor({ ...base, aiProvider: "anthropic", aiApiKey: "sk-ant-test" })).toBe(true);
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

describe("isAiProviderConfigured", () => {
  const base = {
    aiProvider: "openai",
    aiAuthMode: "api_key",
    aiApiKey: "",
    aiAccessToken: "",
    aiEndpoint: "",
    aiModel: "gpt-4o",
  };

  test("Anthropic: true with API key and model without endpoint", () => {
    expect(isAiProviderConfigured({
      ...base,
      aiProvider: "anthropic",
      aiApiKey: "sk-ant-test",
      aiEndpoint: "",
      aiModel: "claude-sonnet-4-6",
    })).toBe(true);
  });

  test("Anthropic: false without API key", () => {
    expect(isAiProviderConfigured({
      ...base,
      aiProvider: "anthropic",
      aiEndpoint: "",
      aiModel: "claude-sonnet-4-6",
    })).toBe(false);
  });

  test("OpenAI: true with API key and model without endpoint", () => {
    expect(isAiProviderConfigured({
      ...base,
      aiEndpoint: "",
      aiApiKey: "sk-test",
    })).toBe(true);
  });

  test("OpenAI: false without API key", () => {
    expect(isAiProviderConfigured({
      ...base,
      aiEndpoint: "",
    })).toBe(false);
  });

  test("Azure OpenAI: requires endpoint, API key, and model in api_key mode", () => {
    expect(isAiProviderConfigured({
      ...base,
      aiProvider: "azure_openai",
      aiEndpoint: "https://api.openai.com",
      aiApiKey: "sk-test",
    })).toBe(true);
    expect(isAiProviderConfigured({
      ...base,
      aiProvider: "azure_openai",
      aiApiKey: "sk-test",
    })).toBe(false);
  });

  test("any provider requires a model", () => {
    expect(isAiProviderConfigured({
      ...base,
      aiProvider: "anthropic",
      aiApiKey: "sk-ant-test",
      aiModel: "",
    })).toBe(false);
  });
});

// ── narrationProvider (shared connection pool) ──────────────────

describe("narrationProvider", () => {
  const foundry: AiProviderConfig = {
    id: "foundry-1",
    name: "Foundry",
    provider: "microsoft_foundry",
    authMode: "azure_oauth",
    endpoint: "https://demo.services.ai.azure.com",
    model: "gpt-4o",
    contextLength: 128000,
    modelSupportsVision: "true",
    tenantId: "",
    clientId: "",
    subscriptionId: "",
    resourceGroup: "",
    resourceName: "",
  };
  const openai: AiProviderConfig = {
    ...foundry,
    id: "openai-1",
    name: "OpenAI",
    provider: "openai",
    authMode: "api_key",
    endpoint: "",
  };
  const base = {
    aiProvider: "openai",
    aiEndpoint: "",
    aiApiKey: "",
    aiModel: "",
    aiAuthMode: "api_key",
    aiAccessToken: "",
  };

  test("shared mode reuses the active provider when it can serve narration", () => {
    const chosen = narrationProvider({
      ...base,
      aiProviders: [foundry],
      aiActiveProviderId: "foundry-1",
      narrationConnectionMode: "reuse_active_foundry",
      narrationProviderId: "",
    });
    expect(chosen?.id).toBe("foundry-1");
  });

  test("shared mode falls back to a dedicated pool connection when the active provider can't serve narration", () => {
    // Active harness provides its own (non-Azure/Foundry) provider — e.g. the
    // Copilot entitlement — so narration must not break; it falls back to the
    // Foundry connection still present in the shared pool.
    const chosen = narrationProvider({
      ...base,
      aiProviders: [openai, foundry],
      aiActiveProviderId: "openai-1",
      narrationConnectionMode: "reuse_active_foundry",
      narrationProviderId: "foundry-1",
    });
    expect(chosen?.id).toBe("foundry-1");
  });

  test("dedicated mode uses the chosen narration connection", () => {
    const chosen = narrationProvider({
      ...base,
      aiProviders: [openai, foundry],
      aiActiveProviderId: "openai-1",
      narrationConnectionMode: "dedicated",
      narrationProviderId: "foundry-1",
    });
    expect(chosen?.id).toBe("foundry-1");
  });

  test("returns null when the shared pool has no Foundry/Azure connection", () => {
    const chosen = narrationProvider({
      ...base,
      aiProviders: [openai],
      aiActiveProviderId: "openai-1",
      narrationConnectionMode: "reuse_active_foundry",
      narrationProviderId: "",
    });
    expect(chosen).toBeNull();
  });
});
