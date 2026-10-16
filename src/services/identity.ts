import { invoke, listen } from "./tauri";

export type IdentitySource = "profile" | "environment" | "git_config" | "system" | "fallback";

export interface ContributorProfile {
  name: string;
  email?: string;
}

/** Who CutReady attributes snapshots to. */
export interface ResolvedIdentity {
  name: string;
  email: string | null;
  name_source: IdentitySource;
  email_source: IdentitySource | null;
  profile: ContributorProfile | null;
  needs_setup: boolean;
}

export function getContributorIdentity() {
  return invoke<ResolvedIdentity>("get_contributor_identity");
}

export function setContributorIdentity(name: string, email: string) {
  return invoke<ResolvedIdentity>("set_contributor_identity", { name, email });
}

export function clearContributorIdentity() {
  return invoke<ResolvedIdentity>("clear_contributor_identity");
}

const SOURCE_LABELS: Record<IdentitySource, string> = {
  profile: "your CutReady profile",
  environment: "GIT_AUTHOR environment variables",
  git_config: "git config",
  system: "your system username",
  fallback: "a default",
};

export function identitySourceLabel(source: IdentitySource | null) {
  return source ? SOURCE_LABELS[source] : "nowhere";
}

export function formatIdentity(identity: Pick<ResolvedIdentity, "name" | "email">) {
  return identity.email ? `${identity.name} <${identity.email}>` : identity.name;
}

/** Error code the backend returns when a save would have no known author email. */
export const CONTRIBUTOR_IDENTITY_REQUIRED = "contributor_identity_required";
const CONTRIBUTOR_IDENTITY_REQUIRED_HINT = "Add your name and email in Settings › Profile";

/** True when an error (or its message) says CutReady needs the user's name and email first. */
export function isContributorIdentityRequired(error: unknown): boolean {
  if (!error) return false;
  if (typeof error === "string") return error.includes(CONTRIBUTOR_IDENTITY_REQUIRED_HINT);
  if (typeof error === "object") {
    const { code, message } = error as { code?: unknown; message?: unknown };
    if (code === CONTRIBUTOR_IDENTITY_REQUIRED) return true;
    if (typeof message === "string") return message.includes(CONTRIBUTOR_IDENTITY_REQUIRED_HINT);
  }
  return false;
}

/** Emitted when an automatic workspace save stays pending because CutReady doesn't know who is acting. */
export const WORKSPACE_SNAPSHOT_DEFERRED_EVENT = "workspace-snapshot-deferred";

/** Why an automatic save stayed pending: no known author, or it touched unsaved edits. */
export type SnapshotDeferReason = "identity" | "unsaved_edits";

export function onWorkspaceSnapshotDeferred(
  handler: (message: string, reason: SnapshotDeferReason) => void,
) {
  return listen<{ message?: unknown; reason?: unknown }>(WORKSPACE_SNAPSHOT_DEFERRED_EVENT, (event) => {
    const message = event.payload?.message;
    const reason = event.payload?.reason === "unsaved_edits" ? "unsaved_edits" : "identity";
    if (typeof message === "string" && message.trim()) handler(message, reason);
  });
}
