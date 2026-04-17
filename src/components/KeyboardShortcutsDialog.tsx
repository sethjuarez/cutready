import { Terminal, X } from "lucide-react";
import { useCommands } from "../services/commandRegistry";
import { Dialog } from "./Dialog";

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
    <kbd className="px-1.5 py-0.5 rounded border border-[rgb(var(--color-border))] bg-[rgb(var(--color-surface-alt))] text-[10px] font-mono text-[rgb(var(--color-text-secondary))]">
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
          {i > 0 && <span className="text-[10px] text-[rgb(var(--color-text-secondary))]">+</span>}
          <Kbd>{part}</Kbd>
        </span>
      ))}
    </span>
  );
}

export function KeyboardShortcutsDialog({ open, onClose }: KeyboardShortcutsDialogProps) {
  const commands = useCommands();

  // Filter to commands with keybindings and group by category
  const withKeybindings = commands.filter((cmd) => cmd.keybinding);
  const groups = new Map<string, { title: string; keybinding: string }[]>();
  for (const cmd of withKeybindings) {
    const category = cmd.category ?? "Other";
    if (!groups.has(category)) groups.set(category, []);
    groups.get(category)!.push({ title: cmd.title, keybinding: cmd.keybinding! });
  }

  return (
    <Dialog isOpen={open} onClose={onClose} align="top" topOffset="18vh" width="w-full max-w-lg mx-4" backdropClass="bg-black/40">
      <div className="bg-[rgb(var(--color-surface))] border border-[rgb(var(--color-border))] rounded-xl shadow-2xl overflow-hidden">
        {/* Header */}
        <div className="flex items-center justify-between px-5 pt-4 pb-3 border-b border-[rgb(var(--color-border))]">
          <div className="flex items-center gap-2">
            <Terminal className="w-4 h-4 text-[rgb(var(--color-text-secondary))]" />
            <h2 className="text-sm font-semibold text-[rgb(var(--color-text))]">Keyboard Shortcuts</h2>
          </div>
          <button
            onClick={onClose}
            className="p-1 rounded-md text-[rgb(var(--color-text-secondary))] hover:text-[rgb(var(--color-text))] hover:bg-[rgb(var(--color-surface-alt))] transition-colors"
          >
            <X className="w-4 h-4" />
          </button>
        </div>

        {/* Shortcut sections */}
        <div className="px-5 py-3 space-y-4">
          {[...groups.entries()].map(([category, shortcuts]) => (
            <section key={category}>
              <h3 className="text-[10px] font-medium uppercase tracking-wider text-[rgb(var(--color-text-secondary))] mb-1.5">
                {category}
              </h3>
              <div className="space-y-0.5">
                {shortcuts.map((s) => (
                  <div key={s.title} className="flex items-center justify-between py-1.5">
                    <span className="text-xs text-[rgb(var(--color-text))]">{s.title}</span>
                    <KeybindingBadge keybinding={s.keybinding} />
                  </div>
                ))}
              </div>
            </section>
          ))}

          {/* General section */}
          <section>
            <h3 className="text-[10px] font-medium uppercase tracking-wider text-[rgb(var(--color-text-secondary))] mb-1.5">
              General
            </h3>
            <div className="space-y-0.5">
              {generalShortcuts.map((s) => (
                <div key={s.title} className="flex items-center justify-between py-1.5">
                  <span className="text-xs text-[rgb(var(--color-text))]">{s.title}</span>
                  <KeybindingBadge keybinding={s.keybinding} />
                </div>
              ))}
            </div>
          </section>
        </div>
      </div>
    </Dialog>
  );
}
