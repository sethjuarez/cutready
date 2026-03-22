import { useEffect } from "react";
import { CommandLineIcon, XMarkIcon } from "@heroicons/react/20/solid";
import { useCommands } from "../services/commandRegistry";

interface KeyboardShortcutsDialogProps {
  open: boolean;
  onClose: () => void;
}

const generalShortcuts = [
  { title: "Close dialogs & overlays", keybinding: "Escape" },
  { title: "Confirm / Send message", keybinding: "Enter" },
  { title: "Navigate table cells", keybinding: "Tab" },
];

function Kbd({ children }: { children: string }) {
  return (
    <kbd className="px-1.5 py-0.5 rounded border border-[var(--color-border)] bg-[var(--color-surface-alt)] text-[10px] font-mono text-[var(--color-text-secondary)]">
      {children}
    </kbd>
  );
}

function KeybindingBadge({ keybinding }: { keybinding: string }) {
  const parts = keybinding.split("+");
  return (
    <span className="flex items-center gap-0.5">
      {parts.map((part, i) => (
        <span key={i} className="flex items-center gap-0.5">
          {i > 0 && <span className="text-[10px] text-[var(--color-text-secondary)]">+</span>}
          <Kbd>{part}</Kbd>
        </span>
      ))}
    </span>
  );
}

export function KeyboardShortcutsDialog({ open, onClose }: KeyboardShortcutsDialogProps) {
  const commands = useCommands();

  useEffect(() => {
    if (!open) return;
    const handler = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        e.preventDefault();
        onClose();
      }
    };
    window.addEventListener("keydown", handler);
    return () => window.removeEventListener("keydown", handler);
  }, [open, onClose]);

  if (!open) return null;

  // Filter to commands with keybindings and group by category
  const withKeybindings = commands.filter((cmd) => cmd.keybinding);
  const groups = new Map<string, { title: string; keybinding: string }[]>();
  for (const cmd of withKeybindings) {
    const category = cmd.category ?? "Other";
    if (!groups.has(category)) groups.set(category, []);
    groups.get(category)!.push({ title: cmd.title, keybinding: cmd.keybinding! });
  }

  return (
    <div className="fixed inset-0 z-[9999] flex items-start justify-center pt-[18vh]">
      <div className="absolute inset-0 bg-black/40" onClick={onClose} />
      <div className="relative bg-[var(--color-surface)] border border-[var(--color-border)] rounded-xl shadow-2xl w-full max-w-lg mx-4 overflow-hidden">
        {/* Header */}
        <div className="flex items-center justify-between px-5 pt-4 pb-3 border-b border-[var(--color-border)]">
          <div className="flex items-center gap-2">
            <CommandLineIcon className="w-4 h-4 text-[var(--color-text-secondary)]" />
            <h2 className="text-sm font-semibold text-[var(--color-text)]">Keyboard Shortcuts</h2>
          </div>
          <button
            onClick={onClose}
            className="p-1 rounded-md text-[var(--color-text-secondary)] hover:text-[var(--color-text)] hover:bg-[var(--color-surface-alt)] transition-colors"
          >
            <XMarkIcon className="w-4 h-4" />
          </button>
        </div>

        {/* Shortcut sections */}
        <div className="px-5 py-3 space-y-4">
          {[...groups.entries()].map(([category, shortcuts]) => (
            <section key={category}>
              <h3 className="text-[10px] font-medium uppercase tracking-wider text-[var(--color-text-secondary)] mb-1.5">
                {category}
              </h3>
              <div className="space-y-0.5">
                {shortcuts.map((s) => (
                  <div key={s.title} className="flex items-center justify-between py-1.5">
                    <span className="text-xs text-[var(--color-text)]">{s.title}</span>
                    <KeybindingBadge keybinding={s.keybinding} />
                  </div>
                ))}
              </div>
            </section>
          ))}

          {/* General section */}
          <section>
            <h3 className="text-[10px] font-medium uppercase tracking-wider text-[var(--color-text-secondary)] mb-1.5">
              General
            </h3>
            <div className="space-y-0.5">
              {generalShortcuts.map((s) => (
                <div key={s.title} className="flex items-center justify-between py-1.5">
                  <span className="text-xs text-[var(--color-text)]">{s.title}</span>
                  <KeybindingBadge keybinding={s.keybinding} />
                </div>
              ))}
            </div>
          </section>
        </div>
      </div>
    </div>
  );
}
