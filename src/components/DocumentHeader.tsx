import type { ReactNode } from "react";

interface DocumentHeaderProps {
  icon?: ReactNode;
  title: ReactNode;
  badge?: ReactNode;
  toolbar?: ReactNode;
  children?: ReactNode;
  className?: string;
}

export function DocumentHeader({ icon, title, badge, toolbar, children, className = "" }: DocumentHeaderProps) {
  return (
    <header className={`document-header mb-4 min-w-0 ${className}`}>
      <div className="flex min-w-0 flex-wrap items-start gap-3">
        {icon && (
          <div className="mt-1 flex h-6 w-6 shrink-0 items-center justify-center text-[rgb(var(--color-text-secondary))]">
            {icon}
          </div>
        )}
        <div className="min-w-[14rem] flex-1">
          <div className="min-w-0 flex-1">
            <div className="flex min-w-0 items-center gap-2">
              <div className="min-w-0 flex-1">{title}</div>
              {badge && <div className="shrink-0">{badge}</div>}
            </div>
          </div>
        </div>
        {toolbar && <div className="ml-auto flex max-w-full shrink-0 justify-end">{toolbar}</div>}
      </div>
      {children}
    </header>
  );
}
