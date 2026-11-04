import { AudioLines, Film, Image as ImageIcon, Shapes } from "lucide-react";
import type { MediaKind } from "../../utils/media";

const ICONS = { image: ImageIcon, visual: Shapes, video: Film, audio: AudioLines } as const;

export function MediaKindIcon({ kind, className }: { kind: MediaKind; className?: string }) {
  const Icon = ICONS[kind];
  return <Icon className={className} aria-hidden="true" />;
}

export const KIND_LABEL: Record<MediaKind, string> = {
  image: "Image",
  visual: "Visual",
  video: "Video",
  audio: "Audio",
};
