// SPEC §8 Tier 2 — Build / Buy / Partner comparative scoring (Q6 decision).
// Sonnet via OpenRouter. Caller is responsible for the gating check
// (only call when rolled-up Tier 1 confidence > 0.6).

import { completeJson, type Message } from "@/lib/llm-client";

export type Tier2Option = "build" | "buy" | "partner";
export const TIER2_OPTIONS: Tier2Option[] = ["build", "buy", "partner"];

export type Tier2Criterion =
  | "speed"
  | "control"
  | "capability_fit"
  | "capital"
  | "risk";
export const TIER2_CRITERIA: Tier2Criterion[] = [
  "speed",
  "control",
  "capability_fit",
  "capital",
  "risk",
];

export type Tier2Scores = Record<Tier2Option, Record<Tier2Criterion, number>>;

export interface Tier2Result {
  recommendedOption: Tier2Option;
  scores: Tier2Scores;
  rationale: string;
}

export interface Tier1Summary {
  hypothesisId: string;
  label: string;
  confidence: number;
  weight: number;
}

export async function evaluateTier2(
  caseTitle: string,
  caseQuestion: string,
  tier1: Tier1Summary[],
): Promise<Tier2Result> {
  const tier1Block = tier1
    .map(
      (h) =>
        `- ${h.label} — confidence ${h.confidence.toFixed(2)}, weight ${h.weight.toFixed(2)}`,
    )
    .join("\n");

  const messages: Message[] = [
    {
      role: "system",
      content: [
        "You are a corporate-strategy advisor scoring market entry MODES.",
        "The Tier 1 question (whether to pursue) has already been answered yes.",
        "Your job is to compare BUILD vs BUY vs PARTNER across five criteria.",
        "Each score is 0..1 where 1 = this option excels on that criterion.",
        "For 'risk' and 'capital', higher score = LESS risk / LESS capital required.",
        "",
        "Return JSON with shape:",
        "{",
        '  "scores": {',
        '    "build":   { "speed":0..1, "control":0..1, "capability_fit":0..1, "capital":0..1, "risk":0..1 },',
        '    "buy":     { ... },',
        '    "partner": { ... }',
        "  },",
        '  "recommendedOption": "build" | "buy" | "partner",',
        '  "rationale": "<≤4 sentences>"',
        "}",
        "",
        "Pick recommendedOption as the option with the highest sum of its five",
        "scores. Break ties by preferring the option with the highest 'risk' score.",
      ].join("\n"),
    },
    {
      role: "user",
      content: [
        `Case: ${caseTitle}`,
        `Question: ${caseQuestion}`,
        "",
        "Tier 1 hypothesis confidences (signal where the company is strong/weak):",
        tier1Block,
        "",
        "Score Build vs Buy vs Partner. Respond with JSON only.",
      ].join("\n"),
    },
  ];

  const parsed = await completeJson<Tier2Result>("tier2", messages, {
    temperature: 0.2,
  });

  // Sanity-check: enforce bounds and recompute recommendedOption from scores
  // to guarantee internal consistency even if the model picked oddly.
  for (const opt of TIER2_OPTIONS) {
    if (!parsed.scores?.[opt]) {
      throw new Error(`tier2: missing scores for option "${opt}"`);
    }
    for (const crit of TIER2_CRITERIA) {
      const v = parsed.scores[opt][crit];
      if (typeof v !== "number" || Number.isNaN(v)) {
        throw new Error(`tier2: scores.${opt}.${crit} is not a number`);
      }
      parsed.scores[opt][crit] = Math.max(0, Math.min(1, v));
    }
  }

  const sums = TIER2_OPTIONS.map((opt) => ({
    opt,
    sum: TIER2_CRITERIA.reduce((a, c) => a + parsed.scores[opt][c], 0),
    risk: parsed.scores[opt].risk,
  }));
  sums.sort((a, b) => b.sum - a.sum || b.risk - a.risk);
  parsed.recommendedOption = sums[0].opt;

  if (typeof parsed.rationale !== "string") parsed.rationale = "";
  return parsed;
}
