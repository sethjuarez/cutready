import { useCallback, useEffect, useRef } from "react";
import { LexicalComposer } from "@lexical/react/LexicalComposer";
import { RichTextPlugin } from "@lexical/react/LexicalRichTextPlugin";
import { ContentEditable } from "@lexical/react/LexicalContentEditable";
import { HistoryPlugin } from "@lexical/react/LexicalHistoryPlugin";
import { ListPlugin } from "@lexical/react/LexicalListPlugin";
import { MarkdownShortcutPlugin } from "@lexical/react/LexicalMarkdownShortcutPlugin";
import { OnChangePlugin } from "@lexical/react/LexicalOnChangePlugin";
import { LexicalErrorBoundary } from "@lexical/react/LexicalErrorBoundary";
import { HeadingNode, QuoteNode } from "@lexical/rich-text";
import { ListNode, ListItemNode } from "@lexical/list";
import { CodeNode } from "@lexical/code";
import { LinkNode } from "@lexical/link";
import { HorizontalRuleNode } from "@lexical/react/LexicalHorizontalRuleNode";
import { TRANSFORMERS } from "@lexical/markdown";
import type { EditorState } from "lexical";
import { useAppStore } from "../stores/appStore";
import { ScriptTableNode } from "./ScriptTableNode";
import { SlashCommandPlugin } from "./SlashCommandPlugin";

const EDITOR_NODES = [
  HeadingNode,
  QuoteNode,
  ListNode,
  ListItemNode,
  CodeNode,
  LinkNode,
  HorizontalRuleNode,
  ScriptTableNode,
];

function onError(error: Error) {
  console.error("Lexical error:", error);
}

export function SketchEditor() {
  const activeDocument = useAppStore((s) => s.activeDocument);
  const updateDocumentContent = useAppStore((s) => s.updateDocumentContent);

  const debounceRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  const handleChange = useCallback(
    (editorState: EditorState) => {
      if (debounceRef.current) {
        clearTimeout(debounceRef.current);
      }
      debounceRef.current = setTimeout(() => {
        const json = editorState.toJSON();
        updateDocumentContent(json);
      }, 500);
    },
    [updateDocumentContent],
  );

  useEffect(() => {
    return () => {
      if (debounceRef.current) {
        clearTimeout(debounceRef.current);
      }
    };
  }, []);

  // Build initial config — load saved content if available
  const hasContent =
    activeDocument?.content != null &&
    typeof activeDocument.content === "object" &&
    activeDocument.content !== null &&
    "root" in (activeDocument.content as Record<string, unknown>);

  const initialConfig = {
    namespace: "CutReadySketch",
    theme: {
      root: "sketch-editor-root",
      paragraph: "sketch-editor-paragraph",
      heading: {
        h1: "sketch-editor-h1",
        h2: "sketch-editor-h2",
        h3: "sketch-editor-h3",
      },
      list: {
        ul: "sketch-editor-ul",
        ol: "sketch-editor-ol",
        listitem: "sketch-editor-li",
      },
      quote: "sketch-editor-quote",
      code: "sketch-editor-code",
      link: "sketch-editor-link",
      text: {
        bold: "sketch-editor-bold",
        italic: "sketch-editor-italic",
        underline: "sketch-editor-underline",
        strikethrough: "sketch-editor-strikethrough",
        code: "sketch-editor-code-inline",
      },
    },
    nodes: EDITOR_NODES,
    editorState: hasContent
      ? JSON.stringify(activeDocument!.content)
      : undefined,
    onError,
  };

  // Key forces a full re-mount when document changes
  const editorKey = activeDocument?.id ?? "empty";

  return (
    <div className="sketch-editor-wrapper flex-1 overflow-y-auto">
      <LexicalComposer key={editorKey} initialConfig={initialConfig}>
        <div className="relative">
          <RichTextPlugin
            contentEditable={
              <ContentEditable className="sketch-editor-content outline-none min-h-[400px] px-12 py-8" />
            }
            ErrorBoundary={LexicalErrorBoundary}
          />
          <HistoryPlugin />
          <ListPlugin />
          <MarkdownShortcutPlugin transformers={TRANSFORMERS} />
          <OnChangePlugin onChange={handleChange} ignoreSelectionChange />
          <SlashCommandPlugin />
        </div>
      </LexicalComposer>
    </div>
  );
}
