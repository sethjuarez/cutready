/**
 * A project's save label template, e.g. `docs(demo): {subject}`. Draftline
 * wraps every saved label in it; the app shows the name the user typed.
 */
export const LABEL_SUBJECT = "{subject}";

/** Why `template` can't be saved, or null when it can (blank clears it). */
export function labelTemplateProblem(template: string): string | null {
  if (!template.trim()) return null;
  if (/[\r\n]/.test(template)) return "Keep the template on one line.";
  if (template.split(LABEL_SUBJECT).length !== 2) return `Include ${LABEL_SUBJECT} exactly once.`;
  return null;
}

/** `label` without the template's prefix and suffix, when its first line follows it. */
export function stripLabelTemplate(label: string, template: string | null | undefined): string {
  if (!template || labelTemplateProblem(template)) return label;
  const [prefix, suffix] = template.split(LABEL_SUBJECT);
  if (!prefix && !suffix) return label;
  const breakAt = label.search(/\r?\n/);
  const first = breakAt < 0 ? label : label.slice(0, breakAt);
  const rest = breakAt < 0 ? "" : label.slice(breakAt);
  if (first.length <= prefix.length + suffix.length || !first.startsWith(prefix) || !first.endsWith(suffix)) return label;
  return first.slice(prefix.length, first.length - suffix.length) + rest;
}
