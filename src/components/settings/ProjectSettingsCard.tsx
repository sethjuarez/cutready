import { useEffect, useState } from "react";
import { errorMessage, useAppStore } from "../../stores/appStore";
import { useProjectSettings, useProjectSettingsStore } from "../../stores/projectSettingsStore";
import { LABEL_SUBJECT, labelTemplateProblem } from "../../domain/versioning/labelTemplate";
import { inputClass } from "../../styles";

const blankToNull = (value: string) => (value.trim() ? value.trim() : null);

/** Shared settings of a project that lives inside a code repository, saved with the project. */
export function ProjectSettingsCard() {
  const root = useAppStore((s) => (s.currentProject?.hybrid ? s.currentProject.root : null));
  const settings = useProjectSettings();
  const loaded = useProjectSettingsStore((s) => s.loaded && s.root === root);
  const save = useProjectSettingsStore((s) => s.save);
  const [sendTo, setSendTo] = useState("");
  const [template, setTemplate] = useState("");
  const [status, setStatus] = useState<{ tone: "success" | "error"; text: string } | null>(null);
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    setSendTo(settings?.base_branch ?? "");
    setTemplate(settings?.commit_template ?? "");
  }, [settings?.base_branch, settings?.commit_template]);

  if (!root) return null;
  const problem = labelTemplateProblem(template);
  const changed = blankToNull(sendTo) !== (settings?.base_branch ?? null)
    || blankToNull(template) !== (settings?.commit_template ?? null);

  const onSave = async () => {
    setSaving(true);
    setStatus(null);
    const stillHere = () => useAppStore.getState().currentProject?.root === root;
    try {
      await save(root, blankToNull(sendTo), blankToNull(template));
      if (stillHere()) setStatus({ tone: "success", text: "Saved for everyone on this project." });
    } catch (error) {
      if (stillHere()) setStatus({ tone: "error", text: errorMessage(error) });
    } finally {
      setSaving(false);
    }
  };

  return (
    <fieldset className="flex flex-col gap-3" data-testid="project-settings-card" disabled={!loaded} aria-busy={!loaded}>
      <legend className="text-sm font-medium text-[rgb(var(--color-text))]">Project</legend>
      <p className="text-xs text-[rgb(var(--color-text-secondary))]">
        These are saved with the project, so everyone who opens it uses them.
      </p>
      <div className="flex flex-col gap-1.5">
        <label htmlFor="project-send-to" className="text-xs font-medium text-[rgb(var(--color-text))]">Send saves to</label>
        <input
          id="project-send-to"
          type="text"
          value={sendTo}
          onChange={(e) => setSendTo(e.target.value)}
          placeholder="The repository's default"
          className={inputClass}
          aria-describedby="project-send-to-help"
        />
        <p id="project-send-to-help" className="text-xs text-[rgb(var(--color-text-secondary))]">
          When you send, CutReady asks for your saves to be added here.
        </p>
      </div>
      <div className="flex flex-col gap-1.5">
        <label htmlFor="project-label-template" className="text-xs font-medium text-[rgb(var(--color-text))]">Save label template</label>
        <input
          id="project-label-template"
          type="text"
          value={template}
          onChange={(e) => setTemplate(e.target.value)}
          placeholder={`docs(demo): ${LABEL_SUBJECT}`}
          className={inputClass}
          aria-invalid={problem ? true : undefined}
          aria-describedby="project-label-template-help"
        />
        <p id="project-label-template-help" className={`text-xs ${problem ? "text-error" : "text-[rgb(var(--color-text-secondary))]"}`}>
          {problem ?? `Optional. Each save's label is written this way; ${LABEL_SUBJECT} is the name you type. CutReady still shows just your name.`}
        </p>
      </div>
      <div className="flex items-center gap-3">
        <button
          type="button"
          onClick={onSave}
          disabled={!changed || !!problem || saving}
          className="px-3 py-2 rounded-lg text-xs font-medium bg-[rgb(var(--color-accent))] text-[rgb(var(--color-accent-fg))] hover:opacity-90 transition-opacity disabled:opacity-50"
        >
          {saving ? "Saving\u2026" : "Save project settings"}
        </button>
        {status && (
          <p role="status" className={`text-xs ${status.tone === "success" ? "text-success" : "text-error"}`}>{status.text}</p>
        )}
      </div>
    </fieldset>
  );
}
