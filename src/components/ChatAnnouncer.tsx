import { useEffect, useRef, useState } from "react";
import { listenEvent } from "../ipc/events";
import { createActivityClassifier, shouldAnnounce } from "../accessibility/activityAnnouncements";
import { useAccessibilityStore, useInteractionHints } from "../stores/accessibilityStore";

/**
 * Screen-reader channel for companion chat activity, gated per category by
 * Settings > Accessibility > Announcements. Also hosts the chat input's
 * interaction hint so turning hints off removes it from the accessible
 * description.
 */
export function ChatAnnouncer() {
  const [message, setMessage] = useState("");
  const hints = useInteractionHints();
  const classify = useRef(createActivityClassifier());

  useEffect(() => {
    let cleared = 0;
    const unlisten = listenEvent("agent-event", (event) => {
      const ev = event.payload;
      const announcement = classify.current(ev);
      if (!announcement) return;
      if (!shouldAnnounce(announcement, ev, useAccessibilityStore.getState().settings.announce)) return;
      // Clear first so the same phrase twice in a row is still read out.
      setMessage("");
      cleared = window.requestAnimationFrame(() => setMessage(announcement.text));
    });
    return () => {
      window.cancelAnimationFrame(cleared);
      void unlisten.then((fn) => fn());
    };
  }, []);

  return (
    <>
      <div role="status" aria-live="polite" aria-atomic="true" className="sr-only" data-testid="chat-announcer">
        {message}
      </div>
      {hints && (
        <span id="chat-input-hint" hidden>
          Press Enter to send, Shift+Enter for a new line. Type @ to reference a document.
        </span>
      )}
    </>
  );
}
