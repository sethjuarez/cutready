import { Children, isValidElement, memo, type ReactNode } from "react";
import { Check } from "lucide-react";
import { SafeMarkdown } from "../SafeMarkdown";
import { ProjectImage } from "../ProjectImage";
import { projectRelativeScreenshotPath } from "../../utils/projectImage";
import { detectFileType, typeColors } from "./chatFileTypes";

// ── Simple Markdown Renderer ─────────────────────────────────────

type CalloutKind = "note" | "tip" | "important" | "warning" | "next";

const CALLOUT_PATTERN = /^(note|tip|important|warning|caution|recommendation|next steps?|action):\s*/i;

function textFromNode(node: ReactNode): string {
  if (typeof node === "string" || typeof node === "number") return String(node);
  if (Array.isArray(node)) return node.map(textFromNode).join("");
  if (isValidElement(node)) {
    return textFromNode((node.props as { children?: ReactNode }).children);
  }
  return "";
}

function stripCalloutPrefix(node: ReactNode): ReactNode {
  const parts = Children.toArray(node);
  if (typeof parts[0] === "string") {
    const stripped = parts[0].replace(CALLOUT_PATTERN, "");
    return [stripped, ...parts.slice(1)];
  }
  return node;
}

function calloutKind(label: string): CalloutKind {
  const normalized = label.toLowerCase();
  if (normalized === "tip" || normalized === "recommendation") return "tip";
  if (normalized === "important") return "important";
  if (normalized === "warning" || normalized === "caution") return "warning";
  if (normalized.startsWith("next") || normalized === "action") return "next";
  return "note";
}

function MarkdownParagraph({ children }: { children: ReactNode }) {
  const label = textFromNode(children).trim().match(CALLOUT_PATTERN)?.[1];
  if (!label) {
    return <div className="my-2 first:mt-0 last:mb-0">{children}</div>;
  }

  const kind = calloutKind(label);
  const tone: Record<CalloutKind, string> = {
    note: "border-[rgb(var(--color-border-subtle))] bg-[rgb(var(--color-surface-alt))]/70 text-[rgb(var(--color-text-secondary))]",
    tip: "border-[rgb(var(--color-success))]/35 bg-[rgb(var(--color-success))]/10 text-[rgb(var(--color-text))]",
    important: "border-[rgb(var(--color-accent))]/40 bg-[rgb(var(--color-accent))]/10 text-[rgb(var(--color-text))]",
    warning: "border-[rgb(var(--color-warning))]/45 bg-[rgb(var(--color-warning))]/10 text-[rgb(var(--color-text))]",
    next: "border-[rgb(var(--color-accent))]/35 bg-[rgb(var(--color-accent))]/[0.07] text-[rgb(var(--color-text))]",
  };
  const title = kind === "next" ? "Next step" : label.replace(/\b\w/g, (c) => c.toUpperCase());

  return (
    <div className={`my-3 rounded-card border px-3 py-2 ${tone[kind]}`}>
      <div className="mb-0.5 text-xs font-semibold">{title}</div>
      <div className="leading-[1.65]">{stripCalloutPrefix(children)}</div>
    </div>
  );
}

function hasTaskCheckbox(node: ReactNode): boolean {
  return Children.toArray(node).some((child) => {
    if (!isValidElement(child)) return false;
    if (child.type === "input" && (child.props as { type?: string }).type === "checkbox") return true;
    return hasTaskCheckbox((child.props as { children?: ReactNode }).children);
  });
}

