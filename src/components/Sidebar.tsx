import { type ReactNode } from "react";
import { House, Settings, Images, LayoutList, MessageSquare, MessageSquareMore, GitCompareArrows, Mic2 } from "lucide-react";
import type { AppView } from "../stores/appStore";
import { useAppStore } from "../stores/appStore";
import { UpdateAvailableButton } from "./UpdateAvailableButton";
import { activityButtonClass } from "./shellStyles";

const navItems: { id: AppView; label: string; icon: ReactNode }[] = [
  {
    id: "project",
    label: "Project",
    icon: <LayoutList className="w-4 h-4" />,
  },
  {
    id: "assets",
    label: "Visuals",
    icon: <Images className="w-4 h-4" />,
  },
  {
    id: "narrations",
    label: "Narrations",
    icon: <Mic2 className="w-4 h-4" />,
  },
  {
    id: "changes",
    label: "Changes",
    icon: <GitCompareArrows className="w-4 h-4" />,
  },
  {
    id: "chat",
    label: "Chat",
    icon: <MessageSquareMore className="w-4 h-4" />,
  },
];

export function Sidebar({
  onFeedback,
  onChatToggle,
  chatActive = false,
}: {
  onFeedback?: () => void;
  onChatToggle?: () => void;
  chatActive?: boolean;
}) {
  const view = useAppStore((s) => s.view);
  const setView = useAppStore((s) => s.setView);
  const currentProject = useAppStore((s) => s.currentProject);
  const changedFilesCount = useAppStore((s) => s.changedFiles.length);

  return (
    <nav className="no-select flex w-12 flex-col items-center gap-1.5 border-r border-[rgb(var(--color-border-subtle))] bg-[rgb(var(--color-surface))] px-1.5 py-3">
      {navItems.map((item) => {
        const isChat = item.id === "chat";
        const isActive = isChat ? chatActive : view === item.id;
        const requiresProject = item.id === "project" || item.id === "assets" || item.id === "narrations" || item.id === "changes";
        const isDisabled = requiresProject && !currentProject;

        return (
          <button
            key={item.id}
            onClick={() => {
              if (isDisabled) return;
              if (isChat) {
                onChatToggle?.();
                return;
              }
              setView(item.id);
            }}
            disabled={isDisabled}
            data-testid={`activity-${item.id}`}
            className={activityButtonClass(isActive, isDisabled)}
            title={item.label}
            aria-label={item.label}
          >
            {item.icon}
            {/* Badge for changes count */}
            {item.id === "changes" && changedFilesCount > 0 && (
              <span className="absolute -top-0.5 -right-0.5 min-w-[14px] h-[14px] flex items-center justify-center rounded-full bg-[rgb(var(--color-accent))] text-[rgb(var(--color-accent-fg))] text-[8px] font-bold leading-none px-0.5">
                {changedFilesCount > 99 ? "99+" : changedFilesCount}
              </span>
            )}
            {isActive && <ActiveIndicator />}
          </button>
        );
      })}

      {/* Spacer pushes bottom items down */}
      <div className="flex-1" />

      <UpdateAvailableButton />

      {/* Home — pinned to bottom */}
      <button
        onClick={() => setView("home")}
        className={activityButtonClass(view === "home")}
        title="Home"
        aria-label="Home"
        data-testid="activity-home"
      >
        <House className="w-4 h-4" />
        {view === "home" && <ActiveIndicator />}
      </button>

      {/* Feedback */}
      {onFeedback && (
        <button
          onClick={onFeedback}
          className={activityButtonClass(false)}
          title="Send Feedback"
          aria-label="Send feedback"
          data-testid="activity-feedback"
        >
          <MessageSquare className="w-4 h-4" />
        </button>
      )}

      {/* Global settings gear — pinned to bottom */}
      <button
        onClick={() => setView("settings")}
        className={activityButtonClass(view === "settings")}
        title="Settings"
        aria-label="Settings"
        data-testid="activity-settings"
      >
        <Settings className="w-4 h-4" />
        {view === "settings" && <ActiveIndicator />}
      </button>
    </nav>
  );
}

function ActiveIndicator() {
  return <span className="absolute left-[-8px] top-1/2 h-4 w-[2px] -translate-y-1/2 bg-[rgb(var(--color-accent))]" />;
}
