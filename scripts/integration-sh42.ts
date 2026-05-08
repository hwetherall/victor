// STORY-010: end-to-end integration test for SH4.2 with the bottoms-up
// skill loaded. Sets up a real case + run + tree_node so the V2 tool
// handlers (FK checks, storage upload) hit live tables, then dispatches
// the Investigator and prints what landed.
//
// Run: npx tsx scripts/integration-sh42.ts
// Needs:
//   - ANTHROPIC_API_KEY, INVESTIGATOR_AGENT_ID, MANAGED_AGENTS_ENVIRONMENT_ID
//   - InsForge `artifacts` bucket created in the dashboard
//
// Cost: one Opus session ~$1-9 + skill loading. Same order as the STORY-005
// smoke. The leaf row is left in the DB after the run for inspection;
// cleanup SQL is printed at the end.

import { config as loadEnv } from "dotenv";
loadEnv({ path: ".env.local" });

import { insforge } from "../lib/db";
import { ensureCaseRow } from "../lib/case";
import { createInvestigatorSession } from "../lib/managed-agents-client";
import { persistInvestigatorOutput } from "../lib/v2-persistence";

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
        parent_id: null, // bypassing the parent hierarchy for this isolated test
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
  const { error } = await insforge.database
    .from("tree_nodes")
    .update({ trace_id: traceId })
    .eq("id", nodeId);
  if (error) console.warn(`stampTraceId: ${error.message}`);
}

async function fetchArtifacts(nodeId: string) {
  const { data, error } = await insforge.database
    .from("artifacts")
    .select("id, type, uri, version, parent_artifact_id, metadata, created_at")
    .eq("evidence_node_id", nodeId);
  if (error) console.warn(`fetchArtifacts: ${error.message}`);
  return (data as Array<Record<string, unknown>>) ?? [];
}

async function fetchTrace(nodeId: string) {
  const { data, error } = await insforge.database
    .from("reasoning_traces")
    .select(
      "id, agent_type, managed_agent_session_id, trace_id, steps, rejected_alternatives, created_at",
    )
    .eq("node_id", nodeId);
  if (error) console.warn(`fetchTrace: ${error.message}`);
  return (data as Array<Record<string, unknown>>) ?? [];
}

async function fetchSessionCost(sessionId: string) {
  const { data, error } = await insforge.database
    .from("session_costs")
    .select("*")
    .eq("session_id", sessionId);
  if (error) console.warn(`fetchSessionCost: ${error.message}`);
  return (data as Array<Record<string, unknown>>) ?? [];
}

async function fetchEscalations(nodeId: string) {
  const { data, error } = await insforge.database
    .from("user_questions")
    .select("id, question, question_type, options, created_at")
    .contains("affects_node_ids", [nodeId]);
  if (error) console.warn(`fetchEscalations: ${error.message}`);
  return (data as Array<Record<string, unknown>>) ?? [];
}

async function main() {
  const overall = Date.now();
  console.log(`Integration SH4.2 start at ${new Date().toISOString()}`);

  // 1. Setup ─────────────────────────────────────────────────────────────────
  console.log("\n━━━ Setup ━━━");
  const caseId = await ensureCaseRow("abb-rack-pdu");
  console.log(`  case_id:  ${caseId}`);
  const runId = await createTestRun(caseId);
  console.log(`  run_id:   ${runId}`);
  const nodeId = await createSh42Node(caseId);
  console.log(`  node_id:  ${nodeId}`);
  const traceId = `${caseId}:${nodeId}`;
  await stampTraceId(nodeId, traceId);
  console.log(`  trace_id: ${traceId}`);

  // 2. Dispatch ──────────────────────────────────────────────────────────────
  console.log("\n━━━ Dispatching SH4.2 to Investigator ━━━");
  console.log("  (this will run for several minutes — Opus session with skill loaded)");
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
  console.log(`  ✓ session completed in ${dispatchSecs}s`);
  console.log(`    session_id:        ${output.managedAgentSessionId}`);
  console.log(`    confidence:        ${output.confidence}`);
  console.log(`    reasoning_steps:   ${output.reasoningTrace.length}`);
  console.log(`    artifacts (mem):   ${output.artifacts.length}`);
  console.log(`    escalations(mem):  ${output.escalations.length}`);
  console.log(
    `    usage:             input=${output.usage.inputTokens} ` +
      `cache_read=${output.usage.cacheReadInputTokens} ` +
      `cache_create=${output.usage.cacheCreationInputTokens} ` +
      `output=${output.usage.outputTokens}`,
  );

  // 3. Persist ───────────────────────────────────────────────────────────────
  console.log("\n━━━ Persisting to Postgres ━━━");
  await persistInvestigatorOutput(output, { runId, nodeId, traceId });

  // 4. Verify ────────────────────────────────────────────────────────────────
  console.log("\n━━━ Reading back from Postgres ━━━");
  const [artifacts, traces, costs, escalations] = await Promise.all([
    fetchArtifacts(nodeId),
    fetchTrace(nodeId),
    fetchSessionCost(output.managedAgentSessionId),
    fetchEscalations(nodeId),
  ]);

  console.log(`  artifacts rows:        ${artifacts.length}`);
  for (const a of artifacts) {
    const meta = (a.metadata as Record<string, unknown> | null) ?? {};
    console.log(
      `    - ${a.id} type=${a.type} v${a.version} bytes=${meta.bytes ?? "?"} ` +
        `parent=${a.parent_artifact_id ?? "null"} uri=${a.uri}`,
    );
  }
  console.log(`  reasoning_traces rows: ${traces.length}`);
  for (const t of traces) {
    const steps = (t.steps as Array<unknown>) ?? [];
    const rej = (t.rejected_alternatives as Array<unknown>) ?? [];
    console.log(
      `    - ${t.id} agent=${t.agent_type} steps=${steps.length} ` +
        `rejected_alts=${rej.length} session=${t.managed_agent_session_id}`,
    );
  }
  console.log(`  session_costs rows:    ${costs.length}`);
  for (const c of costs) {
    console.log(
      `    - ${c.session_id} model=${c.model} ` +
        `tokens=in:${c.input_tokens}+cache:${c.cached_tokens}/out:${c.output_tokens} ` +
        `cost=$${c.cost_usd}`,
    );
  }
  console.log(`  user_questions rows:   ${escalations.length}`);
  for (const e of escalations) {
    console.log(`    - ${e.id} type=${e.question_type} q="${(e.question as string)?.slice(0, 80)}..."`);
  }

  // 5. Summary ───────────────────────────────────────────────────────────────
  const elapsed = ((Date.now() - overall) / 1000).toFixed(1);
  console.log(`\n━━━ Done in ${elapsed}s ━━━`);
  console.log(
    `  Anthropic Console: https://console.anthropic.com/managed-agents/sessions/${output.managedAgentSessionId}`,
  );
  console.log("\nTo inspect, run:");
  console.log(`  npx tsx scripts/trace.ts ${traceId}`);
  console.log("\nTo clean up the test rows:");
  console.log(`  delete from tree_nodes where id = '${nodeId}';`);
  console.log(`  delete from runs where id = '${runId}';`);
  console.log("  -- (case row left intact; reusable across runs)");
}

main().catch((e) => {
  console.error("✗ integration-sh42 failed:", e instanceof Error ? e.message : e);
  if (e instanceof Error && e.stack) console.error(e.stack);
  process.exit(1);
});
