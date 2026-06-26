import { useCallback, useMemo } from "react";
import { BUILT_IN_AGENTS, resolveAgentPrompt } from "../agents/builtInAgents";
import { clearSuppressedEditorFlush, suppressEditorFlush, useAppStore } from "../stores/appStore";
import { useToastStore } from "../stores/toastStore";
import { useSettings, type AgentPreset } from "./useSettings";
import { loadProviderSecrets } from "./useSecretStore";
import { invoke } from "../services/tauri";
import type { ChatMessage } from "../types/sketch";
import {
  activeProviderInput,
  buildProviderConfig,
  defaultProvider,
  providerById,
  providerToConfigInput,
} from "../utils/providerConfig";

interface AgentChatResult {
  messages: ChatMessage[];
  response: string;
}

interface BackgroundAgentActionOptions {
  agent?: string;
  label?: string;
}

const SKETCH_MUTATION_TOOLS = new Set(["write_sketch", "update_planning_row", "set_row_visual", "design_plan"]);

function resolveAgentModelOverride(agent: AgentPreset, overrides: Record<string, string> | undefined): string {
  return (overrides?.[agent.id] || agent.modelOverride || "").trim();
}

function resolveAgentProviderOverride(agent: AgentPreset, overrides: Record<string, string> | undefined): string {
  return (overrides?.[agent.id] || agent.providerOverride || "").trim();
}

function normalizeMutationPath(path: string | null | undefined): string | null {
  const normalized = path?.trim().replace(/\\/g, "/");
  return normalized ? normalized : null;
}

function sketchMutationInfo(toolName: string, argsJson: string, fallbackPath: string | null) {
  if (!SKETCH_MUTATION_TOOLS.has(toolName)) return null;
  try {
    const args = JSON.parse(argsJson || "{}");
    const path = typeof args.path === "string" ? args.path : fallbackPath;
    const changedRows: number[] = [];
    if (toolName === "update_planning_row" || toolName === "set_row_visual" || toolName === "design_plan") {
      const idx = typeof args.index === "number" ? args.index : parseInt(String(args.index), 10);
      if (!Number.isNaN(idx)) changedRows.push(idx);
    }
    return { path, rows: changedRows, toolName };
  } catch {
    return { path: fallbackPath, rows: [], toolName };
  }
}

function storyboardMutationInfo(toolName: string, argsJson: string, fallbackPath: string | null) {
  if (toolName !== "write_storyboard") return null;
  try {
    const args = JSON.parse(argsJson || "{}");
    const path = typeof args.path === "string" ? args.path : fallbackPath;
    return { path, toolName };
  } catch {
    return { path: fallbackPath, toolName };
  }
}

function noteMutationPath(argsJson: string, fallbackPath: string | null) {
  try {
    const args = JSON.parse(argsJson || "{}");
    return typeof args.path === "string" ? args.path : fallbackPath;
  } catch {
    return fallbackPath;
  }
}

function buildAgentPrompts(settingsAgents: AgentPreset[] | undefined) {
  const prompts: Record<string, string> = {};
  for (const agent of BUILT_IN_AGENTS) prompts[agent.id] = agent.prompt;
  for (const agent of settingsAgents || []) prompts[agent.id] = agent.prompt;
  return prompts;
}

