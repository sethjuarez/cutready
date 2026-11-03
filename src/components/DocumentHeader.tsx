import type { ReactNode } from "react";

interface DocumentHeaderProps {
  icon?: ReactNode;
  /** Breadcrumb trail shown above the title. */
  crumbs?: ReactNode;
  title: ReactNode;
  /** Meta line under the title (duration, file type). */
  badge?: ReactNode;
  toolbar?: ReactNode;
  children?: ReactNode;
  className?: string;
}

/** Shared classes for the editable title input inside a DocumentHeader. */
export function documentTitleInputClass(extra = ""): string {
  return `min-w-0 w-full truncate rounded-control border-none bg-transparent text-[1.75rem] font-semibold leading-9 tracking-[-0.005em] text-[rgb(var(--color-text))] outline-none placeholder:text-[rgb(var(--color-text-secondary))]/40 focus-visible:ring-2 focus-visible:ring-[rgb(var(--color-accent))]/40 ${extra}`;
}

export function DocumentHeader({ icon, crumbs, title, badge, toolbar, children, className = "" }: DocumentHeaderProps) {
  return (
    <header className={`document-header mb-4 min-w-0 ${className}`}>
      {crumbs && <div className="mb-2.5 min-w-0">{crumbs}</div>}
      <div className="flex min-w-0 flex-wrap items-center gap-x-4 gap-y-2">
        <div className="flex min-w-[14rem] flex-1 items-center gap-2.5">
          {icon && (
            <div className="flex h-7 w-7 shrink-0 items-center justify-center text-[rgb(var(--color-text-secondary))]">
              {icon}
            </div>
          )}
          <div className="min-w-0 flex-1">{title}</div>
        </div>
        {toolbar && <div className="ml-auto flex max-w-full shrink-0 justify-end">{toolbar}</div>}
      </div>
      {badge && <div className="mt-2 flex min-w-0 flex-wrap items-center gap-2 text-xs text-[rgb(var(--color-text-secondary))]">{badge}</div>}
      {children}
    </header>
  );
}

/** Breadcrumb trail for a DocumentHeader; the last item is the current page. */
export function DocumentCrumbs({ items }: { items: { label: ReactNode; icon?: ReactNode; onClick?: () => void }[] }) {
  return (
    <nav aria-label="Breadcrumb">
      <ol className="flex min-w-0 items-center gap-1.5 text-sm text-[rgb(var(--color-text-secondary))]">
        {items.map((item, i) => {
          const last = i === items.length - 1;
          return (
            <li key={i} className="flex min-w-0 items-center gap-1.5">
              {i > 0 && <span aria-hidden="true" className="opacity-60">›</span>}
              {item.onClick && !last ? (
                <button
                  type="button"
                  onClick={item.onClick}
                  className="-mx-1 inline-flex min-w-0 items-center gap-1.5 rounded-control px-1 py-0.5 transition-colors duration-fast hover:bg-fill-hover hover:text-[rgb(var(--color-text))] focus:outline-none focus-visible:ring-2 focus-visible:ring-[rgb(var(--color-accent))]"
                >
                  {item.icon}
                  <span className="truncate">{item.label}</span>
                </button>
              ) : (
                <span aria-current={last ? "page" : undefined} className="inline-flex min-w-0 items-center gap-1.5">
                  {item.icon}
                  <span className="truncate">{item.label}</span>
                </span>
              )}
            </li>
          );
        })}
      </ol>
    </nav>
  );
}
