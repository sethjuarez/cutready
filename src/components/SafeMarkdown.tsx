/**
 * SafeMarkdown — drop-in ReactMarkdown replacement wrapped in an ErrorBoundary.
 *
 * If the markdown parser or a custom component throws during rendering,
 * the boundary catches it and shows the raw text as a fallback instead of
 * crashing the parent component tree.  The boundary auto-resets whenever
 * `children` changes so a new message gets a fresh chance to render.
 */
import { useMemo } from "react";
import ReactMarkdown, { type Options } from "react-markdown";
import remarkGfm from "remark-gfm";
import rehypeRaw from "rehype-raw";
import { ErrorBoundary } from "./ErrorBoundary";

type SafeMarkdownProps = Options & {
  /** Extra class applied to the error-fallback wrapper (not the markdown). */
  fallbackClassName?: string;
};

export function SafeMarkdown({
  children,
  remarkPlugins = [remarkGfm],
  rehypePlugins = [rehypeRaw],
  fallbackClassName,
  ...rest
}: SafeMarkdownProps) {
  // Derive a reset key from the content so the boundary recovers on new input.
  const resetKey = useMemo(
    () => (typeof children === "string" ? `${children.length}:${children.slice(0, 64)}` : ""),
    [children],
  );

  return (
    <ErrorBoundary
      resetKey={resetKey}
      fallback={
        <pre
          className={`whitespace-pre-wrap text-[var(--color-text-secondary)] text-xs p-2 ${fallbackClassName ?? ""}`}
        >
          {children}
        </pre>
      }
    >
      <ReactMarkdown remarkPlugins={remarkPlugins} rehypePlugins={rehypePlugins} {...rest}>
        {children}
      </ReactMarkdown>
    </ErrorBoundary>
  );
}
