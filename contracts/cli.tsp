import "@typra/emitter";
import "./errors.tsp";

namespace CutReady.Contracts;

/*
 * The `cutready-cli` wire. Every command prints exactly one of these as JSON
 * on stdout (and exits non-zero with a `CommandFailure`); the MCP server
 * returns the same models as each tool's `structuredContent`. Reviews are
 * `RunReview[]`.
 */

/** A document as it is on disk now (`read_document`). */
@serializable
model DocumentSnapshot {
  /** Project-relative path. */
  path: string;

  /** The file's text, or null when it doesn't exist. */
  content: string | null;

  /** `EditService.documentVersion` of the bytes; null when the file doesn't exist. */
  version: string | null;
}

/** A run that was started (`begin_run`); its writes wait for Keep or Undo. */
@serializable
model RunStarted {
  run_id: string;
}

/** One batch applied to one document (`edit`, `apply_ops`). */
@serializable
model AppliedEdit {
  run_id: string;

  /** Project-relative path. */
  path: string;

  /** The document's version after the batch: what the next edit expects. */
  version: string;

  /** False when the batch left the bytes as they were; nothing was logged. */
  changed: boolean;

  /** The op-log entry of the write, or null when nothing changed. */
  seq: uint64 | null;

  /** For notes: the lock now in force. */
  note_locked?: boolean;

  /** For notes: the batch changed the lock. */
  note_lock_changed?: boolean;
}

union ReviewAction {
  keep: "keep",
  undo: "undo",
}

/** A run's changes to one document were kept or undone (`keep`, `undo`). */
@serializable
model ReviewResolution {
  run_id: string;
  path: string;
  resolved: ReviewAction;
}

/** `validate`: whether each document loads. `ok` is true when all of them do. */
@serializable
model ValidationReport {
  ok: boolean;
  documents: DocumentValidation[];
}

model DocumentValidation {
  /** Project-relative path. */
  path: string;

  ok: boolean;

  /** The version an edit must expect, when the document loads. */
  version?: string;

  /** Why it doesn't load. */
  error?: CmdError;
}

/** What a failed command prints. */
@serializable
model CommandFailure {
  error: CmdError;
}

/** One installed `cutready-cli`, as `register` records it and `discover` reports it. */
@serializable
model CliInstall {
  /** Absolute path of the binary. */
  path: string;

  /** Its SemVer version. */
  version: string;

  /** The edit contract it speaks. */
  contract_version: uint32;
}

union RegistrationOutcome {
  /** Nothing usable was registered before. */
  registered: "registered",

  /** An older, equal or missing install was replaced; see `previous`. */
  replaced: "replaced",

  /** A newer install is registered and present, so it was kept. */
  keptNewer: "kept_newer",
}

/** `register`: the install now registered, which is this one unless a newer one was kept. */
@serializable
model CliRegistration {
  outcome: RegistrationOutcome;
  registered: CliInstall;

  /** The install `replaced` replaced. */
  previous?: CliInstall;
}
