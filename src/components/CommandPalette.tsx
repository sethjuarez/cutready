import { useState, useEffect, useRef, useMemo } from "react";
import { X } from "lucide-react";
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
      // Try focusing immediately, then again after a frame for Tauri webview
      inputRef.current?.focus();
      requestAnimationFrame(() => inputRef.current?.focus());
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
      className="fixed inset-0 z-modal flex justify-center pt-[var(--titlebar-height)] bg-black/25"
      onClick={onClose}
    >
      <div
        className="w-[520px] max-w-[90vw] max-h-[60vh] bg-[rgb(var(--color-surface))] border border-[rgb(var(--color-border))] rounded-b-xl shadow-2xl flex flex-col overflow-hidden h-fit"
        onClick={(e) => e.stopPropagation()}
        onKeyDown={handleKeyDown}
        tabIndex={-1}
      >
        {/* Input */}
        <div className="flex items-center px-3 py-2 border-b border-[rgb(var(--color-border))]">
          <input
            ref={inputRef}
            type="text"
            role="combobox"
            aria-expanded="true"
            aria-controls="command-list"
            aria-activedescendant={filteredCommands[selectedIndex] ? `cmd-${filteredCommands[selectedIndex].id}` : undefined}
            className="flex-1 bg-transparent border-none outline-none text-[rgb(var(--color-text))] text-sm py-1"
            placeholder="Type a command..."
            value={query}
            onChange={(e) => {
              setQuery(e.target.value);
              setSelectedIndex(0);
            }}
          />
          <button
            className="flex items-center justify-center w-6 h-6 rounded text-[rgb(var(--color-text-secondary))] hover:text-[rgb(var(--color-text))] hover:bg-[rgb(var(--color-surface-alt))] transition-colors shrink-0"
            onClick={onClose}
          >
            <X className="w-3.5 h-3.5" />
          </button>
        </div>

        {/* Live region for screen readers */}
        <span className="sr-only" aria-live="polite" aria-atomic="true">
          {filteredCommands.length} {filteredCommands.length === 1 ? "command" : "commands"}
        </span>

        {/* List */}
        <div className="overflow-y-auto max-h-[350px] p-1" ref={listRef} id="command-list" role="listbox" aria-label="Commands">
          {filteredCommands.length === 0 && (
            <div className="px-4 py-4 text-center text-[rgb(var(--color-text-secondary))] text-[13px]">
              No commands found
            </div>
          )}
          {filteredCommands.map((cmd, index) => (
            <div
              key={cmd.id}
              id={`cmd-${cmd.id}`}
              role="option"
              aria-selected={index === selectedIndex}
              className={`flex items-center justify-between px-3 py-1.5 rounded cursor-pointer text-[13px] transition-colors ${
                index === selectedIndex
                  ? "bg-[rgb(var(--color-surface-alt))] text-[rgb(var(--color-accent))]"
                  : "hover:bg-[rgb(var(--color-surface-alt))]"
              }`}
              onClick={() => {
                onExecute(cmd.id);
                onClose();
              }}
              onMouseEnter={() => setSelectedIndex(index)}
            >
              <div className="flex items-center gap-2 min-w-0">
                {cmd.icon && (
                  <span className={`shrink-0 w-4 h-4 flex items-center justify-center ${index !== selectedIndex ? 'text-[rgb(var(--color-text-secondary))]' : ''}`}>{cmd.icon}</span>
                )}
                {cmd.category && (
                  <span className="text-[rgb(var(--color-text-secondary))]">{cmd.category}:</span>
                )}
                <span className="text-[rgb(var(--color-text))]">{cmd.title}</span>
              </div>
              {cmd.keybinding && (
                <kbd className="text-[11px] px-1.5 py-0.5 rounded bg-[rgb(var(--color-surface-alt))] border border-[rgb(var(--color-border))] text-[rgb(var(--color-text-secondary))] font-[inherit] shrink-0 ml-3">
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
