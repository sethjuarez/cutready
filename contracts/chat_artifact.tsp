import "@typra/emitter";
import "./vectors.tsp";

namespace CutReady.Contracts;

/**
 * A `.cv` file: a private chat promoted into the shared project.
 * The transcript never changes after promotion; only `title` and `summary` do.
 * Unknown top-level and turn fields must survive every runtime's decode -> save.
 */
@serializable
model ChatArtifact {
  @sample(#{ title: "Plan the launch demo" })
  title: string;

  /** Markdown. Omitted when blank. */
  summary?: string;

  /** Who held the conversation. */
  author: ChatParticipant;

  /** Who promoted it into the project. */
  promoted_by: ChatParticipant;

  /** RFC 3339 UTC timestamp. */
  @sample(#{ promoted_at: "2026-07-01T09:30:00Z" })
  promoted_at: string;

  source: ChatArtifactSource;
  turns: ChatTurn[];

  /** RFC 3339 UTC timestamp, set by every title or summary edit. */
  @sample(#{ updated_at: "2026-07-01T09:30:00Z" })
  updated_at: string;

  /** Fields written by newer builds, preserved verbatim. */
  ...Record<unknown>;
}

/** A person, as recorded by their git identity. */
model ChatParticipant {
  @sample(#{ name: "Ada Lovelace" })
  name: string;

  /** Omitted when unknown. */
  email?: string;
}

/** The private session a chat artifact was promoted from. */
model ChatArtifactSource {
  @sample(#{ session_id: "chat-1" })
  session_id: string;

  /** RFC 3339 timestamp. Omitted when unknown. */
  started_at?: string;
}

/** Who spoke a turn. */
union ChatTurnRole {
  user: "user",
  assistant: "assistant",
}

/** A user message, or everything the assistant said and did before the next one. */
model ChatTurn {
  role: ChatTurnRole;

  /** Markdown. */
  @sample(#{ text: "Draft an intro sketch." })
  text: string;

  /** Tools the assistant called, in order. Omitted when none. */
  tool_uses?: ChatToolUse[];

  /** The CutReady agent that answered, such as `planner`. */
  agent?: string;

  /** The model that answered. */
  `model`?: string;

  /** Fields written by newer builds, preserved verbatim. */
  ...Record<unknown>;
}

/** A tool call, without its arguments or result. */
model ChatToolUse {
  @sample(#{ name: "write_sketch" })
  name: string;

  /** The project path or URL the call acted on. Omitted when none. */
  target?: string;
}

/** A private chat session, as the desktop stores it. */
model ChatTranscript {
  @sample(#{ session_id: "chat-1" })
  session_id: string;

  /** RFC 3339 timestamp. Omitted when unknown. */
  created_at?: string;

  /**
   * Messages in chat-completions shape: `role`, `content` (a string, an array
   * of `text` and `image_url` parts, or null), and `tool_calls`, plus CutReady's
   * `pending` flag and `cutready` metadata.
   */
  messages: unknown[];
}

/** What to promote, and who promoted it. The host supplies identities and the clock. */
model ChatPromotion {
  @sample(#{ title: "Plan the launch demo" })
  title: string;

  /** Markdown. */
  summary?: string;

  author: ChatParticipant;
  promoted_by: ChatParticipant;

  /** RFC 3339 UTC timestamp. Also becomes `updated_at`. */
  @sample(#{ promoted_at: "2026-07-01T09:30:00Z" })
  promoted_at: string;

  /** Zero-based indices into the curated turns. Omitted keeps every turn. */
  selected_turns?: uint32[];
}

/**
 * Behavioral contract for `.cv` documents. Each runtime binds these operations
 * to its production code through a thin vector adapter.
 */
interface ChatArtifactDocument {
  /**
   * Decode a `.cv` document and save it again. A blank `summary` and empty
   * `tool_uses` are omitted.
   */
  @sync
  @vector(ChatArtifactRoundTripVectors)
  roundTrip(artifact: ChatArtifact): ChatArtifact;

  /**
   * Curate a private chat into a `.cv` document. Text is trimmed throughout.
   *
   * - Only `user` and `assistant` messages are kept, and none marked `pending`.
   * - A message's text is its string `content`, or its `text` parts joined by a
   *   newline. Images are dropped, then user messages without text.
   * - Each user message is a turn. Consecutive assistant messages fold into one
   *   turn: their non-blank texts joined by a blank line, every named
   *   `tool_calls` entry as a tool use, and `agent` and `model` from the last
   *   `cutready.runDetails` (`agent_id`, `model`). A turn with no text and no
   *   tool uses is dropped.
   * - A tool use's `target` is the first non-blank string among `path` and
   *   `url` in the call's JSON `arguments`.
   * - `selected_turns` keeps the listed curated turns in transcript order;
   *   out-of-range and repeated indices are ignored.
   * - `source.started_at` is the session's `created_at`; `updated_at` is
   *   `promoted_at`; a blank `summary` is omitted.
   *
   * Tool arguments and results, working notes, and images stay private.
   */
  @sync
  @vector(ChatArtifactPromoteVectors)
  promote(session: ChatTranscript, request: ChatPromotion): ChatArtifact;
}
