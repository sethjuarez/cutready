// The home prompt box: a textarea plus Project, Agent and Model pickers. Sending hands the
// prompt to the existing chat in the chosen project; there is no separate pipeline.
import { useEffect, useMemo, useState } from "react";
import { ArrowUp, Bot, Cpu, FolderOpen, Paperclip } from "lucide-react";
import { BUILT_IN_AGENTS } from "../../agents/builtInAgents";
import { useSettings } from "../../hooks/useSettings";
import { modelSelectionUpdate, useModelList } from "../../hooks/useModelList";
import { resolveAgentModelOverride, resolveEffectiveProvider } from "../../utils/agentProvider";
import { defaultAgentId, projectPickerOptions, resolveProjectSelection, workspaceName } from "../../utils/home";
import type { RecentProject } from "../../types/project";
import { HomeDropdown } from "./HomeDropdown";

const iconButton =
  "grid h-7 w-7 place-items-center rounded-control text-[rgb(var(--color-text-secondary))] transition-colors duration-fast hover:bg-fill-hover hover:text-[rgb(var(--color-text))] focus:outline-none focus-visible:ring-2 focus-visible:ring-[rgb(var(--color-accent))] disabled:cursor-not-allowed disabled:opacity-40";

interface HomeComposerProps {
  recents: RecentProject[];
  /** The composer's target project; owned by the home view so the cards share it. */
  projectPath: string | null;
  onProjectChange: (path: string) => void;
  onOpenFolder: () => void;
  onSend: (text: string, agentId: string, projectPath: string | null) => Promise<boolean>;
  onAttach: (projectPath: string | null) => Promise<string | null>;
}

export function HomeComposer({ recents, projectPath, onProjectChange, onOpenFolder, onSend, onAttach }: HomeComposerProps) {
  const { settings, updateSetting } = useSettings();
  const [text, setText] = useState("");
  const [busy, setBusy] = useState(false);

  const agents = useMemo(() => [...BUILT_IN_AGENTS, ...(settings.aiAgents || [])], [settings.aiAgents]);
  const [agentId, setAgentId] = useState(() => defaultAgentId(agents));
  const agent = agents.find((a) => a.id === agentId) ?? agents[0];
  const provider = resolveEffectiveProvider(settings, agent);
  const modelOverride = resolveAgentModelOverride(agent, settings.aiAgentModelOverrides);
  const model = modelOverride || provider?.model || settings.aiModel || "";
  const [modelsWanted, setModelsWanted] = useState(false);
  const { models, loading } = useModelList(settings, provider?.id, model, modelsWanted);

  useEffect(() => {
    if (!agents.some((a) => a.id === agentId)) setAgentId(defaultAgentId(agents));
  }, [agents, agentId]);

  const projects = projectPickerOptions(recents);
  const selectedProject = resolveProjectSelection(projectPath, recents);
  const canSend = text.trim().length > 0 && !!selectedProject && !busy;

  const send = async () => {
    if (!canSend) return;
    setBusy(true);
    try {
      if (await onSend(text, agentId, selectedProject)) setText("");
    } finally {
      setBusy(false);
    }
  };

  const attach = async () => {
    const mention = await onAttach(selectedProject);
    if (mention) setText((current) => (current.trim() ? `${current.trimEnd()} ${mention} ` : `${mention} `));
  };

  return (
    <div className="rounded-card border border-[rgb(var(--color-border))] bg-[rgb(var(--color-surface))] px-4 pb-2.5 pt-3.5 shadow-layer focus-within:border-[rgb(var(--color-accent))]">
      <label htmlFor="home-prompt" className="sr-only">Describe what you are presenting</label>
      <textarea
        id="home-prompt"
        data-testid="home-prompt"
        value={text}
        onChange={(e) => setText(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === "Enter" && !e.shiftKey && !e.nativeEvent.isComposing) {
            e.preventDefault();
            void send();
          }
        }}
        rows={3}
        placeholder="A 20-minute keynote on our new agent platform, with two live demos…"
        className="block h-[68px] w-full resize-none bg-transparent text-[15px] leading-[22px] text-[rgb(var(--color-text))] placeholder:text-[rgb(var(--color-text-tertiary))] focus:outline-none"
      />
      <div className="mt-1.5 flex flex-wrap items-center gap-1.5">
        <button
          type="button"
          onClick={() => void attach()}
          disabled={!selectedProject}
          className={iconButton}
          title="Attach a deck or document"
          aria-label="Attach a deck or document"
        >
          <Paperclip className="h-4 w-4" />
        </button>
        <HomeDropdown
          label="Project"
          testId="home-project-picker"
          icon={<FolderOpen className="h-3.5 w-3.5" />}
          options={projects.map((p) => ({ value: p.path, label: workspaceName(p.path), description: p.path }))}
          selected={selectedProject}
          onSelect={onProjectChange}
          placeholder="No project"
          emptyText="No recent projects"
          action={{ label: "Open folder…", icon: <FolderOpen className="h-3.5 w-3.5" />, onSelect: onOpenFolder }}
        />
        <HomeDropdown
          label="Agent"
          testId="home-agent-picker"
          icon={<Bot className="h-3.5 w-3.5" />}
          options={agents.map((a) => ({ value: a.id, label: a.name, description: a.description }))}
          selected={agentId}
          onSelect={setAgentId}
        />
        <div onFocusCapture={() => setModelsWanted(true)} onMouseEnter={() => setModelsWanted(true)}>
          <HomeDropdown
            label="Model"
            testId="home-model-picker"
            icon={<Cpu className="h-3.5 w-3.5" />}
            options={(models.includes(model) || !model ? models : [model, ...models]).map((id) => ({ value: id, label: id }))}
            selected={model || null}
            onSelect={(next) => {
              if (modelOverride) {
                // The agent's override wins over the connection model, so change the override.
                const metadata = { ...(settings.aiAgentModelOverrideMetadata || {}) };
                delete metadata[agent.id];
                void updateSetting("aiAgentModelOverrides", { ...(settings.aiAgentModelOverrides || {}), [agent.id]: next });
                void updateSetting("aiAgentModelOverrideMetadata", metadata);
                return;
              }
              const update = modelSelectionUpdate(settings, provider?.id, next);
              void updateSetting(update.key, update.value);
            }}
            placeholder="Default model"
            loading={loading}
            emptyText="No models available"
          />
        </div>
        <div className="flex-1" />
        <button
          type="button"
          onClick={() => void send()}
          disabled={!canSend}
          data-testid="home-send"
          title={selectedProject ? "Send to chat (Enter)" : "Open a project to send"}
          aria-label="Send to chat"
          className="grid h-7 w-7 place-items-center rounded-control bg-[rgb(var(--color-accent))] text-[rgb(var(--color-accent-fg))] transition-colors duration-fast hover:bg-[rgb(var(--color-accent-hover))] focus:outline-none focus-visible:ring-2 focus-visible:ring-[rgb(var(--color-accent))] focus-visible:ring-offset-2 focus-visible:ring-offset-[rgb(var(--color-surface))] disabled:cursor-not-allowed disabled:opacity-40"
        >
          <ArrowUp className="h-4 w-4" />
        </button>
      </div>
    </div>
  );
}
