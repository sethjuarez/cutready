import type { CSSProperties } from "react";

export function IncomingPreview({
  commits,
  inline = false,
  align = "right",
  style,
}: {
  commits: Array<{
    id: string;
    message: string;
    author: string;
    timestamp: string;
    changed_files: Array<{ path: string }>;
    projects: string[];
  }>;
  inline?: boolean;
  align?: "left" | "right";
  style?: CSSProperties;
}) {
  const body = (
    <div className="max-h-64 overflow-y-auto py-1">
      <div className="px-2 pb-1 text-2xs font-semibold uppercase tracking-wider text-[rgb(var(--color-text-secondary))]">
        Incoming work
      </div>
      {commits.length === 0 ? (
        <div className="px-2 py-1 text-2xs text-[rgb(var(--color-text-secondary))]">
          Fetch latest to preview what collaborators changed.
        </div>
      ) : (
        commits.map((commit) => (
          <div key={commit.id} className="border-t border-[rgb(var(--color-border))]/60 px-2 py-1.5 first:border-t-0">
            <div className="truncate text-xs font-medium text-[rgb(var(--color-text))]">{commit.message}</div>
            <div className="mt-0.5 flex items-center gap-1 text-2xs text-[rgb(var(--color-text-secondary))]">
              <span className="truncate">{commit.author}</span>
              <span>•</span>
              <span>{commit.changed_files.length} file{commit.changed_files.length === 1 ? "" : "s"}</span>
              {commit.projects.length > 0 && (
                <>
                  <span>•</span>
                  <span className="truncate">{commit.projects.slice(0, 2).join(", ")}</span>
                </>
              )}
            </div>
          </div>
        ))
      )}
    </div>
  );

  if (inline) {
    return (
      <div className="rounded-lg border border-[rgb(var(--color-border))] bg-[rgb(var(--color-surface))]">
        {body}
      </div>
    );
  }

  return (
    <div
      style={style}
      className={`${style ? "z-[var(--z-overlay)]" : `absolute top-full z-dropdown mt-1 w-72 ${align === "left" ? "left-0" : "right-0"}`} max-w-[calc(100vw-2rem)] rounded-lg border border-[rgb(var(--color-border))] bg-[rgb(var(--color-surface))] shadow-lg`}
    >
      {body}
    </div>
  );
}
