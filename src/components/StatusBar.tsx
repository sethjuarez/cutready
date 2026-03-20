import { useEffect, useState } from "react";
import { MoonIcon, SunIcon } from "@heroicons/react/24/outline";
import type { Theme } from "../hooks/useTheme";

interface StatusBarProps {
  theme: Theme;
  onToggleTheme: () => void;
}

export function StatusBar({ theme, onToggleTheme }: StatusBarProps) {
  const [version, setVersion] = useState("");

  useEffect(() => {
    import("@tauri-apps/api/app")
      .then(({ getVersion }) => getVersion())
      .then((v) => setVersion(import.meta.env.DEV ? `${v}-dev` : v))
      .catch(() => setVersion("dev"));
  }, []);

  return (
    <div
      className="no-select fixed bottom-0 left-0 right-0 z-50 flex items-center justify-between bg-[var(--color-surface)]/80 backdrop-blur-md border-t border-[var(--color-border)] px-3 text-xs text-[var(--color-text-secondary)]"
      style={{ height: "var(--statusbar-height)" }}
    >
      {/* Left: status items */}
      <div className="flex items-center gap-3">
        <span className="inline-flex items-center gap-1.5">
          <span className="w-1.5 h-1.5 rounded-full bg-warning animate-pulse" />
          Early Development
        </span>
      </div>

      {/* Right: version + theme toggle */}
      <div className="flex items-center gap-2">
        {version && (
          <span className="opacity-60">v{version}</span>
        )}
        <button
          onClick={onToggleTheme}
          className="flex items-center gap-1.5 px-2 py-0.5 rounded-md hover:bg-[var(--color-surface-alt)] transition-colors"
          title={`Theme: ${theme} (click to toggle)`}
        >
          {theme === "dark" ? (
            <MoonIcon className="w-3 h-3" />
          ) : (
            <SunIcon className="w-3 h-3" />
          )}
          <span className="capitalize">{theme}</span>
        </button>
      </div>
    </div>
  );
}

