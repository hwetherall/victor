// STORY-020 Phase B: Investigator rubric calibration eval. Runs a fixture
// set of ABB tier-1 leaves through the live Investigator agent and reports
// two signals per leaf:
//
//   • Mechanical rubric checks — the five pass conditions from
//     agents/managed/investigator/RUBRIC.md, restated here in code form so
//     the failure mode is observable per-criterion. C1 (addresses-falsifier)
//     and C4 (confidence-calibrated) are genuinely judgment calls — the
//     mechanical version is a loose heuristic; trust the grader for those.
//   • Grader verdict — the actual `span.outcome_evaluation_end` result from
//     the latest iteration. The gap between mechanical and grader is the
//     calibration signal. When mechanical fails but grader returns
//     `satisfied`, the rubric is too soft; when grader fails things
//     mechanical passes, the rubric is too aggressive.
//
// Run:
//   curl -X POST http://localhost:3000/api/dev/eval-investigator \
//        -H "content-type: application/json" \
//        --max-time 1800
//
// Optional body to override the fixture:
//   { leafLabels?: string[],         // subset by label
//     useAllLeaves?: boolean,        // run all 11 ABB tier-1 leaves
//     customLeaves?: EvalLeaf[] }    // ad-hoc one-off tests
//
// Returns a structured summary table — one row per leaf plus a summary.
// Re-run after each prompt iteration to compare. Default fixture is 3
// leaves (Haiku sanity); flip useAllLeaves for the 10-leaf acceptance
// run on Sonnet.
//
// Cost expectations (per spec-v2-plan.md STORY-020 Phase B notes):
//   - Haiku 3-leaf sanity:    ~$0.50–1
//   - Haiku 10-leaf baseline: ~$2
//   - Sonnet 10-leaf accept:  ~$10–15

import { NextResponse } from "next/server";
import { insforge } from "@/lib/db";
import { ensureCaseRow } from "@/lib/case";
import { createInvestigatorSession } from "@/lib/managed-agents-client";
import { persistInvestigatorOutput } from "@/lib/v2-persistence";
import type { InvestigatorOutput } from "@/lib/schema";

export const dynamic = "force-dynamic";
// 30-min cap. Each leaf is 4–15 min on Sonnet (Phase A.5 SH4.2 was 7.1 min);
// 3 leaves × 10 min worst case = 30 min; 10 leaves needs sequential dispatch
// so this route is for ≤5-leaf invocations. Run all 10 in two halves if you
// need to fit under the cap.
export const maxDuration = 1800;

interface EvalLeaf {
  label: string;
  displayLabel: string;
  templateId: string;
  claim: string;
  falsifier: string;
  threshold: { metric: string; value: number | string };
}

interface RequestBody {
  leafLabels?: string[];
  useAllLeaves?: boolean;
  customLeaves?: EvalLeaf[];
}

