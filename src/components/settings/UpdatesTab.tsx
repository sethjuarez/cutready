import { useEffect, useState } from "react";
import { CheckCircle, Download, ExternalLink, RefreshCw } from "lucide-react";
import { getVersion } from "@tauri-apps/api/app";
import { relaunch } from "@tauri-apps/plugin-process";
import { useUpdateStore } from "../../stores/updateStore";
import { ReleaseNotesMarkdown } from "../UpdateAvailableButton";

export function UpdatesTab() {
  const update = useUpdateStore((s) => s.update);
  const checking = useUpdateStore((s) => s.checking);
  const checkForUpdate = useUpdateStore((s) => s.checkForUpdate);
  const [currentVersion, setCurrentVersion] = useState<string | null>(null);
  const [installing, setInstalling] = useState(false);
  const [progress, setProgress] = useState("");
  const [checked, setChecked] = useState(false);

  useEffect(() => {
    getVersion().then(setCurrentVersion).catch(() => {});
  }, []);

  const handleCheck = async () => {
    await checkForUpdate();
    setChecked(true);
  };

  const handleInstall = async () => {
    if (!update) return;
    setInstalling(true);
    try {
      let downloaded = 0;
      await update.downloadAndInstall((event) => {
        switch (event.event) {
          case "Started": setProgress("Downloading…"); break;
          case "Progress":
            downloaded += event.data.chunkLength;
            setProgress(`Downloading… ${(downloaded / 1024 / 1024).toFixed(1)} MB`);
            break;
          case "Finished": setProgress("Installing…"); break;
        }
      });
      await relaunch();
    } catch {
      setProgress("Installation failed.");
      setInstalling(false);
    }
  };

  return (
    <div className="max-w-xl">
      {/* Current version + actions */}
      <div className="flex items-center justify-between mb-6 p-4 rounded-xl bg-[rgb(var(--color-surface-alt))] border border-[rgb(var(--color-border))]">
        <div>
          <p className="text-xs text-[rgb(var(--color-text-secondary))] uppercase tracking-wider mb-0.5">Installed</p>
          <p className="text-sm font-semibold text-[rgb(var(--color-text))]">
            {currentVersion ? `v${currentVersion}` : "…"}
          </p>
        </div>
        <div className="flex items-center gap-2">
          {!update && checked && (
            <div className="flex items-center gap-1.5 text-xs text-success">
              <CheckCircle className="w-3.5 h-3.5" />
              Up to date
            </div>
          )}
          <button
            onClick={handleCheck}
            disabled={checking}
            className="flex items-center gap-1.5 px-2.5 py-1.5 rounded-lg text-xs font-medium border border-[rgb(var(--color-border))] text-[rgb(var(--color-text-secondary))] hover:text-[rgb(var(--color-text))] hover:border-[rgb(var(--color-text-secondary))]/40 transition-colors disabled:opacity-50"
          >
            <RefreshCw className={`w-3 h-3 ${checking ? "animate-spin" : ""}`} />
            {checking ? "Checking…" : "Check for Updates"}
          </button>
        </div>
      </div>

      {/* Update available */}
      {update ? (
        <div className="rounded-xl border border-[rgb(var(--color-accent))]/30 bg-[rgb(var(--color-accent))]/5 overflow-hidden">
          <div className="flex items-center justify-between px-4 py-3 border-b border-[rgb(var(--color-accent))]/20">
            <div>
              <p className="text-xs text-[rgb(var(--color-text-secondary))] uppercase tracking-wider mb-0.5">Update Available</p>
              <p className="text-sm font-semibold text-[rgb(var(--color-accent))]">v{update.version}</p>
            </div>
            {installing ? (
              <span className="text-xs text-[rgb(var(--color-accent))]">{progress}</span>
            ) : (
              <button
                onClick={handleInstall}
                className="flex items-center gap-1.5 px-3 py-1.5 rounded-lg text-xs font-medium bg-[rgb(var(--color-accent))] text-[rgb(var(--color-accent-fg))] hover:bg-[rgb(var(--color-accent-hover))] transition-colors"
              >
                <Download className="w-3.5 h-3.5" />
                Download &amp; Install
              </button>
            )}
          </div>
          {update.body && (
            <div className="px-4 py-3 max-h-[420px] overflow-y-auto">
              <p className="text-xs text-[rgb(var(--color-text-secondary))] uppercase tracking-wider mb-2">Release Notes</p>
              <ReleaseNotesMarkdown>{update.body}</ReleaseNotesMarkdown>
            </div>
          )}
        </div>
      ) : (
        <div className="flex flex-col gap-2">
          <p className="text-sm text-[rgb(var(--color-text-secondary))]">
            CutReady checks for updates automatically. You'll see a notification in the activity bar when one is available.
          </p>
          <a
            href="https://github.com/sethjuarez/cutready/blob/main/CHANGELOG.md"
            target="_blank"
            rel="noreferrer"
            className="inline-flex items-center gap-1.5 text-xs text-[rgb(var(--color-accent))] hover:underline"
          >
            <ExternalLink className="w-3 h-3" />
            View full changelog on GitHub
          </a>
        </div>
      )}
    </div>
  );
}

// ── Experimental Tab ────────────────────────────────────────────
