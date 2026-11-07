export function providerRunLabel(provider: string | undefined): string {
  switch ((provider ?? "").toLowerCase()) {
    case "microsoft_foundry":
      return "Microsoft Foundry";
    case "azure_openai":
      return "Azure OpenAI";
    case "openai":
      return "OpenAI";
    case "anthropic":
      return "Anthropic";
    case "copilot-sdk":
      return "GitHub Copilot";
    default:
      return provider?.trim() || "—";
  }
}

export function harnessRunLabel(harness: string | undefined): string {
  switch ((harness ?? "").toLowerCase()) {
    case "prompty":
      return "Prompty";
    case "agentive":
      return "Agentive";
    case "copilot-sdk":
      return "GitHub Copilot";
    default:
      return harness?.trim() || "—";
  }
}

export function formatRunDuration(ms: number | undefined): string {
  if (typeof ms !== "number" || !Number.isFinite(ms) || ms < 0) return "—";
  if (ms < 1_000) return `${Math.round(ms)}ms`;
  const seconds = ms / 1_000;
  if (seconds < 60) return `${seconds.toFixed(seconds < 10 ? 1 : 0)}s`;
  const minutes = Math.floor(seconds / 60);
  const remainingSeconds = Math.round(seconds % 60);
  return `${minutes}m ${remainingSeconds}s`;
}

export function formatRunTokens(tokens: number | undefined): string {
  if (typeof tokens !== "number" || !Number.isFinite(tokens) || tokens < 0) return "—";
  return Math.round(tokens).toLocaleString();
}

export function reasoningEffortLabel(effort: string | undefined): string {
  if (!effort) return "Default";
  return effort === "xhigh" ? "X-high" : effort[0].toUpperCase() + effort.slice(1);
}
