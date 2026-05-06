// SPEC §6.7 — Master Decision Agent. Opus via OpenRouter (per Q1).
// Reads top-level hypothesis confidences, computes thresholdsMet, optionally
// invokes Tier 2 (Q6 conditional: only when rolled-up Tier 1 conf > 0.6),
// and produces a typed DecisionContent. Persists to the decision node.

import { insforge } from "@/lib/db";
import { completeJson, type Message } from "@/lib/llm-client";
import { loadCase } from "@/lib/framework-registry";
import type {
  DecisionContent,
  HypothesisContent,
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

  // Compute thresholdsMet deterministically from caseConfig.thresholds.
  // For v1 we cannot evaluate every threshold against real data — we mark
  // them based on hypothesis evidence alignment. This is a placeholder that
  // Opus can refine in its rationale.
  const thresholdsMet: Record<string, boolean> = {};
  for (const key of Object.keys(caseConfig.thresholds)) {
    thresholdsMet[key] = opts.rolledConfidence > 0.5;
  }

  // Ask Opus to write the human-facing decision text.
  const finalDecisionText = await callOpus({
    caseTitle: caseConfig.title,
    caseQuestion: caseConfig.question,
    rolledConfidence: opts.rolledConfidence,
    hypotheses: hypotheses.map((h) => ({
      label: h.label,
      claim: (h.content as HypothesisContent).claim,
      confidence: typeof h.confidence === "number" ? h.confidence : 0.5,
      weight: typeof h.weight === "number" ? h.weight : 0,
    })),
    weakestLinkLabel:
      hypotheses.find((h) => h.id === opts.weakestLinkNodeId)?.label ??
      "(unknown)",
    tier2,
    thresholdsMet,
  });

  const content: DecisionContent = {
    finalDecision: finalDecisionText.headline,
    reasoning: finalDecisionText.reasoning,
    weakestLinkNodeId: opts.weakestLinkNodeId,
    thresholdsMet,
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

interface OpusInput {
  caseTitle: string;
  caseQuestion: string;
  rolledConfidence: number;
  hypotheses: {
    label: string;
    claim: string;
    confidence: number;
    weight: number;
  }[];
  weakestLinkLabel: string;
  tier2: Tier2Result | null;
  thresholdsMet: Record<string, boolean>;
}

async function callOpus(
  input: OpusInput,
): Promise<{ headline: string; reasoning: string }> {
  const hypBlock = input.hypotheses
    .map(
      (h) =>
        `- ${h.label} — confidence ${h.confidence.toFixed(2)}, weight ${h.weight.toFixed(2)}\n  claim: ${h.claim}`,
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
        "",
        "Return JSON with shape:",
        "{",
        '  "headline":  "<≤15 words, e.g. \\"Pursue rack PDU via acquisition\\" or \\"Do not pursue\\">",',
        '  "reasoning": "<3–5 sentences referencing the weakest link>"',
        "}",
        "",
        "If Tier 1 rolled confidence ≤ 0.6, the headline must be 'Do not pursue",
        "rack PDU' and Tier 2 has not been evaluated — do not invent a mode.",
        "If Tier 1 confidence > 0.6 and Tier 2 was evaluated, the headline must",
        "name the recommended mode (build/acquire/partner).",
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

  const parsed = await completeJson<{ headline: string; reasoning: string }>(
    "decision",
    messages,
    { temperature: 0.3 },
  );

  if (typeof parsed.headline !== "string" || parsed.headline.length === 0) {
    throw new Error("decision: missing headline");
  }
  if (typeof parsed.reasoning !== "string") parsed.reasoning = "";
  return parsed;
}
