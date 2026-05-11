// STORY-017 verification: force the Investigator to delegate to the
// Researcher by giving it a falsifier that genuinely requires external
// benchmarks (no answer in the case sources, not a pure computation).
//
// Designed against the Investigator's system-prompt delegation guidance:
// "delegate when the answer requires reading 5+ web pages and synthesising
//  — margin benchmarks, competitor product specs, regulatory thresholds,
//  base rates from comparable situations." Three competitor 10-Ks fits that
// shape exactly.
//
// Run:
//   curl -X POST http://localhost:3000/api/dev/force-delegate-leaf \
//        --max-time 1500
//
// Returns the integration log + DB read-back. Verification is:
// - reasoning_traces has BOTH agent_type='investigator' AND 'researcher' rows
// - the investigator trace has thread_running:agent-victor-researcher events
//   and at least one agent.thread_message_received from the Researcher
// - the researcher trace's steps include researcher_citations with > 0 entries

import { NextResponse } from "next/server";
import { insforge } from "@/lib/db";
import { ensureCaseRow } from "@/lib/case";
import { createInvestigatorSession } from "@/lib/managed-agents-client";
import { persistInvestigatorOutput } from "@/lib/v2-persistence";

export const dynamic = "force-dynamic";
export const maxDuration = 1500;

// Research-shaped falsifier. ABB sources can't answer this — the truth
// lives in Vertiv / Schneider / Eaton 10-K segment disclosures. To make a
// defensible claim, the Investigator must either run many web_search calls
// inline (polluting its context) OR delegate to the Researcher (clean
// compression boundary). Per its system prompt, the latter is preferred.
const RESEARCH_LEAF = {
  claim:
    "Intelligent PDU segment gross margins among incumbent data center vendors exceed 25%, supporting ABB's 25-30% planning assumption",
  displayLabel: "Incumbent margin benchmarks",
  falsifier:
    "Public segment-level margin disclosures from Vertiv, Schneider Electric, and Eaton's most recent 10-K filings or earnings calls show gross margins at or below 22%, undermining the 25-30% planning assumption",
  test: {
    type: "threshold" as const,
    metric: "incumbent_segment_gross_margin",
    target: 0.25,
    horizon: "current fiscal year",
  },
  modeDependence: "agnostic" as const,
  insightAtStake:
    "The 25-30% margin assumption is the load-bearing input to the IRR calculation. If incumbents are materially below that, the IRR test fails before any ABB-specific risk is considered.",
  templateId: "incumbent-benchmark-test",
};

async function createTestRun(caseId: string): Promise<string> {
  const { data, error } = await insforge.database
    .from("runs")
    .insert([{ case_id: caseId, scenario_id: null, status: "running", leaf_runtime: "v2" }])
    .select("id");
  if (error) throw new Error(`createTestRun: ${error.message}`);
  return (data as { id: string }[])[0].id;
}

async function createLeafNode(caseId: string): Promise<string> {
  const { data, error } = await insforge.database
    .from("tree_nodes")
    .insert([
      {
        case_id: caseId,
        parent_id: null,
        type: "sub_hypothesis",
        label: "FORCE-DELEGATE",
        content: RESEARCH_LEAF,
        status: "running",
      },
    ])
    .select("id");
  if (error) throw new Error(`createLeafNode: ${error.message}`);
  return (data as { id: string }[])[0].id;
}

async function fetchDbState(nodeId: string, sessionId: string) {
  const [traceRes, costsRes, escalationsRes] = await Promise.all([
    insforge.database
      .from("reasoning_traces")
      .select(
        "id, agent_type, managed_agent_session_id, trace_id, steps, rejected_alternatives, created_at",
      )
      .eq("node_id", nodeId),
    insforge.database.from("session_costs").select("*").eq("session_id", sessionId),
    insforge.database
      .from("user_questions")
      .select("id, question, question_type, options, created_at")
      .contains("affects_node_ids", [nodeId]),
  ]);
  return {
    traces: (traceRes.data as Array<Record<string, unknown>>) ?? [],
    costs: (costsRes.data as Array<Record<string, unknown>>) ?? [],
    escalations: (escalationsRes.data as Array<Record<string, unknown>>) ?? [],
  };
}