// ─── ABB tier-1 leaf catalog ────────────────────────────────────────────────
//
// Mirrors frameworks/market-entry-tiered.yaml decomposition leaves under
// tier-1 with case substitutions interpolated (cases/abb-rack-pdu.yaml):
//   COMPANY=ABB, PRODUCT=rack PDU, SCOPE=global data center market,
//   THRESHOLD_LOWER=$50M annual revenue, THRESHOLD_UPPER=$100M, HORIZON=3 years,
//   PARITY_BENCHMARKS=Vertiv, Schneider Electric, Eaton, IRR_HURDLE=15%.
// If the framework or case yaml changes, update this list.
const ABB_LEAVES: EvalLeaf[] = [
  {
    label: "tam-sam-som",
    displayLabel: "TAM-to-SOM bridge",
    templateId: "tam-sam-som",
    claim:
      "TAM-SAM-SOM bridge plus share-capture assumptions support $50M annual revenue in the global data center market",
    falsifier:
      "At top-quartile new-entrant share, accessible revenue does not reach $50M annual revenue",
    threshold: { metric: "accessible_share_capture_revenue", value: "$50M" },
  },
  {
    label: "growth-trajectory",
    displayLabel: "Market growth",
    templateId: "growth-trajectory",
    claim:
      "Market growth trajectory in the global data center market supports $100M annual revenue within 3 years",
    falsifier:
      "Compound annual growth rate across target segments is below 8% or total addressable market expansion does not reach $100M annual revenue by 3 years",
    threshold: { metric: "market_cagr", value: "8%" },
  },
  {
    label: "sub-segment-mix",
    displayLabel: "Intelligent mix",
    templateId: "sub-segment-mix",
    claim:
      "Intelligent vs basic segment mix in the global data center market favours premium pricing",
    falsifier:
      "Intelligent PDU segment share is below 30% of total PDU market or average selling price premium is less than 20%",
    threshold: { metric: "intelligent_segment_share", value: "30%" },
  },
  {
    label: "capability-gap",
    displayLabel: "Capability gap",
    templateId: "capability-gap",
    claim:
      "Capability gap to Vertiv, Schneider Electric, Eaton is closeable within 24 months",
    falsifier:
      "Technical assessment shows >24 months required to match feature parity with Vertiv, Schneider Electric, Eaton on remote monitoring, outlet-level control, or efficiency metrics",
    threshold: { metric: "months_to_parity_product", value: 24 },
  },
  {
    label: "brand-permission",
    displayLabel: "Brand permission",
    templateId: "brand-permission",
    claim:
      "ABB brand has permission in electrical-room and IT-rack buyer segments",
    falsifier:
      "ABB is not on approved vendor list at any of top-5 hyperscalers or top-3 colocation providers for electrical infrastructure",
    threshold: { metric: "approved_vendor_status_count", value: 5 },
  },
  {
    label: "electrical-channels-insufficient",
    displayLabel: "Existing channel reach",
    templateId: "electrical-channels-insufficient",
    claim:
      "Existing ABB electrical channels cannot reach IT decision-makers for rack PDU",
    falsifier:
      "ABB electrical sales force has existing relationships with IT buyers at 50%+ of target accounts",
    threshold: { metric: "existing_it_relationships_pct", value: "50%" },
  },
  {
    label: "acquisition-opens-channels",
    displayLabel: "AVL via buy/partner",
    templateId: "acquisition-opens-channels",
    claim:
      "Acquisition or partnership secures approved vendor status at top hyperscalers and colos",
    falsifier:
      "No acquisition target or partner in the global data center market has approved vendor status at 3+ hyperscalers",
    threshold: { metric: "approved_vendor_status_count", value: 3 },
  },
  {
    label: "margins-credible",
    displayLabel: "Margin potential",
    templateId: "margins-credible",
    claim: "25-30% gross margins are achievable on intelligent PDU portfolio",
    falsifier:
      "Channel margin leakage or intelligent/basic mix results in blended margin below 20%",
    threshold: { metric: "blended_gross_margin", value: "20%" },
  },
  {
    label: "investment-vs-ramp",
    displayLabel: "IRR and payback",
    templateId: "investment-vs-ramp",
    claim: "Investment required vs revenue ramp clears 15% IRR hurdle",
    falsifier:
      "NPV at 15% is negative or payback period exceeds 3 years",
    threshold: { metric: "npv_at_hurdle", value: 0 },
  },
  {
    label: "density-migration",
    displayLabel: "Density migration",
    templateId: "density-migration",
    claim:
      "100-200 kW density band migration timeline is manageable with current roadmap",
    falsifier:
      "100-200 kW density band exceeds 50% of target market within 24 months",
    threshold: { metric: "density_band_penetration", value: "50%" },
  },
  {
    label: "dc-distribution-unlikely",
    displayLabel: "DC distribution risk",
    templateId: "dc-distribution-unlikely",
    claim:
      "DC distribution disruption remains below 15% of target market through 3 years",
    falsifier:
      "DC distribution penetration in the global data center market exceeds 15% within 3 years",
    threshold: { metric: "dc_distribution_penetration", value: "15%" },
  },
];

