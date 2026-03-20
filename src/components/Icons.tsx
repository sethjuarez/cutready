/**
 * Shared icons for document types.
 * Tasteful, distinct SVG icons for sketches and storyboards.
 */
import {
  SwatchIcon,
  FilmIcon,
  DocumentIcon,
  ExclamationTriangleIcon,
  ClockIcon,
} from "@heroicons/react/24/outline";

interface IconProps {
  size?: number;
  className?: string;
}

/** Sketch icon — color swatch, representing a creative design. */
export function SketchIcon({ size = 14, className = "" }: IconProps) {
  return <SwatchIcon width={size} height={size} className={className} />;
}

/** Storyboard icon — film clapperboard, representing a sequence of scenes. */
export function StoryboardIcon({ size = 14, className = "" }: IconProps) {
  return <FilmIcon width={size} height={size} className={className} />;
}

/** Note icon — document with lines, representing a text note. */
export function NoteIcon({ size = 14, className = "" }: IconProps) {
  return <DocumentIcon width={size} height={size} className={className} />;
}

/** Alert triangle icon — warning indicator for orphaned items. */
export function AlertTriangleIcon({ size = 14, className = "" }: IconProps) {
  return <ExclamationTriangleIcon width={size} height={size} className={className} />;
}

/** History icon — branching graph, representing the DAG timeline view. */
export function HistoryIcon({ size = 14, className = "" }: IconProps) {
  return <ClockIcon width={size} height={size} className={className} />;
}
