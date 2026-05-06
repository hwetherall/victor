// SPEC §6.7 — Master Decision Agent. Opus via OpenRouter (per Q1).
// Reads top-level hypothesis confidences, computes thresholdsMet, optionally
// invokes Tier 2 (Q6 conditional: only when rolled-up Tier 1 conf > 0.6),
// and produces a typed DecisionContent. Persists to the decision node.

import { insforge } from "@/lib/db";
import { completeJson, type Message } from "@/lib/llm-client";
import { loadCase } from "@/lib/framework-registry";
import type {
  ConsideredAlternative,
  DecisionContent,
  EvidenceContent,
  FinalDecisionState,
  HypothesisContent,
  ThresholdRecord,
  TreeNode,
} from "@/lib/schema";
import {
  evaluateTier2,
  type Tier1Summary,
  type Tier2Result,
} from "./tier2-evaluator";

const TIER2_THRESHOLD = 0.6; // SPEC §8 framework activatesIf

export interface DecideOptions {
  /** Caller-supplied rolled-up decision confidence (from rollupConfidence). */
  rolledConfidence: number;
  /** Caller-supplied weakest-link node id. */
  weakestLinkNodeId: string;
}

export async function decide(
  dbCaseId: string,
  caseConfigId: string,
  opts: DecideOptions,
): Promise<DecisionContent> {
  const caseConfig = loadCase(caseConfigId);

  // Fetch decision + hypotheses for context.
  const { data: nodeRows, error } = await insforge.database
    .from("tree_nodes")
    .select("*")
    .eq("case_id", dbCaseId);
  if (error) throw new Error(`decision fetch: ${error.message}`);
  const nodes = (nodeRows as TreeNode[] | null) ?? [];

  const decisionNode = nodes.find((n) => n.type === "decision");
  if (!decisionNode) throw new Error("Decision node missing for case");

  const hypotheses = nodes.filter(
    (n): n is Extract<TreeNode, { type: "hypothesis" }> =>
      n.type === "hypothesis",
  );

  // Tier 2 conditional invocation.
  let tier2: Tier2Result | null = null;
  if (opts.rolledConfidence > TIER2_THRESHOLD) {
    const tier1Summary: Tier1Summary[] = hypotheses.map((h) => ({
      hypothesisId: h.id,
      label: h.label,
      confidence: typeof h.confidence === "number" ? h.confidence : 0.5,
      weight: typeof h.weight === "number" ? h.weight : 0,
    }));
    tier2 = await evaluateTier2(
      caseConfig.title,
      caseConfig.question,
      tier1Summary,
    );
  }

  // Per-threshold records (improve.md §10). v1 falsely showed every threshold
  // as "met"; v3 says "not directly tested" unless a leaf produced a numeric
  // observation that clears the target. Numeric extraction from evidence is
  // not implemented yet (v3.5 work), so every threshold currently surfaces as
  // not-directly-tested with the candidate source leaves named.
  const subHypotheses = nodes.filter((n) => n.type === "sub_hypothesis");
  const thresholds = buildThresholdRecords(
    caseConfig.thresholds,
    subHypotheses as Extract<TreeNode, { type: "sub_hypothesis" }>[],
  );

  // thresholdsMet retained for pre-v3 read paths until they migrate.
  const thresholdsMet: Record<string, boolean> = {};
  for (const [key, record] of Object.entries(thresholds)) {
    thresholdsMet[key] = record.status === "met";
  }

  const weakestLinkLabel =
    hypotheses.find((h) => h.id === opts.weakestLinkNodeId)?.label ??
    "(unknown)";

  // Ask Opus to write the human-facing decision text + state.
  const finalDecisionText = await callOpus({
    caseTitle: caseConfig.title,
    caseQuestion: caseConfig.question,
    rolledConfidence: opts.rolledConfidence,
    hypotheses: hypotheses.map((h) => ({
      label: h.label,
      claim: (h.content as HypothesisContent).claim,
      falsifier: (h.content as HypothesisContent).falsifier,
      insightAtStake: (h.content as HypothesisContent).insightAtStake,
      confidence: typeof h.confidence === "number" ? h.confidence : 0.5,
      weight: typeof h.weight === "number" ? h.weight : 0,
    })),
    weakestLinkLabel,
    tier2,
    thresholdsMet,
  });

  // Deterministic post-check (improve.md §7): if Opus picked `do-not-pursue`
  // but no leaf has substantial contradicting evidence, force the state to
  // `insufficient-evidence`. This guards against the v1 failure where every
  // low-confidence leaf was framed as a hard "no" when it was really "we
  // don't know yet".
  const finalDecisionState = applyStatePostCheck(
    finalDecisionText.state,
    opts.rolledConfidence,
    nodes,
  );

  const content: DecisionContent = {
    finalDecision: finalDecisionText.headline,
    finalDecisionState,
    reasoning: finalDecisionText.reasoning,
    weakestLinkNodeId: opts.weakestLinkNodeId,
    weakestLinkLabel,
    thresholds,
    thresholdsMet,
    consideredAlternatives: finalDecisionText.consideredAlternatives ?? [],
  };

  // Persist on the decision node.
  const { error: updErr } = await insforge.database
    .from("tree_nodes")
    .update({
      content,
      confidence: opts.rolledConfidence,
      status: "complete",
    })
    .eq("id", decisionNode.id);
  if (updErr) throw new Error(`decision update: ${updErr.message}`);

  return content;
}

