import { useEffect, useRef, useState, type ReactNode, type UIEvent } from "react";
import type { AppView } from "../stores/appStore";
import { useAppStore } from "../stores/appStore";
import { useChatStore } from "../stores/chatStore";
import { useVersioningStore } from "../stores/versioningStore";
import { panelOwner, type NavId } from "../utils/navigation";
import { NavIcon, type NavIconName } from "./navIcons";
import { UpdateAvailableButton } from "./UpdateAvailableButton";
import { getContributorIdentity, type ResolvedIdentity } from "../services/identity";

const panelRows: { id: Exclude<NavId, "project" | "chat">; label: string; icon: NavIconName }[] = [
  { id: "assets", label: "Assets", icon: "assets" },
  { id: "narrations", label: "Narrations", icon: "mic" },
  { id: "changes", label: "Changes", icon: "changes" },
];

interface SidebarProps {
  onFeedback?: () => void;
  /** Opens Settings at the Profile tab (identity). */
  onProfile?: () => void;
  onChatToggle?: () => void;
  chatActive?: boolean;
  /** False collapses the sidebar to a zero-width track. */
  expanded?: boolean;
  /** Document sections (Storyboards, Sketches, Notes), shown while a project is open. */
  documents?: ReactNode;
  /** Assets, Narrations or Changes list, nested under the row that owns it. */
  panel?: ReactNode;
  /** View whose panel is shown; defaults to the current view (differs while Settings is open). */
  panelView?: AppView;
  width?: number;
  /** Suspends the width transition while the user drags the resize handle. */
  resizing?: boolean;
}

const rowClass = (...names: (string | false | undefined)[]) => ["cr-nv", ...names].filter(Boolean).join(" ");

