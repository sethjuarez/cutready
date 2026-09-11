import { useState } from "react";
import { RefreshCw, Trash2 } from "lucide-react";
import { useSettings, type AppSettings } from "../../hooks/useSettings";
import { inputClass } from "../../styles";
import { isMac } from "../../utils/platform";

type PresentationHotkeyKey =
  | "presentationNextHotkey"
  | "presentationPreviousHotkey"
  | "presentationPlayPauseHotkey"
  | "presentationSpeedUpHotkey"
  | "presentationSlowDownHotkey"
  | "presentationToggleModeHotkey"
  | "presentationExitHotkey";

const modifierCodes = new Set([
  "ControlLeft",
  "ControlRight",
  "ShiftLeft",
  "ShiftRight",
  "AltLeft",
  "AltRight",
  "MetaLeft",
  "MetaRight",
]);

function formatKeyCombo(event: KeyboardEvent): { combo: string; hasMainKey: boolean } {
  const parts: string[] = [];
  if (event.ctrlKey) parts.push(isMac ? "Control" : "CmdOrControl");
  if (event.metaKey) parts.push(isMac ? "CmdOrControl" : "Meta");
  if (event.altKey) parts.push("Alt");
  if (event.shiftKey) parts.push("Shift");

  const { code } = event;
  let hasMainKey = false;
  if (!modifierCodes.has(code)) {
    hasMainKey = true;
    if (code.startsWith("Digit")) {
      parts.push(code.slice(5));
    } else if (code.startsWith("Key")) {
      parts.push(code.slice(3));
    } else if (code.startsWith("Numpad")) {
      parts.push(`num${code.slice(6)}`);
    } else {
      parts.push(code);
    }
  }

  return { combo: parts.join("+"), hasMainKey };
}

function HotkeyCaptureField({
  label,
  description,
  settingKey,
  value,
  updateSetting,
}: {
  label: string;
  description: string;
  settingKey: PresentationHotkeyKey;
  value: string;
  updateSetting: <K extends keyof AppSettings>(key: K, value: AppSettings[K]) => Promise<void>;
}) {
  const [capturing, setCapturing] = useState(false);
  const [captureError, setCaptureError] = useState("");

  const handleKeyDown = (event: React.KeyboardEvent<HTMLInputElement>) => {
    event.preventDefault();
    event.stopPropagation();

    if (event.key === "Backspace" || event.key === "Delete") {
      void updateSetting(settingKey, "");
      setCapturing(false);
      setCaptureError("");
      return;
    }

    const { combo, hasMainKey } = formatKeyCombo(event.nativeEvent);
    if (hasMainKey && combo) {
      void updateSetting(settingKey, combo);
      setCapturing(false);
      setCaptureError("");
      return;
    }

    setCaptureError("Press a complete shortcut with a non-modifier key, for example F13 or Ctrl+Alt+Shift+Right.");
  };

  return (
    <label className="flex flex-col gap-1.5">
      <span className="text-xs font-medium text-[rgb(var(--color-text-secondary))]">{label}</span>
      <div className="flex gap-2">
        <input
          value={capturing ? "Press a key combo..." : value}
          readOnly
          onFocus={() => {
            setCapturing(true);
            setCaptureError("");
          }}
          onBlur={() => setCapturing(false)}
          onKeyDown={handleKeyDown}
          placeholder="Click to capture hotkey"
          spellCheck={false}
          className={`${inputClass} font-mono ${capturing ? "ring-2 ring-[rgb(var(--color-accent))]/35" : ""}`}
        />
        <button
          type="button"
          onClick={() => updateSetting(settingKey, "")}
          className="grid h-10 w-10 shrink-0 place-items-center rounded-lg border border-[rgb(var(--color-border))] bg-[rgb(var(--color-surface))] text-[rgb(var(--color-text-secondary))] transition-colors hover:text-[rgb(var(--color-text))]"
          aria-label={`Clear ${label.toLowerCase()} hotkey`}
          title="Clear hotkey"
        >
          <Trash2 className="h-3.5 w-3.5" />
        </button>
      </div>
      <span className={`text-[10px] leading-4 ${captureError ? "text-[rgb(var(--color-error))]" : "text-[rgb(var(--color-text-secondary))]"}`}>
        {captureError || description}
      </span>
    </label>
  );
}

