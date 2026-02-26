import type { Theme } from "../hooks/useTheme";

interface StatusBarProps {
  theme: Theme;
  onToggleTheme: () => void;
}

export function StatusBar({ theme, onToggleTheme }: StatusBarProps) {
  return (
    <div
      className="no-select fixed bottom-0 left-0 right-0 z-50 flex items-center justify-between bg-[var(--color-surface)]/80 backdrop-blur-md border-t border-[var(--color-border)] px-3 text-xs text-[var(--color-text-secondary)]"
      style={{ height: "var(--statusbar-height)" }}
    >
      {/* Left: status items */}
      <div className="flex items-center gap-3">
        <span className="inline-flex items-center gap-1.5">
          <span className="w-1.5 h-1.5 rounded-full bg-amber-500 animate-pulse" />
          Early Development
        </span>
      </div>

      {/* Right: theme toggle */}
      <div className="flex items-center gap-2">
        <button
          onClick={onToggleTheme}
          className="flex items-center gap-1.5 px-2 py-0.5 rounded-md hover:bg-[var(--color-surface-alt)] transition-colors"
          title={`Theme: ${theme} (click to toggle)`}
        >
          {theme === "dark" ? (
            <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
              <path d="M21 12.79A9 9 0 1 1 11.21 3 7 7 0 0 0 21 12.79z" />
            </svg>
          ) : (
            <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
              <circle cx="12" cy="12" r="5" />
              <line x1="12" y1="1" x2="12" y2="3" />
              <line x1="12" y1="21" x2="12" y2="23" />
              <line x1="4.22" y1="4.22" x2="5.64" y2="5.64" />
              <line x1="18.36" y1="18.36" x2="19.78" y2="19.78" />
              <line x1="1" y1="12" x2="3" y2="12" />
              <line x1="21" y1="12" x2="23" y2="12" />
              <line x1="4.22" y1="19.78" x2="5.64" y2="18.36" />
              <line x1="18.36" y1="5.64" x2="19.78" y2="4.22" />
            </svg>
          )}
          <span className="capitalize">{theme}</span>
        </button>
      </div>
    </div>
  );
}