// Default sanity fixture — three leaves spanning the falsifier shape space:
// quantitative-revenue (tam-sam-som), qualitative-judgement (capability-gap),
// quantitative-IRR (investment-vs-ramp = SH4.2 wedge). 3 leaves at Haiku
// is the cheapest acceptance signal before scaling to 10 on Sonnet.
const DEFAULT_LABELS = [
  "tam-sam-som",
  "capability-gap",
  "investment-vs-ramp",
];

// ─── Mechanical rubric checks ───────────────────────────────────────────────
//
// Mirrors agents/managed/investigator/RUBRIC.md. Each function returns
// { passed, reason? } so the failure mode is observable per leaf.

interface CheckResult {
  passed: boolean;
  reason?: string;
}

/** C1 (loose mechanical proxy): the evidence summary engages with the
 *  falsifier — at minimum, it's substantial prose AND not just the auto-
 *  generated outcome-grade fallback. The grader's per-criterion verdict
 *  is the authoritative signal; this is a sniff test for "agent gave up". */
function checkAddressesFalsifier(o: InvestigatorOutput): CheckResult {
  const summary = (o.evidenceSummary ?? "").trim();
  if (summary.length < 80) {
    return {
      passed: false,
      reason: `evidence_summary length=${summary.length} (<80 chars — likely no real analysis)`,
    };
  }
  // The post-processing fallback prefixes summaries with "Outcome <result>"
  // when the agent emitted no parseable EVIDENCE_SUMMARY block. That's a
  // signal the agent did not engage with the falsifier in writing.
  if (/^Outcome\s+(satisfied|needs_revision|max_iterations_reached|failed|interrupted)/i.test(summary)) {
    return {
      passed: false,
      reason: "evidence_summary is the outcome-grade fallback (no agent prose)",
    };
  }
  return { passed: true };
}

/** C2: threshold question is answered. RUBRIC.md acceptable phrasings:
 *  "above the threshold" / "below by N%" / "insufficient data". Search the
 *  evidence summary (and lastAgentText as fallback) for one of those signal
 *  words near the threshold metric. */
function checkThresholdAnswered(o: InvestigatorOutput): CheckResult {
  const text = `${o.evidenceSummary ?? ""}\n${o.lastAgentText ?? ""}`.toLowerCase();
  const signals = [
    "above",
    "below",
    "exceeds",
    "exceed ",
    "meets ",
    "meet the",
    "clears",
    "fails to clear",
    "fails to meet",
    "fails to reach",
    "fall short",
    "falls short",
    "insufficient data",
    "insufficient evidence",
    "not directly tested",
    "not enough data",
    "cannot be determined",
    "indeterminate",
  ];
  const hit = signals.find((s) => text.includes(s));
  if (!hit) {
    return {
      passed: false,
      reason: `no threshold-verdict signal word found (looked for ${signals.slice(0, 5).join("/")}/...)`,
    };
  }
  return { passed: true };
}

/** C3: quantitative claims have lineage — citations OR computed lineage.
 *  Mechanical proxy: at least one of (a) any artifact uploaded (computed
 *  lineage = the file), (b) URL in evidence_summary or lastAgentText
 *  (citation), (c) `[N]` numbered-citation marker. Falls short of the real
 *  rubric (the grader checks every numeric claim) but catches the worst
 *  case: zero traceability. */
function checkQuantitativeLineage(o: InvestigatorOutput): CheckResult {
  if (o.artifacts.length > 0) {
    return { passed: true };
  }
  const text = `${o.evidenceSummary ?? ""}\n${o.lastAgentText ?? ""}`;
  if (/https?:\/\//.test(text)) {
    return { passed: true };
  }
  // Numbered citation marker like "[1]" with surrounding whitespace.
  if (/\[\d+\]/.test(text)) {
    return { passed: true };
  }
  // Document-id reference from retrieve_documents (e.g., "(doc:abc-123, p.5)").
  if (/\bdoc:[a-z0-9\-]+/i.test(text)) {
    return { passed: true };
  }
  return {
    passed: false,
    reason: "no artifact, URL, [N] citation marker, or doc: reference found",
  };
}

