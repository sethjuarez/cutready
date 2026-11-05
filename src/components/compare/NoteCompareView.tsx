import { useState } from "react";
import type { NoteBlock, NoteComparison, WordSegment } from "../../domain/compare/noteCompare";
import { DELETED_TEXT, DiffBadge, INSERTED_TEXT, TONE_ROW } from "./diffTone";

type Layout = "inline" | "split";

function Words({ words, side }: { words: WordSegment[]; side: "inline" | "before" | "after" }) {
  return (
    <>
      {words.map((word, i) => {
        if (word.op === "equal") return <span key={i}>{word.text}</span>;
        if (word.op === "delete") return side === "after" ? null : <del key={i} className={DELETED_TEXT}>{word.text}</del>;
        return side === "before" ? null : <ins key={i} className={`no-underline ${INSERTED_TEXT}`}>{word.text}</ins>;
      })}
    </>
  );
}

const blockClass = "whitespace-pre-wrap break-words rounded px-2 py-1";

function InlineBlock({ block }: { block: NoteBlock }) {
  switch (block.status) {
    case "equal":
      return <div className={blockClass}>{block.text}</div>;
    case "moved":
      return (
        <div className={blockClass} data-block-status="moved">
          <DiffBadge tone="moved" /> {block.text}
        </div>
      );
    case "added":
      return <div className={`${blockClass} ${TONE_ROW.added}`} data-block-status="added"><ins className="no-underline">{block.text}</ins></div>;
    case "removed":
      return <div className={`${blockClass} ${TONE_ROW.removed} line-through`} data-block-status="removed"><del>{block.text}</del></div>;
    case "changed":
      return <div className={`${blockClass} ${TONE_ROW.changed}`} data-block-status="changed"><Words words={block.words} side="inline" /></div>;
  }
}

function SplitBlock({ block }: { block: NoteBlock }) {
  const cell = `${blockClass} min-h-[1.5rem]`;
  switch (block.status) {
    case "equal":
    case "moved":
      return (
        <>
          <div className={cell}>{block.text}</div>
          <div className={cell} data-block-status={block.status}>
            {block.status === "moved" && <><DiffBadge tone="moved" /> </>}
            {block.text}
          </div>
        </>
      );
    case "added":
      return (<><div className={cell} /><div className={`${cell} ${TONE_ROW.added}`} data-block-status="added">{block.text}</div></>);
    case "removed":
      return (<><div className={`${cell} ${TONE_ROW.removed} line-through`} data-block-status="removed">{block.text}</div><div className={cell} /></>);
    case "changed":
      return (
        <>
          <div className={`${cell} ${TONE_ROW.changed}`}><Words words={block.words} side="before" /></div>
          <div className={`${cell} ${TONE_ROW.changed}`} data-block-status="changed"><Words words={block.words} side="after" /></div>
        </>
      );
  }
}

/** Prose diff of a note or plain-text file, inline or side by side. */
export function NoteCompareView({ comparison, beforeLabel, afterLabel }: { comparison: NoteComparison; beforeLabel: string; afterLabel: string }) {
  const [layout, setLayout] = useState<Layout>("inline");
  const changed = comparison.blocks.some((block) => block.status !== "equal");
  return (
    <div className="space-y-2">
      <div role="group" aria-label="Layout" className="inline-flex rounded-control border border-border p-0.5 text-xs">
        {(["inline", "split"] as const).map((value) => (
          <button
            key={value}
            type="button"
            aria-pressed={layout === value}
            onClick={() => setLayout(value)}
            className={`rounded px-2 py-0.5 focus-visible:outline focus-visible:outline-2 focus-visible:outline-accent ${layout === value ? "bg-fill-selected text-text" : "text-text-secondary hover:bg-fill-hover"}`}
          >
            {value === "inline" ? "Inline" : "Side by side"}
          </button>
        ))}
      </div>
      {!changed && <p className="text-sm text-text-secondary">No text changes.</p>}
      {layout === "inline" ? (
        <div className="space-y-1 text-sm">
          {comparison.blocks.map((block, i) => <InlineBlock key={i} block={block} />)}
        </div>
      ) : (
        <div className="grid grid-cols-2 gap-x-3 gap-y-1 text-sm">
          <div className="text-xs font-medium text-text-secondary">{beforeLabel}</div>
          <div className="text-xs font-medium text-text-secondary">{afterLabel}</div>
          {comparison.blocks.map((block, i) => <SplitBlock key={i} block={block} />)}
        </div>
      )}
    </div>
  );
}
