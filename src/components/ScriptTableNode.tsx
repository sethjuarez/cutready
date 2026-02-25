import type React from "react";
import type { EditorConfig, LexicalEditor, NodeKey, SerializedLexicalNode, Spread } from "lexical";
import { $getNodeByKey, DecoratorNode } from "lexical";
import { useLexicalComposerContext } from "@lexical/react/LexicalComposerContext";
import { ScriptTable } from "./ScriptTable";
import type { PlanningRow } from "../types/document";

export type SerializedScriptTableNode = Spread<
  {
    rows: PlanningRow[];
  },
  SerializedLexicalNode
>;

export class ScriptTableNode extends DecoratorNode<React.ReactElement> {
  __rows: PlanningRow[];

  static getType(): string {
    return "script-table";
  }

  static clone(node: ScriptTableNode): ScriptTableNode {
    return new ScriptTableNode([...node.__rows], node.__key);
  }

  constructor(rows?: PlanningRow[], key?: NodeKey) {
    super(key);
    this.__rows = rows ?? [
      {
        id: crypto.randomUUID(),
        time: "",
        narrative: "",
        demo_actions: "",
        screenshot: null,
      },
    ];
  }

  createDOM(_config: EditorConfig): HTMLElement {
    const div = document.createElement("div");
    div.className = "script-table-node";
    return div;
  }

  updateDOM(): boolean {
    return false;
  }

  getRows(): PlanningRow[] {
    return this.__rows;
  }

  setRows(rows: PlanningRow[]): void {
    const writable = this.getWritable();
    writable.__rows = rows;
  }

  static importJSON(serializedNode: SerializedScriptTableNode): ScriptTableNode {
    return new ScriptTableNode(serializedNode.rows);
  }

  exportJSON(): SerializedScriptTableNode {
    return {
      type: "script-table",
      version: 1,
      rows: this.__rows,
    };
  }

  decorate(_editor: LexicalEditor): React.ReactElement {
    return (
      <ScriptTableNodeComponent nodeKey={this.__key} rows={this.__rows} />
    );
  }

  isInline(): boolean {
    return false;
  }
}

function ScriptTableNodeComponent({
  nodeKey,
  rows,
}: {
  nodeKey: NodeKey;
  rows: PlanningRow[];
}) {
  const [editor] = useLexicalComposerContext();

  const handleChange = (newRows: PlanningRow[]) => {
    editor.update(() => {
      const node = $getNodeByKey(nodeKey) as ScriptTableNode | null;
      if (node) {
        node.setRows(newRows);
      }
    });
  };

  return <ScriptTable rows={rows} onChange={handleChange} />;
}

export function $createScriptTableNode(): ScriptTableNode {
  return new ScriptTableNode();
}

export function $isScriptTableNode(
  node: unknown,
): node is ScriptTableNode {
  return node instanceof ScriptTableNode;
}
