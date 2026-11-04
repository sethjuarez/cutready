// Quick-start cards. Each maps to a capability the app already has.
import type { ReactNode } from "react";
import { FileText, FolderOpen, PenLine, Presentation } from "lucide-react";

interface Starter {
  id: string;
  icon: ReactNode;
  /** Tile tint hue, matching the Direction C starters. */
  hue: number;
  title: string;
  subtitle: string;
  needsProject: boolean;
  onClick: () => void;
}

interface QuickStartCardsProps {
  hasProject: boolean;
  onImportDeck: () => void;
  onDraftFromDocument: () => void;
  onBlankSketch: () => void;
  onOpenFolder: () => void;
}

export function QuickStartCards({ hasProject, onImportDeck, onDraftFromDocument, onBlankSketch, onOpenFolder }: QuickStartCardsProps) {
  const starters: Starter[] = [
    { id: "deck", icon: <Presentation className="h-[18px] w-[18px]" />, hue: 20, title: "Import a deck", subtitle: ".pptx · slides become rows", needsProject: true, onClick: onImportDeck },
    { id: "document", icon: <FileText className="h-[18px] w-[18px]" />, hue: 210, title: "Draft from a document", subtitle: ".docx, .pdf · Planner drafts rows", needsProject: true, onClick: onDraftFromDocument },
    { id: "blank", icon: <PenLine className="h-[18px] w-[18px]" />, hue: 260, title: "Start a blank sketch", subtitle: "An empty planning table", needsProject: true, onClick: onBlankSketch },
    { id: "folder", icon: <FolderOpen className="h-[18px] w-[18px]" />, hue: 150, title: "Open a folder", subtitle: "A project folder or code repo", needsProject: false, onClick: onOpenFolder },
  ];

  return (
    <div className="mt-5 grid gap-3 [grid-template-columns:repeat(auto-fit,minmax(170px,1fr))]">
      {starters.map((starter) => {
        const disabled = starter.needsProject && !hasProject;
        return (
          <button
            key={starter.id}
            type="button"
            data-testid={`home-start-${starter.id}`}
            onClick={starter.onClick}
            disabled={disabled}
            title={disabled ? "Open a project first" : undefined}
            className="flex flex-col items-start gap-2.5 rounded-card border border-[rgb(var(--color-border-subtle))] bg-[rgb(var(--color-surface))] p-3.5 text-left shadow-layer transition-colors duration-fast ease-fluent hover:border-[rgb(var(--color-accent))] focus:outline-none focus-visible:ring-2 focus-visible:ring-[rgb(var(--color-accent))] disabled:cursor-not-allowed disabled:opacity-50 disabled:hover:border-[rgb(var(--color-border-subtle))]"
          >
            <span
              aria-hidden="true"
              className="grid h-9 w-9 place-items-center rounded-control text-[rgb(var(--color-text))]"
              style={{ background: `hsl(${starter.hue} 60% 50% / 0.16)` }}
            >
              {starter.icon}
            </span>
            <span className="min-w-0">
              <span className="block text-sm font-semibold">{starter.title}</span>
              <span className="mt-0.5 block text-xs text-[rgb(var(--color-text-secondary))]">{starter.subtitle}</span>
            </span>
          </button>
        );
      })}
    </div>
  );
}
