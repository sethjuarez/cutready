import { useEffect, useState } from "react";
import { relaunch } from "@tauri-apps/plugin-process";
import { Download, Sparkles, X } from "lucide-react";
import { useUpdateStore } from "../stores/updateStore";
import { SafeMarkdown } from "./SafeMarkdown";

export function ReleaseNotesMarkdown({ children }: { children: string }) {
  return (
    <div className="space-y-3 text-[13px] leading-relaxed text-[rgb(var(--color-text))] [&_a]:font-medium [&_a]:text-[rgb(var(--color-accent))] [&_a]:underline [&_code]:rounded [&_code]:bg-[rgb(var(--color-surface-inset))] [&_code]:px-1.5 [&_code]:py-0.5 [&_h1]:text-lg [&_h1]:font-semibold [&_h1]:tracking-tight [&_h2]:mt-4 [&_h2]:text-sm [&_h2]:font-semibold [&_h2]:tracking-tight [&_h3]:mt-3 [&_h3]:text-sm [&_h3]:font-semibold [&_li]:my-1 [&_ol]:ml-4 [&_ol]:list-decimal [&_p]:my-2 [&_strong]:font-semibold [&_ul]:ml-4 [&_ul]:list-disc">
      <SafeMarkdown>{children}</SafeMarkdown>
    </div>
  );
}

export function UpdateAvailableButton() {
  const update = useUpdateStore((s) => s.update);
  const [open, setOpen] = useState(false);
  const [installing, setInstalling] = useState(false);
  const [progress, setProgress] = useState("");

  useEffect(() => {
    if (!open) return;

    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape" && !installing) {
        setOpen(false);
      }
    };

    window.addEventListener("keydown", handleKeyDown);
    return () => window.removeEventListener("keydown", handleKeyDown);
  }, [installing, open]);

  if (!update) return null;

  const handleInstall = async () => {
    setInstalling(true);
    try {
      let downloaded = 0;
      await update.downloadAndInstall((event) => {
        switch (event.event) {
          case "Started":
            setProgress("Downloading...");
            break;
          case "Progress":
            downloaded += event.data.chunkLength;
            setProgress(`Downloading... ${(downloaded / 1024 / 1024).toFixed(1)} MB`);
            break;
          case "Finished":
            setProgress("Installing...");
            break;
        }
      });
      await relaunch();
    } catch {
      setProgress("Installation failed.");
      setInstalling(false);
    }
  };

  return (
    <>
      <button
        onClick={() => setOpen(true)}
        className="group relative flex h-10 w-10 items-center justify-center rounded-xl border border-[rgb(var(--color-accent))]/25 bg-[rgb(var(--color-accent))]/12 text-[rgb(var(--color-accent))] shadow-[0_0_24px_rgb(var(--color-accent)/0.18)] transition-colors hover:border-[rgb(var(--color-accent))]/45 hover:bg-[rgb(var(--color-accent))]/18"
        title={`Update available: v${update.version}`}
        aria-label={`Update available: version ${update.version}`}
      >
        <Download className="h-4 w-4" />
        <span className="absolute -right-0.5 -top-0.5 h-2.5 w-2.5 rounded-full bg-[rgb(var(--color-accent))] ring-2 ring-[rgb(var(--color-surface))]" />
        <span className="absolute inset-0 rounded-xl border border-[rgb(var(--color-accent))]/20 opacity-0 transition-opacity group-hover:opacity-100" />
      </button>

      {open && (
        <div
          className="fixed inset-0 z-modal flex items-center justify-center bg-[rgb(var(--color-overlay-scrim)/0.5)] p-5 backdrop-blur-sm"
          role="dialog"
          aria-modal="true"
          aria-labelledby="update-title"
          onMouseDown={(event) => {
            if (event.target === event.currentTarget && !installing) {
              setOpen(false);
            }
          }}
        >
          <div className="relative flex max-h-[min(720px,calc(100vh-48px))] w-full max-w-2xl flex-col overflow-hidden rounded-2xl border border-[rgb(var(--color-border))] bg-[rgb(var(--color-surface))] shadow-2xl">
            <div className="relative overflow-hidden border-b border-[rgb(var(--color-border))] px-6 py-5">
              <div className="absolute -right-16 -top-24 h-48 w-48 rounded-full bg-[rgb(var(--color-accent))]/18 blur-3xl" />
              <div className="relative flex items-start justify-between gap-4">
                <div>
                  <div className="mb-2 inline-flex items-center gap-1.5 rounded-full border border-[rgb(var(--color-accent))]/25 bg-[rgb(var(--color-accent))]/10 px-2.5 py-1 text-[11px] font-semibold uppercase tracking-[0.14em] text-[rgb(var(--color-accent))]">
                    <Sparkles className="h-3 w-3" />
                    Update available
                  </div>
                  <h2 id="update-title" className="text-xl font-semibold tracking-tight text-[rgb(var(--color-text))]">
                    CutReady v{update.version}
                  </h2>
                  <p className="mt-1 text-sm text-[rgb(var(--color-text-secondary))]">
                    Review what changed, then install when you are ready to relaunch.
                  </p>
                </div>
                <button
                  onClick={() => setOpen(false)}
                  disabled={installing}
                  className="flex h-8 w-8 shrink-0 items-center justify-center rounded-lg text-[rgb(var(--color-text-secondary))] transition-colors hover:bg-[rgb(var(--color-surface-alt))] hover:text-[rgb(var(--color-text))] disabled:opacity-50"
                  aria-label="Close update dialog"
                >
                  <X className="h-4 w-4" />
                </button>
              </div>
            </div>

            <div className="min-h-0 flex-1 overflow-y-auto px-6 py-5">
              {update.body ? (
                <ReleaseNotesMarkdown>{update.body}</ReleaseNotesMarkdown>
              ) : (
                <p className="text-sm text-[rgb(var(--color-text-secondary))]">
                  This release is ready to install. No release notes were provided.
                </p>
              )}
            </div>

            <div className="flex items-center justify-between gap-3 border-t border-[rgb(var(--color-border))] bg-[rgb(var(--color-surface-alt))]/60 px-6 py-4">
              <p className="text-xs text-[rgb(var(--color-text-secondary))]">
                {installing ? progress : "The app will relaunch after installation finishes."}
              </p>
              <button
                onClick={handleInstall}
                disabled={installing}
                className="inline-flex h-9 items-center gap-2 rounded-xl bg-[rgb(var(--color-accent))] px-4 text-sm font-semibold text-[rgb(var(--color-accent-fg))] shadow-lg shadow-[rgb(var(--color-accent))]/15 transition-colors hover:bg-[rgb(var(--color-accent-hover))] disabled:cursor-wait disabled:opacity-70"
              >
                <Download className="h-4 w-4" />
                {installing ? progress || "Preparing..." : "Download & Install"}
              </button>
            </div>
          </div>
        </div>
      )}
    </>
  );
}
