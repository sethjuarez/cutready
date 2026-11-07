export type SendGateKind =
  /** No remote is connected, so there's nothing to send to. */
  | "no-remote"
  | "busy"
  /** Waiting for the first sync status. */
  | "checking"
  /** Nothing new since the last send. */
  | "up-to-date"
  /** Collaborators sent work that has to come in first. */
  | "behind"
  /** Unsaved changes: save them as a version, then send. */
  | "save-first"
  /** Both sides moved: get updates, then send. */
  | "sync"
  /** Versions to send and a clean workspace. */
  | "direct";

export interface SendGateInput {
  hasRemote: boolean;
  isSyncing: boolean;
  status: { ahead: number; behind: number } | null;
  changedCount: number;
}

export interface SendGate {
  kind: SendGateKind;
  /** Versions this send would share (excluding the one save-first creates). */
  toSend: number;
  enabled: boolean;
}

/**
 * Decides what Send does. Unsaved changes always offer a version first, and
 * nothing new means Send is disabled ("Up to date").
 */
export function sendGate({ hasRemote, isSyncing, status, changedCount }: SendGateInput): SendGate {
  const ahead = status?.ahead ?? 0;
  if (!hasRemote) return { kind: "no-remote", toSend: 0, enabled: false };
  if (isSyncing) return { kind: "busy", toSend: ahead, enabled: false };
  if (!status) return { kind: "checking", toSend: 0, enabled: false };
  if (changedCount > 0) return { kind: "save-first", toSend: ahead, enabled: true };
  if (ahead > 0 && status.behind > 0) return { kind: "sync", toSend: ahead, enabled: true };
  if (ahead > 0) return { kind: "direct", toSend: ahead, enabled: true };
  if (status.behind > 0) return { kind: "behind", toSend: 0, enabled: false };
  return { kind: "up-to-date", toSend: 0, enabled: false };
}

const plural = (count: number, one: string, many = `${one}s`) => `${count} ${count === 1 ? one : many}`;
const lowerFirst = (text: string) => `${text.charAt(0).toLowerCase()}${text.slice(1)}`;

/** Button label for a gate; `sendLabel` is "Send" or, for hybrid projects, "Send for review". */
export function sendGateLabel(gate: SendGate, sendLabel: string, behind = 0): string {
  switch (gate.kind) {
    case "no-remote": return "Not connected";
    case "busy": return "Sending…";
    case "checking": return "Checking…";
    case "up-to-date": return "Up to date";
    case "behind": return `Get ${plural(behind, "update")} first`;
    case "save-first": return `Save & ${lowerFirst(sendLabel)}`;
    case "sync": return `Sync & ${lowerFirst(sendLabel)}`;
    case "direct": return `${sendLabel} ${plural(gate.toSend, "version")}`;
  }
}
