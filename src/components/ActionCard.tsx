import type { CapturedAction } from "../types/recording";
import { convertFileSrc } from "@tauri-apps/api/core";

/** Human-readable labels for action types. */
const actionLabels: Record<string, string> = {
  BrowserNavigate: "Navigate",
  BrowserClick: "Click",
  BrowserType: "Type",
  BrowserSelect: "Select",
  BrowserScroll: "Scroll",
  BrowserWaitForElement: "Wait",
  NativeLaunch: "Launch",
  NativeClick: "Click (Native)",
  NativeType: "Type (Native)",
  NativeSelect: "Select (Native)",
  NativeInvoke: "Invoke (Native)",
  Wait: "Wait",
  Screenshot: "Screenshot",
  Annotation: "Note",
};

/** Badge color classes for action types. */
const badgeColors: Record<string, string> = {
  BrowserNavigate: "bg-blue-500/20 text-blue-400",
  BrowserClick: "bg-green-500/20 text-green-400",
  BrowserType: "bg-yellow-500/20 text-yellow-400",
  BrowserSelect: "bg-purple-500/20 text-purple-400",
  BrowserScroll: "bg-gray-500/20 text-gray-400",
  Wait: "bg-gray-500/20 text-gray-400",
};

/** Get a human-readable description of an action. */
function describeAction(action: CapturedAction["action"]): string {
  switch (action.type) {
    case "BrowserNavigate":
      return action.url;
    case "BrowserClick": {
      const sel = action.selectors[0];
      return sel ? `${sel.strategy}: ${sel.value}` : "Unknown element";
    }
    case "BrowserType": {
      const text =
        action.text.length > 40
          ? action.text.substring(0, 40) + "…"
          : action.text;
      return `"${text}"`;
    }
    case "BrowserSelect":
      return `Value: ${action.value}`;
    case "BrowserScroll":
      return `${action.direction} ${action.amount}px`;
    case "Wait":
      return `${action.duration_ms}ms`;
    case "Annotation":
      return action.text;
    default:
      return action.type;
  }
}

interface ActionCardProps {
  action: CapturedAction;
  index: number;
}

export function ActionCard({ action, index }: ActionCardProps) {
  const actionType = action.action.type;
  const label = actionLabels[actionType] || actionType;
  const badgeColor = badgeColors[actionType] || "bg-gray-500/20 text-gray-400";
  const description = describeAction(action.action);
  const screenshot = action.metadata.captured_screenshot;
  const timestamp = new Date(action.metadata.timestamp_ms).toLocaleTimeString();

  return (
    <div className="flex items-start gap-3 rounded-xl bg-[var(--color-surface-alt)] p-3 transition-colors hover:bg-[var(--color-surface-alt)]/80">
      {/* Index */}
      <span className="mt-0.5 flex h-6 w-6 shrink-0 items-center justify-center rounded-md bg-[var(--color-border)]/30 text-xs font-medium text-[var(--color-text-secondary)]">
        {index + 1}
      </span>

      {/* Content */}
      <div className="min-w-0 flex-1">
        <div className="flex items-center gap-2">
          {/* Type badge */}
          <span
            className={`inline-flex items-center rounded-md px-2 py-0.5 text-xs font-medium ${badgeColor}`}
          >
            {label}
          </span>
          {/* Timestamp */}
          <span className="text-xs text-[var(--color-text-secondary)]">
            {timestamp}
          </span>
        </div>

        {/* Description */}
        <p className="mt-1 truncate text-sm text-[var(--color-text)]">
          {description}
        </p>

        {/* Confidence */}
        {action.metadata.confidence < 0.8 && (
          <p className="mt-0.5 text-xs text-yellow-500">
            Low confidence ({Math.round(action.metadata.confidence * 100)}%)
          </p>
        )}
      </div>

      {/* Screenshot thumbnail */}
      {screenshot && (
        <img
          src={convertFileSrc(screenshot)}
          alt={`Step ${index + 1}`}
          className="h-14 w-24 shrink-0 rounded-lg border border-[var(--color-border)] object-cover"
          loading="lazy"
        />
      )}
    </div>
  );
}

