/**
 * Shared icons for document types.
 * Tasteful, distinct SVG icons for sketches and storyboards.
 */

interface IconProps {
  size?: number;
  className?: string;
}

/** Sketch icon — pencil on paper, representing a creative draft. */
export function SketchIcon({ size = 14, className = "" }: IconProps) {
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.5"
      strokeLinecap="round"
      strokeLinejoin="round"
      className={className}
    >
      <path d="M12 20h9" />
      <path d="M16.5 3.5a2.121 2.121 0 0 1 3 3L7 19l-4 1 1-4L16.5 3.5z" />
    </svg>
  );
}

/** Storyboard icon — film clapperboard, representing a sequence of scenes. */
export function StoryboardIcon({ size = 14, className = "" }: IconProps) {
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.5"
      strokeLinecap="round"
      strokeLinejoin="round"
      className={className}
    >
      <path d="M4 11v8a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2v-8" />
      <path d="M2 7h20l-2 4H4L2 7z" />
      <path d="M7 3l-2 4" />
      <path d="M17 3l2 4" />
      <path d="M12 3v4" />
    </svg>
  );
}