/** C4: confidence calibrated. Hard caps from RUBRIC.md:
 *  - ≤ 0.6 single-point estimate, no sensitivity
 *  - ≤ 0.8 bottoms-up + sensitivity on dominant assumption
 *  - > 0.85 multiple independent lines of evidence
 *  Mechanical proxy: confidence is non-zero (parsed something), and the cap
 *  is roughly respected — > 0.85 requires ≥2 artifacts OR ≥3 citation hits.
 *  Real verdict belongs to the grader; this catches confidence=0 (parser
 *  failure) and obvious over-confidence with thin support. */
function checkConfidenceCalibrated(o: InvestigatorOutput): CheckResult {
  if (o.confidence <= 0) {
    return {
      passed: false,
      reason: "confidence parsed as 0 — agent emitted no parseable CONFIDENCE",
    };
  }
  const text = `${o.evidenceSummary ?? ""}\n${o.lastAgentText ?? ""}`;
  const citationHits =
    (text.match(/https?:\/\/\S+/g)?.length ?? 0) +
    (text.match(/\[\d+\]/g)?.length ?? 0);
  if (o.confidence > 0.85 && o.artifacts.length < 2 && citationHits < 3) {
    return {
      passed: false,
      reason: `confidence=${o.confidence} > 0.85 but only ${o.artifacts.length} artifact(s) and ${citationHits} citation hit(s) — over-confident on thin support`,
    };
  }
  return { passed: true };
}

/** C5: at least one rejected alternative is named. Mechanical: structured
 *  output's REJECTED_ALTERNATIVES block parsed at least one entry. */
function checkRejectedAlternative(o: InvestigatorOutput): CheckResult {
  if (o.rejectedAlternatives.length === 0) {
    return {
      passed: false,
      reason: "rejected_alternatives is empty",
    };
  }
  return { passed: true };
}

/** Canary for the structured-block-to-file drift mode (gotcha #10): the
 *  agent's final agent.message text MUST start with `CONFIDENCE:`. When this
 *  is false but the parser still extracted fields (via sandbox-block
 *  fallback), it tells us the rubric needs to enforce emission-as-final-
 *  message, not just block presence. */
function checkBlockEmittedAsFinalMessage(text: string): CheckResult {
  const firstNonEmptyLine = text
    .split("\n")
    .map((l) => l.trim())
    .find((l) => l.length > 0);
  if (!firstNonEmptyLine) {
    return { passed: false, reason: "lastAgentText is empty" };
  }
  if (!/^CONFIDENCE:/i.test(firstNonEmptyLine)) {
    return {
      passed: false,
      reason: `first line is "${firstNonEmptyLine.slice(0, 80)}..." (expected "CONFIDENCE:")`,
    };
  }
  return { passed: true };
}

// ─── DB helpers (mirroring app/api/dev/integration-sh42/route.ts) ──────────

async function createEvalRun(caseId: string): Promise<string> {
  const { data, error } = await insforge.database
    .from("runs")
    .insert([
      {
        case_id: caseId,
        scenario_id: null,
        status: "running",
        leaf_runtime: "v2",
      },
    ])
    .select("id");
  if (error) throw new Error(`createEvalRun: ${error.message}`);
  const id = (data as { id: string }[] | null)?.[0]?.id;
  if (!id) throw new Error("createEvalRun: no row returned");
  return id;
}

async function createLeafNode(
  caseId: string,
  leaf: EvalLeaf,
): Promise<string> {
  const content = {
    claim: leaf.claim,
    displayLabel: leaf.displayLabel,
    falsifier: leaf.falsifier,
    test: { type: "threshold", metric: leaf.threshold.metric, target: leaf.threshold.value },
    templateId: leaf.templateId,
  };
  const { data, error } = await insforge.database
    .from("tree_nodes")
    .insert([
      {
        case_id: caseId,
        parent_id: null,
        type: "sub_hypothesis",
        label: leaf.label,
        content,
        status: "running",
      },
    ])
    .select("id");
  if (error) throw new Error(`createLeafNode[${leaf.label}]: ${error.message}`);
  const id = (data as { id: string }[] | null)?.[0]?.id;
  if (!id) throw new Error(`createLeafNode[${leaf.label}]: no row returned`);
  return id;
}

