import { describe, it, expect } from "vitest";
import { buildDebugStream, type AuditaurDiagnosticItem } from "../components/OutputPanel";
import type { ActivityEntry } from "../stores/appStore";

function item(nanos: string, title: string): AuditaurDiagnosticItem {
  return {
    timestamp_unix_nanos: nanos,
    source: "test",
    kind: "test",
    title,
    detail: null,
    status: null,
    trace_id: null,
    span_id: null,
    window_label: null,
  };
}

function legacy(ms: number, content: string): ActivityEntry {
  return { id: content, timestamp: new Date(ms), source: "app", content, level: "warn" };
}

const emptySummary = {
  frontend_errors: [],
  failed_ipc: [],
  failed_traces: [],
  warning_logs: [],
};

describe("buildDebugStream", () => {
  it("returns an empty stream when there is nothing to show", () => {
    expect(buildDebugStream(emptySummary, [])).toEqual([]);
  });

  it("tags each source with its filter category", () => {
    const stream = buildDebugStream(
      {
        frontend_errors: [item("4000000", "fe")],
        failed_ipc: [item("3000000", "ipc")],
        failed_traces: [item("2000000", "trace")],
        warning_logs: [item("1000000", "log")],
      },
      [legacy(5, "legacy")],
    );

    expect(stream.map((entry) => [entry.title, entry.category])).toEqual([
      ["legacy", "legacy"],
      ["fe", "frontend"],
      ["ipc", "ipc"],
      ["trace", "trace"],
      ["log", "log"],
    ]);
  });

  it("interleaves legacy entries with diagnostics newest first", () => {
    const stream = buildDebugStream(
      { ...emptySummary, warning_logs: [item("1000000", "older"), item("3000000", "newer")] },
      [legacy(2, "between")],
    );

    expect(stream.map((entry) => entry.title)).toEqual(["newer", "between", "older"]);
  });

  it("keeps only the most recent legacy entries when over the cap", () => {
    const entries = Array.from({ length: 60 }, (_, index) => legacy(index + 1, `entry-${index}`));
    const stream = buildDebugStream(emptySummary, entries);

    expect(stream).toHaveLength(50);
    expect(stream[0].title).toBe("entry-59");
    expect(stream[stream.length - 1].title).toBe("entry-10");
  });

  it("honours a custom legacy cap", () => {
    const entries = Array.from({ length: 5 }, (_, index) => legacy(index + 1, `entry-${index}`));

    expect(buildDebugStream(emptySummary, entries, 2).map((entry) => entry.title)).toEqual([
      "entry-4",
      "entry-3",
    ]);
  });

  it("sorts malformed timestamps last instead of throwing", () => {
    const stream = buildDebugStream(
      { ...emptySummary, warning_logs: [item("not-a-number", "broken"), item("1000000", "valid")] },
      [legacy(Number.NaN, "invalid-date")],
    );

    expect(stream.map((entry) => entry.title)).toEqual(["valid", "broken", "invalid-date"]);
  });

  it("sorts nanosecond timestamps numerically rather than lexicographically", () => {
    const stream = buildDebugStream(
      { ...emptySummary, warning_logs: [item("9000000", "nine"), item("10000000", "ten")] },
      [],
    );

    expect(stream.map((entry) => entry.title)).toEqual(["ten", "nine"]);
  });
});
