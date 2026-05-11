// STORY-010 integration test, packaged as a one-shot dev API route.
//
// The standalone scripts/integration-sh42.ts hit a packaging issue: the
// InsForge SDK's CJS build does require("@insforge/shared-schemas") but
// shared-schemas only exposes an "import" condition in its package.json
// exports. Under tsx → Node ESM resolver, that fails with
// ERR_PACKAGE_PATH_NOT_EXPORTED. Next.js's bundler handles the interop
// transparently, so we run the same logic from a route handler instead.
//
// Run:
//   1. npm run dev         (Next dev server)
//   2. curl -X POST http://localhost:3000/api/dev/integration-sh42 \
//          --max-time 1500
//
// Returns JSON with the full integration log + DB read-back. Cost is one
// Opus session ~$1-9 + skill loading.

import { NextResponse } from "next/server";
import { insforge } from "@/lib/db";
import { ensureCaseRow } from "@/lib/case";
import { createInvestigatorSession } from "@/lib/managed-agents-client";
import { persistInvestigatorOutput } from "@/lib/v2-persistence";

export const dynamic = "force-dynamic";
// Allow up to 25 min for one Opus session with skill loading.
export const maxDuration = 1500;

const SH42_CONTENT = {
  claim: "Investment required vs revenue ramp clears 15% IRR hurdle",
  displayLabel: "IRR and payback",
  falsifier: "NPV at 15% is negative or payback period exceeds 3 years",
  test: {
    type: "threshold" as const,
    metric: "npv_at_hurdle",
    target: 0,
    horizon: "3 years",
  },
  modeDependence: "mode-conditional" as const,
  insightAtStake:
    "If false, ROI does not justify capital allocation under any entry mode",
  templateId: "investment-vs-ramp",
};

async function createTestRun(caseId: string): Promise<string> {
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
  if (error) throw new Error(`createTestRun: ${error.message}`);
  const id = (data as { id: string }[] | null)?.[0]?.id;
  if (!id) throw new Error("createTestRun: no row returned");
  return id;
}

async function createSh42Node(caseId: string): Promise<string> {
  const { data, error } = await insforge.database
    .from("tree_nodes")
    .insert([
      {
        case_id: caseId,
        parent_id: null,
        type: "sub_hypothesis",
        label: "SH4.2",
        content: SH42_CONTENT,
        status: "running",
      },
    ])
    .select("id");
  if (error) throw new Error(`createSh42Node: ${error.message}`);
  const id = (data as { id: string }[] | null)?.[0]?.id;
  if (!id) throw new Error("createSh42Node: no row returned");
  return id;
}

async function stampTraceId(nodeId: string, traceId: string) {
  await insforge.database
    .from("tree_nodes")
    .update({ trace_id: traceId })
    .eq("id", nodeId);
}

async function fetchDbState(nodeId: string, sessionId: string) {
  const [artifactsRes, traceRes, costsRes, escalationsRes] = await Promise.all([
    insforge.database
      .from("artifacts")
      .select("id, type, uri, version, parent_artifact_id, metadata, created_at")
      .eq("evidence_node_id", nodeId),
    insforge.database
      .from("reasoning_traces")
      .select(
        "id, agent_type, managed_agent_session_id, trace_id, steps, rejected_alternatives, created_at",
      )
      .eq("node_id", nodeId),
    insforge.database
      .from("session_costs")
      .select("*")
      .eq("session_id", sessionId),
    insforge.database
      .from("user_questions")
      .select("id, question, question_type, options, created_at")
      .contains("affects_node_ids", [nodeId]),
  ]);
  return {
    artifacts: (artifactsRes.data as Array<Record<string, unknown>>) ?? [],
    traces: (traceRes.data as Array<Record<string, unknown>>) ?? [],
    costs: (costsRes.data as Array<Record<string, unknown>>) ?? [],
    escalations: (escalationsRes.data as Array<Record<string, unknown>>) ?? [],
  };
}

export async function POST() {
  const log: string[] = [];
  const append = (msg: string) => {
    log.push(msg);
    console.log(`[integration-sh42] ${msg}`);
  };

  const overall = Date.now();
  try {
    append("━━━ Setup ━━━");
    const caseId = await ensureCaseRow("abb-rack-pdu");
    append(`case_id:  ${caseId}`);
    const runId = await createTestRun(caseId);
    append(`run_id:   ${runId}`);
    const nodeId = await createSh42Node(caseId);
    append(`node_id:  ${nodeId}`);
    const traceId = `${caseId}:${nodeId}`;
    await stampTraceId(nodeId, traceId);
    append(`trace_id: ${traceId}`);

    append("━━━ Dispatching SH4.2 to Investigator ━━━");
    const dispatchStart = Date.now();
    const output = await createInvestigatorSession({
      traceId,
      hypothesis: {
        id: nodeId,
        claim: SH42_CONTENT.claim,
        templateId: SH42_CONTENT.templateId,
      },
      falsifier: SH42_CONTENT.falsifier,
      threshold: {
        metric: SH42_CONTENT.test.metric,
        value: SH42_CONTENT.test.target,
      },
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
    const dispatchSecs = ((Date.now() - dispatchStart) / 1000).toFixed(1);
    append(`session completed in ${dispatchSecs}s`);
    append(`session_id:        ${output.managedAgentSessionId}`);
    append(`confidence:        ${output.confidence}`);
    append(`reasoning_steps:   ${output.reasoningTrace.length}`);
    append(`artifacts (mem):   ${output.artifacts.length}`);
    append(`escalations(mem):  ${output.escalations.length}`);
    append(
      `usage: input=${output.usage.inputTokens} cache_read=${output.usage.cacheReadInputTokens} ` +
        `cache_create=${output.usage.cacheCreationInputTokens} output=${output.usage.outputTokens}`,
    );

    append("━━━ Persisting to Postgres ━━━");
    await persistInvestigatorOutput(output, {
      runId,
      nodeId,
      traceId,
      modelLabel: process.env.INVESTIGATOR_MODEL ?? "claude-opus-4-7",
    });

    append("━━━ Reading back ━━━");
    const db = await fetchDbState(nodeId, output.managedAgentSessionId);
    append(`artifacts rows:        ${db.artifacts.length}`);
    append(`reasoning_traces rows: ${db.traces.length}`);
    append(`session_costs rows:    ${db.costs.length}`);
    append(`user_questions rows:   ${db.escalations.length}`);

    const elapsed = ((Date.now() - overall) / 1000).toFixed(1);
    return NextResponse.json({
      ok: true,
      elapsed_s: Number(elapsed),
      session_id: output.managedAgentSessionId,
      console_url: `https://console.anthropic.com/managed-agents/sessions/${output.managedAgentSessionId}`,
      output_summary: {
        confidence: output.confidence,
        evidence_summary: output.evidenceSummary.slice(0, 1200),
        reasoning_steps: output.reasoningTrace.length,
        rejected_alternatives: output.rejectedAlternatives,
        artifacts_in_memory: output.artifacts,
        escalations_in_memory: output.escalations,
        usage: output.usage,
      },
      db,
      log,
      cleanup_sql: [
        `delete from tree_nodes where id = '${nodeId}';`,
        `delete from runs where id = '${runId}';`,
        "-- artifacts, reasoning_traces, session_costs cascade via FK",
      ],
      ids: { case_id: caseId, run_id: runId, node_id: nodeId, trace_id: traceId },
    });
  } catch (e) {
    return NextResponse.json(
      {
        ok: false,
        error: e instanceof Error ? e.message : String(e),
        stack: e instanceof Error ? e.stack : undefined,
        log,
      },
      { status: 500 },
    );
  }
}
