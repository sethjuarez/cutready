import { useState } from "react";
import { CloudUpload, Loader2 } from "lucide-react";
import { sendGate, sendGateLabel } from "../../domain/versioning";
import { isSaveBlocked, runVersionOperation } from "../../services/versionOperation";
import { useAppStore } from "../../stores/appStore";
import { useChangeSummaryStore } from "../../stores/changeSummaryStore";
import { useSyncStore } from "../../stores/syncStore";
import { useVersioningStore } from "../../stores/versioningStore";
import { firstParentTimelineNodes } from "../../utils/timelineNodes";
import { VersionForm } from "./VersionForm";

/** Send, gated: "Up to date" when there's nothing new, and a version first when there are unsaved changes. */
export function SendSection({ showComment = false }: { showComment?: boolean }) {
  const currentRemote = useSyncStore((s) => s.currentRemote);
  const syncStatus = useSyncStore((s) => s.syncStatus);
  const isSyncing = useSyncStore((s) => s.isSyncing);
  const pushToRemote = useSyncStore((s) => s.pushToRemote);
  const sendForReview = useSyncStore((s) => s.sendForReview);
  const syncWithRemote = useSyncStore((s) => s.syncWithRemote);
  const changedCount = useChangeSummaryStore((s) => s.summary?.documents.length ?? 0);
  const isHybrid = useAppStore((s) => s.currentProject?.hybrid === true);
  const [confirmingSave, setConfirmingSave] = useState(false);

  if (!currentRemote) return null;

  const gate = sendGate({ hasRemote: true, isSyncing, status: syncStatus, changedCount });
  const sendLabel = isHybrid ? "Send for review" : "Send";
  const label = sendGateLabel(gate, sendLabel, syncStatus?.behind ?? 0);

  // Send reuses the version's name and comment; hybrid projects use them for the pull request.
  const send = async (version?: { name: string; comment: string }) => {
    if (isHybrid) {
      const latest = version ?? latestVersion();
      await sendForReview(latest.name, latest.comment || undefined);
    } else {
      await pushToRemote();
    }
  };

  const onClick = () => {
    if (gate.kind === "save-first") {
      setConfirmingSave(true);
      return;
    }
    const action = gate.kind === "sync" ? () => syncWithRemote() : () => send();
    void runVersionOperation("Send", async (summary) => {
      // Edits landed since the popover opened: ask for a version first.
      if (summary.documents.length > 0) {
        setConfirmingSave(true);
        return;
      }
      await action();
    }).catch((err) => {
      if (!isSaveBlocked(err)) console.error("Send failed:", err);
    });
  };

  return (
    <div className="border-t border-[rgb(var(--color-border-subtle))] px-3 py-2">
      {confirmingSave ? (
        <div>
          <p className="text-xs text-[rgb(var(--color-text))]">Save these changes as a version before sending.</p>
          <VersionForm
            submitLabel={sendGateLabel({ kind: "save-first", toSend: gate.toSend, enabled: true }, sendLabel)}
            afterSave={send}
            onDone={() => setConfirmingSave(false)}
            onCancel={() => setConfirmingSave(false)}
            showComment={showComment}
            focusRequest={1}
          />
        </div>
      ) : (
        <button
          type="button"
          onClick={onClick}
          disabled={!gate.enabled}
          className="inline-flex h-7 w-full items-center justify-center gap-1.5 rounded-control border border-[rgb(var(--color-border))] px-3 text-xs font-medium text-[rgb(var(--color-text))] hover:bg-fill-hover disabled:cursor-not-allowed disabled:text-[rgb(var(--color-text-secondary))] disabled:hover:bg-transparent focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[rgb(var(--color-accent))]"
          data-testid="titlebar-send"
          title={gate.kind === "behind" ? "Get updates first, then send" : undefined}
        >
          {gate.kind === "busy" ? <Loader2 className="h-3.5 w-3.5 animate-spin" aria-hidden="true" /> : <CloudUpload className="h-3.5 w-3.5" aria-hidden="true" />}
          {label}
        </button>
      )}
    </div>
  );
}

function latestVersion(): { name: string; comment: string } {
  const [head] = firstParentTimelineNodes(useVersioningStore.getState().graphNodes);
  return { name: head?.message.split(/\r?\n/, 1)[0] || "CutReady changes", comment: "" };
}
