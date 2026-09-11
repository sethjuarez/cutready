import { useSettings } from "../../hooks/useSettings";

export function ExperimentalTab({ settings, updateSetting }: {
  settings: ReturnType<typeof useSettings>["settings"];
  updateSetting: ReturnType<typeof useSettings>["updateSetting"];
}) {
  return (
    <div className="flex flex-col gap-6">
      <p className="text-sm text-[rgb(var(--color-text-secondary))]">
        These features are still in development. They may be incomplete or unstable.
      </p>

      <fieldset className="flex flex-col gap-2">
        <legend className="text-sm font-medium mb-1">Feature Flags</legend>

        <label className="flex items-center justify-between gap-3 rounded-lg bg-[rgb(var(--color-surface))] px-3 py-2">
          <span>
            <span className="block text-xs text-[rgb(var(--color-text))]">Recording</span>
            <span className="block text-[11px] text-[rgb(var(--color-text-secondary))]">Screen, camera, and audio capture for demo recordings</span>
          </span>
          <input
            type="checkbox"
            checked={settings.featureRecording}
            onChange={(e) => updateSetting("featureRecording", e.target.checked)}
            className="h-4 w-4 accent-[rgb(var(--color-accent))]"
          />
        </label>

      </fieldset>
    </div>
  );
}
