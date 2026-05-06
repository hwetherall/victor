// SPEC §6.6 — deterministic confidence rollup. No LLM.
//
// Sub-hypothesis → hypothesis: weighted average using the framework slot
//   decomposition; in v1 we treat each sub-hypothesis equally (no per-sub
//   weights are defined in SPEC §7.1), so this collapses to a plain mean.
//
// Hypothesis → decision: weighted product (AND-aggregation) using the
//   case-level weights from cases/<id>.yaml. Per SPEC §6.6 the function also
//   tracks the weakest-link node — the hypothesis whose contribution drags
//   the decision confidence down the most.

import type { TreeNode } from "@/lib/schema";

export interface RollupResult {
  /** New TreeNode array with confidence filled in for hypotheses + decision. */
  tree: TreeNode[];
  /** Final weighted confidence on the decision node. */
  decisionConfidence: number;
  /** Hypothesis node id whose low confidence × weight contributes least. */
  weakestLinkNodeId: string;
}

/**
 * @param tree   All TreeNode rows for the case (must include decision,
 *               hypotheses with weights, and sub-hypotheses with confidence).
 *               Sub-hypothesis confidences must already be set by the
 *               evaluator before this is called.
 * @param caseWeightsBySlot Maps the hypothesis's `templateId` (slot id) to
 *               the case-level weight. Slots without an entry fall back to
 *               the hypothesis node's stored `weight` column.
 */
export function rollupConfidence(
  tree: TreeNode[],
  caseWeightsBySlot: Record<string, number>,
): RollupResult {
  const byId = new Map(tree.map((n) => [n.id, n]));
  const childrenOf = new Map<string, TreeNode[]>();
  for (const n of tree) {
    if (!n.parent_id) continue;
    const arr = childrenOf.get(n.parent_id) ?? [];
    arr.push(n);
    childrenOf.set(n.parent_id, arr);
  }

  const decision = tree.find((n) => n.type === "decision");
  if (!decision) {
    throw new Error("rollupConfidence: tree has no decision node");
  }

  const hypotheses = (childrenOf.get(decision.id) ?? []).filter(
    (n) => n.type === "hypothesis",
  );

  const updated: TreeNode[] = [...tree];
  const replace = (n: TreeNode) => {
    const i = updated.findIndex((x) => x.id === n.id);
    if (i >= 0) updated[i] = n;
  };

  // Sub-hypothesis → hypothesis: plain mean of sub confidences.
  for (const hyp of hypotheses) {
    const subs = (childrenOf.get(hyp.id) ?? []).filter(
      (n) => n.type === "sub_hypothesis",
    );
    if (subs.length === 0) continue;
    const subConfs = subs.map((s) =>
      typeof s.confidence === "number" ? s.confidence : 0.5,
    );
    const mean = subConfs.reduce((a, b) => a + b, 0) / subConfs.length;
    replace({ ...hyp, confidence: round4(mean) });
  }

  // Hypothesis → decision: weighted product (AND-aggregation).
  // confidence_decision = Π (hyp_confidence ^ normalized_weight)
  // The slot with the lowest hyp_confidence^weight is the weakest link.
  const refreshed = updated.filter((n) => n.type === "hypothesis");
  const weighted = refreshed.map((h) => {
    const slotId =
      h.type === "hypothesis"
        ? (h.content.templateId ?? null)
        : null;
    const weight =
      (slotId ? caseWeightsBySlot[slotId] : undefined) ?? h.weight ?? 0;
    const conf = typeof h.confidence === "number" ? h.confidence : 0.5;
    return { id: h.id, weight, conf };
  });

  const weightTotal = weighted.reduce((a, b) => a + b.weight, 0) || 1;
  let logSum = 0;
  let weakestLinkNodeId = decision.id;
  let weakestContribution = Number.POSITIVE_INFINITY;

  for (const w of weighted) {
    const normWeight = w.weight / weightTotal;
    // Treat 0 confidence as a tiny epsilon so log doesn't explode; this is
    // really a "this hypothesis killed the decision" signal anyway.
    const safeConf = Math.max(w.conf, 1e-6);
    logSum += normWeight * Math.log(safeConf);
    // Weakest-link metric: contribution to log-product. The smallest (most
    // negative) contribution drags the product down the most.
    const contribution = normWeight * Math.log(safeConf);
    if (contribution < weakestContribution) {
      weakestContribution = contribution;
      weakestLinkNodeId = w.id;
    }
  }

  const decisionConfidence = round4(Math.exp(logSum));

  // Decision node: update content with weakest link + computed confidence.
  if (decision.type === "decision") {
    const newContent = {
      ...decision.content,
      weakestLinkNodeId,
    };
    replace({
      ...decision,
      confidence: decisionConfidence,
      content: newContent,
    });
  }

  return {
    tree: updated,
    decisionConfidence,
    weakestLinkNodeId,
  };
}

function round4(n: number): number {
  return Math.round(n * 10000) / 10000;
}
