// SPEC §6.8 — Run Orchestrator. Wires the full pipeline.
// Path: parseBrief → bindFramework → buildTree → fanout(web + doc evidence)
// → evaluate(sub-hypotheses) → rollup → decide (with optional Tier 2).

import { insforge } from "@/lib/db";
import { ensureCaseRow } from "@/lib/case";
import { loadCase } from "@/lib/framework-registry";
import type { TreeNode } from "@/lib/schema";
import { parseBrief } from "./brief-parser";
import { bindFramework } from "./framework-binder";
import { buildTree } from "./tree-builder";
import { evaluateHypothesis } from "./evaluator";
import { rollupConfidence } from "./rollup";
import { decide } from "./decision";
import { gatherWebEvidence, type CaseContext } from "./evidence/web-search";
import { gatherDocEvidence } from "./evidence/doc-retrieval";

export interface RunResult {
  runId: string;
  caseId: string;
  status: "complete" | "failed";
  error?: string;
  durationMs: number;
}

export interface StartRunResult {
  runId: string;
  caseId: string;
}

/**
 * Two-phase entry point used by the HTTP route.
 *  1. Synchronously creates the case row (if missing) and the run row, so the
 *     caller can return a runId to the client immediately.
 *  2. Detaches the pipeline as a background Promise (the caller may await it
 *     in tests or ignore it in HTTP).
 */
export async function startRun(
  caseConfigId: string,
  scenarioId: string | null = null,
): Promise<{ ids: StartRunResult; pipeline: Promise<RunResult> }> {
  const dbCaseId = await ensureCaseRow(caseConfigId);
  const runId = await createRunRow(dbCaseId, scenarioId);
  const pipeline = executeRun(runId, dbCaseId, caseConfigId, scenarioId);
  return { ids: { runId, caseId: dbCaseId }, pipeline };
}

/**
 * Convenience: full synchronous run (creates IDs and awaits the pipeline).
 * Useful for tests and the /scripts entrypoint.
 */
export async function runCase(
  caseConfigId: string,
  scenarioId: string | null = null,
): Promise<RunResult> {
  const { pipeline } = await startRun(caseConfigId, scenarioId);
  return pipeline;
}

async function executeRun(
  runId: string,
  dbCaseId: string,
  caseConfigId: string,
  scenarioId: string | null,
): Promise<RunResult> {
  const start = Date.now();
  try {
    await updateRunStatus(runId, "running");

    // Reset any existing tree for this case+scenario so the run is idempotent.
    await clearTreeNodes(dbCaseId, scenarioId);

    // Stages 1–3: parse → bind → build.
    await parseBrief(caseConfigId);
    const binding = await bindFramework(caseConfigId);
    const caseConfig = loadCase(caseConfigId);
    const tree = await buildTree(dbCaseId, binding, caseConfig.weights);

    // Stage 4: real evidence fanout. For each sub-hypothesis leaf, run web
    // search + doc retrieval in parallel. Promise.allSettled per SPEC §12
    // failure-mode prevention — one agent failure must not crash the run.
    const subs = tree.filter((n) => n.type === "sub_hypothesis");
    const ctx: CaseContext = {
      caseId: dbCaseId,
      caseTitle: caseConfig.title,
      caseQuestion: caseConfig.question,
      substitutions: caseConfig.substitutions,
    };
    await Promise.allSettled(
      subs.flatMap((s) => [
        gatherWebEvidence(s, ctx),
        gatherDocEvidence(s, ctx),
      ]),
    );

    // Stage 5: evaluate every sub-hypothesis in parallel. Promise.allSettled
    // per SPEC §12 failure-mode prevention — one evaluator failure must not
    // crash the whole run.
    const evalResults = await Promise.allSettled(
      subs.map((s) => evaluateHypothesis(s.id)),
    );
    for (let i = 0; i < evalResults.length; i++) {
      if (evalResults[i].status === "rejected") {
        const reason = (evalResults[i] as PromiseRejectedResult).reason;
        await markNodeFailed(
          subs[i].id,
          reason instanceof Error ? reason.message : String(reason),
        );
      }
    }

    // Stage 6: refetch tree, roll up to hypothesis + decision level.
    const refreshed = await fetchTree(dbCaseId);
    const caseWeightsBySlot = mapCaseWeightsToSlots(caseConfig.weights);
    const rollup = rollupConfidence(refreshed, caseWeightsBySlot);

    // Stage 7: persist hypothesis-level confidences.
    await persistHypothesisRollup(rollup.tree);

    // Stage 8: decision agent (Opus). Conditionally invokes Tier 2 inside.
    await decide(dbCaseId, caseConfigId, {
      rolledConfidence: rollup.decisionConfidence,
      weakestLinkNodeId: rollup.weakestLinkNodeId,
    });

    await updateRunStatus(runId, "complete");
    return {
      runId,
      caseId: dbCaseId,
      status: "complete",
      durationMs: Date.now() - start,
    };
  } catch (e) {
    const message = e instanceof Error ? e.message : String(e);
    await updateRunStatus(runId, "failed", message);
    return {
      runId,
      caseId: dbCaseId,
      status: "failed",
      error: message,
      durationMs: Date.now() - start,
    };
  }
}

