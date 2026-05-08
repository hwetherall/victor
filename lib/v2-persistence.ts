// STORY-007: persist Investigator session output to Postgres.
//
// Splits cleanly from lib/managed-agents-client.ts (SDK adapter) and
// lib/investigator-tools.ts (per-session handlers). The orchestrator's
// dispatchV2Leaf calls persistInvestigatorOutput once after
// createInvestigatorSession returns.
//
// Idempotency: reasoning_traces and session_costs both use a delete-then-
// insert pattern keyed on the Anthropic session_id. If this function runs
// twice for the same session (recovery, retry), the end state is the same.

import { insforge } from "./db";
import type { InvestigatorOutput } from "./schema";

// Anthropic Opus 4.7 published per-million-token pricing (USD).
// Approximation: cache_creation pays a 25% premium over base input price.
const PRICE_PER_M = {
  input: 15,
  output: 75,
  cacheCreation: 18.75,
  cacheRead: 1.5,
} as const;

function computeCostUsd(usage: InvestigatorOutput["usage"]): number {
  const cost =
    (usage.inputTokens * PRICE_PER_M.input +
      usage.outputTokens * PRICE_PER_M.output +
      usage.cacheCreationInputTokens * PRICE_PER_M.cacheCreation +
      usage.cacheReadInputTokens * PRICE_PER_M.cacheRead) /
    1_000_000;
  // Round to 4 decimals to match the numeric(10,4) column.
  return Math.round(cost * 10_000) / 10_000;
}

export interface PersistOpts {
  runId: string;
  nodeId: string;
  /** Same trace_id we set on session.title; correlator anchor (STORY-002b). */
  traceId: string;
  /** Model name to record on tree_nodes.model_used. */
  modelLabel?: string;
}

/**
 * Persist a completed Investigator session. Updates the leaf's tree_nodes
 * row, writes the reasoning trace, records cost telemetry. Each step is
 * isolated — a failure in one is logged but does not abort the others, so a
 * partial persist is still useful for debugging via scripts/trace.ts.
 */
export async function persistInvestigatorOutput(
  output: InvestigatorOutput,
  opts: PersistOpts,
): Promise<void> {
  const errors: string[] = [];

  // 1. Update the leaf row — confidence + status + model_used. This is the
  //    one step we DON'T swallow: a silent failure here means rollup reads
  //    stale null confidence and the run completes with a wrong answer
  //    (guardian M1). Telemetry steps below stay log-and-continue.
  const treeUpd = await insforge.database
    .from("tree_nodes")
    .update({
      confidence: output.confidence,
      status: "complete",
      model_used: opts.modelLabel ?? "investigator-v2",
    })
    .eq("id", opts.nodeId);
  if (treeUpd.error) {
    throw new Error(
      `persistInvestigatorOutput: tree_nodes.update for node=${opts.nodeId} failed: ${treeUpd.error.message}`,
    );
  }

  // 2. Reasoning trace. Idempotent via delete-where-session-id then insert.
  //    No unique constraint on managed_agent_session_id (intentional — V2
  //    Researcher sub-sessions write their own rows with the same parent
  //    node), so we scope the delete to (node_id, agent_type, session_id).
  try {
    await insforge.database
      .from("reasoning_traces")
      .delete()
      .eq("node_id", opts.nodeId)
      .eq("agent_type", "investigator")
      .eq("managed_agent_session_id", output.managedAgentSessionId);

    const { error } = await insforge.database.from("reasoning_traces").insert([
      {
        node_id: opts.nodeId,
        agent_type: "investigator",
        managed_agent_session_id: output.managedAgentSessionId,
        trace_id: opts.traceId,
        steps: output.reasoningTrace,
        rejected_alternatives: output.rejectedAlternatives,
        // Persist outcomes grades structured (guardian M2). Empty array if
        // the agent didn't run an outcome — null only when truly missing.
        outcomes_grades: output.outcomesGrades.length > 0 ? output.outcomesGrades : null,
      },
    ]);
    if (error) errors.push(`reasoning_traces.insert: ${error.message}`);
  } catch (e) {
    errors.push(`reasoning_traces.insert threw: ${formatErr(e)}`);
  }

  // 3. Cost telemetry. session_costs PK is session_id, so an insert that
  //    races with a duplicate persist call would conflict — handle with
  //    delete-then-insert just like reasoning_traces.
  try {
    await insforge.database
      .from("session_costs")
      .delete()
      .eq("session_id", output.managedAgentSessionId);

    const { error } = await insforge.database.from("session_costs").insert([
      {
        session_id: output.managedAgentSessionId,
        parent_session_id: null, // Investigator is top-level for this leaf
        run_id: opts.runId,
        node_id: opts.nodeId,
        agent_type: "investigator",
        model: opts.modelLabel ?? "claude-opus-4-7",
        input_tokens: output.usage.inputTokens,
        output_tokens: output.usage.outputTokens,
        cached_tokens: output.usage.cacheReadInputTokens,
        cost_usd: computeCostUsd(output.usage),
      },
    ]);
    if (error) errors.push(`session_costs.insert: ${error.message}`);
  } catch (e) {
    errors.push(`session_costs.insert threw: ${formatErr(e)}`);
  }

  if (errors.length) {
    console.warn(
      `[v2] persistInvestigatorOutput partial failure for node=${opts.nodeId} ` +
        `session=${output.managedAgentSessionId}:\n  ${errors.join("\n  ")}`,
    );
  }
}

function formatErr(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
}
