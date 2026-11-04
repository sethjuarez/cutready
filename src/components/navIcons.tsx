import {
  ChevronDown,
  ChevronRight,
  Clapperboard,
  Download,
  FileText,
  GitCompareArrows,
  House,
  Images,
  Menu,
  MessageSquareMore,
  MessageSquareText,
  Mic2,
  NotebookPen,
  Pencil,
  Plus,
  Settings,
  Sparkles,
  SquarePen,
  Trash2,
  User,
  X,
  type LucideIcon,
} from "lucide-react";

/** Sidebar icons, by role: CutReady's own lucide choices at their default stroke. */
const icons = {
  menu: Menu,
  home: House,
  docs: FileText,
  assets: Images,
  changes: GitCompareArrows,
  feedback: MessageSquareText,
  settings: Settings,
  note: NotebookPen,
  clapper: Clapperboard,
  sketch: SquarePen,
  mic: Mic2,
  sparkle: Sparkles,
  chat: MessageSquareMore,
  import: Download,
  plus: Plus,
  close: X,
  pencil: Pencil,
  trash: Trash2,
  user: User,
  chevD: ChevronDown,
  chevR: ChevronRight,
} satisfies Record<string, LucideIcon>;

export type NavIconName = keyof typeof icons;

export function NavIcon({ name, size = 20, className }: { name: NavIconName; size?: number; className?: string }) {
  const Icon = icons[name];
  return <Icon size={size} className={`shrink-0${className ? ` ${className}` : ""}`} aria-hidden="true" />;
}