// "Substantial contradicting evidence" at a leaf means at least one
// against-strong item, OR two against items at moderate-or-better strength.
// (improve.md §7 doesn't fix the bar — this is the v3 baseline.)
function leafHasSubstantialContradicting(
  leaf: Extract<TreeNode, { type: "sub_hypothesis" }>,
  evidenceByParent: Map<string, TreeNode[]>,
): boolean {
  const ev = (evidenceByParent.get(leaf.id) ?? []).filter(
    (n) => n.type === "evidence",
  );
  let strongAgainst = 0;
  let moderateOrBetterAgainst = 0;
  for (const e of ev) {
    const c = e.content as EvidenceContent;
    if (c.supports !== "against") continue;
    if (c.strength === "strong") strongAgainst++;
    if (c.strength === "moderate" || c.strength === "strong") {
      moderateOrBetterAgainst++;
    }
  }
  return strongAgainst >= 1 || moderateOrBetterAgainst >= 2;
}

const STATE_GATING_THRESHOLD = 0.6;
const LOW_CONFIDENCE_LEAF_BAR = 0.5;

function applyStatePostCheck(
  proposed: FinalDecisionState,
  rolledConfidence: number,
  nodes: TreeNode[],
): FinalDecisionState {
  // Above the gating threshold the only valid state is `pursue`. Below it,
  // `pursue` is impossible — fall through to the contradicting-vs-absent
  // disambiguation below.
  if (rolledConfidence >= STATE_GATING_THRESHOLD) return "pursue";
  if (proposed === "pursue") return "insufficient-evidence";

  // For below-threshold states, decide between do-not-pursue (test answered
  // "no") and insufficient-evidence (test not answered) based on whether the
  // low-confidence leaves carry substantial contradicting evidence.
  const evidenceByParent = new Map<string, TreeNode[]>();
  for (const n of nodes) {
    if (n.type !== "evidence" || !n.parent_id) continue;
    const arr = evidenceByParent.get(n.parent_id) ?? [];
    arr.push(n);
    evidenceByParent.set(n.parent_id, arr);
  }

  const lowConfLeaves = nodes.filter(
    (n): n is Extract<TreeNode, { type: "sub_hypothesis" }> =>
      n.type === "sub_hypothesis" &&
      typeof n.confidence === "number" &&
      n.confidence < LOW_CONFIDENCE_LEAF_BAR,
  );
  const contradicted = lowConfLeaves.filter((leaf) =>
    leafHasSubstantialContradicting(leaf, evidenceByParent),
  );

  // do-not-pursue requires a majority of low-confidence leaves to be
  // contradicted; otherwise force insufficient-evidence.
  const majorityContradicted =
    lowConfLeaves.length > 0 &&
    contradicted.length * 2 > lowConfLeaves.length;

  if (proposed === "do-not-pursue" && !majorityContradicted) {
    return "insufficient-evidence";
  }
  return proposed;
}

// Map case-yaml threshold keys to the framework template ids of the leaves
// that test them. Hard-coded for `ge-9-box-with-make-buy-ally` while there is
// only one framework; lift to framework yaml when a second one ships.
const THRESHOLD_LEAF_TEMPLATES: Record<string, string[]> = {
  minRevenue: ["tam-sam-som", "growth-trajectory"],
  timeYears: [],
  irrHurdle: ["investment-vs-ramp"],
  internalDevMaxYears: ["capability-gap"],
};

function buildThresholdRecords(
  caseThresholds: Record<string, number | string>,
  subHypotheses: Extract<TreeNode, { type: "sub_hypothesis" }>[],
): Record<string, ThresholdRecord> {
  const leafByTemplateId = new Map<string, string>();
  for (const sub of subHypotheses) {
    const templateId = (sub.content as HypothesisContent).templateId;
    if (templateId) leafByTemplateId.set(templateId, sub.id);
  }

  const out: Record<string, ThresholdRecord> = {};
  for (const [key, target] of Object.entries(caseThresholds)) {
    const templateIds = THRESHOLD_LEAF_TEMPLATES[key] ?? [];
    const sourceLeafIds = templateIds
      .map((tid) => leafByTemplateId.get(tid))
      .filter((id): id is string => Boolean(id));
    out[key] = {
      target,
      observed: null,
      status: "not-directly-tested",
      sourceLeafIds,
    };
  }
  return out;
}

interface OpusInput {
  caseTitle: string;
  caseQuestion: string;
  rolledConfidence: number;
  hypotheses: {
    label: string;
    claim: string;
    falsifier: string;
    insightAtStake: string;
    confidence: number;
    weight: number;
  }[];
  weakestLinkLabel: string;
  tier2: Tier2Result | null;
  thresholdsMet: Record<string, boolean>;
}

