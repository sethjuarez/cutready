export type ChipStateKind = "failed" | "saving" | "changes" | "to-send" | "saved";

export interface ChipStateInput {
  /** A Save version or Send is running. */
  saving: boolean;
  /** Open edits couldn't be written, so the last versioning action stopped. */
  saveFailed: boolean;
  /** Documents changed since the last version. */
  changedCount: number;
  /** Versions saved here but not yet sent; 0 without a remote. */
  toSendCount: number;
}

export interface ChipState {
  kind: ChipStateKind;
  label: string;
}

const plural = (count: number, one: string, many = `${one}s`) => `${count} ${count === 1 ? one : many}`;

/** The status chip's one state, most urgent first. */
export function chipState({ saving, saveFailed, changedCount, toSendCount }: ChipStateInput): ChipState {
  if (saveFailed) return { kind: "failed", label: "Couldn't save – Retry" };
  if (saving) return { kind: "saving", label: "Saving…" };
  if (changedCount > 0) return { kind: "changes", label: plural(changedCount, "change") };
  if (toSendCount > 0) return { kind: "to-send", label: `${toSendCount} to send` };
  return { kind: "saved", label: "Saved" };
}
