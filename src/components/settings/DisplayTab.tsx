import { useSettings } from "../../hooks/useSettings";
import { inputClass } from "../../styles";
import { TERMINAL_COLOR_SCHEMES, normalizeTerminalColorMode, normalizeTerminalCustomTheme, type TerminalCustomTheme } from "../../theme/terminalThemes";

const fontSizes = [
  { value: 13, label: "Small (13px)" },
  { value: 14, label: "Medium (14px)" },
  { value: 16, label: "Large (16px)" },
  { value: 18, label: "XL (18px)" },
];

const terminalFontSizes = [
  { value: 11, label: "Small (11px)" },
  { value: 12, label: "Medium (12px)" },
  { value: 14, label: "Large (14px)" },
  { value: 16, label: "XL (16px)" },
];

const terminalCustomColorFields: Array<{
  key: keyof TerminalCustomTheme;
  label: string;
}> = [
  { key: "background", label: "Background" },
  { key: "foreground", label: "Foreground" },
  { key: "cursor", label: "Cursor" },
  { key: "selectionBackground", label: "Selection" },
];

export function DisplayTab({ settings, updateSetting }: {
  settings: ReturnType<typeof useSettings>["settings"];
  updateSetting: ReturnType<typeof useSettings>["updateSetting"];
}) {
  const terminalColorMode = normalizeTerminalColorMode(settings.displayTerminalColorMode);
  const terminalCustomTheme = normalizeTerminalCustomTheme(settings.displayTerminalCustomTheme);
  const updateTerminalCustomColor = (key: keyof TerminalCustomTheme, value: string) => {
    void updateSetting("displayTerminalCustomTheme", { ...terminalCustomTheme, [key]: value });
  };

  return (
    <div className="flex flex-col gap-6">
      {/* Font family */}
      <fieldset className="flex flex-col gap-2">
        <label className="text-sm font-medium">Font</label>
        <div className="flex gap-2">
          {([
            { id: "system", label: "System", preview: "Geist Sans" },
            { id: "sans", label: "Sans", preview: "Inter" },
            { id: "serif", label: "Serif", preview: "Lora" },
            { id: "mono", label: "Mono", preview: "Geist Mono" },
          ] as const).map((f) => (
            <button
              key={f.id}
              onClick={() => updateSetting("displayFontFamily", f.id)}
              className={`flex-1 flex flex-col items-center gap-1 px-3 py-2.5 rounded-lg text-sm transition-colors border ${
                settings.displayFontFamily === f.id
                  ? "bg-[rgb(var(--color-accent))] text-[rgb(var(--color-accent-fg))] border-[rgb(var(--color-accent))]"
                  : "bg-[rgb(var(--color-surface-alt))] border-[rgb(var(--color-border))] text-[rgb(var(--color-text-secondary))] hover:text-[rgb(var(--color-text))]"
              }`}
            >
              <span
                className="text-base leading-none"
                style={{ fontFamily: f.id === "system" ? "var(--app-font-family)" :
                  f.id === "sans" ? '"Inter", "Helvetica Neue", sans-serif' :
                  f.id === "serif" ? '"Lora", Georgia, serif' :
                  '"Geist Mono", "Cascadia Code", monospace' }}
              >
                Aa
              </span>
              <span className="text-[10px]">{f.label}</span>
            </button>
          ))}
        </div>
        <p className="text-xs text-[rgb(var(--color-text-secondary))]">Font used throughout the app. Serif and Sans require web fonts to be available.</p>
      </fieldset>

      {/* Editor text size */}
      <fieldset className="flex flex-col gap-2">
        <label className="text-sm font-medium">Editor Text Size</label>
        <select
          value={settings.displayFontSize}
          onChange={(e) => updateSetting("displayFontSize", Number(e.target.value))}
          className={inputClass}
        >
          {fontSizes.map((s) => (
            <option key={s.value} value={s.value}>{s.label}</option>
          ))}
        </select>
        <p className="text-xs text-[rgb(var(--color-text-secondary))]">Text size for the sketch editor and planning table.</p>
      </fieldset>

      {/* Chat text size */}
      <fieldset className="flex flex-col gap-2">
        <label className="text-sm font-medium">Chat Text Size</label>
        <select
          value={settings.displayChatFontSize}
          onChange={(e) => updateSetting("displayChatFontSize", Number(e.target.value))}
          className={inputClass}
        >
          {fontSizes.map((s) => (
            <option key={s.value} value={s.value}>{s.label}</option>
          ))}
        </select>
        <p className="text-xs text-[rgb(var(--color-text-secondary))]">Text size for the chat panel.</p>
      </fieldset>

      {/* Terminal appearance */}
      <fieldset className="flex flex-col gap-3 rounded-xl border border-[rgb(var(--color-border))] bg-[rgb(var(--color-surface-alt))]/40 p-4">
        <div>
          <label className="text-sm font-medium">Terminal Appearance</label>
          <p className="mt-1 text-xs text-[rgb(var(--color-text-secondary))]">
            Use a Nerd Font for prompt glyphs, then choose a built-in terminal palette or customize key colors.
          </p>
        </div>

        <label className="flex flex-col gap-1.5">
          <span className="text-xs font-medium text-[rgb(var(--color-text-secondary))]">Terminal Font Family</span>
          <input
            value={settings.displayTerminalFontFamily}
            onChange={(e) => updateSetting("displayTerminalFontFamily", e.target.value)}
            className={inputClass}
            spellCheck={false}
            placeholder={'"CaskaydiaCove Nerd Font", "Cascadia Code", Consolas, monospace'}
          />
        </label>

        <div className="grid gap-3 sm:grid-cols-2">
          <label className="flex flex-col gap-1.5">
            <span className="text-xs font-medium text-[rgb(var(--color-text-secondary))]">Terminal Text Size</span>
            <select
              value={settings.displayTerminalFontSize}
              onChange={(e) => updateSetting("displayTerminalFontSize", Number(e.target.value))}
              className={inputClass}
            >
              {terminalFontSizes.map((s) => (
                <option key={s.value} value={s.value}>{s.label}</option>
              ))}
            </select>
          </label>

          <div className="flex flex-col gap-1.5">
            <span className="text-xs font-medium text-[rgb(var(--color-text-secondary))]">Terminal Colors</span>
            <div className="grid grid-cols-2 gap-2">
              {TERMINAL_COLOR_SCHEMES.map((mode) => (
                <button
                  key={mode.id}
                  onClick={() => updateSetting("displayTerminalColorMode", mode.id)}
                  title={mode.description}
                  className={`rounded-lg border px-3 py-2 text-left text-xs font-medium transition-colors ${
                    terminalColorMode === mode.id
                      ? "border-[rgb(var(--color-accent))] bg-[rgb(var(--color-accent))] text-[rgb(var(--color-accent-fg))]"
                      : "border-[rgb(var(--color-border))] bg-[rgb(var(--color-surface))] text-[rgb(var(--color-text-secondary))] hover:text-[rgb(var(--color-text))]"
                  }`}
                >
                  {mode.label}
                </button>
              ))}
            </div>
          </div>
        </div>

        {terminalColorMode === "custom" && (
          <div className="grid gap-3 rounded-lg border border-[rgb(var(--color-border))] bg-[rgb(var(--color-surface))] p-3 sm:grid-cols-2">
            {terminalCustomColorFields.map((field) => (
              <label key={field.key} className="flex items-center justify-between gap-3 text-xs font-medium text-[rgb(var(--color-text-secondary))]">
                <span>{field.label}</span>
                <input
                  type="color"
                  value={terminalCustomTheme[field.key]}
                  onChange={(event) => updateTerminalCustomColor(field.key, event.target.value)}
                  className="h-8 w-14 cursor-pointer rounded border border-[rgb(var(--color-border))] bg-[rgb(var(--color-surface-alt))]"
                  aria-label={`Terminal ${field.label.toLowerCase()} color`}
                />
              </label>
            ))}
          </div>
        )}
      </fieldset>

      {/* Row density */}
      <fieldset className="flex flex-col gap-2">
        <label className="text-sm font-medium">Row Density</label>
        <div className="flex gap-2">
          {(["compact", "comfortable", "spacious"] as const).map((d) => (
            <button
              key={d}
              onClick={() => updateSetting("displayRowDensity", d)}
              className={`px-3 py-1.5 rounded-lg text-sm capitalize transition-colors border ${
                settings.displayRowDensity === d
                  ? "bg-[rgb(var(--color-accent))] text-[rgb(var(--color-accent-fg))] border-[rgb(var(--color-accent))]"
                  : "bg-[rgb(var(--color-surface-alt))] border-[rgb(var(--color-border))] text-[rgb(var(--color-text-secondary))] hover:text-[rgb(var(--color-text))]"
              }`}
            >
              {d}
            </button>
          ))}
        </div>
        <p className="text-xs text-[rgb(var(--color-text-secondary))]">Controls padding and line-height in planning table rows.</p>
      </fieldset>

      {/* Row colors */}
      <fieldset className="flex flex-col gap-2">
        <label className="text-sm font-medium">Row Color Palette</label>
        <div className="flex gap-2">
          {(["neutral", "pastel", "vivid"] as const).map((c) => (
            <button
              key={c}
              onClick={() => updateSetting("displayRowColors", c)}
              className={`px-3 py-1.5 rounded-lg text-sm capitalize transition-colors border ${
                settings.displayRowColors === c
                  ? "bg-[rgb(var(--color-accent))] text-[rgb(var(--color-accent-fg))] border-[rgb(var(--color-accent))]"
                  : "bg-[rgb(var(--color-surface-alt))] border-[rgb(var(--color-border))] text-[rgb(var(--color-text-secondary))] hover:text-[rgb(var(--color-text))]"
              }`}
            >
              {c}
            </button>
          ))}
        </div>
        <p className="text-xs text-[rgb(var(--color-text-secondary))]">Color intensity of the left stripe on planning rows.</p>
      </fieldset>

      {/* Editor width */}
      <fieldset className="flex flex-col gap-2">
        <label className="text-sm font-medium">Editor Width</label>
        <div className="flex gap-2">
          {(["centered", "full"] as const).map((w) => (
            <button
              key={w}
              onClick={() => updateSetting("displayEditorWidth", w)}
              className={`px-3 py-1.5 rounded-lg text-sm capitalize transition-colors border ${
                settings.displayEditorWidth === w
                  ? "bg-[rgb(var(--color-accent))] text-[rgb(var(--color-accent-fg))] border-[rgb(var(--color-accent))]"
                  : "bg-[rgb(var(--color-surface-alt))] border-[rgb(var(--color-border))] text-[rgb(var(--color-text-secondary))] hover:text-[rgb(var(--color-text))]"
              }`}
            >
              {w === "centered" ? "Centered (896px)" : "Full Width"}
            </button>
          ))}
        </div>
        <p className="text-xs text-[rgb(var(--color-text-secondary))]">Whether document editors use a max-width or expand to fill available space.</p>
      </fieldset>
    </div>
  );
}

// ── AI Provider Tab ──────────────────────────────────────────────
