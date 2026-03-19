/**
 * Deep link handler hook.
 *
 * Listens for `cutready://gh/{owner}/{repo}` URLs from two sources:
 * 1. Backend "deep-link-received" event (single-instance or on_open_url)
 * 2. Plugin getCurrent() on mount (app launched via deep link)
 *
 * When a deep link arrives:
 * - Parses the owner/repo from the URL
 * - Calls resolve_deep_link to check if already cloned
 * - If found: opens the project directly
 * - If not: prompts for folder, clones, and opens
 */

import { useEffect } from "react";
import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { open } from "@tauri-apps/plugin-dialog";
import { sep } from "@tauri-apps/api/path";
import { useAppStore } from "../stores/appStore";
import { useToastStore } from "../stores/toastStore";

const isTauri = !!(window as any).__TAURI_INTERNALS__;

/** Parse a cutready:// deep link URL into owner and repo. */
function parseDeepLink(url: string): { owner: string; repo: string } | null {
  // Match: cutready://gh/owner/repo or cutready://gh/owner/repo/
  const match = url.match(/^cutready:\/\/gh\/([^/]+)\/([^/?#]+)/);
  if (!match) return null;
  return { owner: match[1], repo: match[2] };
}

async function handleDeepLink(url: string) {
  const parsed = parseDeepLink(url);
  if (!parsed) {
    console.warn("Invalid deep link URL:", url);
    return;
  }

  const { owner, repo } = parsed;
  const toast = useToastStore.getState().show;
  const store = useAppStore.getState();

  toast(`Opening ${owner}/${repo}…`, 5000);

  try {
    // Check if we already have this repo cloned
    const existingPath = await invoke<string | null>("resolve_deep_link", {
      owner,
      repo,
    });

    if (existingPath) {
      await store.openProject(existingPath);
      toast(`Opened ${repo}`);
      return;
    }

    // Not cloned yet — prompt for folder location
    const selected = await open({
      directory: true,
      title: `Choose location to clone ${owner}/${repo}`,
    });
    if (!selected) {
      toast("Clone cancelled");
      return;
    }

    const dest = `${selected}${sep}${repo}`;
    const githubUrl = `https://github.com/${owner}/${repo}.git`;

    toast(`Cloning ${owner}/${repo}…`, 10000);
    const success = await store.cloneFromUrl(githubUrl, dest);
    if (success) {
      toast(`Cloned and opened ${repo}`);
    }
  } catch (err) {
    console.error("Deep link handling failed:", err);
    toast(`Failed to open ${owner}/${repo}: ${err}`);
  }
}

export function useDeepLink() {
  useEffect(() => {
    if (!isTauri) return;

    // Listen for deep link events from backend (single-instance forwarding + on_open_url)
    const unlisten = listen<string>("deep-link-received", (event) => {
      handleDeepLink(event.payload);
    });

    // Check if app was launched via deep link (getCurrent)
    // Use dynamic import to avoid errors in web mode
    import("@tauri-apps/plugin-deep-link").then(({ getCurrent }) => {
      getCurrent().then((urls) => {
        if (urls && urls.length > 0) {
          handleDeepLink(urls[0]);
        }
      }).catch(() => {
        // Plugin may not be available in dev mode
      });
    }).catch(() => {});

    return () => {
      unlisten.then((fn) => fn());
    };
  }, []);
}
