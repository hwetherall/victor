"use client";

// Top-level overview: 5 hypothesis cards + decision card. Weakest-link
// hypothesis gets a rose border so it pops on the demo screen.

import { useQuery } from "@tanstack/react-query";
import { fetchRunNodes } from "@/lib/api-client";
import { aggregateModels } from "@/lib/model-labels";
import { ConfidenceMeter } from "./ConfidenceMeter";
import type {
  DecisionNode,
  HypothesisContent,
  HypothesisNode,
  TreeNode,
} from "@/lib/schema";

interface KanbanBoardProps {
  runId: string;
  onSelectHypothesis: (hypothesisId: string) => void;
}

export function KanbanBoard({ runId, onSelectHypothesis }: KanbanBoardProps) {
  const q = useQuery({
    queryKey: ["run-nodes", runId],
    queryFn: () => fetchRunNodes(runId),
  });

  if (q.isLoading) {
    return <p className="text-sm text-neutral-400">Loading tree…</p>;
  }
  if (q.isError) {
    return (
      <p className="text-sm text-rose-400">
        Failed to load tree: {(q.error as Error).message}
      </p>
    );
  }
  if (!q.data) return null;

  const decision = q.data.byType.decision[0] as DecisionNode | undefined;
  const hypotheses = q.data.byType.hypothesis as HypothesisNode[];
  const subByParent = groupByParent(q.data.byType.sub_hypothesis);
  const evByParent = groupByParent(q.data.byType.evidence);

  // Top-level (Tier 1) hypotheses are direct children of the decision node.
  const tier1 = decision
    ? hypotheses.filter((h) => h.parent_id === decision.id)
    : hypotheses;
  const sortedTier1 = [...tier1].sort(byLabel);

  // Tier 2 (Build/Buy/Partner) hypotheses, if Tier 1 cleared the gate.
  const tier2 = decision
    ? hypotheses.filter(
        (h) =>
          h.parent_id === decision.id &&
          /^(build|buy|partner)$/i.test(h.label.trim()),
      )
    : [];
  const tier1OnlyIds = new Set(tier2.map((h) => h.id));
  const tier1Filtered = sortedTier1.filter((h) => !tier1OnlyIds.has(h.id));

  const weakestId = decision?.content.weakestLinkNodeId ?? null;

  // Distinct model pills for the decision card footer — aggregated across
  // every node in the run (decision, hypotheses, evidence, vision-ingest).
  const modelsUsed = aggregateModels(q.data.nodes.map((n) => n.model_used));

  return (
    <div className="flex flex-col gap-6">
      {decision && <DecisionCard node={decision} modelsUsed={modelsUsed} />}

      <section>
        <h3 className="mb-3 text-xs font-medium uppercase tracking-wider text-neutral-500">
          Tier 1 hypotheses
        </h3>
        <div className="grid grid-cols-1 gap-4 md:grid-cols-2 lg:grid-cols-3">
          {tier1Filtered.map((h) => (
            <HypothesisCard
              key={h.id}
              node={h}
              isWeakest={h.id === weakestId}
              subCount={subByParent.get(h.id)?.length ?? 0}
              evidenceCount={countEvidenceUnder(h, subByParent, evByParent)}
              onClick={() => onSelectHypothesis(h.id)}
            />
          ))}
        </div>
      </section>

      {tier2.length > 0 && (
        <section>
          <h3 className="mb-3 text-xs font-medium uppercase tracking-wider text-neutral-500">
            Tier 2: Build · Buy · Partner
          </h3>
          <div className="grid grid-cols-1 gap-4 md:grid-cols-3">
            {tier2.map((h) => (
              <HypothesisCard
                key={h.id}
                node={h}
                isWeakest={false}
                subCount={subByParent.get(h.id)?.length ?? 0}
                evidenceCount={countEvidenceUnder(h, subByParent, evByParent)}
                onClick={() => onSelectHypothesis(h.id)}
              />
            ))}
          </div>
        </section>
      )}
    </div>
  );
}

// ─── Cards ───────────────────────────────────────────────────────────────────

import type { ModelMeta } from "@/lib/model-labels";

