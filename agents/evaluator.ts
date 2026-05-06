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
  /** Single-sentence prescription, populated only when confidence < 0.5.
   *  (improve.md §8.) */
  gapClosingAction?: string;
}

const GAP_CONFIDENCE_THRESHOLD = 0.5;

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

  // Persist on the hypothesis node. gapClosingAction is only carried through
  // when confidence is below the threshold; clear it otherwise so that an
  // earlier low-confidence run doesn't leave a stale prescription behind.
  const baseContent = hypothesis.content as HypothesisContent;
  const updatedContent: HypothesisContent = {
    ...baseContent,
    rationale: result.rationale,
    gapClosingAction:
      result.confidence < GAP_CONFIDENCE_THRESHOLD
        ? result.gapClosingAction
        : undefined,
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
      // Surface stake-adjusted strength + raw + source bias so the evaluator
      // can reason about source-conflict patterns explicitly. (improve.md §5.)
      const stakeNote =
        c.sourceStake && c.sourceStake !== "third-party"
          ? ` · source: ${c.sourceStake}`
          : "";
      const rawNote =
        c.rawStrength && c.rawStrength !== c.strength
          ? ` · was ${c.rawStrength} pre-stake-adjustment`
          : "";
      return `${i + 1}. [${c.supports}/${c.strength}${stakeNote}${rawNote}] ${c.finding}`;
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
        "Some findings carry a `source:` annotation indicating bias of the",
        "source (e.g. pre-disposed-favourable). The strength shown has already",
        "been stake-adjusted (one step demoted when the source supports its",
        "own bias, one step promoted when it goes against). When a biased",
        "source contributes materially to your conclusion, name the bias",
        "explicitly in the rationale (e.g. \"the deck's stake is",
        "pre-disposed-favourable; supporting findings from it are de-rated\").",
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
        '  "rationale": "<≤3 sentences>",',
        '  "gapClosingAction": "<single sentence; required ONLY if confidence < 0.5>"',
        "}",
        "",
        "Calibration: 0.5 = pure uncertainty. 0.8+ requires multiple",
        "moderate-or-strong supporting findings with no strong contradictions.",
        "Below 0.3 requires strong contradicting evidence.",
        "",
        "gapClosingAction (when confidence < 0.5): one sentence naming the",
        "specific artefact, dataset, or analysis that would change the answer.",
        "Be concrete — name the document type, the comparison, or the",
        "benchmark. Do NOT restate the claim or falsifier. Do NOT prescribe",
        "anything if confidence is ≥ 0.5; omit the field instead.",
        "Examples:",
        '  - "Retrieve a bottom-up investment model with WACC, year-1 to',
        "year-5 revenue ramp by SKU mix, and capex schedule for tooling and",
        'certification."',
        '  - "Run a teardown comparison of ABB MNS PDU vs Vertiv Geist vs',
        "Schneider NetShelter on remote-monitoring depth, outlet-level",
        'switching, and 3-phase 60A support."',
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
  if (typeof parsed.gapClosingAction !== "string" || parsed.gapClosingAction.length === 0) {
    parsed.gapClosingAction = undefined;
  }
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
