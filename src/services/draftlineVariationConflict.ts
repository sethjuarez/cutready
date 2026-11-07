import type { VariationCreatePreflight } from "@draftline/client";

/** Creating a variation was refused (a local or remote branch collides); carries the preflight. */
export class DraftlineVariationCreateConflictError extends Error {
  readonly preflight: VariationCreatePreflight;

  constructor(preflight: VariationCreatePreflight) {
    super(variationCreateConflictMessage(preflight));
    this.name = "DraftlineVariationCreateConflictError";
    this.preflight = preflight;
  }
}

export function isDraftlineVariationCreateConflictError(
  error: unknown,
): error is DraftlineVariationCreateConflictError {
  return error instanceof DraftlineVariationCreateConflictError;
}

function variationCreateConflictMessage(preflight: VariationCreatePreflight): string {
  if (preflight.remote_collision || preflight.remote_only_collision) {
    const remote = preflight.remote ?? "remote";
    const head = preflight.existing_remote_head?.label
      ? ` Remote head: ${preflight.existing_remote_head.label}.`
      : "";
    const suggestion = preflight.suggested_alternative
      ? ` Suggested name: ${preflight.suggested_alternative}.`
      : "";
    return `Branch "${preflight.variation}" already exists on ${remote}.${head}${suggestion}`;
  }
  if (preflight.local_collision) {
    return `Branch "${preflight.variation}" already exists locally.`;
  }
  return `Branch "${preflight.variation}" cannot be created.`;
}

export function variationCreatePreflightFromError(error: unknown): VariationCreatePreflight | null {
  const value = typeof error === "string" ? parseJsonObject(error) : error;
  if (!value || typeof value !== "object") return null;
  const record = value as Record<string, unknown>;
  const preflight = record.preflight ?? record.report;
  if (isVariationCreatePreflight(preflight)) return preflight;
  if (
    (record.kind === "variation_create_preflight_failed" || record.code === "variation_create_preflight_failed")
    && isVariationCreatePreflight(record.preflight)
  ) {
    return record.preflight;
  }
  return null;
}

function parseJsonObject(value: string): unknown {
  try {
    return JSON.parse(value);
  } catch {
    return null;
  }
}

function isVariationCreatePreflight(value: unknown): value is VariationCreatePreflight {
  if (!value || typeof value !== "object") return false;
  const record = value as Record<string, unknown>;
  return typeof record.from_version === "string"
    && typeof record.variation === "string"
    && typeof record.can_create === "boolean"
    && typeof record.local_collision === "boolean"
    && typeof record.remote_collision === "boolean"
    && typeof record.remote_only_collision === "boolean";
}