async function stampTraceId(nodeId: string, traceId: string) {
  await insforge.database
    .from("tree_nodes")
    .update({ trace_id: traceId })
    .eq("id", nodeId);
}

// ─── Route ──────────────────────────────────────────────────────────────────

export async function POST(req: Request) {
  const start = Date.now();
  let body: RequestBody = {};
  try {
    body = (await req.json()) as RequestBody;
  } catch {
    // tolerate empty body — fixture defaults below
  }

  // Resolve which leaves to run.
  let leaves: EvalLeaf[];
  if (body.customLeaves && body.customLeaves.length > 0) {
    leaves = body.customLeaves;
  } else if (body.useAllLeaves) {
    leaves = ABB_LEAVES;
  } else if (body.leafLabels && body.leafLabels.length > 0) {
    leaves = body.leafLabels
      .map((label) => ABB_LEAVES.find((l) => l.label === label))
      .filter((l): l is EvalLeaf => l !== undefined);
    if (leaves.length === 0) {
      return NextResponse.json(
        {
          ok: false,
          error: `no leaves matched labels: ${body.leafLabels.join(",")}. Known labels: ${ABB_LEAVES.map((l) => l.label).join(", ")}`,
        },
        { status: 400 },
      );
    }
  } else {
    leaves = ABB_LEAVES.filter((l) => DEFAULT_LABELS.includes(l.label));
  }

  interface LeafResult {
    label: string;
    display_label: string;
    ok: boolean;
    error?: string;
    elapsed_s?: number;
    session_id?: string;
    console_url?: string;
    parsed?: {
      confidence: number;
      artifacts_count: number;
      escalations_count: number;
      reasoning_steps: number;
      rejected_alternatives_count: number;
      evidence_summary_first_300: string;
    };
    last_message_first_200?: string;
    grader?: {
      iterations: number;
      last_result: string | null;
      last_explanation: string | null;
    };
    usage?: InvestigatorOutput["usage"];
    checks?: {
      c1_addresses_falsifier: CheckResult;
      c2_threshold_answered: CheckResult;
      c3_quantitative_lineage: CheckResult;
      c4_confidence_calibrated: CheckResult;
      c5_rejected_alternative: CheckResult;
      block_emitted_as_final_message: CheckResult;
      passed_all_5: boolean;
    };
  }

  const results: LeafResult[] = [];

  // Bootstrap shared infra: case row + run row. One run per eval invocation
  // so session_costs aggregate naturally per-eval.
  const caseId = await ensureCaseRow("abb-rack-pdu");
  const runId = await createEvalRun(caseId);

  for (const leaf of leaves) {
    const leafStart = Date.now();
    try {
      const nodeId = await createLeafNode(caseId, leaf);
      const traceId = `eval-investigator:${leaf.label}:${leafStart}`;
      await stampTraceId(nodeId, traceId);

      const output = await createInvestigatorSession({
        traceId,
        hypothesis: {
          id: nodeId,
          claim: leaf.claim,
          templateId: leaf.templateId,
        },
        falsifier: leaf.falsifier,
        threshold: leaf.threshold,
        caseContext: {
          caseId,
          runId,
          question:
            "Should ABB pursue the rack PDU business, and if yes, should it be " +
            "built internally, acquired, or partnered into?",
          documentIds: [],
          weights: {},
          siblingLeafIds: [],
        },
      });

      // Persist so reasoning_traces / session_costs land — same shape as
      // integration-sh42. The eval is meant to leave a real DB trail for
      // post-hoc inspection of failed leaves (recon-investigator route can
      // then dump them by session_id).
      await persistInvestigatorOutput(output, {
        runId,
        nodeId,
        traceId,
        modelLabel: process.env.INVESTIGATOR_MODEL ?? "claude-opus-4-7",
      });

      const c1 = checkAddressesFalsifier(output);
      const c2 = checkThresholdAnswered(output);
      const c3 = checkQuantitativeLineage(output);
      const c4 = checkConfidenceCalibrated(output);
      const c5 = checkRejectedAlternative(output);
      const blockCheck = checkBlockEmittedAsFinalMessage(output.lastAgentText);
      const passedAll5 =
        c1.passed && c2.passed && c3.passed && c4.passed && c5.passed;
      const lastGrade =
        output.outcomesGrades.length > 0
          ? output.outcomesGrades[output.outcomesGrades.length - 1]
          : null;

      results.push({
        label: leaf.label,
        display_label: leaf.displayLabel,
        ok: true,
        elapsed_s: Number(((Date.now() - leafStart) / 1000).toFixed(1)),
        session_id: output.managedAgentSessionId,
        console_url: `https://console.anthropic.com/managed-agents/sessions/${output.managedAgentSessionId}`,
        parsed: {
          confidence: output.confidence,
          artifacts_count: output.artifacts.length,
          escalations_count: output.escalations.length,
          reasoning_steps: output.reasoningTrace.length,
          rejected_alternatives_count: output.rejectedAlternatives.length,
          evidence_summary_first_300: (output.evidenceSummary ?? "").slice(0, 300),
        },
        last_message_first_200: output.lastAgentText.slice(0, 200),
        grader: {
          iterations: output.outcomesGrades.length,
          last_result: lastGrade?.result ?? null,
          last_explanation: lastGrade?.explanation ?? null,
        },
        usage: output.usage,
        checks: {
          c1_addresses_falsifier: c1,
          c2_threshold_answered: c2,
          c3_quantitative_lineage: c3,
          c4_confidence_calibrated: c4,
          c5_rejected_alternative: c5,
          block_emitted_as_final_message: blockCheck,
          passed_all_5: passedAll5,
        },
      });
    } catch (e) {
      results.push({
        label: leaf.label,
        display_label: leaf.displayLabel,
        ok: false,
        elapsed_s: Number(((Date.now() - leafStart) / 1000).toFixed(1)),
        error: e instanceof Error ? e.message : String(e),
      });
    }
  }

  // Aggregate.
  const ok_runs = results.filter((r) => r.ok).length;
  const tally = (pred: (r: LeafResult) => boolean) =>
    results.filter((r) => r.ok && pred(r)).length;

  const summary = {
    leaves: leaves.length,
    ok_runs,
    failed_runs: leaves.length - ok_runs,
    passed_all_5: tally((r) => !!r.checks?.passed_all_5),
    passed_c1_addresses_falsifier: tally((r) => !!r.checks?.c1_addresses_falsifier.passed),
    passed_c2_threshold_answered: tally((r) => !!r.checks?.c2_threshold_answered.passed),
    passed_c3_quantitative_lineage: tally((r) => !!r.checks?.c3_quantitative_lineage.passed),
    passed_c4_confidence_calibrated: tally((r) => !!r.checks?.c4_confidence_calibrated.passed),
    passed_c5_rejected_alternative: tally((r) => !!r.checks?.c5_rejected_alternative.passed),
    block_emitted: tally(
      (r) => !!r.checks?.block_emitted_as_final_message.passed,
    ),
    grader_satisfied: tally((r) => r.grader?.last_result === "satisfied"),
    // The gap that matters: how often does the grader say satisfied while
    // mechanical checks fail? That's the rubric-too-soft signal.
    grader_satisfied_but_mechanical_fail: tally(
      (r) =>
        r.grader?.last_result === "satisfied" && !r.checks?.passed_all_5,
    ),
    artifacts_uploaded: tally((r) => (r.parsed?.artifacts_count ?? 0) > 0),
  };

  return NextResponse.json({
    ok: ok_runs === leaves.length,
    elapsed_s: Number(((Date.now() - start) / 1000).toFixed(1)),
    config: {
      leaf_count: leaves.length,
      labels: leaves.map((l) => l.label),
      model_label: process.env.INVESTIGATOR_MODEL ?? "claude-opus-4-7",
    },
    ids: { case_id: caseId, run_id: runId },
    summary,
    results,
  });
}
