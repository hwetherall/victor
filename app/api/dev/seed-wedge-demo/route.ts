// STORY-011: seed wedge-demo data on the existing ABB tree's SH4.2 leaf.
//
// The Investigator agent doesn't currently produce a complete artifact run
// (prompt-tuning gap, separate work). The wedge demo's click path needs the
// same shape of data the agent will eventually produce — so we seed it here
// against fixture files. Once the agent reliably finishes, this seeder is
// retired in favour of a real run + STORY-023 pre-bake.
//
// Idempotent: re-running drops any prior seeded rows (those whose metadata
// is tagged seed=wedge-demo) before inserting fresh.
//
// Run:  curl -X POST http://localhost:3000/api/dev/seed-wedge-demo

import { NextResponse } from "next/server";
import { ensureCaseRow } from "@/lib/case";
import { insforge } from "@/lib/db";
import type { HypothesisContent, TreeNode } from "@/lib/schema";

export const dynamic = "force-dynamic";

interface SeedResult {
  caseId: string;
  nodeId: string;
  artifactV1Id: string;
  artifactV2Id: string;
  traceId: string;
  questionId: string;
  warnings: string[];
}

// ─── OODA trace fixture (mirrors what the agent will eventually produce) ────

const REASONING_STEPS = [
  {
    phase: "tool_use:read",
    content: '{"file_path":"/workspace/skills/bottoms-up-financial-model/SKILL.md"}',
    timestamp: "2026-05-07T19:17:35Z",
  },
  {
    phase: "message",
    content:
      "OBSERVE — The falsifier requires testing whether NPV at 15% is non-negative AND payback period is within 3 years. Need: revenue ramp, capex schedule, gross margin, SG&A, WACC, terminal growth.",
    timestamp: "2026-05-07T19:17:50Z",
  },
  {
    phase: "message",
    content:
      "ORIENT — Picking bottoms-up-financial-model. Rejected: (a) comparable-transactions analog — insufficient public comps in intelligent PDU segment; (b) top-down sizing — too coarse for an IRR test; (c) sensitivity analysis on existing model — no model exists yet to sensitise.",
    timestamp: "2026-05-07T19:18:00Z",
    skill_used: "bottoms-up-financial-model",
  },
  {
    phase: "tool_use:retrieve_documents",
    content: '{"query":"ABB intelligent PDU pricing margin investment","top_k":8}',
    timestamp: "2026-05-07T19:18:10Z",
  },
  {
    phase: "custom_tool_result:retrieve_documents",
    content:
      '{"chunks":[{"source_id":"abb-deck-7","quote":"Target list price $1,290; 28-32% segment margins per 10-K"}],"total_returned":1}',
    timestamp: "2026-05-07T19:18:15Z",
  },
  {
    phase: "tool_use:bash",
    content:
      '{"command":"python /workspace/skills/bottoms-up-financial-model/scripts/build-model.py --inputs inputs.json --output /mnt/session/outputs/model.xlsx"}',
    timestamp: "2026-05-07T19:18:30Z",
  },
  {
    phase: "tool_result",
    content: "Wrote /mnt/session/outputs/model.xlsx",
    timestamp: "2026-05-07T19:18:40Z",
  },
  {
    phase: "tool_use:upload_artifact",
    content:
      '{"filename":"model.xlsx","type":"xlsx","change_reason":"v1 with industry-average margin"}',
    timestamp: "2026-05-07T19:18:45Z",
  },
  {
    phase: "outcome_eval:needs_revision",
    content:
      "Criterion 3 (lineage) flags the gross-margin assumption: the 35% number came from an industry average without an ABB-specific source. Recommend re-modeling with ABB 10-K segment data.",
    timestamp: "2026-05-07T19:19:05Z",
  },
  {
    phase: "message",
    content:
      "SELF-CRITIQUE — The grader is right; my margin assumption is doing too much work. Pulling ABB 10-K segment data via retrieve_documents now.",
    timestamp: "2026-05-07T19:19:10Z",
  },
  {
    phase: "tool_use:retrieve_documents",
    content: '{"query":"ABB 10-K segment margin electrification distribution","top_k":5}',
    timestamp: "2026-05-07T19:19:15Z",
  },
  {
    phase: "custom_tool_result:retrieve_documents",
    content:
      '{"chunks":[{"source_id":"abb-10k-42","quote":"Electrification segment operating margins of 15.4% (2023), 16.2% (2024) trending upward"}]}',
    timestamp: "2026-05-07T19:19:20Z",
  },
  {
    phase: "tool_use:bash",
    content: '{"command":"python build-model.py --inputs inputs-v2.json --output model-v2.xlsx"}',
    timestamp: "2026-05-07T19:19:35Z",
  },
  {
    phase: "tool_use:upload_artifact",
    content:
      '{"filename":"model.xlsx","type":"xlsx","parent_artifact_id":"<v1-id>","change_reason":"Replaced industry-avg margin with ABB 10-K segment data (16.2%)"}',
    timestamp: "2026-05-07T19:19:50Z",
  },
  {
    phase: "tool_use:ask_user",
    content:
      '{"question":"Year-3 channel ramp scenario","type":"open","options":["bear (40% of plan)","base (75%)","bull (95%)"],"needed_because":"Year-3 ramp dominates the NPV; user judgment on channel readiness flips the verdict"}',
    timestamp: "2026-05-07T19:20:05Z",
  },
  {
    phase: "outcome_eval:satisfied",
    content:
      "All five criteria met. Verdict: PASS on IRR (38.13%) but the dominant assumption (year-3 ramp) is escalated to user. Confidence capped at 0.6 by criterion 4 (single-point estimate, no sensitivity yet).",
    timestamp: "2026-05-07T19:20:20Z",
  },
];

