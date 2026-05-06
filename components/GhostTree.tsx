"use client";

import { useMemo } from "react";
import { ReactFlow, type Node } from "reactflow";
import "reactflow/dist/style.css";
import type { HypothesisContent, TreeNode } from "@/lib/schema";

interface GhostTreeProps {
  tree: TreeNode[];
  visible: boolean;
}

export function GhostTree({ tree, visible }: GhostTreeProps) {
  const nodes = useMemo(() => buildGhostNodes(tree), [tree]);
  if (!visible || nodes.length === 0) return null;

  return (
    <div className="pointer-events-none absolute inset-0 z-0">
      <ReactFlow
        nodes={nodes}
        edges={[]}
        fitView
        nodesDraggable={false}
        nodesConnectable={false}
        elementsSelectable={false}
        panOnDrag={false}
        zoomOnScroll={false}
        zoomOnPinch={false}
        zoomOnDoubleClick={false}
        proOptions={{ hideAttribution: true }}
      />
    </div>
  );
}

function buildGhostNodes(tree: TreeNode[]): Node[] {
  const hypotheses = tree.filter(
    (node) => node.type === "hypothesis" || node.type === "sub_hypothesis",
  );
  const nodes: Node[] = [];

  hypotheses.forEach((node, hypIndex) => {
    const alternatives = (node.content as HypothesisContent).consideredAlternatives ?? [];
    alternatives.forEach((alternative, altIndex) => {
      nodes.push({
        id: `ghost-${node.id}-${altIndex}`,
        position: {
          x: -260 + altIndex * 220,
          y: 260 + hypIndex * 80,
        },
        data: {
          label: `${alternative.name}\n(considered, not used)`,
        },
        style: {
          background: "#0a0a0a",
          color: "#d6d3d1",
          border: "1px dashed #a8a29e",
          borderRadius: 8,
          fontSize: 12,
          opacity: 0.25,
          padding: 10,
          whiteSpace: "pre-line",
          width: 200,
        },
      });
    });
  });

  return nodes;
}
