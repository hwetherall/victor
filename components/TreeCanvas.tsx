"use client";

// Generic React Flow canvas. The hypothesis drill-down (STORY-030) feeds it a
// sub-hypothesis subtree; the placeholder mode renders a single welcome node.

import {
  Background,
  Controls,
  ReactFlow,
  type Edge,
  type Node,
} from "reactflow";
import "reactflow/dist/style.css";

interface TreeCanvasProps {
  nodes?: Node[];
  edges?: Edge[];
}

const PLACEHOLDER_NODES: Node[] = [
  {
    id: "placeholder",
    position: { x: 0, y: 0 },
    data: { label: "Tree canvas — populated when a run completes" },
    style: {
      background: "#171717",
      color: "#e5e5e5",
      border: "1px solid #404040",
      borderRadius: 8,
      padding: 12,
      fontSize: 13,
    },
  },
];

export function TreeCanvas({
  nodes = PLACEHOLDER_NODES,
  edges = [],
}: TreeCanvasProps) {
  return (
    <div className="h-[500px] w-full rounded-lg border border-neutral-800 bg-neutral-950">
      <ReactFlow
        nodes={nodes}
        edges={edges}
        fitView
        proOptions={{ hideAttribution: true }}
      >
        <Background color="#262626" gap={16} />
        <Controls className="!bg-neutral-900 !border-neutral-700" />
      </ReactFlow>
    </div>
  );
}
