import { useEffect, useRef, useState, type ReactNode } from "react";
import {
  ChevronDown,
  Download,
  Film,
  Lock,
  Monitor,
  MonitorPlay,
  MoreHorizontal,
  Eye,
  Pencil,
  PlayCircle,
  Sparkles,
  Unlock,
  Video,
} from "lucide-react";
import { WordDocumentIcon } from "./ExportWordButton";

export interface DocumentToolbarAction {
  id: string;
  label: string;
  icon?: ReactNode;
  onSelect: () => void | Promise<void>;
  disabled?: boolean;
  title?: string;
  selected?: boolean;
}

interface DocumentToolbarProps {
  canRecord: boolean;
  onRecord: () => void | Promise<void>;
  recordLabel?: string;
  showRecord?: boolean;
  presentActions: DocumentToolbarAction[];
  modeActions?: DocumentToolbarAction[];
  aiActions?: DocumentToolbarAction[];
  exportActions?: DocumentToolbarAction[];
  locked: boolean;
  onToggleLock: () => void | Promise<void>;
  lockLabel: string;
  unlockLabel: string;
}

const toolbarButtonClass =
  "inline-flex items-center gap-1.5 rounded-md border border-transparent px-2.5 py-1.5 text-xs font-medium text-[rgb(var(--color-text-secondary))] transition-colors hover:border-[rgb(var(--color-border))] hover:bg-[rgb(var(--color-surface-alt))] hover:text-[rgb(var(--color-text))] disabled:cursor-not-allowed disabled:opacity-40";

const primaryButtonClass =
  "inline-flex items-center gap-1.5 rounded-md bg-[rgb(var(--color-accent))] px-3 py-1.5 text-xs font-semibold text-white shadow-sm shadow-[rgb(var(--color-accent))]/15 transition-colors hover:bg-[rgb(var(--color-accent-hover))] disabled:cursor-not-allowed disabled:opacity-40";

const menuItemClass =
  "flex w-full items-center gap-2 px-3 py-2 text-left text-xs text-[rgb(var(--color-text))] transition-colors hover:bg-[rgb(var(--color-accent))]/10 disabled:cursor-not-allowed disabled:opacity-40 disabled:hover:bg-transparent";