async function callOpus(
  input: OpusInput,
): Promise<{
  headline: string;
  reasoning: string;
  state: FinalDecisionState;
  consideredAlternatives: ConsideredAlternative[];
}> {
  const hypBlock = input.hypotheses
    .map(
      (h) =>
        [
          `- ${h.label} — confidence ${h.confidence.toFixed(2)}, weight ${h.weight.toFixed(2)}`,
          `  claim: ${h.claim}`,
          `  falsifier: ${h.falsifier}`,
          `  insight at stake: ${h.insightAtStake}`,
        ].join("\n"),
    )
    .join("\n");

  const tier2Block = input.tier2
    ? [
        "",
        `Tier 2 recommendation: ${input.tier2.recommendedOption.toUpperCase()}`,
        `Tier 2 rationale: ${input.tier2.rationale}`,
      ].join("\n")
    : "Tier 2: NOT EVALUATED (Tier 1 confidence below threshold).";

  const messages: Message[] = [
    {
      role: "system",
      content: [
        "You are the senior partner writing the final recommendation for an MBB",
        "case-style strategic decision. You have a rolled-up confidence score,",
        "five Tier 1 hypotheses with individual confidences, optionally a Tier 2",
        "build/buy/partner result, and a weakest-link callout.",
        "Each hypothesis also includes the falsifier that would disprove it and",
        "the insight at stake if it is true or false. Use those fields to make",
        "the recommendation sharper and to avoid overclaiming where a falsifier",
        "has not been addressed.",
        "",
        "There are exactly THREE possible decision states. Be opinionated;",
        "never hedge with phrases like 'pursue with conditions' — that state",
        "does not exist.",
        "",
        "  - 'pursue' — rolled confidence ≥ 0.6 and Tier 2 ran. Headline names",
        "    the recommended mode (build / acquire / partner).",
        "  - 'do-not-pursue' — rolled confidence < 0.6 AND most low-confidence",
        "    leaves carry strong contradicting evidence (the test was answered",
        "    and the answer was 'no'). Headline: 'Do not pursue <product>'.",
        "  - 'insufficient-evidence' — rolled confidence < 0.6 AND the low-",
        "    confidence leaves are low because evidence is missing, not",
        "    because findings contradict the claim. Headline: 'Below",
        "    confidence threshold — close diligence gaps before deciding'.",
        "",
        "Return JSON with shape:",
        "{",
        '  "state": "pursue" | "do-not-pursue" | "insufficient-evidence",',
        '  "headline":  "<≤15 words; matches the state per rules above>",',
        '  "reasoning": "<3–5 sentences referencing the weakest link>",',
        '  "consideredAlternatives": [',
        '    { "type": "hypothesis" | "method" | "scope", "name": "<alternative decision framing or entry mode>", "whyCut": "<why it was seriously weighed and rejected>" }',
        "  ]",
        "}",
        "",
        "The consideredAlternatives array must contain 2–4 items. Include",
        "alternative decision framings or entry modes that were seriously",
        "weighed but cut. Be concrete about what made each one lose.",
        "",
        "When state='insufficient-evidence', the reasoning must say what",
        "evidence would resolve the gap (the user is going to act on this).",
      ].join("\n"),
    },
    {
      role: "user",
      content: [
        `Case: ${input.caseTitle}`,
        `Question: ${input.caseQuestion}`,
        `Rolled Tier 1 confidence: ${input.rolledConfidence.toFixed(3)}`,
        `Weakest link: ${input.weakestLinkLabel}`,
        "",
        "Hypotheses:",
        hypBlock,
        "",
        tier2Block,
        "",
        "Respond with JSON only.",
      ].join("\n"),
    },
  ];

  const parsed = await completeJson<{
    headline: string;
    reasoning: string;
    state: string;
    consideredAlternatives?: ConsideredAlternative[];
  }>("decision", messages, { temperature: 0.3 });

  if (typeof parsed.headline !== "string" || parsed.headline.length === 0) {
    throw new Error("decision: missing headline");
  }
  if (typeof parsed.reasoning !== "string") parsed.reasoning = "";
  const state = isFinalDecisionState(parsed.state)
    ? parsed.state
    : "insufficient-evidence";
  const consideredAlternatives = Array.isArray(parsed.consideredAlternatives)
    ? parsed.consideredAlternatives.filter(isConsideredAlternative)
    : [];
  return {
    headline: parsed.headline,
    reasoning: parsed.reasoning,
    state,
    consideredAlternatives,
  };
}

function isConsideredAlternative(value: unknown): value is ConsideredAlternative {
  return (
    typeof value === "object" &&
    value !== null &&
    isConsideredAlternativeType((value as { type?: unknown }).type) &&
    typeof (value as { name?: unknown }).name === "string" &&
    typeof (value as { whyCut?: unknown }).whyCut === "string"
  );
}

function isConsideredAlternativeType(value: unknown): value is ConsideredAlternative["type"] {
  return value === "hypothesis" || value === "method" || value === "scope";
}

function isFinalDecisionState(s: unknown): s is FinalDecisionState {
  return (
    s === "pursue" || s === "do-not-pursue" || s === "insufficient-evidence"
  );
}