// ─── Run lifecycle ───────────────────────────────────────────────────────────
// (ensureCaseRow lives in lib/case.ts so the ingest route can share it.)

async function createRunRow(
  dbCaseId: string,
  scenarioId: string | null,
): Promise<string> {
  const { data, error } = await insforge.database
    .from("runs")
    .insert([{ case_id: dbCaseId, scenario_id: scenarioId, status: "pending" }])
    .select();
  if (error) throw new Error(`createRun: ${error.message}`);
  const row = (data as { id: string }[] | null)?.[0];
  if (!row) throw new Error("createRun: insert returned no row");
  return row.id;
}

async function updateRunStatus(
  runId: string,
  status: "running" | "complete" | "failed",
  error?: string,
) {
  const patch: Record<string, unknown> = { status };
  if (status === "complete" || status === "failed") {
    patch.completed_at = new Date().toISOString();
  }
  if (error) patch.error = error;
  const { error: updErr } = await insforge.database
    .from("runs")
    .update(patch)
    .eq("id", runId);
  if (updErr) throw new Error(`updateRunStatus: ${updErr.message}`);
}

async function clearTreeNodes(
  dbCaseId: string,
  scenarioId: string | null,
): Promise<void> {
  const builder = insforge.database
    .from("tree_nodes")
    .delete()
    .eq("case_id", dbCaseId);
  const filtered =
    scenarioId === null ? builder.is("scenario_id", null) : builder.eq("scenario_id", scenarioId);
  const { error } = await filtered;
  if (error) throw new Error(`clearTreeNodes: ${error.message}`);
}

// ─── Tree fetch + rollup persistence ─────────────────────────────────────────

async function fetchTree(dbCaseId: string): Promise<TreeNode[]> {
  const { data, error } = await insforge.database
    .from("tree_nodes")
    .select("*")
    .eq("case_id", dbCaseId);
  if (error) throw new Error(`fetchTree: ${error.message}`);
  return (data as TreeNode[] | null) ?? [];
}

async function persistHypothesisRollup(tree: TreeNode[]): Promise<void> {
  const hypotheses = tree.filter((n) => n.type === "hypothesis");
  await Promise.all(
    hypotheses.map(async (h) => {
      const { error } = await insforge.database
        .from("tree_nodes")
        .update({
          confidence: h.confidence,
          status: "complete",
        })
        .eq("id", h.id);
      if (error) {
        throw new Error(`persistHypothesisRollup: ${error.message}`);
      }
    }),
  );
}

async function markNodeFailed(nodeId: string, reason: string): Promise<void> {
  await insforge.database
    .from("tree_nodes")
    .update({ status: "failed" })
    .eq("id", nodeId);
  // We log the reason to console rather than persist it (no error column on
  // tree_nodes); the run row gets the failure message if it bubbles up.
  console.warn(`tree_node ${nodeId} marked failed: ${reason}`);
}

// ─── Case-level weight key → framework slot id mapping ───────────────────────

const CASE_WEIGHT_TO_SLOT: Record<string, string> = {
  marketSize: "market-attractive",
  strategicFit: "can-win",
  timeToMarket: "can-reach",
  roi: "financials-clear",
  techResilience: "tech-resilient",
};

function mapCaseWeightsToSlots(
  caseWeights: Record<string, number>,
): Record<string, number> {
  const out: Record<string, number> = {};
  for (const [k, v] of Object.entries(caseWeights)) {
    const slotId = CASE_WEIGHT_TO_SLOT[k];
    if (slotId) out[slotId] = v;
  }
  return out;
}

export const __test = { mapCaseWeightsToSlots, CASE_WEIGHT_TO_SLOT };
