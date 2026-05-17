import { useEffect, useRef, useState, type ReactNode } from "react";
import {
  ChevronDown,
  Download,
  FileText,
  Lock,
  Monitor,
  MonitorPlay,
  MoreHorizontal,
  PlayCircle,
  Sparkles,
  Unlock,
  Video,
} from "lucide-react";

export interface DocumentToolbarAction {
  id: string;
  label: string;
  icon?: ReactNode;
  onSelect: () => void | Promise<void>;
  disabled?: boolean;
  title?: string;
}

interface DocumentToolbarProps {
  canRecord: boolean;
  onRecord: () => void | Promise<void>;
  recordLabel?: string;
  showRecord?: boolean;
  presentActions: DocumentToolbarAction[];
  aiActions?: DocumentToolbarAction[];
  exportActions?: DocumentToolbarAction[];
  locked: boolean;
  onToggleLock: () => void | Promise<void>;
  lockLabel: string;
  unlockLabel: string;
}

const toolbarButtonClass =
  "inline-flex items-center gap-1.5 rounded-lg border border-[rgb(var(--color-border))] px-2.5 py-1.5 text-xs font-medium text-[rgb(var(--color-text-secondary))] transition-colors hover:border-[rgb(var(--color-accent))]/40 hover:bg-[rgb(var(--color-accent))]/5 hover:text-[rgb(var(--color-text))] disabled:cursor-not-allowed disabled:opacity-40";

const primaryButtonClass =
  "inline-flex items-center gap-1.5 rounded-lg bg-[rgb(var(--color-accent))] px-3 py-1.5 text-xs font-semibold text-white shadow-sm shadow-[rgb(var(--color-accent))]/20 transition-colors hover:bg-[rgb(var(--color-accent-hover))] disabled:cursor-not-allowed disabled:opacity-40";

export function DocumentToolbar({
  canRecord,
  onRecord,
  recordLabel = "Record",
  showRecord = true,
  presentActions,
  aiActions = [],
  exportActions = [],
  locked,
  onToggleLock,
  lockLabel,
  unlockLabel,
}: DocumentToolbarProps) {
  return (
    <div className="flex shrink-0 items-center gap-1.5">
      {showRecord && (
        <button
          type="button"
          onClick={onRecord}
          disabled={!canRecord}
          className={primaryButtonClass}
          title={canRecord ? recordLabel : "Add content before recording"}
        >
          <Video className="h-3.5 w-3.5" />
          {recordLabel}
        </button>
      )}

      <ToolbarMenu
        label="Present"
        icon={<Monitor className="h-3.5 w-3.5" />}
        actions={presentActions}
      />

      {aiActions.length > 0 && (
        <ToolbarMenu
          label="AI"
          icon={<Sparkles className="h-3.5 w-3.5" />}
          actions={aiActions}
        />
      )}

      {exportActions.length > 0 && (
        <ToolbarMenu
          label="Export"
          icon={<Download className="h-3.5 w-3.5" />}
          actions={exportActions}
        />
      )}

      <button
        type="button"
        onClick={onToggleLock}
        className={`inline-flex items-center justify-center rounded-lg p-1.5 transition-colors ${
          locked
            ? "bg-[rgb(var(--color-warning))]/10 text-[rgb(var(--color-warning))] hover:bg-[rgb(var(--color-warning))]/15"
            : "text-[rgb(var(--color-text-secondary))] hover:bg-[rgb(var(--color-surface-alt))] hover:text-[rgb(var(--color-text))]"
        }`}
        title={locked ? unlockLabel : lockLabel}
        aria-label={locked ? unlockLabel : lockLabel}
      >
        {locked ? <Lock className="h-4 w-4" /> : <Unlock className="h-4 w-4" />}
      </button>
    </div>
  );
}

interface ToolbarMenuProps {
  label: string;
  icon: ReactNode;
  actions: DocumentToolbarAction[];
}

function ToolbarMenu({ label, icon, actions }: ToolbarMenuProps) {
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);
  const enabled = actions.length > 0;

  useEffect(() => {
    if (!open) return;
    const onPointerDown = (event: MouseEvent) => {
      if (ref.current && !ref.current.contains(event.target as Node)) {
        setOpen(false);
      }
    };
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        setOpen(false);
      }
    };
    document.addEventListener("mousedown", onPointerDown);
    document.addEventListener("keydown", onKeyDown);
    return () => {
      document.removeEventListener("mousedown", onPointerDown);
      document.removeEventListener("keydown", onKeyDown);
    };
  }, [open]);

  return (
    <div ref={ref} className="relative">
      <button
        type="button"
        onClick={() => setOpen((value) => !value)}
        disabled={!enabled}
        className={toolbarButtonClass}
        aria-haspopup="menu"
        aria-expanded={open}
      >
        {icon}
        {label}
        <ChevronDown className="h-3 w-3" />
      </button>

      {open && (
        <div
          role="menu"
          className="absolute right-0 top-full z-dropdown mt-1 min-w-[180px] overflow-hidden rounded-xl border border-[rgb(var(--color-border))] bg-[rgb(var(--color-surface))] py-1 shadow-lg"
        >
          {actions.map((action) => (
            <button
              key={action.id}
              type="button"
              role="menuitem"
              disabled={action.disabled}
              title={action.title}
              onClick={async () => {
                if (action.disabled) return;
                setOpen(false);
                await action.onSelect();
              }}
              className="flex w-full items-center gap-2 px-3 py-2 text-left text-xs text-[rgb(var(--color-text))] transition-colors hover:bg-[rgb(var(--color-accent))]/10 disabled:cursor-not-allowed disabled:opacity-40"
            >
              <span className="flex h-4 w-4 shrink-0 items-center justify-center text-[rgb(var(--color-text-secondary))]">
                {action.icon ?? <MoreHorizontal className="h-3.5 w-3.5" />}
              </span>
              {action.label}
            </button>
          ))}
        </div>
      )}
    </div>
  );
}

export const documentToolbarIcons = {
  fileText: <FileText className="h-3.5 w-3.5" />,
  monitor: <Monitor className="h-3.5 w-3.5" />,
  monitorPlay: <MonitorPlay className="h-3.5 w-3.5" />,
  playCircle: <PlayCircle className="h-3.5 w-3.5" />,
  sparkles: <Sparkles className="h-3.5 w-3.5" />,
};
