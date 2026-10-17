import type { ChatArtifact } from "./generated/model/chat-artifact";
import type { ChatPromotion } from "./generated/model/chat-promotion";
import type { ChatTranscript } from "./generated/model/chat-transcript";

type JsonRecord = Record<string, unknown>;

function isRecord(value: unknown): value is JsonRecord {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function compactString(value: unknown): string | undefined {
  if (typeof value !== "string") {
    return undefined;
  }
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : undefined;
}

function optionalString(value: unknown): string | undefined {
  return typeof value === "string" && value.length > 0 ? value : undefined;
}

function cleanParticipant(value: unknown): JsonRecord {
  const participant = isRecord(value) ? value : {};
  const result: JsonRecord = {
    name: typeof participant.name === "string" ? participant.name : "",
  };
  const email = optionalString(participant.email);
  if (email !== undefined) {
    result.email = email;
  }
  return result;
}

function cleanSource(value: unknown): JsonRecord {
  const source = isRecord(value) ? value : {};
  const result: JsonRecord = {
    session_id: typeof source.session_id === "string" ? source.session_id : "",
  };
  const startedAt = optionalString(source.started_at);
  if (startedAt !== undefined) {
    result.started_at = startedAt;
  }
  return result;
}

function cleanToolUse(value: unknown): JsonRecord | undefined {
  if (!isRecord(value)) {
    return undefined;
  }
  const name = compactString(value.name);
  if (name === undefined) {
    return undefined;
  }
  const result: JsonRecord = { name };
  const target = compactString(value.target);
  if (target !== undefined) {
    result.target = target;
  }
  return result;
}

function cleanTurn(value: unknown): JsonRecord | undefined {
  if (!isRecord(value)) {
    return undefined;
  }
  const role = value.role === "assistant" ? "assistant" : "user";
  const result: JsonRecord = {
    role,
    text: typeof value.text === "string" ? value.text : "",
  };
  const tools = Array.isArray(value.tool_uses)
    ? value.tool_uses.map(cleanToolUse).filter((tool) => tool !== undefined)
    : [];
  if (tools.length > 0) {
    result.tool_uses = tools;
  }
  const agent = optionalString(value.agent);
  if (agent !== undefined) {
    result.agent = agent;
  }
  const model = optionalString(value.model);
  if (model !== undefined) {
    result.model = model;
  }
  for (const [key, extra] of Object.entries(value)) {
    if (!["role", "text", "tool_uses", "agent", "model"].includes(key)) {
      result[key] = extra;
    }
  }
  return result;
}

export function roundTripChatArtifact(
  artifact: ChatArtifact | JsonRecord,
): JsonRecord {
  const input = artifact as unknown as JsonRecord;
  const result: JsonRecord = {
    title: typeof input.title === "string" ? input.title : "",
    author: cleanParticipant(input.author),
    promoted_by: cleanParticipant(input.promoted_by),
    promoted_at: typeof input.promoted_at === "string" ? input.promoted_at : "",
    source: cleanSource(input.source),
    turns: Array.isArray(input.turns)
      ? input.turns.map(cleanTurn).filter((turn) => turn !== undefined)
      : [],
    updated_at: typeof input.updated_at === "string" ? input.updated_at : "",
  };
  const summary = compactString(input.summary);
  if (summary !== undefined) {
    result.summary = summary;
  }
  for (const [key, extra] of Object.entries(input)) {
    if (
      ![
        "title",
        "summary",
        "author",
        "promoted_by",
        "promoted_at",
        "source",
        "turns",
        "updated_at",
      ].includes(key)
    ) {
      result[key] = extra;
    }
  }
  return result;
}

function messageText(content: unknown): string | undefined {
  if (typeof content === "string") {
    return compactString(content);
  }
  if (!Array.isArray(content)) {
    return undefined;
  }
  const parts = content
    .map((part) => {
      if (!isRecord(part) || part.type !== "text") {
        return undefined;
      }
      return compactString(part.text);
    })
    .filter((part) => part !== undefined);
  return parts.length > 0 ? parts.join("\n") : undefined;
}

function runDetails(message: JsonRecord): JsonRecord | undefined {
  if (!isRecord(message.cutready) || !isRecord(message.cutready.runDetails)) {
    return undefined;
  }
  return message.cutready.runDetails;
}

function toolTarget(rawArguments: unknown): string | undefined {
  if (typeof rawArguments !== "string") {
    return undefined;
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(rawArguments);
  } catch {
    return undefined;
  }
  if (!isRecord(parsed)) {
    return undefined;
  }
  return compactString(parsed.path) ?? compactString(parsed.url);
}

function messageToolUses(message: JsonRecord): JsonRecord[] {
  if (!Array.isArray(message.tool_calls)) {
    return [];
  }
  const tools: JsonRecord[] = [];
  for (const call of message.tool_calls) {
    if (!isRecord(call) || !isRecord(call.function)) {
      continue;
    }
    const name = compactString(call.function.name);
    if (name === undefined) {
      continue;
    }
    const tool: JsonRecord = { name };
    const target = toolTarget(call.function.arguments);
    if (target !== undefined) {
      tool.target = target;
    }
    tools.push(tool);
  }
  return tools;
}

function pushAssistant(
  turns: JsonRecord[],
  text: string | undefined,
  tools: JsonRecord[],
  details: JsonRecord | undefined,
) {
  const previous = turns[turns.length - 1];
  if (previous?.role === "assistant") {
    if (text !== undefined) {
      previous.text =
        typeof previous.text === "string" && previous.text.length > 0
          ? `${previous.text}\n\n${text}`
          : text;
    }
    if (tools.length > 0) {
      previous.tool_uses = [
        ...((previous.tool_uses as JsonRecord[] | undefined) ?? []),
        ...tools,
      ];
    }
    if (details !== undefined) {
      const agent = compactString(details.agent_id);
      const model = compactString(details.model);
      if (agent !== undefined) {
        previous.agent = agent;
      }
      if (model !== undefined) {
        previous.model = model;
      }
    }
    return;
  }
  if (text === undefined && tools.length === 0) {
    return;
  }
  const turn: JsonRecord = { role: "assistant", text: text ?? "" };
  if (tools.length > 0) {
    turn.tool_uses = tools;
  }
  if (details !== undefined) {
    const agent = compactString(details.agent_id);
    const model = compactString(details.model);
    if (agent !== undefined) {
      turn.agent = agent;
    }
    if (model !== undefined) {
      turn.model = model;
    }
  }
  turns.push(turn);
}

function curatedTurns(session: ChatTranscript | JsonRecord): JsonRecord[] {
  const turns: JsonRecord[] = [];
  const messages = Array.isArray((session as JsonRecord).messages)
    ? ((session as JsonRecord).messages as unknown[])
    : [];
  for (const raw of messages) {
    if (!isRecord(raw) || raw.pending === true) {
      continue;
    }
    if (raw.role === "user") {
      const text = messageText(raw.content);
      if (text !== undefined) {
        turns.push({ role: "user", text });
      }
      continue;
    }
    if (raw.role === "assistant") {
      pushAssistant(
        turns,
        messageText(raw.content),
        messageToolUses(raw),
        runDetails(raw),
      );
    }
  }
  return turns;
}

function applySelection(turns: JsonRecord[], selected: unknown): JsonRecord[] {
  if (!Array.isArray(selected)) {
    return turns;
  }
  const keep = new Set(
    selected.filter(
      (index): index is number =>
        Number.isInteger(index) && index >= 0 && index < turns.length,
    ),
  );
  return turns.filter((_, index) => keep.has(index));
}

export function promoteChatArtifact(
  session: ChatTranscript | JsonRecord,
  request: ChatPromotion | JsonRecord,
): JsonRecord {
  const requestRecord = request as unknown as JsonRecord;
  const sessionRecord = session as unknown as JsonRecord;
  const source: JsonRecord = {
    session_id:
      typeof sessionRecord.session_id === "string"
        ? sessionRecord.session_id
        : "",
  };
  const startedAt = optionalString(sessionRecord.created_at);
  if (startedAt !== undefined) {
    source.started_at = startedAt;
  }
  return roundTripChatArtifact({
    title: compactString(requestRecord.title) ?? "",
    summary: requestRecord.summary,
    author: requestRecord.author,
    promoted_by: requestRecord.promoted_by,
    promoted_at:
      typeof requestRecord.promoted_at === "string"
        ? requestRecord.promoted_at
        : "",
    source,
    turns: applySelection(curatedTurns(session), requestRecord.selected_turns),
    updated_at:
      typeof requestRecord.promoted_at === "string"
        ? requestRecord.promoted_at
        : "",
  });
}