export function useBackgroundAgentAction() {
  const { settings, updateSetting } = useSettings();
  const showToast = useToastStore((s) => s.show);
  const activeSketchPath = useAppStore((s) => s.activeSketchPath);
  const activeStoryboardPath = useAppStore((s) => s.activeStoryboardPath);
  const activeNotePath = useAppStore((s) => s.activeNotePath);
  const loadSketches = useAppStore((s) => s.loadSketches);
  const loadStoryboards = useAppStore((s) => s.loadStoryboards);
  const loadNotes = useAppStore((s) => s.loadNotes);
  const openSketch = useAppStore((s) => s.openSketch);
  const openStoryboard = useAppStore((s) => s.openStoryboard);
  const openNote = useAppStore((s) => s.openNote);
  const checkDirty = useAppStore((s) => s.checkDirty);
  const refreshChangedFiles = useAppStore((s) => s.refreshChangedFiles);
  const addActivityEntries = useAppStore((s) => s.addActivityEntries);

  const agents = useMemo(() => [...BUILT_IN_AGENTS, ...(settings.aiAgents || [])], [settings.aiAgents]);

  const buildEffectiveProviderInput = useCallback(async (agent: AgentPreset) => {
    const providerOverride = resolveAgentProviderOverride(agent, settings.aiAgentProviderOverrides);
    const overrideProvider = providerById(settings, providerOverride);
    const selectedProvider = overrideProvider ?? defaultProvider(settings);
    if (!selectedProvider) return activeProviderInput(settings);

    const secrets = selectedProvider.id === settings.aiActiveProviderId
      ? { apiKey: settings.aiApiKey, accessToken: settings.aiAccessToken }
      : await loadProviderSecrets(selectedProvider.id);
    return providerToConfigInput(selectedProvider, settings, {
      apiKey: secrets.apiKey,
      accessToken: secrets.accessToken,
    });
  }, [settings]);

  const buildSystemPrompt = useCallback((agentId: string) => {
    let prompt = resolveAgentPrompt(agentId, settings.aiAgents || []);
    if (activeSketchPath) {
      prompt += `\n\nThe user is currently editing the sketch at: ${activeSketchPath}`;
    }
    if (activeStoryboardPath) {
      prompt += `\n\nThe user is currently editing the storyboard at: ${activeStoryboardPath}. Use the read_storyboard tool with this path to see its sequence and description before making suggestions.`;
    }
    if (activeNotePath) {
      prompt += `\n\nThe user is currently editing the note at: ${activeNotePath}. Use the read_note tool with this path to see its contents before making suggestions.`;
    }
    return prompt;
  }, [activeNotePath, activeSketchPath, activeStoryboardPath, settings.aiAgents]);

  const refreshAfterResult = useCallback(async (result: AgentChatResult) => {
    const fallbackSketchPath = useAppStore.getState().activeSketchPath;
    const fallbackStoryboardPath = useAppStore.getState().activeStoryboardPath;
    const fallbackNotePath = useAppStore.getState().activeNotePath;
    const sketchMutations: Array<{ path: string | null; rows: number[]; toolName: string }> = [];
    const storyboardMutations: Array<{ path: string | null; toolName: string }> = [];
    const noteMutations: Array<{ path: string | null }> = [];

    for (const message of result.messages) {
      for (const toolCall of message.tool_calls ?? []) {
        const toolName = toolCall.function.name;
        const argsJson = toolCall.function.arguments;
        const sketchMutation = sketchMutationInfo(toolName, argsJson, fallbackSketchPath);
        if (sketchMutation) sketchMutations.push(sketchMutation);
        const storyboardMutation = storyboardMutationInfo(toolName, argsJson, fallbackStoryboardPath);
        if (storyboardMutation) storyboardMutations.push(storyboardMutation);
        if (toolName === "write_note") noteMutations.push({ path: noteMutationPath(argsJson, fallbackNotePath) });
      }
    }

    for (const mutation of sketchMutations) {
      const mutationPath = normalizeMutationPath(mutation.path);
      const affectedPath = mutationPath ?? normalizeMutationPath(fallbackSketchPath);
      if (affectedPath) suppressEditorFlush(affectedPath);
      await loadSketches();
      window.dispatchEvent(new CustomEvent("cutready:ai-sketch-updated", { detail: mutation }));
      if (mutationPath) await openSketch(mutationPath);
      if (affectedPath) globalThis.setTimeout(() => clearSuppressedEditorFlush(affectedPath), 100);
    }

    for (const mutation of storyboardMutations) {
      const mutationPath = normalizeMutationPath(mutation.path);
      if (mutationPath) suppressEditorFlush(mutationPath);
      await loadStoryboards();
      window.dispatchEvent(new CustomEvent("cutready:ai-storyboard-updated", { detail: mutation }));
      if (mutationPath) await openStoryboard(mutationPath);
      if (mutationPath) globalThis.setTimeout(() => clearSuppressedEditorFlush(mutationPath), 100);
    }

    for (const mutation of noteMutations) {
      await loadNotes();
      const mutationPath = normalizeMutationPath(mutation.path);
      if (mutationPath && mutationPath !== normalizeMutationPath(fallbackNotePath)) {
        await openNote(mutationPath);
      }
      window.dispatchEvent(new CustomEvent("cutready:ai-note-updated", { detail: { path: mutationPath } }));
    }

    if (sketchMutations.length > 0 || storyboardMutations.length > 0 || noteMutations.length > 0) {
      await checkDirty();
      await refreshChangedFiles();
    }
  }, [checkDirty, loadNotes, loadSketches, loadStoryboards, openNote, openSketch, openStoryboard, refreshChangedFiles]);

  return useCallback(async (prompt: string, options: BackgroundAgentActionOptions = {}) => {
    const label = options.label ?? "AI action";
    const agentId = options.agent || settings.aiSelectedAgent || "planner";
    const effectiveAgent = agents.find((agent) => agent.id === agentId) ?? agents.find((agent) => agent.id === "planner") ?? BUILT_IN_AGENTS[0];

    addActivityEntries([{
      id: crypto.randomUUID(),
      timestamp: new Date(),
      source: "background-ai",
      content: `Started ${label}`,
      level: "info",
    }]);
    window.dispatchEvent(new CustomEvent("cutready:agent-runs-updated"));
    const runningRefreshTimer = globalThis.setTimeout(() => {
      window.dispatchEvent(new CustomEvent("cutready:agent-runs-updated"));
    }, 750);
    showToast(`${label} started in Runs`, 3000, "info");

    try {
      let freshBearerToken = settings.aiAuthMode === "azure_oauth" ? settings.aiAccessToken : null;
      if (settings.aiAuthMode === "azure_oauth" && settings.aiRefreshToken) {
        try {
          const tokenResult = await invoke<{ access_token: string; refresh_token?: string }>("azure_token_refresh", {
            tenantId: settings.aiTenantId || "",
            refreshToken: settings.aiRefreshToken,
            clientId: settings.aiClientId || null,
          });
          if (tokenResult.access_token) {
            freshBearerToken = tokenResult.access_token;
            await updateSetting("aiAccessToken", tokenResult.access_token);
            if (tokenResult.refresh_token) {
              await updateSetting("aiRefreshToken", tokenResult.refresh_token);
            }
          }
        } catch {
          // The provider request below will surface any auth failure with the current token.
        }
      }

      const modelOverride = resolveAgentModelOverride(effectiveAgent, settings.aiAgentModelOverrides);
      const providerConfig = buildProviderConfig(await buildEffectiveProviderInput(effectiveAgent));
      if (!resolveAgentProviderOverride(effectiveAgent, settings.aiAgentProviderOverrides) && freshBearerToken) {
        providerConfig.bearer_token = freshBearerToken;
      }
      const result = await invoke<AgentChatResult>("agent_chat_with_tools", {
        config: {
          ...providerConfig,
          ...(modelOverride ? { model: modelOverride } : {}),
        },
        messages: [
          { role: "system", content: buildSystemPrompt(effectiveAgent.id) },
          { role: "user", content: prompt },
        ],
        agentPrompts: buildAgentPrompts(settings.aiAgents),
        agentId: effectiveAgent.id,
        emitEvents: false,
      });

      await refreshAfterResult(result);
      addActivityEntries([{
        id: crypto.randomUUID(),
        timestamp: new Date(),
        source: "background-ai",
        content: `Completed ${label}`,
        level: "success",
      }]);
      showToast(`${label} complete`, 3000, "success");
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      addActivityEntries([{
        id: crypto.randomUUID(),
        timestamp: new Date(),
        source: "background-ai",
        content: `${label} failed: ${message}`,
        level: "error",
      }]);
      showToast(`${label} failed: ${message}`, 5000, "error");
    } finally {
      globalThis.clearTimeout(runningRefreshTimer);
      window.dispatchEvent(new CustomEvent("cutready:agent-runs-updated"));
    }
  }, [addActivityEntries, agents, buildEffectiveProviderInput, buildSystemPrompt, refreshAfterResult, settings, showToast, updateSetting]);
}
