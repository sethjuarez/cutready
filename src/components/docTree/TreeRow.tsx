import type { CSSProperties, KeyboardEvent, MouseEvent, ReactNode } from "react";
import { useSortable } from "@dnd-kit/sortable";
import { CSS } from "@dnd-kit/utilities";
import { useChatStore } from "../../stores/chatStore";
import { NavIcon, type NavIconName } from "../navIcons";

export type TreeDepth = "tv" | "note" | "leaf";

export interface TreeRowProps {
  depth: TreeDepth;
  label: string;
  icon?: NavIconName;
  selected: boolean;
  /** Storyboard rows: chevron state and toggle. */
  expanded?: boolean;
  onToggle?: () => void;
  onOpen: () => void;
  /** Noun used in action titles, e.g. "storyboard". */
  kind: string;
  onRename?: () => void;
  onDelete?: () => void;
  onContextMenu?: (event: MouseEvent<HTMLDivElement>) => void;
  /** Rendered in place of the label while renaming. */
  renameInput?: ReactNode;
  testId?: string;
  sortable?: SortableBinding;
}

export interface SortableBinding {
  setNodeRef: (node: HTMLElement | null) => void;
  style: CSSProperties;
  attributes: Record<string, unknown>;
  listeners: Record<string, unknown> | undefined;
  isDragging: boolean;
}

/** A sidebar tree row: 32px, 13px text, a 20px icon slot, indented 20px per level; selected rows get a fill. */
export function TreeRow({
  depth,
  label,
  icon,
  selected,
  expanded,
  onToggle,
  onOpen,
  kind,
  onRename,
  onDelete,
  onContextMenu,
  renameInput,
  testId,
  sortable,
}: TreeRowProps) {
  const renaming = renameInput != null;
  // Opening a document from the nav leaves chat focus mode so the document is visible.
  const open = () => {
    useChatStore.getState().setChatFocusMode(false);
    onOpen();
  };
  const handleKeyDown = (event: KeyboardEvent<HTMLDivElement>) => {
    if (event.target !== event.currentTarget) return;
    if (event.key === "F2" && onRename) {
      event.preventDefault();
      onRename();
    } else if (event.key === "Enter" || event.key === " ") {
      event.preventDefault();
      open();
    } else if (onToggle && ((event.key === "ArrowRight" && !expanded) || (event.key === "ArrowLeft" && expanded))) {
      event.preventDefault();
      onToggle();
    }
  };
  const classes = ["cr-nv", "tv", depth === "tv" ? "" : depth, selected ? "sel" : ""].filter(Boolean).join(" ");

  // The row control and its actions are siblings, so the action buttons are not nested in a button.
  // Reordering is pointer-only, so dnd-kit's keyboard-sortable ARIA attributes are not applied.
  return (
    <div
      ref={sortable?.setNodeRef}
      style={sortable?.style}
      className={`cr-trow${sortable?.isDragging ? " dragging" : ""}`}
      onContextMenu={onContextMenu}
    >
      <div
        {...(renaming ? {} : (sortable?.listeners ?? {}))}
        role="button"
        tabIndex={0}
        title={label}
        data-testid={testId}
        aria-current={selected ? "page" : undefined}
        aria-expanded={onToggle ? expanded : undefined}
        className={classes}
        onClick={() => {
          if (!renaming) open();
        }}
        onDoubleClick={(event) => {
          if (!onRename) return;
          event.stopPropagation();
          onRename();
        }}
        onKeyDown={handleKeyDown}
      >
        <span className="ico">{icon && <NavIcon name={icon} size={16} />}</span>
        {renaming ? renameInput : <span className="lbl">{label}</span>}
        {onToggle && !renaming && (
          <span
            className={`tchev${expanded ? "" : " collapsed"}`}
            aria-hidden="true"
            onClick={(event) => {
              event.stopPropagation();
              onToggle();
            }}
            onDoubleClick={(event) => event.stopPropagation()}
          >
            <NavIcon name={expanded ? "chevD" : "chevR"} size={12} />
          </span>
        )}
      </div>
      {!renaming && (onRename || onDelete) && (
        <span className="acts">
          {onRename && (
            <button
              type="button"
              title={`Rename ${kind}`}
              aria-label={`Rename ${label}`}
              onClick={(event) => {
                event.stopPropagation();
                onRename();
              }}
            >
              <NavIcon name="pencil" size={16} />
            </button>
          )}
          {onDelete && (
            <button
              type="button"
              title={`Delete ${kind}`}
              aria-label={`Delete ${label}`}
              onClick={(event) => {
                event.stopPropagation();
                onDelete();
              }}
            >
              <NavIcon name="trash" size={16} />
            </button>
          )}
        </span>
      )}
    </div>
  );
}

/** A tree row that can be dragged to reorder within its SortableContext. */
export function SortableTreeRow(props: Omit<TreeRowProps, "sortable"> & { id: string }) {
  const { id, ...rest } = props;
  const { attributes, listeners, setNodeRef, transform, transition, isDragging } = useSortable({ id });
  return (
    <TreeRow
      {...rest}
      sortable={{
        setNodeRef,
        style: { transform: CSS.Transform.toString(transform), transition },
        attributes: attributes as unknown as Record<string, unknown>,
        listeners: listeners as Record<string, unknown> | undefined,
        isDragging,
      }}
    />
  );
}

/**
 * A collapsible section header: 12px muted label with a chevron after it, and hover-only
 * actions on the right. Expanded chevrons show on hover; collapsed ones always show.
 */
export function TreeSection({
  label,
  collapsed,
  onToggle,
  children,
}: {
  label: string;
  collapsed: boolean;
  onToggle: () => void;
  children?: ReactNode;
}) {
  return (
    <div className="cr-sec-h" data-collapsed={collapsed ? "true" : "false"}>
      <button type="button" className="cr-sec-toggle" aria-expanded={!collapsed} onClick={onToggle}>
        <span>{label}</span>
        <NavIcon name={collapsed ? "chevR" : "chevD"} size={12} className="cr-sec-chev" />
      </button>
      {children && <span className="cr-sec-acts">{children}</span>}
    </div>
  );
}

/** Section contents; stays mounted so opening and closing can animate its height. */
export function TreeSectionBody({ open, children }: { open: boolean; children: ReactNode }) {
  return (
    <div className="cr-sec-body" data-open={open ? "true" : "false"} inert={!open} aria-hidden={open ? undefined : true}>
      <div className="cr-sec-body-in">{children}</div>
    </div>
  );
}

/** A 24px icon button in a section header, shown on header hover or focus. */
export function TreeMiniButton({
  label,
  icon = "plus",
  onClick,
  testId,
  disabled,
  ariaHasPopup,
  ariaExpanded,
  children,
}: {
  label: string;
  icon?: NavIconName;
  onClick: (event: MouseEvent<HTMLButtonElement>) => void;
  testId?: string;
  disabled?: boolean;
  ariaHasPopup?: "menu";
  ariaExpanded?: boolean;
  children?: ReactNode;
}) {
  return (
    <button
      type="button"
      className="cr-mini"
      title={label}
      aria-label={label}
      data-testid={testId}
      disabled={disabled}
      aria-haspopup={ariaHasPopup}
      aria-expanded={ariaExpanded}
      onClick={(event) => {
        event.stopPropagation();
        onClick(event);
      }}
    >
      {children ?? <NavIcon name={icon} size={16} />}
    </button>
  );
}
