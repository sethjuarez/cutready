import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { sendGateLabel, type SendGateKind } from "../domain/versioning/sendGate";
import { syncCopy } from "../domain/versioning/syncCopy";

// Sync is the one place a business user meets the team. None of these words
// may reach them; "Merge into…" is a deliberate, user-chosen action and lives
// outside these files.
const BANNED = /\b(merge[sd]?|merging|rebas(e|ed|ing)|ahead|behind|main|origin|branch(es)?)\b/i;

function everyMessage(): string[] {
  const out: string[] = [];
  for (const [key, value] of Object.entries(syncCopy)) {
    if (typeof value === "string") out.push(value);
    else if (key === "status") {
      for (const s of [{}, { error: true }, { ahead: 2 }, { behind: 3 }, { ahead: 1, behind: 1 }]) out.push(syncCopy.status(s));
    } else if (key === "conflictTitle") {
      out.push(syncCopy.conflictTitle(["Dana"], ["sketches/compass.sk"]), syncCopy.conflictTitle([], ["a.sk", "b.md"]));
    } else if (key === "conflict") {
      out.push(syncCopy.conflict(["Dana", "Lee"]));
    } else if (key === "sent") {
      out.push(syncCopy.sent(), syncCopy.sent(2, true));
    } else {
      const fn = value as (n: number) => string;
      out.push(fn(0), fn(1), fn(4));
    }
  }
  return out;
}

describe("sync copy stays plain", () => {
  it("never uses Git words in any message", () => {
    for (const message of everyMessage()) expect(message, message).not.toMatch(BANNED);
  });

  it("covers the status pill states", () => {
    expect(syncCopy.status({})).toBe("Up to date");
    expect(syncCopy.status({ ahead: 2 })).toBe("2 saves waiting to send");
    expect(syncCopy.status({ ahead: 1, behind: 3 })).toBe("Team has 3 new updates");
    expect(syncCopy.status({ error: true, behind: 3 })).toBe("Sync needs attention");
    expect(syncCopy.sent(2)).toBe("Sent ✓ (also picked up 2 team updates)");
  });

  it("keeps Send button labels plain", () => {
    const kinds: SendGateKind[] = ["no-remote", "busy", "checking", "up-to-date", "behind", "save-first", "sync", "direct"];
    for (const kind of kinds) {
      for (const send of ["Send", "Send for review"]) {
        const label = sendGateLabel({ kind, toSend: 2, enabled: true }, send, 3);
        expect(label, label).not.toMatch(BANNED);
      }
    }
  });

  // String literals and JSX text in the sync surfaces. Class names, imports,
  // comments and identifiers are skipped; anything a user can read is checked.
  const SURFACES = [
    "components/versioning/RemoteStatus.tsx",
    "components/versioning/SendSection.tsx",
    "components/versioning/StartBranchControls.tsx",
    "components/versioning/IncomingPreview.tsx",
    "components/versioning/TimelineMenu.tsx",
    "components/MergeConflictPanel.tsx",
  ];

  // Deliberate exceptions, each with its reason.
  const ALLOWED = new Set([
    // Conflict header for the user-chosen "Merge into…" action, never team updates.
    "Merging",
    // Pre-action dialog wording for the same user-chosen merge of a timeline.
    "Merge ${label}",
    "merging ${label}",
    // SendGate kind identifier, compared in code and never shown.
    "behind",
    // Ref prefixes stripped before display, never shown.
    "refs/heads/timeline/",
    "refs/heads/",
  ]);

  function readableText(source: string): string[] {
    const code = source
      .replace(/\/\*[\s\S]*?\*\//g, "")
      .replace(/(^|[^:])\/\/.*$/gm, "$1")
      .replace(/^import .*$/gm, "")
      .replace(/console\.\w+\([^)]*\);?/g, "");
    const strings = [...code.matchAll(/"([^"\n]*)"|'([^'\n]*)'|`([^`]*)`/g)]
      .map((m) => m[1] ?? m[2] ?? m[3])
      .filter((s) => !/(^|\s)(text|bg|px|py|h|w|rounded|inline|flex|border|hover|focus)[-:]/.test(s));
    const jsxText = [...code.matchAll(/>([^<>{}]*[A-Za-z][^<>{}]*)</g)].map((m) => m[1].trim());
    return [...strings, ...jsxText]
      .filter((text) => text && !ALLOWED.has(text))
      .map((text) => text.replace(/\$\{[^}]*\}/g, "…"));
  }

  it.each(SURFACES)("%s shows no Git words", (file) => {
    const source = readFileSync(resolve(__dirname, "..", file), "utf8");
    for (const text of readableText(source)) expect(text, `${file}: ${text}`).not.toMatch(BANNED);
  });
});
