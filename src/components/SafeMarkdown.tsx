/**
 * SafeMarkdown — drop-in ReactMarkdown replacement wrapped in an ErrorBoundary.
 *
 * If the markdown parser or a custom component throws during rendering,
 * the boundary catches it and shows the raw text as a fallback instead of
 * crashing the parent component tree.  The boundary auto-resets whenever
 * `children` changes so a new message gets a fresh chance to render.
 *
 * External links (http/https) are intercepted and opened in the system
 * browser via Tauri's shell plugin instead of navigating the webview.
 */
import { useCallback, useMemo } from "react";
import ReactMarkdown, { type Options } from "react-markdown";
import remarkGfm from "remark-gfm";
import rehypeRaw from "rehype-raw";
import { ErrorBoundary } from "./ErrorBoundary";

/** Open a URL in the system browser. Falls back to window.open in dev/browser mode. */
async function openExternal(url: string) {
  try {
    const { open } = await import("@tauri-apps/plugin-shell");
    await open(url);
  } catch {
    window.open(url, "_blank", "noopener,noreferrer");
  }
}

type SafeMarkdownProps = Options & {
  /** Extra class applied to the error-fallback wrapper (not the markdown). */
  fallbackClassName?: string;
};

export function SafeMarkdown({
  children,
  remarkPlugins = [remarkGfm],
  rehypePlugins = [rehypeRaw],
  fallbackClassName,
  components,
  ...rest
}: SafeMarkdownProps) {
  // Derive a reset key from the content so the boundary recovers on new input.
  const resetKey = useMemo(
    () => (typeof children === "string" ? `${children.length}:${children.slice(0, 64)}` : ""),
    [children],
  );

  const ExternalLink = useCallback(
    ({ href, children: linkChildren, ...props }: React.AnchorHTMLAttributes<HTMLAnchorElement>) => {
      if (href && /^https?:\/\//.test(href)) {
        return (
          <a
            {...props}
            href={href}
            onClick={(e) => {
              e.preventDefault();
              openExternal(href);
            }}
            className="text-[rgb(var(--color-accent))] hover:underline cursor-pointer"
          >
            {linkChildren}
          </a>
        );
      }
      // Non-http links (anchors, mailto, etc.) — render normally
      return <a href={href} {...props}>{linkChildren}</a>;
    },
    [],
  );

  const mergedComponents = useMemo(
    () => ({ a: ExternalLink, ...components }),
    [ExternalLink, components],
  );

  return (
    <ErrorBoundary
      resetKey={resetKey}
      fallback={
        <pre
          className={`whitespace-pre-wrap text-[rgb(var(--color-text-secondary))] text-xs p-2 ${fallbackClassName ?? ""}`}
        >
          {children}
        </pre>
      }
    >
      <ReactMarkdown
        remarkPlugins={remarkPlugins}
        rehypePlugins={rehypePlugins}
        components={mergedComponents}
        {...rest}
      >
        {children}
      </ReactMarkdown>
    </ErrorBoundary>
  );
}
