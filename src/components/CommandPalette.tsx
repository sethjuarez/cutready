import { useState, useEffect, useRef, useMemo } from "react";
import type { Command } from "../services/commandRegistry";

interface CommandPaletteProps {
  isOpen: boolean;
  onClose: () => void;
  commands: Command[];
  onExecute: (commandId: string) => void;
  recentCommands: string[];
  initialQuery?: string;
}

/**
 * CommandPalette — keyboard-driven command launcher.
 * Opens as a centered overlay, supports fuzzy search and arrow navigation.
 */
export function CommandPalette({
  isOpen,
  onClose,
  commands,
  onExecute,
  recentCommands,
  initialQuery = "",
}: CommandPaletteProps) {
  const [query, setQuery] = useState("");
  const [selectedIndex, setSelectedIndex] = useState(0);
  const inputRef = useRef<HTMLInputElement>(null);
  const listRef = useRef<HTMLDivElement>(null);

  const filteredCommands = useMemo(() => {
    if (!query.trim()) {
      const recent = recentCommands
        .map((id) => commands.find((c) => c.id === id))
        .filter(Boolean) as Command[];
      const rest = commands.filter((c) => !recentCommands.includes(c.id));
      return [...recent, ...rest];
    }
    const lowerQuery = query.toLowerCase();
    return commands
      .filter(
        (cmd) =>
          cmd.title.toLowerCase().includes(lowerQuery) ||
          cmd.id.toLowerCase().includes(lowerQuery) ||
          cmd.category?.toLowerCase().includes(lowerQuery),
      )
      .sort((a, b) => {
        const aStarts = a.title.toLowerCase().startsWith(lowerQuery);
        const bStarts = b.title.toLowerCase().startsWith(lowerQuery);
        if (aStarts && !bStarts) return -1;
        if (bStarts && !aStarts) return 1;
        return a.title.localeCompare(b.title);
      });
  }, [query, commands, recentCommands]);

  useEffect(() => {
    if (isOpen) {
      setQuery(initialQuery);
      setSelectedIndex(0);
      setTimeout(() => inputRef.current?.focus(), 0);
    }
  }, [isOpen, initialQuery]);

  const handleKeyDown = (e: React.KeyboardEvent) => {
    switch (e.key) {
      case "ArrowDown":
        e.preventDefault();
        setSelectedIndex((i) => Math.min(i + 1, filteredCommands.length - 1));
        break;
      case "ArrowUp":
        e.preventDefault();
        setSelectedIndex((i) => Math.max(i - 1, 0));
        break;
      case "Enter":
        e.preventDefault();
        if (filteredCommands[selectedIndex]) {
          onExecute(filteredCommands[selectedIndex].id);
          onClose();
        }
        break;
      case "Escape":
        e.preventDefault();
        onClose();
        break;
    }
  };

  useEffect(() => {
    const el = listRef.current?.children[selectedIndex] as HTMLElement;
    el?.scrollIntoView({ block: "nearest" });
  }, [selectedIndex]);

  if (!isOpen) return null;

  return (
    <div
      className="fixed inset-0 z-[10001] flex justify-center pt-[36px] bg-black/25"
      onClick={onClose}
    >
      <div
        className="w-[520px] max-w-[90vw] max-h-[60vh] bg-[var(--color-surface)] border border-[var(--color-border)] rounded-b-xl shadow-2xl flex flex-col overflow-hidden h-fit"
        onClick={(e) => e.stopPropagation()}
      >
        {/* Input */}
        <div className="flex items-center px-3 py-2 border-b border-[var(--color-border)]">
          <input
            ref={inputRef}
            type="text"
            className="flex-1 bg-transparent border-none outline-none text-[var(--color-text)] text-sm py-1"
            placeholder="Type a command..."
            value={query}
            onChange={(e) => {
              setQuery(e.target.value);
              setSelectedIndex(0);
            }}
            onKeyDown={handleKeyDown}
          />
          <button
            className="flex items-center justify-center w-6 h-6 rounded text-[var(--color-text-secondary)] hover:text-[var(--color-text)] hover:bg-[var(--color-surface-alt)] transition-colors shrink-0"
            onClick={onClose}
          >
            <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
              <line x1="18" y1="6" x2="6" y2="18" />
              <line x1="6" y1="6" x2="18" y2="18" />
            </svg>
          </button>
        </div>

        {/* List */}
        <div className="overflow-y-auto max-h-[350px] p-1" ref={listRef}>
          {filteredCommands.length === 0 && (
            <div className="px-4 py-4 text-center text-[var(--color-text-secondary)] text-[13px]">
              No commands found
            </div>
          )}
          {filteredCommands.map((cmd, index) => (
            <div
              key={cmd.id}
              className={`flex items-center justify-between px-3 py-1.5 rounded cursor-pointer text-[13px] ${
                index === selectedIndex
                  ? "bg-[var(--color-accent)]/10"
                  : "hover:bg-[var(--color-surface-alt)]"
              }`}
              onClick={() => {
                onExecute(cmd.id);
                onClose();
              }}
              onMouseEnter={() => setSelectedIndex(index)}
            >
              <div className="flex items-center gap-1 min-w-0">
                {cmd.category && (
                  <span className="text-[var(--color-text-secondary)]">{cmd.category}:</span>
                )}
                <span className="text-[var(--color-text)]">{cmd.title}</span>
              </div>
              {cmd.keybinding && (
                <kbd className="text-[11px] px-1.5 py-0.5 rounded bg-[var(--color-surface-alt)] border border-[var(--color-border)] text-[var(--color-text-secondary)] font-[inherit] shrink-0 ml-3">
                  {cmd.keybinding}
                </kbd>
              )}
            </div>
          ))}
        </div>
      </div>
    </div>
  );
}
