"use client";

// Tier-1 hypothesis → tree of sub-hypotheses (rendered in React Flow). Click a
// sub-hypothesis to surface its evidence list (lifted state in CaseView).

import { useQuery } from "@tanstack/react-query";
import { useMemo, useState } from "react";
import {
  Background,
  Controls,
  ReactFlow,
  type Edge,
  type Node,
} from "reactflow";
import "reactflow/dist/style.css";
import { fetchMickyRuns, fetchNodeDetail, fetchRunNodes } from "@/lib/api-client";
import { ConfidenceMeter } from "./ConfidenceMeter";
import type { HypothesisContent, TreeNode } from "@/lib/schema";
import { MickyAnnotation } from "./MickyAnnotation";
import { GhostTree } from "./GhostTree";
import { TestDefinition } from "./TestDefinition";

interface HypothesisDrilldownProps {
  runId: string;
  hypothesisId: string;
  onSelectSub: (subId: string) => void;
  onBack: () => void;
}

export function HypothesisDrilldown({
  runId,
  hypothesisId,
  onSelectSub,
  onBack,
}: HypothesisDrilldownProps) {
  const [showGhost, setShowGhost] = useState(false);
  const detail = useQuery({
    queryKey: ["node-detail", runId, hypothesisId],
    queryFn: () => fetchNodeDetail(runId, hypothesisId),
  });

  // Pull all evidence so we can show counts per sub-hypothesis.
  const allNodes = useQuery({
    queryKey: ["run-nodes", runId],
    queryFn: () => fetchRunNodes(runId),
  });
  const mickyRuns = useQuery({
    queryKey: ["micky-runs", runId],
    queryFn: () => fetchMickyRuns(runId),
  });

  const evCountBySub = useMemo(() => {
    const map = new Map<string, number>();
    if (!allNodes.data) return map;
    for (const e of allNodes.data.byType.evidence) {
      if (!e.parent_id) continue;
      map.set(e.parent_id, (map.get(e.parent_id) ?? 0) + 1);
    }
    return map;
  }, [allNodes.data]);

  const flow = useMemo(() => {
    if (!detail.data) return { nodes: [], edges: [] };
    return buildFlow(detail.data.node, detail.data.children, evCountBySub);
  }, [detail.data, evCountBySub]);

  if (detail.isLoading) {
    return <p className="text-sm text-neutral-400">Loading hypothesis…</p>;
  }
  if (detail.isError) {
    return (
      <p className="text-sm text-rose-400">
        Failed to load: {(detail.error as Error).message}
      </p>
    );
  }
  if (!detail.data) return null;

  const node = detail.data.node;
  const nodeContent = node.content as HypothesisContent;
  const claim = nodeContent.claim ?? node.label;
  const subs = detail.data.children.filter(
    (c) => c.type === "sub_hypothesis",
  );
  const latestMickyOutput =
    (mickyRuns.data ?? []).find((run) => run.status === "complete")?.output ??
    null;
  const rankEntry =
    latestMickyOutput?.hypothesisRanking.find(
      (entry) => mickyRankId(entry) === node.id,
    ) ??
    null;
  const decompEntry =
    latestMickyOutput?.hypothesisDecomposition.find(
      (entry) => mickyDecompId(entry) === node.id,
    ) ?? null;
  const ghostTree = [node, ...detail.data.children];
  const hasGhosts = ghostTree.some(
    (treeNode) =>
      (treeNode.type === "hypothesis" || treeNode.type === "sub_hypothesis") &&
      ((treeNode.content as HypothesisContent).consideredAlternatives?.length ??
        0) > 0,
  );

  return (
    <div className="flex flex-col gap-5">
      <div className="flex items-center gap-3">
        <button
          type="button"
          onClick={onBack}
          className="text-xs text-neutral-500 hover:text-neutral-200"
        >
          ← overview
        </button>
        <span className="text-xs font-mono uppercase tracking-wider text-neutral-500">
          {node.label}
        </span>
      </div>

      <div className="rounded-lg border border-neutral-800 bg-neutral-950 p-5">
        <p className="text-base font-medium text-neutral-100">{claim}</p>
        {nodeContent.rationale && (
          <p className="mt-2 text-sm text-neutral-400">
            {nodeContent.rationale}
          </p>
        )}
        <div className="mt-4 max-w-md">
          <ConfidenceMeter value={node.confidence} />
        </div>
      </div>
      <TestDefinition content={nodeContent} />
      <MickyAnnotation rankEntry={rankEntry} decompEntry={decompEntry} />

      <div className="relative h-[420px] w-full rounded-lg border border-neutral-800 bg-neutral-950">
        {hasGhosts && (
          <button
            type="button"
            onClick={() => setShowGhost((value) => !value)}
            className="absolute right-3 top-3 z-20 rounded border border-neutral-700 bg-neutral-900 px-3 py-1 text-xs text-neutral-300 hover:bg-neutral-800"
          >
            {showGhost ? "Hide rejected branches" : "Show rejected branches"}
          </button>
        )}
        <GhostTree tree={ghostTree} visible={showGhost} />
        <ReactFlow
          nodes={flow.nodes}
          edges={flow.edges}
          fitView
          proOptions={{ hideAttribution: true }}
          onNodeClick={(_, n) => {
            if (n.id !== node.id) onSelectSub(n.id);
          }}
          className="relative z-10"
        >
          <Background color="#262626" gap={16} />
          <Controls className="!bg-neutral-900 !border-neutral-700" />
        </ReactFlow>
      </div>

      <ul className="grid grid-cols-1 gap-3 md:grid-cols-2">
        {subs.map((s) => {
          const subContent = s.content as HypothesisContent;
          return (
            <li key={s.id}>
              <button
                type="button"
                onClick={() => onSelectSub(s.id)}
                className="flex w-full flex-col gap-2 rounded-lg border border-neutral-800 bg-neutral-950 p-4 text-left transition-colors hover:border-neutral-600"
              >
                <div className="flex items-center justify-between">
                  <span className="text-xs font-mono text-neutral-500">
                    {s.label}
                  </span>
                  <span className="text-[11px] text-neutral-500">
                    {evCountBySub.get(s.id) ?? 0} evidence
                  </span>
                </div>
                <p className="line-clamp-2 text-sm text-neutral-200">
                  {subContent.claim ?? s.label}
                </p>
                <ConfidenceMeter value={s.confidence} size="sm" />
                {subContent.rationale && (
                  <p className="line-clamp-3 text-xs leading-relaxed text-neutral-400">
                    <span className="mr-1.5 text-[10px] font-medium uppercase tracking-wider text-neutral-500">
                      Verdict
                    </span>
                    {subContent.rationale}
                  </p>
                )}
                {subContent.gapClosingAction && (
                  <div className="mt-1 rounded border border-amber-700/40 bg-amber-950/30 p-2 text-[11px] leading-relaxed text-amber-200">
                    <span className="font-medium uppercase tracking-wider text-amber-400">
                      To close this gap:
                    </span>{" "}
                    {subContent.gapClosingAction}
                  </div>
                )}
              </button>
            </li>
          );
        })}
      </ul>
    </div>
  );
}