export function DocumentToolbar({
  canRecord,
  onRecord,
  recordLabel = "Record",
  showRecord = true,
  presentActions,
  modeActions = [],
  aiActions = [],
  exportActions = [],
  locked,
  onToggleLock,
  lockLabel,
  unlockLabel,
}: DocumentToolbarProps) {
  const overflowGroups: ToolbarOverflowGroup[] = [
    { id: "present", label: "Present", icon: <Monitor className="h-3.5 w-3.5" />, actions: presentActions },
    { id: "ai", label: "AI assist", icon: <Sparkles className="h-3.5 w-3.5" />, actions: aiActions },
    { id: "export", label: "Export", icon: <Download className="h-3.5 w-3.5" />, actions: exportActions },
  ].filter((group) => group.actions.length > 0);

  return (
    <div className="flex max-w-full shrink-0 flex-nowrap items-center justify-end gap-1 rounded-lg border border-[rgb(var(--color-border))] bg-[rgb(var(--color-surface))]/80 p-1 pr-2">
      {modeActions.length > 0 && <ToolbarSegmentedGroup actions={modeActions} />}

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

      <ToolbarMenu label="Present" icon={<Monitor className="h-3.5 w-3.5" />} actions={presentActions} className="document-toolbar-wide-action" />

      {aiActions.length > 0 && (
        <ToolbarMenu
          label="AI"
          icon={<Sparkles className="h-3.5 w-3.5" />}
          actions={aiActions}
          className="document-toolbar-wide-action"
        />
      )}

      {exportActions.length > 0 && (
        <ToolbarMenu
          label="Export"
          icon={<Download className="h-3.5 w-3.5" />}
          actions={exportActions}
          className="document-toolbar-wide-action"
        />
      )}

      <ToolbarOverflowMenu groups={overflowGroups} />

      <button
        type="button"
        onClick={onToggleLock}
        className={`inline-flex items-center justify-center rounded-md p-1.5 transition-colors ${
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

function ToolbarOverflowMenu({ groups }: { groups: ToolbarOverflowGroup[] }) {
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);
  const enabled = groups.length > 0;
  const hasEnabledAction = groups.some((group) => group.actions.some((action) => !action.disabled));

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

  if (!enabled) return null;

  return (
    <div ref={ref} className="document-toolbar-overflow relative">
      <button
        type="button"
        onClick={() => {
          if (hasEnabledAction) setOpen((value) => !value);
        }}
        disabled={!hasEnabledAction}
        className={toolbarButtonClass}
        aria-haspopup="menu"
        aria-expanded={open}
        aria-label="More document actions"
        title={hasEnabledAction ? "More document actions" : "No document actions available"}
      >
        <MoreHorizontal className="h-3.5 w-3.5" />
      </button>

      {open && (
        <div
          role="menu"
          className="absolute right-0 top-full z-dropdown mt-1 min-w-[220px] overflow-hidden rounded-lg border border-[rgb(var(--color-border))] bg-[rgb(var(--color-surface))] py-1 shadow-lg"
        >
          {groups.map((group, groupIndex) => (
            <div key={group.id} className={groupIndex > 0 ? "border-t border-[rgb(var(--color-border))]" : undefined}>
              <div className="flex items-center gap-2 px-3 pb-1 pt-2 text-[10px] font-semibold uppercase tracking-wider text-[rgb(var(--color-text-secondary))]">
                <span className="flex h-4 w-4 items-center justify-center">{group.icon}</span>
                {group.label}
              </div>
              {group.actions.map((action) => (
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
                  className={menuItemClass}
                >
                  <span className="flex h-4 w-4 shrink-0 items-center justify-center text-[rgb(var(--color-text-secondary))]">
                    {action.icon ?? <MoreHorizontal className="h-3.5 w-3.5" />}
                  </span>
                  {action.label}
                </button>
              ))}
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

function ToolbarSegmentedGroup({ actions }: { actions: DocumentToolbarAction[] }) {
  return (
    <div className="flex items-center gap-0.5 rounded-md bg-[rgb(var(--color-surface-alt))] p-0.5">
      {actions.map((action) => (
        <button
          key={action.id}
          type="button"
          onClick={() => {
            if (!action.disabled) void action.onSelect();
          }}
          disabled={action.disabled}
          title={action.title ?? action.label}
          aria-pressed={action.selected}
          className={`inline-flex h-7 items-center gap-1.5 rounded px-2 text-xs font-medium transition-colors disabled:cursor-not-allowed disabled:opacity-40 ${
            action.selected
              ? "bg-[rgb(var(--color-surface))] text-[rgb(var(--color-text))] shadow-sm"
              : "text-[rgb(var(--color-text-secondary))] hover:text-[rgb(var(--color-text))]"
          }`}
        >
          {action.icon}
          <span className="hidden sm:inline">{action.label}</span>
        </button>
      ))}
    </div>
  );
}

interface ToolbarMenuProps {
  label: string;
  icon: ReactNode;
  actions: DocumentToolbarAction[];
  className?: string;
}

interface ToolbarOverflowGroup {
  id: string;
  label: string;
  icon: ReactNode;
  actions: DocumentToolbarAction[];
}

function ToolbarMenu({ label, icon, actions, className = "" }: ToolbarMenuProps) {
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);
  const enabled = actions.length > 0;
  const hasEnabledAction = actions.some((action) => !action.disabled);
  const disabledTitle = actions.find((action) => action.disabled && action.title)?.title ?? `No ${label.toLowerCase()} actions available`;

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

  if (!enabled) return null;

  return (
    <div ref={ref} className={`relative ${className}`}>
      <button
        type="button"
        onClick={() => {
          if (hasEnabledAction) setOpen((value) => !value);
        }}
        disabled={!hasEnabledAction}
        className={toolbarButtonClass}
        aria-haspopup="menu"
        aria-expanded={open}
        aria-label={`${label} actions`}
        title={hasEnabledAction ? `${label} actions` : disabledTitle}
      >
        {icon}
        {label}
        <ChevronDown className="h-3 w-3" />
      </button>

      {open && (
        <div
          role="menu"
          className="absolute right-0 top-full z-dropdown mt-1 min-w-[180px] overflow-hidden rounded-lg border border-[rgb(var(--color-border))] bg-[rgb(var(--color-surface))] py-1 shadow-lg"
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
              className={menuItemClass}
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
  fileText: <WordDocumentIcon />,
  eye: <Eye className="h-3.5 w-3.5" />,
  monitor: <Monitor className="h-3.5 w-3.5" />,
  monitorPlay: <MonitorPlay className="h-3.5 w-3.5" />,
  pencil: <Pencil className="h-3.5 w-3.5" />,
  playCircle: <PlayCircle className="h-3.5 w-3.5" />,
  sparkles: <Sparkles className="h-3.5 w-3.5" />,
  video: <Film className="h-3.5 w-3.5" />,
};
