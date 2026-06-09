export interface TelemetryActivityEntry {
  id: string;
  timestamp: Date;
  source: string;
  content: string;
  level: "info" | "warn" | "error" | "success";
}

export function recordActivityEntries(entries: TelemetryActivityEntry[]) {
  if (entries.length === 0) return;

  for (const entry of entries) {
    const payload = {
      type: "cutready.activity",
      id: entry.id,
      timestamp: entry.timestamp.toISOString(),
      source: entry.source,
      content: entry.content,
      level: entry.level,
    };

    if (entry.level === "error") console.error(payload);
    else if (entry.level === "warn") console.warn(payload);
    else console.info(payload);
  }
}