/** Left sidebar, modelled on the GitHub Copilot app: top rows, collapsible sections, footer. */
export function Sidebar({
  onFeedback,
  onProfile,
  onChatToggle,
  chatActive = false,
  expanded = true,
  documents,
  panel,
  panelView,
  width = 280,
  resizing = false,
}: SidebarProps) {
  const view = useAppStore((s) => s.view);
  const setView = useAppStore((s) => s.setView);
  const currentProject = useAppStore((s) => s.currentProject);
  const changedFilesCount = useVersioningStore((s) => s.changedFiles.length);
  const owner = panelOwner(panelView ?? view);
  const count = changedFilesCount > 0 ? (changedFilesCount > 99 ? "99+" : String(changedFilesCount)) : null;
  const scrollRef = useRef<HTMLDivElement>(null);

  // Navigating anywhere leaves chat focus mode so its overlay never covers the destination.
  const go = (target: AppView) => {
    useChatStore.getState().setChatFocusMode(false);
    setView(target);
  };

  // Identity can come from the open repository's git config, so reload it when the repository
  // changes, and whenever Settings closes so a profile edit shows up straight away.
  const inSettings = view === "settings";
  const repoRoot = currentProject?.repo_root ?? null;
  const [identity, setIdentity] = useState<ResolvedIdentity | null>(null);
  useEffect(() => {
    if (inSettings) return;
    let live = true;
    getContributorIdentity()
      .then((next) => { if (live) setIdentity(next); })
      .catch(() => { if (live) setIdentity(null); });
    return () => { live = false; };
  }, [inSettings, repoRoot]);
  const needsSetup = !identity || identity.needs_setup;
  const displayName = needsSetup ? "Set up identity" : identity.name;

  const updateFades = (el: HTMLElement) => {
    el.dataset.fadeTop = el.scrollTop > 0 ? "true" : "false";
    el.dataset.fadeBottom = el.scrollTop + el.clientHeight < el.scrollHeight - 1 ? "true" : "false";
  };
  useEffect(() => {
    const el = scrollRef.current;
    if (!el || typeof ResizeObserver === "undefined") return;
    const observer = new ResizeObserver(() => updateFades(el));
    observer.observe(el);
    if (el.firstElementChild) observer.observe(el.firstElementChild);
    return () => observer.disconnect();
  }, []);

  return (
    <nav
      id="app-sidebar"
      aria-label="Main"
      aria-hidden={expanded ? undefined : true}
      inert={!expanded}
      data-testid="app-nav"
      data-expanded={expanded ? "true" : "false"}
      data-resizing={resizing ? "true" : undefined}
      className="cr-nav shrink-0"
      style={{ width: expanded ? width : 0 }}
    >
      <div className="cr-nav-inner" style={{ width }}>
        <div ref={scrollRef} className="cr-nav-scroll" onScroll={(e: UIEvent<HTMLDivElement>) => updateFades(e.currentTarget)}>
          <div>
            <div className="cr-nav-list">
              <button
                type="button"
                onClick={() => go("home")}
                className={rowClass(view === "home" && "sel")}
                aria-current={view === "home" ? "page" : undefined}
                data-testid="activity-home"
              >
                <span className="ico"><NavIcon name="home" size={16} /></span>
                <span className="lbl">Home</span>
              </button>

              {panelRows.map((row) => {
                const ownsPanel = expanded && owner === row.id && panel != null;
                const rowCount = row.id === "changes" ? count : null;
                return (
                  <div key={row.id} className="contents">
                    <button
                      type="button"
                      onClick={() => go(row.id)}
                      disabled={!currentProject}
                      className={rowClass(view === row.id && "sel")}
                      title={rowCount ? `${row.label} · ${rowCount} unsaved` : undefined}
                      aria-label={rowCount ? `${row.label}, ${rowCount} unsaved` : row.label}
                      aria-current={view === row.id ? "page" : undefined}
                      aria-expanded={ownsPanel}
                      data-testid={`activity-${row.id}`}
                    >
                      <span className="ico"><NavIcon name={row.icon} size={16} /></span>
                      <span className="lbl">{row.label}</span>
                      {rowCount && <span className="count" aria-hidden="true">{rowCount}</span>}
                    </button>
                    {ownsPanel && (
                      <div className="cr-nav-panel" data-testid="nav-panel">
                        {panel}
                      </div>
                    )}
                  </div>
                );
              })}

              <button
                type="button"
                onClick={() => onChatToggle?.()}
                className={rowClass(chatActive && "sel")}
                aria-pressed={chatActive}
                data-testid="activity-chat"
              >
                <span className="ico"><NavIcon name="sparkle" size={16} /></span>
                <span className="lbl">Chat</span>
              </button>
            </div>

            {documents}
          </div>
        </div>

        <div className="cr-nav-foot">
          <UpdateAvailableButton />
          <div className="cr-nav-me-row">
            <button
              type="button"
              onClick={() => {
                useChatStore.getState().setChatFocusMode(false);
                if (onProfile) onProfile();
                else go("settings");
              }}
              className={rowClass("cr-me", needsSetup && "setup")}
              title={identity && !needsSetup ? (identity.email ? `${identity.name} <${identity.email}>` : identity.name) : "Set up your name and email"}
              aria-label={needsSetup ? "Set up identity" : `Profile: ${identity.name}`}
              data-testid="nav-identity"
            >
              <span className="ava" aria-hidden="true">{needsSetup ? <NavIcon name="user" size={12} /> : initials(identity.name)}</span>
              <span className="lbl">{displayName}</span>
            </button>
            {onFeedback && (
              <button
                type="button"
                onClick={onFeedback}
                className="cr-nav-ibtn"
                aria-label="Send feedback"
                title="Send feedback"
                data-testid="activity-feedback"
              >
                <NavIcon name="feedback" size={16} />
              </button>
            )}
            <button
              type="button"
              onClick={() => go("settings")}
              className="cr-nav-ibtn"
              aria-label="Settings"
              title="Settings"
              aria-current={view === "settings" ? "page" : undefined}
              data-testid="activity-settings"
            >
              <NavIcon name="settings" size={16} />
            </button>
          </div>
        </div>
      </div>
    </nav>
  );
}

/** Up to two initials from a display name ("Seth Juarez" -> "SJ"). */
export function initials(name: string) {
  const parts = name.trim().split(/[\s._-]+/).filter(Boolean);
  const letters = parts.length > 1 ? parts[0][0] + parts[parts.length - 1][0] : (parts[0] ?? "?").slice(0, 2);
  return letters.toUpperCase();
}