export async function POST() {
  const log: string[] = [];
  const append = (msg: string) => {
    log.push(msg);
    console.log(`[force-delegate] ${msg}`);
  };
  const overall = Date.now();
  try {
    append("━━━ Setup ━━━");
    const caseId = await ensureCaseRow("abb-rack-pdu");
    const runId = await createTestRun(caseId);
    const nodeId = await createLeafNode(caseId);
    const traceId = `${caseId}:${nodeId}`;
    await insforge.database.from("tree_nodes").update({ trace_id: traceId }).eq("id", nodeId);
    append(`case=${caseId} run=${runId} node=${nodeId}`);

    append("━━━ Dispatching research-shaped leaf to Investigator ━━━");
    const dispatchStart = Date.now();
    const output = await createInvestigatorSession({
      traceId,
      hypothesis: { id: nodeId, claim: RESEARCH_LEAF.claim, templateId: RESEARCH_LEAF.templateId },
      falsifier: RESEARCH_LEAF.falsifier,
      threshold: {
        metric: RESEARCH_LEAF.test.metric,
        value: RESEARCH_LEAF.test.target,
      },
      caseContext: {
        caseId,
        runId,
        question:
          "Should ABB pursue the rack PDU business, and if yes, should it be built, acquired, or partnered into?",
        documentIds: [],
        weights: {},
        siblingLeafIds: [],
      },
    });
    const dispatchSecs = ((Date.now() - dispatchStart) / 1000).toFixed(1);
    append(`session completed in ${dispatchSecs}s`);
    append(`session_id: ${output.managedAgentSessionId}`);
    append(`confidence: ${output.confidence}`);
    append(`steps: ${output.reasoningTrace.length}`);

    // Count thread / delegation events in the captured trace — the proof
    // that the Investigator engaged the multi-agent path.
    const phaseCounts: Record<string, number> = {};
    for (const s of output.reasoningTrace) {
      const k = s.phase.split(":")[0];
      phaseCounts[k] = (phaseCounts[k] ?? 0) + 1;
    }
    append(`phase_counts: ${JSON.stringify(phaseCounts)}`);
    const researcherThreadEvents = output.reasoningTrace.filter(
      (s) =>
        s.phase.includes("agent-victor-researcher") ||
        s.phase.startsWith("delegate_"),
    );
    append(`researcher_thread_events: ${researcherThreadEvents.length}`);

    append("━━━ Persisting ━━━");
    await persistInvestigatorOutput(output, {
      runId,
      nodeId,
      traceId,
      modelLabel: process.env.INVESTIGATOR_MODEL ?? "claude-opus-4-7",
    });

    append("━━━ Reading back ━━━");
    const db = await fetchDbState(nodeId, output.managedAgentSessionId);
    append(`reasoning_traces rows: ${db.traces.length}`);
    for (const t of db.traces) {
      const steps = (t.steps as Array<{ phase: string }>) ?? [];
      append(`  - agent=${t.agent_type} session=${t.managed_agent_session_id} steps=${steps.length}`);
    }
    append(`session_costs rows: ${db.costs.length}`);
    append(`user_questions rows: ${db.escalations.length}`);

    return NextResponse.json({
      ok: true,
      elapsed_s: Number(((Date.now() - overall) / 1000).toFixed(1)),
      session_id: output.managedAgentSessionId,
      console_url: `https://console.anthropic.com/managed-agents/sessions/${output.managedAgentSessionId}`,
      summary: {
        confidence: output.confidence,
        evidence_summary: output.evidenceSummary.slice(0, 1500),
        reasoning_steps: output.reasoningTrace.length,
        phase_counts: phaseCounts,
        researcher_thread_events: researcherThreadEvents.length,
        rejected_alternatives: output.rejectedAlternatives,
        artifacts_in_memory: output.artifacts,
        escalations_in_memory: output.escalations,
        usage: output.usage,
      },
      db,
      log,
      ids: { case_id: caseId, run_id: runId, node_id: nodeId, trace_id: traceId },
    });
  } catch (e) {
    return NextResponse.json(
      { ok: false, error: e instanceof Error ? e.message : String(e), stack: e instanceof Error ? e.stack : undefined, log },
      { status: 500 },
    );
  }
}
