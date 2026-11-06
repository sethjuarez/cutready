import { useMemo } from "react";
import type { WorkspaceGraph } from "@draftline/client";
import {
  createDraftlineWorkspaceGraphModel,
  DraftlineWorkspaceGraph,
  type DraftlineWorkspaceGraphNode,
  type DraftlineWorkspaceGraphView,
} from "@draftline/react";
import { Handle, Position } from "@xyflow/react";
import "@xyflow/react/dist/style.css";
import { plainVersion } from "../../domain/versioning";
import "./historyGraph.css";

const NODE_WIDTH = 220;
const NODE_HEIGHT = 72;

function GraphNodeCard({ node, onSelect }: { node: DraftlineWorkspaceGraphNode; onSelect: (versionId: string) => void }) {
  const graphNode = node.data.graphNode;
  const current = graphNode.is_current || graphNode.is_head;
  return (
    <button
      type="button"
      className="history-graph-card"
      data-current={current || undefined}
      data-merge={graphNode.is_merge || undefined}
      aria-current={current ? "true" : undefined}
      onClick={() => onSelect(graphNode.version.id)}
    >
      {/* Draftline's node view renders no handles, so edges anchor to these. */}
      <Handle type="target" position={Position.Top} isConnectable={false} />
      <span className="history-graph-card-name">
        {plainVersion(node.data.label, graphNode.version.comment, graphNode.is_merge).name}
      </span>
      <span className="history-graph-card-meta">
        {graphNode.version.author.name}
        {node.data.refs.length > 0 && <> · {node.data.refs.join(", ")}</>}
      </span>
      <Handle type="source" position={Position.Bottom} isConnectable={false} />
    </button>
  );
}

/** Draftline's React Flow graph of the current timeline, themed for CutReady. Loaded as its own chunk. */
export default function HistoryGraphView({
  graph,
  view,
  onSelect,
}: {
  graph: WorkspaceGraph;
  view: DraftlineWorkspaceGraphView;
  onSelect: (versionId: string) => void;
}) {
  const model = useMemo(
    () => createDraftlineWorkspaceGraphModel(graph, { direction: "TB", view, nodeWidth: NODE_WIDTH, nodeHeight: NODE_HEIGHT }),
    [graph, view],
  );
  return (
    <DraftlineWorkspaceGraph
      className="history-graph"
      model={model}
      renderNode={(node) => <GraphNodeCard node={node} onSelect={onSelect} />}
    />
  );
}
