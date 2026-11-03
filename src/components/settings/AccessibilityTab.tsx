import { useId, type ReactNode } from "react";
import { inputClass } from "../../styles";
import { isMac } from "../../utils/platform";
import { useAccessibilityStore } from "../../stores/accessibilityStore";
import {
  DEFAULT_ZOOM,
  TOAST_DURATIONS,
  ZOOM_LEVELS,
  supportsSystemPreference,
  type AccessibilitySettings,
  type AnnouncementCategory,
  type TriState,
} from "../../accessibility/settings";
import { Switch } from "../Switch";

const ANNOUNCEMENT_ROWS: ReadonlyArray<{ key: AnnouncementCategory; title: string; description: string }> = [
  { key: "reasoning", title: "Reasoning", description: "Announce when the assistant starts thinking." },
  { key: "toolCalls", title: "Tool calls", description: "Announce tools the assistant runs." },
  { key: "commandFinished", title: "Command finished", description: "Announce when a tool finishes or fails." },
  { key: "readingFiles", title: "Reading files", description: "Announce when the assistant reads project files." },
  { key: "editingDocuments", title: "Editing documents", description: "Announce when the assistant edits sketches, storyboards, or notes." },
  { key: "agentChange", title: "Model and agent changes", description: "Announce when another agent takes over." },
];

function Section({ title, description, children }: { title: string; description?: string; children: ReactNode }) {
  const headingId = useId();
  return (
    <section aria-labelledby={headingId} className="flex flex-col gap-2">
      <div>
        <h2 id={headingId} className="text-base font-semibold text-[rgb(var(--color-text))]">
          {title}
        </h2>
        {description && <p className="mt-0.5 text-sm text-[rgb(var(--color-text-secondary))]">{description}</p>}
      </div>
      <div className="divide-y divide-[rgb(var(--color-border-subtle))] rounded-card border border-[rgb(var(--color-border))] bg-[rgb(var(--color-surface))]">
        {children}
      </div>
    </section>
  );
}

/** One setting: title and description on the left, its control on the right. */
function Row({
  title,
  description,
  control,
}: {
  title: string;
  description: string;
  control: (ids: { labelId: string; descriptionId: string }) => ReactNode;
}) {
  const labelId = useId();
  const descriptionId = useId();
  return (
    <div className="flex items-center justify-between gap-6 px-4 py-3">
      <div className="min-w-0">
        <div id={labelId} className="text-sm font-medium text-[rgb(var(--color-text))]">
          {title}
        </div>
        <div id={descriptionId} className="mt-0.5 text-sm text-[rgb(var(--color-text-secondary))]">
          {description}
        </div>
      </div>
      <div className="flex shrink-0 items-center gap-2">{control({ labelId, descriptionId })}</div>
    </div>
  );
}

function useSetting<K extends keyof AccessibilitySettings>(key: K) {
  const value = useAccessibilityStore((s) => s.settings[key]);
  const update = useAccessibilityStore((s) => s.update);
  return [value, (next: AccessibilitySettings[K]) => update(key, next)] as const;
}

function SwitchRow({ setting, title, description, testId }: {
  setting: "pointerOnHover" | "showUnderlines" | "interactionHints" | "keyboardShortcuts";
  title: string;
  description: string;
  testId: string;
}) {
  const [value, setValue] = useSetting(setting);
  return (
    <Row
      title={title}
      description={description}
      control={({ labelId, descriptionId }) => (
        <Switch
          checked={value}
          onChange={setValue}
          aria-labelledby={labelId}
          aria-describedby={descriptionId}
          data-testid={testId}
        />
      )}
    />
  );
}

function TriStateRow({ setting, title, description, testId }: {
  setting: "increaseContrast" | "differentiateWithoutColor";
  title: string;
  description: string;
  testId: string;
}) {
  const [value, setValue] = useSetting(setting);
  if (!supportsSystemPreference(isMac)) {
    return (
      <Row
        title={title}
        description={description}
        control={({ labelId, descriptionId }) => (
          <Switch
            checked={value === "on"}
            onChange={(on) => setValue(on ? "on" : "off")}
            aria-labelledby={labelId}
            aria-describedby={descriptionId}
            data-testid={testId}
          />
        )}
      />
    );
  }
  return (
    <Row
      title={title}
      description={description}
      control={({ labelId, descriptionId }) => (
        <select
          value={value}
          onChange={(e) => setValue(e.target.value as TriState)}
          aria-labelledby={labelId}
          aria-describedby={descriptionId}
          data-testid={testId}
          className={inputClass}
        >
          <option value="system">System</option>
          <option value="on">On</option>
          <option value="off">Off</option>
        </select>
      )}
    />
  );
}

