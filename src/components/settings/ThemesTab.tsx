import { useSettings } from "../../hooks/useSettings";
import { useTheme, type ThemePreference } from "../../hooks/useTheme";
import { THEME_PALETTES, type ThemePalette } from "../../theme/appThemePalettes";

function tokenRgb(value: string): string {
  return `rgb(${value})`;
}

function ThemePaletteCard({
  palette,
  selected,
  onSelect,
  theme,
}: {
  palette: ThemePalette;
  selected: boolean;
  onSelect: () => void;
  theme: "light" | "dark";
}) {
  const preview = palette[theme];
  const swatches = [preview.surface, preview.surfaceAlt, preview.accent, preview.secondary].map(tokenRgb);
  return (
    <button
      onClick={onSelect}
      className={`group overflow-hidden rounded-xl border text-left transition-all ${
        selected
          ? "border-[rgb(var(--color-accent))] ring-1 ring-[rgb(var(--color-accent))]/40"
          : "border-[rgb(var(--color-border))] hover:border-[rgb(var(--color-accent))]/60"
      }`}
      aria-pressed={selected}
    >
      <div
        className="h-24 p-3"
        style={{
          backgroundColor: tokenRgb(preview.surface),
          color: tokenRgb(preview.text),
        }}
      >
        <div className="flex items-center gap-1.5">
          <span className="h-1.5 w-1.5 rounded-full" style={{ backgroundColor: tokenRgb(preview.textSecondary) }} />
          <span className="h-1.5 w-1.5 rounded-full" style={{ backgroundColor: tokenRgb(preview.textSecondary) }} />
          <span className="h-1.5 w-1.5 rounded-full" style={{ backgroundColor: tokenRgb(preview.textSecondary) }} />
          <span className="ml-auto h-2 w-8 rounded-full" style={{ backgroundColor: tokenRgb(preview.accent) }} />
        </div>
        <div className="mt-4 grid grid-cols-[0.65fr_1fr] gap-3">
          <div className="space-y-2">
            <div className="h-2 w-16 rounded-full" style={{ backgroundColor: tokenRgb(preview.surfaceAlt) }} />
            <div className="h-2 w-12 rounded-full" style={{ backgroundColor: tokenRgb(preview.surfaceAlt) }} />
            <div className="h-2 w-9 rounded-full" style={{ backgroundColor: tokenRgb(preview.surfaceAlt) }} />
          </div>
          <div className="space-y-2">
            <div className="h-2 w-full rounded-full" style={{ backgroundColor: tokenRgb(preview.borderSubtle) }} />
            <div className="h-2 w-5/6 rounded-full" style={{ backgroundColor: tokenRgb(preview.borderSubtle) }} />
            <div className="flex flex-wrap gap-1">
              {swatches.map((swatch) => (
                <span key={swatch} className="h-1.5 flex-1 rounded-full" style={{ backgroundColor: swatch }} />
              ))}
            </div>
          </div>
        </div>
      </div>
      <div className="flex items-center gap-2 bg-[rgb(var(--color-surface-alt))] px-3 py-2">
        <div className="min-w-0">
          <div className="truncate text-sm font-medium text-[rgb(var(--color-text))]">{palette.name}</div>
          <div className="truncate text-[10px] text-[rgb(var(--color-text-secondary))]">{palette.description}</div>
        </div>
        {selected && (
          <span className="ml-auto rounded-full bg-[rgb(var(--color-accent))]/10 px-2 py-0.5 text-[10px] font-medium text-[rgb(var(--color-accent))]">
            Active
          </span>
        )}
      </div>
    </button>
  );
}

export function ThemesTab({ settings, updateSetting }: {
  settings: ReturnType<typeof useSettings>["settings"];
  updateSetting: ReturnType<typeof useSettings>["updateSetting"];
}) {
  const { preference, theme, setTheme } = useTheme();

  return (
    <div className="flex flex-col gap-6">
      <fieldset className="flex flex-col gap-3">
        <div>
          <label className="text-sm font-medium">Theme Mode</label>
          <p className="mt-1 text-xs text-[rgb(var(--color-text-secondary))]">Choose light, dark, or follow your system appearance.</p>
        </div>
        <div className="inline-flex w-fit rounded-xl bg-[rgb(var(--color-surface-alt))] p-1 border border-[rgb(var(--color-border))]">
          {(["system", "light", "dark"] as ThemePreference[]).map((mode) => (
            <button
              key={mode}
              onClick={() => setTheme(mode)}
              className={`px-3 py-1.5 rounded-lg text-sm font-medium capitalize transition-colors ${
                preference === mode
                  ? "bg-[rgb(var(--color-surface))] text-[rgb(var(--color-text))] shadow-sm"
                  : "text-[rgb(var(--color-text-secondary))] hover:text-[rgb(var(--color-text))]"
              }`}
            >
              {mode}
            </button>
          ))}
        </div>
      </fieldset>

      <fieldset className="flex flex-col gap-3">
        <div>
          <label className="text-sm font-medium">Theme Palette</label>
          <p className="mt-1 text-xs text-[rgb(var(--color-text-secondary))]">Pick the token palette used across app surfaces, borders, text, and accent states.</p>
        </div>
        <div className="grid grid-cols-1 gap-3 sm:grid-cols-2 xl:grid-cols-3">
          {THEME_PALETTES.map((palette) => (
            <ThemePaletteCard
              key={palette.id}
              palette={palette}
              selected={settings.displayThemePalette === palette.id}
              onSelect={() => updateSetting("displayThemePalette", palette.id)}
              theme={theme}
            />
          ))}
        </div>
      </fieldset>

    </div>
  );
}
