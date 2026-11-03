import { useEffect, useRef } from "react";
import { useAppStore } from "../stores/appStore";
import { useChatStore } from "../stores/chatStore";

/** Leaves chat focus mode whenever the app view changes, so the focus overlay never covers the destination. */
export function useExitChatFocusOnNavigate(): void {
  const view = useAppStore((s) => s.view);
  const previous = useRef(view);

  useEffect(() => {
    if (previous.current === view) return;
    previous.current = view;
    const chat = useChatStore.getState();
    if (chat.chatFocusMode) chat.setChatFocusMode(false);
  }, [view]);
}
