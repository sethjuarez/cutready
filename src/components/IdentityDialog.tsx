import { useCallback, useEffect, useRef, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { useAppStore } from "../stores/appStore";

interface IdentityStatus {
  name: string;
  email: string;
  is_fallback: boolean;
}

/**
 * One-time dialog prompting for git identity (name + email).
 * Shown before the first snapshot when identity can't be resolved
 * from git config or GitHub CLI.
 */
export function IdentityDialog() {
  const identityPromptOpen = useAppStore((s) => s.identityPromptOpen);
  const identityPromptCallback = useAppStore(
    (s) => s.identityPromptCallback
  );

  const [name, setName] = useState("");
  const [email, setEmail] = useState("");
  const [saving, setSaving] = useState(false);
  const nameRef = useRef<HTMLInputElement>(null);

  // Pre-fill with whatever partial identity was resolved
  useEffect(() => {
    if (!identityPromptOpen) return;
    (async () => {
      try {
        const status = await invoke<IdentityStatus>("check_git_identity");
        if (status.name && status.name !== "CutReady") setName(status.name);
        if (status.email && status.email !== "app@cutready.local")
          setEmail(status.email);
      } catch {
        // ignore — fields stay empty
      }
    })();
  }, [identityPromptOpen]);

  // Auto-focus name input
  useEffect(() => {
    if (identityPromptOpen) {
      requestAnimationFrame(() => {
        nameRef.current?.focus();
        nameRef.current?.select();
      });
    }
  }, [identityPromptOpen]);

  const handleSave = useCallback(async () => {
    const n = name.trim();
    const e = email.trim();
    if (!n || !e) return;
    setSaving(true);
    try {
      await invoke("set_git_identity", { name: n, email: e });
      const cb = identityPromptCallback;
      useAppStore.setState({
        identityPromptOpen: false,
        identityPromptCallback: null,
      });
      setName("");
      setEmail("");
      setSaving(false);
      // Continue to the snapshot dialog
      cb?.();
    } catch (err) {
      console.error("Failed to set identity:", err);
      const { useToastStore } = await import("../stores/toastStore");
      useToastStore.getState().show(`Failed to set identity: ${err}`, 5000);
      setSaving(false);
    }
  }, [name, email, identityPromptCallback]);

  // Close on Escape only — no backdrop dismiss (identity is required)
  useEffect(() => {
    if (!identityPromptOpen) return;
    const handler = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        e.preventDefault();
        useAppStore.setState({
          identityPromptOpen: false,
          identityPromptCallback: null,
        });
        setName("");
        setEmail("");
        setSaving(false);
      }
    };
    window.addEventListener("keydown", handler);
    return () => window.removeEventListener("keydown", handler);
  }, [identityPromptOpen]);

  if (!identityPromptOpen) return null;

  const isValid = name.trim().length > 0 && email.trim().length > 0;

  return (
    <div className="fixed inset-0 z-[9999] flex items-start justify-center pt-[20vh]">
      {/* Backdrop — no click-to-close since identity is needed */}
      <div className="absolute inset-0 bg-black/40" />

      {/* Dialog */}
      <div className="relative bg-[var(--color-surface)] border border-[var(--color-border)] rounded-xl shadow-2xl w-full max-w-md mx-4 overflow-hidden">
        {/* Header */}
        <div className="flex items-center gap-2.5 px-5 pt-5 pb-3">
          <div className="p-2 rounded-lg bg-[var(--color-accent)]/10">
            <svg
              width="18"
              height="18"
              viewBox="0 0 24 24"
              fill="none"
              stroke="var(--color-accent)"
              strokeWidth="2"
              strokeLinecap="round"
              strokeLinejoin="round"
            >
              <path d="M20 21v-2a4 4 0 0 0-4-4H8a4 4 0 0 0-4 4v2" />
              <circle cx="12" cy="7" r="4" />
            </svg>
          </div>
          <div>
            <h2 className="text-sm font-semibold text-[var(--color-text)]">
              Set Your Identity
            </h2>
            <p className="text-[11px] text-[var(--color-text-secondary)]">
              Used to attribute your snapshots
            </p>
          </div>
        </div>

        {/* Body */}
        <div className="px-5 pb-5 flex flex-col gap-3">
          <p className="text-xs text-[var(--color-text-secondary)]">
            We couldn&apos;t detect your identity from git or GitHub CLI.
            Please enter your name and email — this is saved once per
            workspace.
          </p>

          {/* Name */}
          <div>
            <label className="block text-xs font-medium text-[var(--color-text-secondary)] mb-1.5">
              Name
            </label>
            <input
              ref={nameRef}
              type="text"
              value={name}
              onChange={(e) => setName(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === "Enter" && isValid) handleSave();
              }}
              placeholder="Your name"
              className="w-full px-3 py-2 rounded-lg bg-[var(--color-surface-alt)] border border-[var(--color-border)] text-sm text-[var(--color-text)] placeholder:text-[var(--color-text-secondary)]/40 focus:outline-none focus:ring-2 focus:ring-[var(--color-accent)]/40"
            />
          </div>

          {/* Email */}
          <div>
            <label className="block text-xs font-medium text-[var(--color-text-secondary)] mb-1.5">
              Email
            </label>
            <input
              type="email"
              value={email}
              onChange={(e) => setEmail(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === "Enter" && isValid) handleSave();
              }}
              placeholder="you@example.com"
              className="w-full px-3 py-2 rounded-lg bg-[var(--color-surface-alt)] border border-[var(--color-border)] text-sm text-[var(--color-text)] placeholder:text-[var(--color-text-secondary)]/40 focus:outline-none focus:ring-2 focus:ring-[var(--color-accent)]/40"
            />
          </div>

          {/* Actions */}
          <div className="flex items-center justify-end gap-2 pt-1">
            <button
              onClick={() => {
                useAppStore.setState({
                  identityPromptOpen: false,
                  identityPromptCallback: null,
                });
                setName("");
                setEmail("");
              }}
              className="px-3 py-1.5 rounded-lg text-xs text-[var(--color-text-secondary)] hover:text-[var(--color-text)] transition-colors"
            >
              Cancel
            </button>
            <button
              onClick={handleSave}
              disabled={!isValid || saving}
              className="px-4 py-1.5 rounded-lg text-xs font-medium bg-[var(--color-accent)] text-white hover:bg-[var(--color-accent-hover)] disabled:opacity-40 transition-colors"
            >
              {saving ? "Saving..." : "Continue"}
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}