export const MarkdownContent = memo(function MarkdownContent({ content, projectRoot }: { content: string; projectRoot?: string }) {
  return (
    <SafeMarkdown
      components={{
        h1: ({ children }) => (
          <div className="mt-5 mb-2 text-base font-semibold leading-snug text-[rgb(var(--color-text))] first:mt-0">{children}</div>
        ),
        h2: ({ children }) => (
          <div className="mt-4 mb-1.5 text-[15px] font-semibold leading-snug text-[rgb(var(--color-text))] first:mt-0">{children}</div>
        ),
        h3: ({ children }) => (
          <div className="mt-3 mb-1 text-sm font-semibold leading-snug text-[rgb(var(--color-text))] first:mt-0">{children}</div>
        ),
        h4: ({ children }) => (
          <div className="mt-3 mb-1 text-sm font-medium leading-snug text-[rgb(var(--color-text-secondary))] first:mt-0">{children}</div>
        ),
        h5: ({ children }) => (
          <div className="mt-2 mb-1 text-xs font-semibold text-[rgb(var(--color-text-secondary))] first:mt-0">{children}</div>
        ),
        h6: ({ children }) => (
          <div className="mt-2 mb-0.5 text-xs font-medium text-[rgb(var(--color-text-secondary))] first:mt-0">{children}</div>
        ),
        p: ({ children }) => <MarkdownParagraph>{children}</MarkdownParagraph>,
        strong: ({ children }) => <strong className="font-semibold text-[rgb(var(--color-text))]">{children}</strong>,
        em: ({ children }) => <em className="italic">{children}</em>,
        code: ({ className, children }) => {
          const isBlock = className?.includes("language-");
          if (isBlock) {
            return (
              <pre className="my-3 overflow-x-auto rounded-control border border-[rgb(var(--color-border-subtle))] bg-[rgb(var(--color-surface-inset))] p-3 text-xs leading-relaxed">
                <code>{children}</code>
              </pre>
            );
          }
          // Inline code — colorize if it looks like a project file path
          const text = typeof children === "string" ? children : "";
          const fileType = detectFileType(text);
          if (fileType) {
            const c = typeColors(fileType);
            return (
              <code className={`rounded-md border px-1.5 py-0.5 text-xs ${c.bg} ${c.text} ${c.border}`}>
                {children}
              </code>
            );
          }
          return (
            <code className="rounded-md border border-[rgb(var(--color-border-subtle))] bg-[rgb(var(--color-surface-alt))] px-1.5 py-0.5 text-xs">
              {children}
            </code>
          );
        },
        pre: ({ children }) => <>{children}</>,
        ul: ({ children }) => <ul className="ml-5 my-2 list-disc list-outside space-y-1 marker:text-[rgb(var(--color-text-secondary))]">{children}</ul>,
        ol: ({ children }) => <ol className="ml-5 my-2 list-decimal list-outside space-y-1 marker:text-[rgb(var(--color-text-secondary))]">{children}</ol>,
        li: ({ children }) => {
          const isTask = hasTaskCheckbox(children);
          return (
            <li className={isTask ? "-ml-5 flex list-none items-start gap-2 rounded-lg bg-[rgb(var(--color-surface-alt))]/45 px-2 py-1.5" : "pl-1"}>
              {children}
            </li>
          );
        },
        input: ({ checked, type }) => {
          if (type !== "checkbox") return null;
          return (
            <span
              className={`mt-[0.2em] flex h-4 w-4 shrink-0 items-center justify-center rounded border ${
                checked
                  ? "border-[rgb(var(--color-accent))] bg-[rgb(var(--color-accent))] text-[rgb(var(--color-accent-fg))]"
                  : "border-[rgb(var(--color-border))] bg-[rgb(var(--color-surface))]"
              }`}
              aria-hidden="true"
            >
              {checked && <Check className="h-3 w-3" />}
            </span>
          );
        },
        table: ({ children }) => (
          <div className="my-3 max-w-full overflow-x-auto rounded-card border border-[rgb(var(--color-border-subtle))] bg-[rgb(var(--color-surface))]">
            <table className="w-full border-separate border-spacing-0 text-xs">{children}</table>
          </div>
        ),
        thead: ({ children }) => (
          <thead className="bg-[rgb(var(--color-surface-alt))] text-[rgb(var(--color-text-secondary))]">{children}</thead>
        ),
        tbody: ({ children }) => (
          <tbody className="[&>tr:nth-child(even)]:bg-[rgb(var(--color-surface-alt))]/35">{children}</tbody>
        ),
        tr: ({ children }) => (
          <tr className="transition-colors hover:bg-[rgb(var(--color-accent))]/[0.04]">{children}</tr>
        ),
        th: ({ children }) => (
          <th className="border-b border-r border-[rgb(var(--color-border-subtle))] px-3 py-2 text-left text-xs font-semibold last:border-r-0">{children}</th>
        ),
        td: ({ children }) => (
          <td className="border-b border-r border-[rgb(var(--color-border-subtle))] px-3 py-2.5 align-top last:border-r-0">{children}</td>
        ),
        a: ({ href, children }) => (
          <a href={href} className="show-underlines-target text-[rgb(var(--color-accent))] hover:underline" target="_blank" rel="noopener noreferrer">{children}</a>
        ),
        blockquote: ({ children }) => (
          <div className="my-3 rounded-r-lg border-l-2 border-[rgb(var(--color-accent))]/70 bg-[rgb(var(--color-accent))]/5 px-3 py-2 text-[rgb(var(--color-text-secondary))]">{children}</div>
        ),
        hr: () => (
          <div className="my-5 flex items-center gap-3">
            <span className="h-px flex-1 bg-gradient-to-r from-transparent via-[rgb(var(--color-border-subtle))] to-[rgb(var(--color-border-subtle))]" />
            <span className="h-1.5 w-1.5 rounded-full bg-[rgb(var(--color-accent))]/50" />
            <span className="h-px flex-1 bg-gradient-to-r from-[rgb(var(--color-border-subtle))] to-transparent" />
          </div>
        ),
        img: ({ src, alt, ...props }) => {
          let resolvedSrc = src ?? "";
          const relativePath = projectRelativeScreenshotPath(resolvedSrc);
          if (projectRoot && relativePath) {
            return <ProjectImage relativePath={relativePath} projectRoot={projectRoot} alt={alt ?? ""} {...props} className="my-3 max-w-full rounded-card border border-[rgb(var(--color-border-subtle))]" />;
          }
          return <img src={resolvedSrc} alt={alt ?? ""} {...props} className="my-3 max-w-full rounded-card border border-[rgb(var(--color-border-subtle))]" />;
        },
      }}
    >
      {content}
    </SafeMarkdown>
  );
});
