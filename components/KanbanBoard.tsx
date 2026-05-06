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

  const labelByNodeId = new Map(q.data.nodes.map((n) => [n.id, n.label]));

  const gapList = aggregateGapList(
    q.data.byType.sub_hypothesis,
    sortedTier1,
    subByParent,
  );

  return (
    <div className="flex flex-col gap-6">
      {decision && (
        <DecisionCard
          node={decision}
          modelsUsed={modelsUsed}
          labelByNodeId={labelByNodeId}
          gapList={gapList}
        />
      )}

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

interface GapGroup {
  parentLabel: string;
  actions: string[];
}

function DecisionCard({
  node,
  modelsUsed,
  labelByNodeId,
  gapList,
}: {
  node: DecisionNode;
  modelsUsed: ModelMeta[];
  labelByNodeId: Map<string, string>;
  gapList: GapGroup[];
}) {
  const content = node.content;
  const thresholdEntries = Object.entries(content.thresholds ?? {});
  const metCount = thresholdEntries.filter(
    ([, r]) => r.status === "met",
  ).length;
  const totalThresholds =
    thresholdEntries.length || Object.keys(content.thresholdsMet ?? {}).length;
  const palette = decisionPalette(content.finalDecisionState);

  return (
    <div className={`rounded-xl border ${palette.border} ${palette.bg} p-6`}>
      <div className="mb-2 flex items-center justify-between">
        <span className={`text-[10px] uppercase tracking-widest ${palette.label}`}>
          {palette.eyebrow} · Opus
        </span>
        <span className="text-xs font-mono text-neutral-400">
          thresholds {metCount}/{totalThresholds} met
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
      {content.weakestLinkLabel && (
        <p className="mt-3 text-xs text-neutral-400">
          <span className="text-neutral-500">Weakest link:</span>{" "}
          {content.weakestLinkLabel}
        </p>
      )}
      <div className="mt-4 max-w-md">
        <ConfidenceMeter value={node.confidence} />
      </div>
      {thresholdEntries.length > 0 && (
        <ThresholdsBlock
          entries={thresholdEntries}
          labelByNodeId={labelByNodeId}
        />
      )}
      {gapList.length > 0 && <GapList groups={gapList} />}
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

interface DecisionPalette {
  border: string;
  bg: string;
  label: string;
  eyebrow: string;
}

function decisionPalette(
  state: import("@/lib/schema").FinalDecisionState | undefined,
): DecisionPalette {
  switch (state) {
    case "pursue":
      return {
        border: "border-emerald-700/40",
        bg: "bg-gradient-to-br from-emerald-950/40 via-neutral-950 to-neutral-950",
        label: "text-emerald-400",
        eyebrow: "Master Decision · Pursue",
      };
    case "do-not-pursue":
      return {
        border: "border-rose-700/40",
        bg: "bg-gradient-to-br from-rose-950/40 via-neutral-950 to-neutral-950",
        label: "text-rose-400",
        eyebrow: "Master Decision · Do not pursue",
      };
    case "insufficient-evidence":
      return {
        border: "border-amber-700/40",
        bg: "bg-gradient-to-br from-amber-950/40 via-neutral-950 to-neutral-950",
        label: "text-amber-400",
        eyebrow: "Master Decision · Insufficient evidence",
      };
    default:
      // Pre-v3 runs (no state field) fall back to the original emerald shell.
      return {
        border: "border-emerald-700/40",
        bg: "bg-gradient-to-br from-emerald-950/40 via-neutral-950 to-neutral-950",
        label: "text-emerald-400",
        eyebrow: "Master Decision",
      };
  }
}

function GapList({ groups }: { groups: GapGroup[] }) {
  return (
    <div className="mt-5 border-t border-neutral-800/80 pt-3">
      <span className="text-[10px] uppercase tracking-widest text-amber-400">
        Diligence gaps to close
      </span>
      <ul className="mt-2 space-y-2 text-xs">
        {groups.map((g) => (
          <li key={g.parentLabel}>
            <div className="text-neutral-400">{g.parentLabel}</div>
            <ul className="mt-1 space-y-1 pl-3">
              {g.actions.map((a, i) => (
                <li key={i} className="leading-relaxed text-amber-200">
                  • {a}
                </li>
              ))}
            </ul>
          </li>
        ))}
      </ul>
    </div>
  );
}

function aggregateGapList(
  subs: TreeNode[],
  tier1: HypothesisNode[],
  subByParent: Map<string, TreeNode[]>,
): GapGroup[] {
  const subToParent = new Map<string, string>();
  for (const parent of tier1) {
    for (const child of subByParent.get(parent.id) ?? []) {
      subToParent.set(child.id, parent.id);
    }
  }
  const parentLabelById = new Map(tier1.map((p) => [p.id, p.label]));

  const groups = new Map<string, GapGroup>();
  for (const s of subs) {
    const action = (s.content as HypothesisContent).gapClosingAction;
    if (!action) continue;
    const parentId = subToParent.get(s.id);
    if (!parentId) continue;
    const parentLabel = parentLabelById.get(parentId) ?? "(unknown)";
    const existing = groups.get(parentId);
    if (existing) {
      if (!existing.actions.includes(action)) existing.actions.push(action);
    } else {
      groups.set(parentId, { parentLabel, actions: [action] });
    }
  }
  return [...groups.values()];
}

function ThresholdsBlock({
  entries,
  labelByNodeId,
}: {
  entries: [string, import("@/lib/schema").ThresholdRecord][];
  labelByNodeId: Map<string, string>;
}) {
  return (
    <div className="mt-5 border-t border-neutral-800/80 pt-3">
      <span className="text-[10px] uppercase tracking-widest text-neutral-500">
        Thresholds
      </span>
      <ul className="mt-2 space-y-1.5 text-xs">
        {entries.map(([key, record]) => {
          const sourceLabels = record.sourceLeafIds
            .map((id) => labelByNodeId.get(id))
            .filter((l): l is string => Boolean(l));
          return (
            <li key={key} className="font-mono">
              <div className="flex flex-wrap items-baseline justify-between gap-2">
                <span className="text-neutral-400">{key}</span>
                <span className="text-neutral-300">
                  <span className="text-neutral-500">target </span>
                  {String(record.target)}
                  <span className="mx-1.5 text-neutral-700">/</span>
                  <span className="text-neutral-500">observed </span>
                  <span className={statusClass(record.status)}>
                    {formatObserved(record)}
                  </span>
                </span>
              </div>
              {sourceLabels.length > 0 && (
                <div className="mt-0.5 pl-2 text-[10px] text-neutral-500">
                  see {sourceLabels.join("; ")}
                </div>
              )}
            </li>
          );
        })}
      </ul>
    </div>
  );
}

function formatObserved(record: import("@/lib/schema").ThresholdRecord): string {
  if (record.observed !== null && record.observed !== undefined) {
    return String(record.observed);
  }
  switch (record.status) {
    case "not-directly-tested":
      return "not directly tested";
    case "partially-tested":
      return "partially tested";
    case "met":
      return "met";
    case "not-met":
      return "not met";
  }
}

function statusClass(
  status: import("@/lib/schema").ThresholdStatus,
): string {
  switch (status) {
    case "met":
      return "text-emerald-300";
    case "not-met":
      return "text-rose-300";
    case "partially-tested":
      return "text-amber-300";
    case "not-directly-tested":
      return "text-neutral-400 italic";
  }
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
