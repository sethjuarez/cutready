export type ContentTypeToneName = "storyboard" | "sketch" | "note";

export interface ContentTypeTone {
  bg: string;
  text: string;
  hoverText: string;
  activeBg: string;
  hoverBg: string;
  metaText: string;
  border: string;
}

export const contentTypeTones: Record<ContentTypeToneName, ContentTypeTone> = {
  storyboard: {
    bg: "bg-[rgb(var(--color-content-storyboard))]",
    text: "text-[rgb(var(--color-content-storyboard))]",
    hoverText: "hover:text-[rgb(var(--color-content-storyboard))]",
    activeBg: "bg-[rgb(var(--color-content-storyboard))]/10",
    hoverBg: "hover:bg-[rgb(var(--color-content-storyboard))]/10",
    metaText: "text-[rgb(var(--color-content-storyboard))]/70",
    border: "border-[rgb(var(--color-content-storyboard))]/30",
  },
  sketch: {
    bg: "bg-[rgb(var(--color-content-sketch))]",
    text: "text-[rgb(var(--color-content-sketch))]",
    hoverText: "hover:text-[rgb(var(--color-content-sketch))]",
    activeBg: "bg-[rgb(var(--color-content-sketch))]/10",
    hoverBg: "hover:bg-[rgb(var(--color-content-sketch))]/10",
    metaText: "text-[rgb(var(--color-content-sketch))]/70",
    border: "border-[rgb(var(--color-content-sketch))]/30",
  },
  note: {
    bg: "bg-[rgb(var(--color-content-note))]",
    text: "text-[rgb(var(--color-content-note))]",
    hoverText: "hover:text-[rgb(var(--color-content-note))]",
    activeBg: "bg-[rgb(var(--color-content-note))]/10",
    hoverBg: "hover:bg-[rgb(var(--color-content-note))]/10",
    metaText: "text-[rgb(var(--color-content-note))]/70",
    border: "border-[rgb(var(--color-content-note))]/30",
  },
};

export function contentTypeTone(type: string): ContentTypeTone | null {
  if (type === "storyboard" || type === "sketch" || type === "note") {
    return contentTypeTones[type];
  }
  return null;
}