export function PresentationTab({ settings, updateSetting }: {
  settings: ReturnType<typeof useSettings>["settings"];
  updateSetting: ReturnType<typeof useSettings>["updateSetting"];
}) {
  const resetDefaults = () => {
    void updateSetting("presentationNextHotkey", "CmdOrControl+Alt+Shift+ArrowRight");
    void updateSetting("presentationPreviousHotkey", "CmdOrControl+Alt+Shift+ArrowLeft");
    void updateSetting("presentationPlayPauseHotkey", "CmdOrControl+Alt+Shift+Space");
    void updateSetting("presentationSpeedUpHotkey", "CmdOrControl+Alt+Shift+BracketRight");
    void updateSetting("presentationSlowDownHotkey", "CmdOrControl+Alt+Shift+BracketLeft");
    void updateSetting("presentationToggleModeHotkey", "CmdOrControl+Alt+Shift+T");
    void updateSetting("presentationExitHotkey", "CmdOrControl+Alt+Shift+Q");
  };

  return (
    <div className="flex flex-col gap-6">
      <fieldset className="flex flex-col gap-4 rounded-xl border border-[rgb(var(--color-border))] bg-[rgb(var(--color-surface-alt))]/40 p-4">
        <div className="flex flex-wrap items-start justify-between gap-3">
          <div>
            <label className="text-sm font-medium">Preview and teleprompter hotkeys</label>
            <p className="mt-1 max-w-2xl text-xs leading-5 text-[rgb(var(--color-text-secondary))]">
              These are registered globally so a Stream Deck can move CutReady while your demo app has focus.
              Use non-standard combinations to avoid colliding with the app you are demonstrating.
            </p>
          </div>
          <button
            type="button"
            onClick={resetDefaults}
            className="inline-flex items-center gap-2 rounded-lg border border-[rgb(var(--color-border))] bg-[rgb(var(--color-surface))] px-3 py-2 text-xs font-medium text-[rgb(var(--color-text-secondary))] transition-colors hover:text-[rgb(var(--color-text))]"
          >
            <RefreshCw className="h-3.5 w-3.5" />
            Reset defaults
          </button>
        </div>

        <div className="grid gap-4 sm:grid-cols-2">
          <HotkeyCaptureField
            label="Next slide"
            description="Advances slide preview, slide-only mode, or teleprompter."
            settingKey="presentationNextHotkey"
            value={settings.presentationNextHotkey}
            updateSetting={updateSetting}
          />
          <HotkeyCaptureField
            label="Previous slide"
            description="Moves back one slide in preview, slide-only mode, or teleprompter."
            settingKey="presentationPreviousHotkey"
            value={settings.presentationPreviousHotkey}
            updateSetting={updateSetting}
          />
          <HotkeyCaptureField
            label="Play / pause teleprompter"
            description="Starts or stops teleprompter auto-scroll, matching Space in teleprompter mode."
            settingKey="presentationPlayPauseHotkey"
            value={settings.presentationPlayPauseHotkey}
            updateSetting={updateSetting}
          />
          <HotkeyCaptureField
            label="Speed up teleprompter"
            description="Increases teleprompter auto-scroll speed."
            settingKey="presentationSpeedUpHotkey"
            value={settings.presentationSpeedUpHotkey}
            updateSetting={updateSetting}
          />
          <HotkeyCaptureField
            label="Slow down teleprompter"
            description="Decreases teleprompter auto-scroll speed."
            settingKey="presentationSlowDownHotkey"
            value={settings.presentationSlowDownHotkey}
            updateSetting={updateSetting}
          />
          <HotkeyCaptureField
            label="Toggle teleprompter"
            description="Enters teleprompter from preview, or returns from teleprompter to the prior preview mode."
            settingKey="presentationToggleModeHotkey"
            value={settings.presentationToggleModeHotkey}
            updateSetting={updateSetting}
          />
          <HotkeyCaptureField
            label="Exit presentation"
            description="Closes or backs out of the active presentation preview."
            settingKey="presentationExitHotkey"
            value={settings.presentationExitHotkey}
            updateSetting={updateSetting}
          />
        </div>

        <div className="rounded-lg border border-[rgb(var(--color-border-subtle))] bg-[rgb(var(--color-surface))] px-3 py-2 text-[11px] leading-5 text-[rgb(var(--color-text-secondary))]">
          Click a field, press the Stream Deck hotkey combo you want to emit, or press Backspace/Delete while focused to clear it.
        </div>
      </fieldset>
    </div>
  );
}
