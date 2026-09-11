import { useEffect, useState } from "react";
import { Info } from "lucide-react";
import { useSettings } from "../../hooks/useSettings";
import { addDraftlineRemote, listDraftlineRemotes } from "../../services/draftlineVersioning";
import { GitHubConnectionCard } from "../GitHubConnectionCard";
import { inputClass } from "../../styles";

export function RepositoryTab({ settings, updateSetting }: {
  settings: ReturnType<typeof useSettings>["settings"];
  updateSetting: ReturnType<typeof useSettings>["updateSetting"];
}) {
  const [testStatus, setTestStatus] = useState<"idle" | "testing" | "success" | "error">("idle");
  const [testMessage, setTestMessage] = useState("");
  const [detectedRemote, setDetectedRemote] = useState<{ name: string; url: string } | null>(null);

  useEffect(() => {
    listDraftlineRemotes()
      .then((remotes) => {
        if (Array.isArray(remotes) && remotes.length > 0) {
          const remote = remotes[0];
          setDetectedRemote(remote);
          if (!settings.repoRemoteUrl) {
            updateSetting("repoRemoteUrl", remote.url);
          }
        }
      })
      .catch(() => {});
  }, []);

  const handleTestConnection = async () => {
    setTestStatus("testing");
    setTestMessage("");
    try {
      const remotes = await listDraftlineRemotes();
      const hasOrigin = remotes.some((r) => r.name === "origin");
      if (hasOrigin) {
        setTestStatus("success");
        setTestMessage("Remote is configured and accessible.");
      } else if (settings.repoRemoteUrl) {
        await addDraftlineRemote("origin", settings.repoRemoteUrl);
        setTestStatus("success");
        setTestMessage("Remote 'origin' added successfully.");
      } else {
        setTestStatus("error");
        setTestMessage("Enter a remote URL first.");
      }
    } catch (err) {
      setTestStatus("error");
      setTestMessage(String(err));
    }
  };

  return (
    <div className="flex flex-col gap-6">
      <p className="text-xs text-[rgb(var(--color-text-secondary))]">
        Connect to a GitHub remote to collaborate with others. Your snapshots and timelines sync as git commits and branches.
      </p>

      <GitHubConnectionCard />

      <div className="flex flex-col gap-1.5 px-3 py-2.5 rounded-lg border border-[rgb(var(--color-border))] bg-[rgb(var(--color-surface))]">
        <span className="text-sm font-medium text-[rgb(var(--color-text))]">How CutReady authenticates</span>
        <p className="text-xs text-[rgb(var(--color-text-secondary))]">
          Every push, pull, and fetch tries these in order and stops at the first one that works:
        </p>
        <ol className="list-decimal pl-4 flex flex-col gap-0.5 text-xs text-[rgb(var(--color-text-secondary))]">
          <li>The GitHub account connected above.</li>
          <li>Your GitHub CLI login, if you have run <code>gh auth login</code>.</li>
          <li>SSH keys held by your SSH agent.</li>
        </ol>
        <p className="text-xs text-[rgb(var(--color-text-secondary))] mt-1">
          Snapshots are attributed to <code>GIT_AUTHOR_NAME</code> and <code>GIT_AUTHOR_EMAIL</code>, falling back to your operating system username.
        </p>
      </div>

      {detectedRemote && !settings.repoRemoteUrl && (
        <div className="flex items-center gap-2 px-3 py-2 rounded-lg bg-[rgb(var(--color-accent))]/10 border border-[rgb(var(--color-accent))]/20 text-xs text-[rgb(var(--color-accent))]">
          <Info className="w-3.5 h-3.5" />
          Detected remote: <strong>{detectedRemote.url}</strong>
          <button
            onClick={() => updateSetting("repoRemoteUrl", detectedRemote.url)}
            className="ml-auto text-[rgb(var(--color-accent))] underline hover:no-underline"
          >
            Use this
          </button>
        </div>
      )}

      <fieldset className="flex flex-col gap-2">
        <label className="text-sm font-medium text-[rgb(var(--color-text))]">Remote URL</label>
        <div className="flex gap-2">
          <input
            type="text"
            value={settings.repoRemoteUrl}
            onChange={(e) => updateSetting("repoRemoteUrl", e.target.value)}
            placeholder="https://github.com/user/repo.git"
            className={inputClass + " flex-1"}
          />
          <button
            onClick={handleTestConnection}
            disabled={testStatus === "testing"}
            className="px-3 py-2 rounded-lg text-xs font-medium bg-[rgb(var(--color-accent))] text-[rgb(var(--color-accent-fg))] hover:opacity-90 transition-opacity disabled:opacity-50"
          >
            {testStatus === "testing" ? "Testing\u2026" : "Test"}
          </button>
        </div>
        {testStatus === "success" && (
          <p className="text-xs text-success">{testMessage}</p>
        )}
        {testStatus === "error" && (
          <p className="text-xs text-error">{testMessage}</p>
        )}
      </fieldset>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Memory Tab
// ---------------------------------------------------------------------------
