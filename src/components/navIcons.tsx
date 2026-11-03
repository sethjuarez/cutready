import type { ReactNode } from "react";

/** Direction C navigation icons: 24-unit grid, 1.5 stroke, round caps (ported from docs/design/direction-c.html). */
const paths = {
  menu: <path d="M4 6.5h16M4 12h16M4 17.5h16" />,
  home: (
    <>
      <path d="M3.5 10.2 12 3.5l8.5 6.7" />
      <path d="M5.5 8.8V19a1.5 1.5 0 0 0 1.5 1.5h3.2v-5.5h3.6v5.5H17a1.5 1.5 0 0 0 1.5-1.5V8.8" />
    </>
  ),
  docs: (
    <>
      <path d="M13.5 3.5H7A1.5 1.5 0 0 0 5.5 5v14A1.5 1.5 0 0 0 7 20.5h10a1.5 1.5 0 0 0 1.5-1.5V8.5z" />
      <path d="M13.5 3.5v3.5a1.5 1.5 0 0 0 1.5 1.5h3.5" />
      <path d="M8.8 12.5h6.4M8.8 16h4.4" />
    </>
  ),
  assets: (
    <>
      <rect x="3.5" y="4.5" width="17" height="15" rx="2" />
      <circle cx="9" cy="10" r="1.6" />
      <path d="m20.5 15.5-4.3-4.3a1 1 0 0 0-1.4 0L6 19.5" />
    </>
  ),
  changes: (
    <>
      <path d="M4 12a8 8 0 1 0 2.4-5.7" />
      <path d="M4 4.5v3.8h3.8" />
      <path d="M12 8v4.2l2.8 1.8" />
    </>
  ),
  feedback: (
    <>
      <path d="M5.5 4.5h13A1.5 1.5 0 0 1 20 6v9.5a1.5 1.5 0 0 1-1.5 1.5H10l-4.2 3.2a.5.5 0 0 1-.8-.4V17h.5A1.5 1.5 0 0 1 4 15.5V6a1.5 1.5 0 0 1 1.5-1.5z" />
      <path d="M8.5 9.3h7M8.5 12.3h4.5" />
    </>
  ),
  settings: (
    <>
      <path
        d="M10.3 3.6a1 1 0 0 1 1-.8h1.4a1 1 0 0 1 1 .8l.3 1.9 1.6.9 1.8-.7a1 1 0 0 1 1.2.4l.7 1.2a1 1 0 0 1-.2 1.3l-1.5 1.2v1.8l1.5 1.2a1 1 0 0 1 .2 1.3l-.7 1.2a1 1 0 0 1-1.2.4l-1.8-.7-1.6.9-.3 1.9a1 1 0 0 1-1 .8h-1.4a1 1 0 0 1-1-.8l-.3-1.9-1.6-.9-1.8.7a1 1 0 0 1-1.2-.4l-.7-1.2a1 1 0 0 1 .2-1.3l1.5-1.2v-1.8L4.9 8.8a1 1 0 0 1-.2-1.3l.7-1.2a1 1 0 0 1 1.2-.4l1.8.7 1.6-.9z"
        transform="translate(0 .7)"
      />
      <circle cx="12" cy="12.6" r="2.8" />
    </>
  ),
  note: (
    <>
      <path d="M6.5 4.5h11a1.5 1.5 0 0 1 1.5 1.5v9l-5 5H6.5A1.5 1.5 0 0 1 5 18.5V6a1.5 1.5 0 0 1 1.5-1.5z" />
      <path d="M19 15h-3.5a1.5 1.5 0 0 0-1.5 1.5V20" />
      <path d="M8.5 9h7M8.5 12.5h4.5" />
    </>
  ),
  clapper: (
    <>
      <path d="M4 10.5h16V18a2 2 0 0 1-2 2H6a2 2 0 0 1-2-2z" />
      <path d="m4 10.5-.5-2.6a1.8 1.8 0 0 1 1.4-2.1l11.4-2.3a1.8 1.8 0 0 1 2.1 1.4l.5 2.6z" />
      <path d="m8 5.2 2.6 3.2M12.6 4.3l2.6 3.2" />
    </>
  ),
  sketch: (
    <>
      <path d="M12 4H6a2 2 0 0 0-2 2v12a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2v-6" />
      <path d="M18.4 3.6a1.4 1.4 0 0 1 2 2L12.6 13.4a2 2 0 0 1-.85.5l-2.4.7.7-2.4a2 2 0 0 1 .5-.85z" />
    </>
  ),
  mic: (
    <>
      <rect x="9" y="3.5" width="6" height="11" rx="3" />
      <path d="M5.5 11.5a6.5 6.5 0 0 0 13 0M12 18v2.5" />
    </>
  ),
  sparkle: (
    <>
      <path d="M10.5 4.5 12 8.6a3 3 0 0 0 1.9 1.9l4.1 1.5-4.1 1.5a3 3 0 0 0-1.9 1.9L10.5 19.5 9 15.4a3 3 0 0 0-1.9-1.9L3 12l4.1-1.5A3 3 0 0 0 9 8.6z" />
      <path d="M18 3v4M16 5h4" />
    </>
  ),
  chat: <path d="M4.5 6A1.5 1.5 0 0 1 6 4.5h12A1.5 1.5 0 0 1 19.5 6v9a1.5 1.5 0 0 1-1.5 1.5h-8l-4 3.5v-3.5A1.5 1.5 0 0 1 4.5 15z" />,
  import: (
    <>
      <path d="M12 4v10.5" />
      <path d="m7.5 10 4.5 4.5 4.5-4.5" />
      <path d="M5 19.5h14" />
    </>
  ),
  plus: <path d="M12 5v14M5 12h14" />,
  pencil: <path d="m14 6 4 4M5 19l1-4.5L15.3 5.2a1.5 1.5 0 0 1 2.1 0l1.4 1.4a1.5 1.5 0 0 1 0 2.1L9.5 18z" />,
  trash: <path d="M4.5 7h15M9.5 7V4.5h5V7M6.5 7l1 12.5h9l1-12.5M10.5 10.5v6M13.5 10.5v6" />,
  user: (
    <>
      <circle cx="12" cy="8.5" r="3.5" />
      <path d="M5 19.5a7 7 0 0 1 14 0" />
    </>
  ),
  chevD: <path d="m6.5 9.5 5.5 5.5 5.5-5.5" />,
  chevR: <path d="m9.5 6.5 5.5 5.5-5.5 5.5" />,
} satisfies Record<string, ReactNode>;

export type NavIconName = keyof typeof paths;

export function NavIcon({ name, size = 20, className }: { name: NavIconName; size?: number; className?: string }) {
  return (
    <svg
      className={`shrink-0${className ? ` ${className}` : ""}`}
      width={size}
      height={size}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth={1.5}
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
    >
      {paths[name]}
    </svg>
  );
}
