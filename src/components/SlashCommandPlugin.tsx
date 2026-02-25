import { useCallback, useEffect, useMemo, useState } from "react";
import { useLexicalComposerContext } from "@lexical/react/LexicalComposerContext";
import {
  $getSelection,
  $isRangeSelection,
  $createParagraphNode,
  COMMAND_PRIORITY_LOW,
  KEY_ARROW_DOWN_COMMAND,
  KEY_ARROW_UP_COMMAND,
  KEY_ENTER_COMMAND,
  KEY_ESCAPE_COMMAND,
  TextNode,
} from "lexical";
import { $createHeadingNode } from "@lexical/rich-text";
import { INSERT_UNORDERED_LIST_COMMAND, INSERT_ORDERED_LIST_COMMAND } from "@lexical/list";
import { $createScriptTableNode } from "./ScriptTableNode";
import { INSERT_HORIZONTAL_RULE_COMMAND } from "@lexical/react/LexicalHorizontalRuleNode";

interface SlashCommand {
  label: string;
  description: string;
  icon: string;
  action: () => void;
}

export function SlashCommandPlugin() {
  const [editor] = useLexicalComposerContext();
  const [isOpen, setIsOpen] = useState(false);
  const [query, setQuery] = useState("");
  const [selectedIndex, setSelectedIndex] = useState(0);
  const [position, setPosition] = useState({ top: 0, left: 0 });

  const commands: SlashCommand[] = useMemo(
    () => [
      {
        label: "Heading 1",
        description: "Large heading",
        icon: "H1",
        action: () => {
          editor.update(() => {
            const selection = $getSelection();
            if ($isRangeSelection(selection)) {
              const node = $createHeadingNode("h1");
              selection.insertNodes([node]);
            }
          });
        },
      },
      {
        label: "Heading 2",
        description: "Medium heading",
        icon: "H2",
        action: () => {
          editor.update(() => {
            const selection = $getSelection();
            if ($isRangeSelection(selection)) {
              const node = $createHeadingNode("h2");
              selection.insertNodes([node]);
            }
          });
        },
      },
      {
        label: "Heading 3",
        description: "Small heading",
        icon: "H3",
        action: () => {
          editor.update(() => {
            const selection = $getSelection();
            if ($isRangeSelection(selection)) {
              const node = $createHeadingNode("h3");
              selection.insertNodes([node]);
            }
          });
        },
      },
      {
        label: "Bullet List",
        description: "Unordered list",
        icon: "•",
        action: () => {
          editor.dispatchCommand(INSERT_UNORDERED_LIST_COMMAND, undefined);
        },
      },
      {
        label: "Numbered List",
        description: "Ordered list",
        icon: "1.",
        action: () => {
          editor.dispatchCommand(INSERT_ORDERED_LIST_COMMAND, undefined);
        },
      },
      {
        label: "Script Table",
        description: "4-column planning table",
        icon: "⊞",
        action: () => {
          editor.update(() => {
            const selection = $getSelection();
            if ($isRangeSelection(selection)) {
              const tableNode = $createScriptTableNode();
              const paragraph = $createParagraphNode();
              selection.insertNodes([tableNode, paragraph]);
            }
          });
        },
      },
      {
        label: "Divider",
        description: "Horizontal rule",
        icon: "—",
        action: () => {
          editor.dispatchCommand(INSERT_HORIZONTAL_RULE_COMMAND, undefined);
        },
      },
    ],
    [editor],
  );

  const filtered = useMemo(() => {
    if (!query) return commands;
    const q = query.toLowerCase();
    return commands.filter(
      (c) =>
        c.label.toLowerCase().includes(q) ||
        c.description.toLowerCase().includes(q),
    );
  }, [commands, query]);

  const executeCommand = useCallback(
    (index: number) => {
      const cmd = filtered[index];
      if (!cmd) return;

      // Remove the slash trigger text first
      editor.update(() => {
        const selection = $getSelection();
        if ($isRangeSelection(selection)) {
          const anchor = selection.anchor;
          const node = anchor.getNode();
          if (node instanceof TextNode) {
            const text = node.getTextContent();
            const slashIndex = text.lastIndexOf("/");
            if (slashIndex >= 0) {
              node.spliceText(slashIndex, text.length - slashIndex, "");
            }
          }
        }
      });

      cmd.action();
      setIsOpen(false);
      setQuery("");
      setSelectedIndex(0);
    },
    [editor, filtered],
  );

  // Listen for text changes to detect "/"
  useEffect(() => {
    return editor.registerTextContentListener(() => {
      // Check if the latest character typed was "/"
      editor.getEditorState().read(() => {
        const selection = $getSelection();
        if (!$isRangeSelection(selection)) return;

        const anchor = selection.anchor;
        const node = anchor.getNode();
        if (!(node instanceof TextNode)) return;

        const textContent = node.getTextContent();
        const cursorOffset = anchor.offset;
        const textBefore = textContent.slice(0, cursorOffset);

        const slashIndex = textBefore.lastIndexOf("/");
        if (slashIndex >= 0 && (slashIndex === 0 || textBefore[slashIndex - 1] === " " || textBefore[slashIndex - 1] === "\n")) {
          const queryText = textBefore.slice(slashIndex + 1);
          setQuery(queryText);
          setIsOpen(true);
          setSelectedIndex(0);

          // Position the menu near the cursor
          const domSelection = window.getSelection();
          if (domSelection && domSelection.rangeCount > 0) {
            const range = domSelection.getRangeAt(0);
            const rect = range.getBoundingClientRect();
            setPosition({ top: rect.bottom + 4, left: rect.left });
          }
        } else if (isOpen) {
          setIsOpen(false);
          setQuery("");
        }
      });
    });
  }, [editor, isOpen]);

  // Keyboard navigation
  useEffect(() => {
    if (!isOpen) return;

    const removeDown = editor.registerCommand(
      KEY_ARROW_DOWN_COMMAND,
      (e) => {
        e.preventDefault();
        setSelectedIndex((i) => Math.min(i + 1, filtered.length - 1));
        return true;
      },
      COMMAND_PRIORITY_LOW,
    );

    const removeUp = editor.registerCommand(
      KEY_ARROW_UP_COMMAND,
      (e) => {
        e.preventDefault();
        setSelectedIndex((i) => Math.max(i - 1, 0));
        return true;
      },
      COMMAND_PRIORITY_LOW,
    );

    const removeEnter = editor.registerCommand(
      KEY_ENTER_COMMAND,
      (e) => {
        if (e) e.preventDefault();
        executeCommand(selectedIndex);
        return true;
      },
      COMMAND_PRIORITY_LOW,
    );

    const removeEscape = editor.registerCommand(
      KEY_ESCAPE_COMMAND,
      () => {
        setIsOpen(false);
        setQuery("");
        return true;
      },
      COMMAND_PRIORITY_LOW,
    );

    return () => {
      removeDown();
      removeUp();
      removeEnter();
      removeEscape();
    };
  }, [editor, isOpen, filtered, selectedIndex, executeCommand]);

  if (!isOpen || filtered.length === 0) return null;

  return (
    <div
      className="fixed z-50 w-56 py-1 rounded-xl bg-[var(--color-surface-alt)] border border-[var(--color-border)] shadow-lg backdrop-blur-md"
      style={{ top: position.top, left: position.left }}
    >
      {filtered.map((cmd, idx) => (
        <button
          key={cmd.label}
          onClick={() => executeCommand(idx)}
          onMouseEnter={() => setSelectedIndex(idx)}
          className={`w-full flex items-center gap-2 px-3 py-1.5 text-left transition-colors ${
            idx === selectedIndex
              ? "bg-[var(--color-accent)]/10 text-[var(--color-text)]"
              : "text-[var(--color-text-secondary)]"
          }`}
        >
          <span className="w-6 text-center text-xs font-mono text-[var(--color-accent)]">
            {cmd.icon}
          </span>
          <div>
            <div className="text-xs font-medium">{cmd.label}</div>
            <div className="text-[10px] opacity-70">{cmd.description}</div>
          </div>
        </button>
      ))}
    </div>
  );
}