function DecisionCard({
  node,
  modelsUsed,
}: {
  node: DecisionNode;
  modelsUsed: ModelMeta[];
}) {
  const content = node.content;
  const passedThresholds = Object.entries(content.thresholdsMet ?? {}).filter(
    ([, v]) => v === true,
  ).length;
  const totalThresholds = Object.keys(content.thresholdsMet ?? {}).length;

  return (
    <div className="rounded-xl border border-emerald-700/40 bg-gradient-to-br from-emerald-950/40 via-neutral-950 to-neutral-950 p-6">
      <div className="mb-2 flex items-center justify-between">
        <span className="text-[10px] uppercase tracking-widest text-emerald-400">
          Master Decision · Opus
        </span>
        <span className="text-xs font-mono text-neutral-400">
          thresholds {passedThresholds}/{totalThresholds}
        </span>
      </div>
      <p className="text-xl font-semibold text-neutral-50">
        {content.finalDecision || "—"}
      </p>
      {content.reasoning && (
        <p className="mt-3 text-sm leading-relaxed text-neutral-300">
          {content.reasoning}
        </p>
      )}
      <div className="mt-4 max-w-md">
        <ConfidenceMeter value={node.confidence} />
      </div>
      {modelsUsed.length > 1 && (
        <div className="mt-5 border-t border-neutral-800/80 pt-3">
          <span className="text-[10px] uppercase tracking-widest text-neutral-500">
            Models contributing to this run
          </span>
          <div className="mt-2 flex flex-wrap gap-2">
            {modelsUsed.map((m) => (
              <span
                key={`${m.label}-${m.badge ?? ""}`}
                className={`inline-flex items-center gap-1.5 rounded-full px-2.5 py-1 text-xs ${m.bgClass} ${m.textClass}`}
              >
                <span className="h-1.5 w-1.5 rounded-full bg-current" />
                <span className="uppercase tracking-wider">{m.label}</span>
                {m.badge && (
                  <span className="text-[10px] opacity-90">· {m.badge}</span>
                )}
              </span>
            ))}
          </div>
        </div>
      )}
    </div>
  );
}

interface HypothesisCardProps {
  node: HypothesisNode;
  isWeakest: boolean;
  subCount: number;
  evidenceCount: number;
  onClick: () => void;
}

function HypothesisCard({
  node,
  isWeakest,
  subCount,
  evidenceCount,
  onClick,
}: HypothesisCardProps) {
  const claim = (node.content as HypothesisContent).claim ?? node.label;
  const border = isWeakest
    ? "border-rose-500/60 hover:border-rose-400"
    : "border-neutral-800 hover:border-neutral-600";

  return (
    <button
      type="button"
      onClick={onClick}
      className={`group flex flex-col gap-3 rounded-lg border ${border} bg-neutral-950 p-5 text-left transition-colors`}
    >
      <div className="flex items-start justify-between gap-3">
        <span className="text-xs font-mono uppercase tracking-wider text-neutral-500">
          {node.label}
        </span>
        {isWeakest && (
          <span className="rounded-full bg-rose-500/15 px-2 py-0.5 text-[10px] font-medium text-rose-300">
            weakest link
          </span>
        )}
      </div>
      <p className="line-clamp-3 text-sm text-neutral-200">{claim}</p>
      <ConfidenceMeter value={node.confidence} size="sm" />
      <div className="flex items-center justify-between text-[11px] text-neutral-500">
        <span>
          {subCount} sub-hypothes{subCount === 1 ? "is" : "es"}
        </span>
        <span>{evidenceCount} evidence</span>
      </div>
      {node.weight !== null && node.weight !== undefined && (
        <div className="text-[10px] text-neutral-600">
          weight: {node.weight.toFixed(2)}
        </div>
      )}
    </button>
  );
}

// ─── helpers ─────────────────────────────────────────────────────────────────

function groupByParent(nodes: TreeNode[]): Map<string, TreeNode[]> {
  const map = new Map<string, TreeNode[]>();
  for (const n of nodes) {
    if (!n.parent_id) continue;
    const arr = map.get(n.parent_id) ?? [];
    arr.push(n);
    map.set(n.parent_id, arr);
  }
  return map;
}

function countEvidenceUnder(
  hypothesis: HypothesisNode,
  subByParent: Map<string, TreeNode[]>,
  evByParent: Map<string, TreeNode[]>,
): number {
  const subs = subByParent.get(hypothesis.id) ?? [];
  let total = evByParent.get(hypothesis.id)?.length ?? 0;
  for (const s of subs) total += evByParent.get(s.id)?.length ?? 0;
  return total;
}

function byLabel(a: TreeNode, b: TreeNode): number {
  return a.label.localeCompare(b.label, undefined, { numeric: true });
}
