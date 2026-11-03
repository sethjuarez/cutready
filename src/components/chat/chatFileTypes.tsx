import { FileText, Globe } from "lucide-react";
import { contentTypeTone } from "../../utils/contentTypeTheme";
import { ChatArtifactIcon, NoteIcon, SketchIcon, StoryboardIcon } from "../Icons";

/** Type-specific accent colors — matches the explorer sidebar selected styles. */
export function typeColors(type: string): { text: string; bg: string; border: string } {
  const tone = contentTypeTone(type);
  if (tone) return { text: tone.text, bg: tone.activeBg, border: tone.border };
  if (type === "web") return { text: "text-accent", bg: "bg-accent/10", border: "border-accent/25" };
  return { text: "text-[rgb(var(--color-text-secondary))]", bg: "bg-[rgb(var(--color-surface))]", border: "border-[rgb(var(--color-border))]" };
}

/** Detect file type from a path string for colorizing. */
export function detectFileType(text: string): string | null {
  if (!text) return null;
  const t = text.trim();
  if (/\.sk$/i.test(t)) return "sketch";
  if (/\.md$/i.test(t) || /^notes?\//i.test(t)) return "note";
  if (/\.sb$/i.test(t) || /^storyboards?\//i.test(t)) return "storyboard";
  // Also match tool-style references
  if (/^(read_|set_|update_).*sketch|planning_row/i.test(t)) return "sketch";
  if (/^read_note/i.test(t)) return "note";
  return null;
}

export function FileTypeIcon({ type }: { type: string }) {
  const c = typeColors(type);
  const cls = `shrink-0 ${c.text}`;
  switch (type) {
    case "sketch":
      return <span className={cls}><SketchIcon size={12} /></span>;
    case "note":
      return <span className={cls}><NoteIcon size={12} /></span>;
    case "storyboard":
      return <span className={cls}><StoryboardIcon size={12} /></span>;
    case "chat-artifact":
      return <span className={cls}><ChatArtifactIcon size={12} /></span>;
    case "web":
      return <span className={cls}><Globe width={12} height={12} /></span>;
    default:
      return <span className={cls}><FileText width={12} height={12} /></span>;
  }
}