// ─── Flow layout ─────────────────────────────────────────────────────────────

function buildFlow(
  parent: TreeNode,
  children: TreeNode[],
  evCountBySub: Map<string, number>,
): { nodes: Node[]; edges: Edge[] } {
  const subs = children.filter((c) => c.type === "sub_hypothesis");

  const flowNodes: Node[] = [
    {
      id: parent.id,
      position: { x: 0, y: 0 },
      data: { label: parent.label },
      style: hypothesisStyle(parent.confidence),
      type: "default",
    },
    ...subs.map((s, i) => ({
      id: s.id,
      position: {
        x: -((subs.length - 1) * 220) / 2 + i * 220,
        y: 180,
      },
      data: {
        label: subLabel(s, evCountBySub.get(s.id) ?? 0),
      },
      style: subStyle(s.confidence),
      type: "default",
    })),
  ];

  const flowEdges: Edge[] = subs.map((s) => ({
    id: `${parent.id}->${s.id}`,
    source: parent.id,
    target: s.id,
    style: { stroke: "#525252" },
  }));

  return { nodes: flowNodes, edges: flowEdges };
}

function subLabel(s: TreeNode, evCount: number): string {
  const conf = s.confidence === null ? "—" : `${Math.round(s.confidence * 100)}%`;
  return `${s.label}\n${conf} · ${evCount} evidence`;
}

function hypothesisStyle(conf: number | null): React.CSSProperties {
  return {
    background: "#1c1917",
    color: "#fafafa",
    border: `1px solid ${borderFor(conf)}`,
    borderRadius: 10,
    padding: 12,
    fontSize: 13,
    fontWeight: 600,
    width: 200,
  };
}

function subStyle(conf: number | null): React.CSSProperties {
  return {
    background: "#0a0a0a",
    color: "#e5e5e5",
    border: `1px solid ${borderFor(conf)}`,
    borderRadius: 8,
    padding: 10,
    fontSize: 12,
    width: 200,
    whiteSpace: "pre-line",
  };
}

function borderFor(conf: number | null): string {
  if (conf === null) return "#404040";
  if (conf >= 0.7) return "#10b981";
  if (conf >= 0.4) return "#f59e0b";
  return "#f43f5e";
}

function mickyRankId(
  entry: import("@/lib/schema").MickyOutput["hypothesisRanking"][number],
): string {
  return entry.hypothesisId ?? (entry as unknown as { id?: string }).id ?? "";
}

function mickyDecompId(
  entry: import("@/lib/schema").MickyOutput["hypothesisDecomposition"][number],
): string {
  return entry.hypothesisId ?? (entry as unknown as { hypId?: string }).hypId ?? "";
}
