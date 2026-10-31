// Opens exported files in their default app, except while an Auditaur drill is answering dialogs,
// so unattended drills don't launch Word or PowerPoint on the desktop.
import { openPath } from "@tauri-apps/plugin-opener";

// Workaround until @auditaur/api exposes the armed state or an opener stub (AR-38).
function drillIsArmed(): boolean {
  const state = (globalThis as Record<symbol, { armed?: boolean; expiresAtUnixMs?: number } | undefined>)[
    Symbol.for("auditaur.drillDialogs")
  ];
  return !!state?.armed && Date.now() < (state.expiresAtUnixMs ?? 0);
}

// Call right after the save dialog resolves: the drill lease can lapse during a long export.
export function captureExportOpener(): (path: string) => Promise<void> {
  const fromDrill = drillIsArmed();
  return async (path) => {
    if (!fromDrill) await openPath(path);
  };
}
