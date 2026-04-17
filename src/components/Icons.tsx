/**
 * Shared icons for document types.
 * Tasteful, distinct SVG icons for sketches and storyboards.
 */
import {
  SquarePen,
  Clapperboard,
  NotebookPen,
  AlertTriangle,
  GitBranch,
  Image,
  Sparkles,
} from "lucide-react";

interface IconProps {
  size?: number;
  className?: string;
}

/** Sketch icon — square pen, representing a creative sketch. */
export function SketchIcon({ size = 14, className = "" }: IconProps) {
  return <SquarePen width={size} height={size} className={className} />;
}

/** Storyboard icon — film clapperboard, representing a sequence of scenes. */
export function StoryboardIcon({ size = 14, className = "" }: IconProps) {
  return <Clapperboard width={size} height={size} className={className} />;
}

/** Note icon — notebook pen, representing a text note. */
export function NoteIcon({ size = 14, className = "" }: IconProps) {
  return <NotebookPen width={size} height={size} className={className} />;
}

/** Alert triangle icon — warning indicator for orphaned items. */
export function AlertTriangleIcon({ size = 14, className = "" }: IconProps) {
  return <AlertTriangle width={size} height={size} className={className} />;
}

/** History icon — git branch, representing the DAG timeline view. */
export function HistoryIcon({ size = 14, className = "" }: IconProps) {
  return <GitBranch width={size} height={size} className={className} />;
}

/** Image icon — photo, representing a captured or imported image. */
export function ImageIcon({ size = 14, className = "" }: IconProps) {
  return <Image width={size} height={size} className={className} />;
}

/** Visual icon — sparkles, representing a generated visual/animation. */
export function VisualIcon({ size = 14, className = "" }: IconProps) {
  return <Sparkles width={size} height={size} className={className} />;
}
