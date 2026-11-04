export type SyncErrorKind =
  | "conflict"
  | "identity"
  | "guidance"
  | "offline"
  | "rejected"
  | "auth"
  | "not-found"
  | "other";

export interface SyncErrorView {
  kind: SyncErrorKind;
  /** Plain-language line for the popover; the raw message stays in the tooltip. */
  text: string;
}

export interface SyncErrorClassifiers {
  isIdentityRequired: (message: string) => boolean;
  isGuidance: (message: string) => boolean;
}

/** Turns a raw sync error into what the user should do next. Never hides it. */
export function classifySyncError(message: string, is: SyncErrorClassifiers): SyncErrorView {
  if (message.includes("can't be merged")) {
    return { kind: "conflict", text: "Changes conflict with collaborators. Save a version, then get updates again." };
  }
  if (is.isIdentityRequired(message)) return { kind: "identity", text: "Add your name and email in Settings › Profile" };
  if (is.isGuidance(message)) return { kind: "guidance", text: message };
  if (/network|resolve host|Could not resolve|timed out/.test(message)) {
    return { kind: "offline", text: "Offline — changes saved locally" };
  }
  if (message.includes("Push rejected")) return { kind: "rejected", text: "Collaborators sent work first — get updates, then send" };
  if (/github|sign-in|auth|unauthorized|401/i.test(message)) {
    return { kind: "auth", text: "GitHub sign-in required — reconnect in Settings" };
  }
  if (message.includes("404")) return { kind: "not-found", text: "Remote not found — check the remote URL in Settings" };
  return { kind: "other", text: message };
}

/** GitHub "compare" link for a review branch, or null on main/master or non-GitHub remotes. */
export function pullRequestUrl(remoteUrl: string | null | undefined, branch: string | null | undefined): string | null {
  if (!remoteUrl || !branch || branch === "main" || branch === "master") return null;
  const match = remoteUrl.match(/github\.com[/:]([^/]+\/[^/.]+)/);
  if (!match) return null;
  return `https://github.com/${match[1]}/compare/${branch}?expand=1`;
}
