// SPEC §6.5 — Hypothesis Evaluator. Sonnet via OpenRouter (per Q1).
// Reads a hypothesis's evidence children (or sub-hypothesis stub evidence),
// returns 0–1 confidence + rationale, writes back to the DB.

import { insforge } from "@/lib/db";
import { completeJson, type Message } from "@/lib/llm-client";
import type {
  EvidenceContent,
  HypothesisContent,
  TreeNode,
} from "@/lib/schema";

export interface EvaluationResult {
  confidence: number;
  evidenceStrength: number;
  rationale: string;
}

export async function evaluateHypothesis(
  hypothesisId: string,
): Promise<EvaluationResult> {
  // Fetch the hypothesis node + its evidence children.
  const { data: hypRows, error: hypErr } = await insforge.database
    .from("tree_nodes")
    .select("*")
    .eq("id", hypothesisId)
    .limit(1);
  if (hypErr) throw new Error(`evaluator: ${hypErr.message}`);
  const hypothesis = (hypRows as TreeNode[] | null)?.[0];
  if (!hypothesis) throw new Error(`Hypothesis ${hypothesisId} not found`);
  if (
    hypothesis.type !== "hypothesis" &&
    hypothesis.type !== "sub_hypothesis"
  ) {
    throw new Error(
      `Node ${hypothesisId} is type=${hypothesis.type}, not hypothesis`,
    );
  }

  const { data: childRows, error: childErr } = await insforge.database
    .from("tree_nodes")
    .select("*")
    .eq("parent_id", hypothesisId);
  if (childErr) throw new Error(`evaluator: ${childErr.message}`);

  const evidenceChildren = (childRows as TreeNode[] | null) ?? [];
  const evidence = evidenceChildren.filter((n) => n.type === "evidence");

  const hypothesisContent = hypothesis.content as HypothesisContent;
  const result = await callSonnet(hypothesisContent, evidence);

  // Persist on the hypothesis node.
  const updatedContent: HypothesisContent = {
    ...(hypothesis.content as HypothesisContent),
    rationale: result.rationale,
  };
  const { error: updErr } = await insforge.database
    .from("tree_nodes")
    .update({
      confidence: result.confidence,
      evidence_strength: result.evidenceStrength,
      content: updatedContent,
      status: "complete",
    })
    .eq("id", hypothesisId);
  if (updErr) throw new Error(`evaluator update: ${updErr.message}`);

  return result;
}

async function callSonnet(
  hypothesis: HypothesisContent,
  evidence: TreeNode[],
): Promise<EvaluationResult> {
  const evidenceList = evidence
    .map((e, i) => {
      const c = e.content as EvidenceContent;
      return `${i + 1}. [${c.supports}/${c.strength}] ${c.finding}`;
    })
    .join("\n");

  const messages: Message[] = [
    {
      role: "system",
      content: [
        "You are a strategic-analysis evaluator. You are given a single",
        "hypothesis claim, its explicit falsifier, its decision test, and a",
        "list of evidence findings. Each finding is tagged with whether it",
        "supports/contradicts/is mixed on the claim,",
        "and whether the evidence is weak/moderate/strong.",
        "",
        "Evaluate confidence against the stated test, not just the wording of",
        "the claim. Treat evidence that satisfies the falsifier as strong",
        "contradicting evidence, and explain any gap between the test and the",
        "available findings.",
        "",
        "Return JSON with shape:",
        "{",
        '  "confidence": <number between 0 and 1>,',
        '  "evidenceStrength": <integer 0..10>,',
        '  "rationale": "<≤3 sentences>"',
        "}",
        "",
        "Calibration: 0.5 = pure uncertainty. 0.8+ requires multiple",
        "moderate-or-strong supporting findings with no strong contradictions.",
        "Below 0.3 requires strong contradicting evidence.",
      ].join("\n"),
    },
    {
      role: "user",
      content: [
        `Hypothesis claim:\n${hypothesis.claim}`,
        "",
        `Falsifier:\n${hypothesis.falsifier}`,
        "",
        `Test:\n${formatTest(hypothesis.test)}`,
        "",
        evidenceList.length > 0
          ? `Evidence (${evidence.length} items):\n${evidenceList}`
          : "Evidence: NONE — no evidence has been gathered yet for this claim.",
        "",
        "Respond with JSON only.",
      ].join("\n"),
    },
  ];

  const parsed = await completeJson<EvaluationResult>("evaluator", messages, {
    temperature: 0.2,
  });

  // Clamp + sanity-check.
  parsed.confidence = clamp(parsed.confidence, 0, 1);
  parsed.evidenceStrength = Math.max(0, Math.min(10, Math.round(parsed.evidenceStrength)));
  if (typeof parsed.rationale !== "string") parsed.rationale = "";
  return parsed;
}

function clamp(n: number, lo: number, hi: number): number {
  if (typeof n !== "number" || Number.isNaN(n)) return 0.5;
  return Math.max(lo, Math.min(hi, n));
}

function formatTest(test: HypothesisContent["test"]): string {
  const horizon = test.horizon ? ` over ${test.horizon}` : "";
  return `${test.type} test on ${test.metric}: target ${String(test.target)}${horizon}`;
}