function DurationRow({ setting, title, description, testId }: {
  setting: "errorToastMs" | "updateToastMs";
  title: string;
  description: string;
  testId: string;
}) {
  const [value, setValue] = useSetting(setting);
  return (
    <Row
      title={title}
      description={description}
      control={({ labelId, descriptionId }) => (
        <select
          value={value}
          onChange={(e) => setValue(Number(e.target.value))}
          aria-labelledby={labelId}
          aria-describedby={descriptionId}
          data-testid={testId}
          className={inputClass}
        >
          {TOAST_DURATIONS.map((d) => (
            <option key={d.ms} value={d.ms}>
              {d.label}
            </option>
          ))}
        </select>
      )}
    />
  );
}

function ZoomRow() {
  const [zoom, setZoom] = useSetting("zoom");
  const shortcut = isMac ? "⌘" : "Ctrl";
  return (
    <Row
      title="Zoom"
      description={`Scale the whole app. ${shortcut}+= and ${shortcut}+- step through levels, ${shortcut}+0 resets.`}
      control={({ labelId, descriptionId }) => (
        <>
          {zoom !== DEFAULT_ZOOM && (
            <button
              type="button"
              onClick={() => setZoom(DEFAULT_ZOOM)}
              data-testid="a11y-zoom-reset"
              className="h-control rounded-control px-2.5 text-sm text-[rgb(var(--color-text-secondary))] transition-colors duration-fast ease-fluent hover:bg-fill-hover hover:text-[rgb(var(--color-text))]"
            >
              Reset
            </button>
          )}
          <select
            value={zoom}
            onChange={(e) => setZoom(Number(e.target.value))}
            aria-labelledby={labelId}
            aria-describedby={descriptionId}
            data-testid="a11y-zoom"
            className={inputClass}
          >
            {ZOOM_LEVELS.map((level) => (
              <option key={level} value={level}>
                {level}%
              </option>
            ))}
          </select>
        </>
      )}
    />
  );
}

function AnnouncementRow({ category, title, description }: { category: AnnouncementCategory; title: string; description: string }) {
  const enabled = useAccessibilityStore((s) => s.settings.announce[category]);
  const announce = useAccessibilityStore((s) => s.settings.announce);
  const update = useAccessibilityStore((s) => s.update);
  return (
    <Row
      title={title}
      description={description}
      control={({ labelId, descriptionId }) => (
        <Switch
          checked={enabled}
          onChange={(on) => update("announce", { ...announce, [category]: on })}
          aria-labelledby={labelId}
          aria-describedby={descriptionId}
          data-testid={`a11y-announce-${category}`}
        />
      )}
    />
  );
}

export function AccessibilityTab() {
  return (
    <div className="flex flex-col gap-6" data-testid="settings-accessibility">
      <Section title="Display" description="Adjust zoom, cursor behavior, and visual differentiation.">
        <ZoomRow />
        <SwitchRow
          setting="pointerOnHover"
          title="Show pointer on hover"
          description="Use the hand cursor over buttons, links, tabs, and other controls."
          testId="a11y-pointer-on-hover"
        />
        <SwitchRow
          setting="showUnderlines"
          title="Show underlines"
          description="Underline links and link-style buttons so they don't rely on color."
          testId="a11y-show-underlines"
        />
        <TriStateRow
          setting="increaseContrast"
          title="Increase contrast"
          description={isMac ? "Strengthen control and card borders. System follows macOS." : "Strengthen control and card borders."}
          testId="a11y-increase-contrast"
        />
        <TriStateRow
          setting="differentiateWithoutColor"
          title="Differentiate without color"
          description={
            isMac
              ? "Add shapes and On/Off labels to states shown by color. System follows macOS."
              : "Add shapes and On/Off labels to states shown by color."
          }
          testId="a11y-differentiate-without-color"
        />
      </Section>

      <Section title="Notifications">
        <DurationRow
          setting="errorToastMs"
          title="Error toast duration"
          description="How long error notifications stay on screen."
          testId="a11y-error-toast-duration"
        />
        <DurationRow
          setting="updateToastMs"
          title="Update toast duration"
          description="How long notices about incoming saves and merged updates stay on screen."
          testId="a11y-update-toast-duration"
        />
      </Section>

      <Section title="Announcements" description="Control what content is announced by a screen reader.">
        <SwitchRow
          setting="interactionHints"
          title="Interaction hints"
          description="Describe how to use controls, such as sending a chat message or resizing a panel."
          testId="a11y-interaction-hints"
        />
        {ANNOUNCEMENT_ROWS.map((row) => (
          <AnnouncementRow key={row.key} category={row.key} title={row.title} description={row.description} />
        ))}
      </Section>

      <Section title="Keyboard">
        <SwitchRow
          setting="keyboardShortcuts"
          title="Use keyboard shortcuts"
          description="Turn off to stop app-wide shortcuts, such as the command palette and zoom, from firing."
          testId="a11y-keyboard-shortcuts"
        />
      </Section>
    </div>
  );
}