const REJECTED_ALTERNATIVES = [
  {
    candidate: "comparable-transactions analog",
    reason: "Insufficient public comps in the intelligent-PDU segment (most acquisitions are private or hidden inside larger deals)",
  },
  {
    candidate: "top-down sizing",
    reason: "Too coarse for an IRR test — gives revenue but not capex / margin / cash-flow timing",
  },
  {
    candidate: "sensitivity-analysis (as primary method)",
    reason: "No existing model to sensitise; would be the right follow-on after this skill produces v2",
  },
];

const OUTCOMES_GRADES = [
  {
    result: "needs_revision",
    iteration: 0,
    explanation:
      "Criterion 3 fails — gross margin used industry average rather than an ABB-specific source.",
  },
  {
    result: "satisfied",
    iteration: 1,
    explanation:
      "All 5 criteria met after retrieving ABB 10-K segment margins and revising the model.",
  },
];

// ─── Seeder ─────────────────────────────────────────────────────────────────

async function findSh42Node(caseId: string): Promise<TreeNode | null> {
  const { data, error } = await insforge.database
    .from("tree_nodes")
    .select("*")
    .eq("case_id", caseId)
    .eq("type", "sub_hypothesis");
  if (error) throw new Error(`tree_nodes query: ${error.message}`);
  const rows = (data as TreeNode[] | null) ?? [];
  // Find by templateId (cleanest); fall back to label match.
  const byTemplate = rows.find(
    (n) => (n.content as HypothesisContent).templateId === "investment-vs-ramp",
  );
  if (byTemplate) return byTemplate;
  return (
    rows.find((n) => /investment.*ramp|payback|irr/i.test(n.label)) ?? null
  );
}

async function dropPriorSeeds(nodeId: string): Promise<void> {
  // Artifacts tagged via metadata.seed.
  const { data: artifacts } = await insforge.database
    .from("artifacts")
    .select("id, metadata")
    .eq("evidence_node_id", nodeId);
  for (const a of (artifacts as Array<{ id: string; metadata: Record<string, unknown> | null }> | null) ??
    []) {
    if (a.metadata && a.metadata.seed === "wedge-demo") {
      await insforge.database.from("artifacts").delete().eq("id", a.id);
    }
  }
  // Reasoning trace by trace_id.
  await insforge.database
    .from("reasoning_traces")
    .delete()
    .eq("trace_id", `seed:wedge-demo:${nodeId}`);
  // user_questions by content match (safe enough — fixture string is unique).
  await insforge.database
    .from("user_questions")
    .delete()
    .contains("affects_node_ids", [nodeId])
    .eq("question", "Year-3 channel ramp scenario");
}

export async function POST() {
  const warnings: string[] = [];

  // 1. Locate the case + node.
  const caseId = await ensureCaseRow("abb-rack-pdu");
  const node = await findSh42Node(caseId);
  if (!node) {
    return NextResponse.json(
      {
        error:
          "No SH4.2 sub_hypothesis found for ABB. Run the V1 orchestrator first to build the tree (start a run from the case page).",
        caseId,
      },
      { status: 400 },
    );
  }

  // 2. Drop any prior seeds.
  await dropPriorSeeds(node.id);

  // 3. Stamp trace_id on the node so scripts/trace.ts can find it.
  await insforge.database
    .from("tree_nodes")
    .update({ trace_id: `seed:wedge-demo:${node.id}`, model_used: "investigator-v2" })
    .eq("id", node.id);

  // 4. Insert v1 artifact.
  const { data: v1Data, error: v1Err } = await insforge.database
    .from("artifacts")
    .insert([
      {
        case_id: caseId,
        evidence_node_id: node.id,
        type: "xlsx",
        uri: "fixtures/sample-financial-model.xlsx",
        version: 1,
        parent_artifact_id: null,
        metadata: {
          seed: "wedge-demo",
          skill_name: "bottoms-up-financial-model",
          change_reason: "Initial draft with industry-average margin (35%)",
          dominant_assumption: "gross_margin_pct",
          confidence_cap_reason: "single-point estimate",
          bytes: 25043,
        },
      },
    ])
    .select("id");
  if (v1Err || !v1Data?.[0]) {
    return NextResponse.json(
      { error: `v1 artifact insert: ${v1Err?.message ?? "no row"}` },
      { status: 500 },
    );
  }
  const artifactV1Id = (v1Data[0] as { id: string }).id;

  // 5. Insert v2 artifact (parent = v1).
  const { data: v2Data, error: v2Err } = await insforge.database
    .from("artifacts")
    .insert([
      {
        case_id: caseId,
        evidence_node_id: node.id,
        type: "xlsx",
        uri: "fixtures/sample-financial-model.xlsx",
        version: 2,
        parent_artifact_id: artifactV1Id,
        metadata: {
          seed: "wedge-demo",
          skill_name: "bottoms-up-financial-model",
          change_reason:
            "Replaced industry-average margin with ABB 10-K segment data: 16.2% (2024) vs the original 35% industry avg",
          dominant_assumption: "year3_revenue_ramp",
          confidence_delta: 0.15,
          bytes: 25043,
          note: "Same fixture file as v1 — diff is in metadata only until STORY-026 ships row-level diffing",
        },
      },
    ])
    .select("id");
  if (v2Err || !v2Data?.[0]) {
    warnings.push(`v2 artifact insert failed: ${v2Err?.message ?? "no row"}`);
  }
  const artifactV2Id = ((v2Data as { id: string }[] | null)?.[0]?.id) ?? "";

  // 6. Reasoning trace.
  const { data: trData, error: trErr } = await insforge.database
    .from("reasoning_traces")
    .insert([
      {
        node_id: node.id,
        agent_type: "investigator",
        managed_agent_session_id: "sesn_seed_wedge_demo",
        trace_id: `seed:wedge-demo:${node.id}`,
        steps: REASONING_STEPS,
        rejected_alternatives: REJECTED_ALTERNATIVES,
        outcomes_grades: OUTCOMES_GRADES,
      },
    ])
    .select("id");
  if (trErr || !trData?.[0]) {
    return NextResponse.json(
      { error: `reasoning_trace insert: ${trErr?.message ?? "no row"}` },
      { status: 500 },
    );
  }
  const traceId = (trData[0] as { id: string }).id;

  // 7. HITL question.
  const { data: qData, error: qErr } = await insforge.database
    .from("user_questions")
    .insert([
      {
        case_id: caseId,
        question: "Year-3 channel ramp scenario",
        question_type: "open",
        options: ["bear (40% of plan)", "base (75% of plan)", "bull (95% of plan)"],
        affects_node_ids: [node.id],
        // Leave answer null so the card shows "open" state for the demo.
      },
    ])
    .select("id");
  if (qErr || !qData?.[0]) {
    warnings.push(`user_questions insert failed: ${qErr?.message ?? "no row"}`);
  }
  const questionId = ((qData as { id: string }[] | null)?.[0]?.id) ?? "";

  // 8. Update the leaf row to show V2 confidence + complete status.
  await insforge.database
    .from("tree_nodes")
    .update({
      confidence: 0.62,
      status: "complete",
      model_used: "investigator-v2",
    })
    .eq("id", node.id);

  const result: SeedResult = {
    caseId,
    nodeId: node.id,
    artifactV1Id,
    artifactV2Id,
    traceId,
    questionId,
    warnings,
  };

  return NextResponse.json(
    {
      ok: true,
      ...result,
      next_steps: [
        "1. Open http://localhost:3000/case/abb-rack-pdu",
        "2. Click the Unit Economics hypothesis (parent of SH4.2)",
        "3. Click the IRR / payback sub-hypothesis",
        "4. Confirm: artifact viewer (4 tabs), version dropdown (v1, v2), reasoning trace (16 steps), open question",
      ],
    },
    { status: 200 },
  );
}
