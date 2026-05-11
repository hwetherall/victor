// SPEC §6.8 — Run Orchestrator. Wires the full pipeline.
// Path: parseBrief → bindFramework → buildTree → fanout(web + doc evidence)
// → evaluate(sub-hypotheses) → rollup → decide (with optional Tier 2).

import { insforge } from "@/lib/db";
import { ensureCaseRow } from "@/lib/case";
import { loadCase } from "@/lib/framework-registry";
import type { LeafRuntime, TreeNode } from "@/lib/schema";
import { createInvestigatorSession } from "@/lib/managed-agents-client";
import { persistInvestigatorOutput } from "@/lib/v2-persistence";
import { parseBrief } from "./brief-parser";
import { bindFramework } from "./framework-binder";
import { buildTree } from "./tree-builder";
import { evaluateHypothesis } from "./evaluator";
import { rollupConfidence } from "./rollup";
import { decide } from "./decision";
import { gatherWebEvidence, type CaseContext } from "./evidence/web-search";
import { gatherDocEvidence } from "./evidence/doc-retrieval";
import { runContrarianPass } from "./contrarian";

/** Read the V1/V2 leaf-runtime flag (STORY-003). Defaults to 'v1' so any
 *  forgotten / typo'd env value preserves the V1 demo. */
function readLeafRuntime(): LeafRuntime {
  return process.env.LEAF_RUNTIME === "v2" ? "v2" : "v1";
}

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
    // Case yaml keys are now slot ids directly (improve.md §4 Option A).
    const caseWeightsBySlot = caseConfig.weights;
    const tree = await buildTree(dbCaseId, binding, caseWeightsBySlot);

    // Stage 4: real evidence fanout. For each sub-hypothesis leaf, run web
    // search + doc retrieval in parallel. Promise.allSettled per SPEC §12
    // failure-mode prevention — one agent failure must not crash the run.
    const subs = tree.filter((n) => n.type === "sub_hypothesis");
    const ctx: CaseContext = {
      caseId: dbCaseId,
      caseTitle: caseConfig.title,
      caseQuestion: caseConfig.question,
      frameworkId: caseConfig.frameworkId,
      substitutions: caseConfig.substitutions,
    };

    const leafRuntime = readLeafRuntime();
    if (leafRuntime === "v1") {
      await Promise.allSettled(
        subs.flatMap((s) => [
          gatherWebEvidence(s, ctx),
          gatherDocEvidence(s, ctx),
        ]),
      );
    } else {
      // STORY-003: V2 leaf runtime. Each sub-hypothesis is one Investigator
      // session. STORY-002 ships stubs that throw "not implemented"; per
      // acceptance criteria the orchestrator logs the error per leaf, marks
      // the leaf failed, and continues. Real implementation lands in
      // STORY-005-008.
      const allLeafIds = subs.map((s) => s.id);
      const v2Results = await Promise.allSettled(
        subs.map((s) =>
          dispatchV2Leaf(s, ctx, runId, allLeafIds.filter((id) => id !== s.id)),
        ),
      );
      for (let i = 0; i < v2Results.length; i++) {
        if (v2Results[i].status === "rejected") {
          const reason = (v2Results[i] as PromiseRejectedResult).reason;
          const message = reason instanceof Error ? reason.message : String(reason);
          console.warn(`[v2] leaf ${subs[i].id} failed: ${message}`);
          await markNodeFailed(subs[i].id, message);
        }
      }
    }

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
    const rollup = rollupConfidence(refreshed, caseWeightsBySlot);

    // Stage 7: persist hypothesis-level confidences.
    await persistHypothesisRollup(rollup.tree);

    // Stage 7.5: contrarian / red-team pass on top-2 hypotheses. Adds
    // `supports='against'` evidence rows. Failures are isolated — they must
    // never block the run.
    try {
      await runContrarianPass(
        dbCaseId,
        rollup.tree.filter((n) => n.type === "hypothesis"),
      );
    } catch (e) {
      console.warn(
        `contrarian pass failed (continuing): ${e instanceof Error ? e.message : e}`,
      );
    }

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
  const leafRuntime = readLeafRuntime();
  const { data, error } = await insforge.database
    .from("runs")
    .insert([
      {
        case_id: dbCaseId,
        scenario_id: scenarioId,
        status: "pending",
        leaf_runtime: leafRuntime,
      },
    ])
    .select();
  if (error) throw new Error(`createRun: ${error.message}`);
  const row = (data as { id: string }[] | null)?.[0];
  if (!row) throw new Error("createRun: insert returned no row");
  return row.id;
}

// ─── V2 leaf dispatch (STORY-003) ────────────────────────────────────────────
//
// STORY-003 wires the call site only. createInvestigatorSession is a stub at
// this stage; the input mapping below is intentionally minimal and placeholder
// — real shape is fleshed out in STORY-005-008 once the Investigator agent is
// registered and tool bindings exist.

async function dispatchV2Leaf(
  sub: TreeNode,
  ctx: CaseContext,
  runId: string,
  siblingLeafIds: string[],
): Promise<void> {
  if (sub.type !== "sub_hypothesis" && sub.type !== "hypothesis") {
    throw new Error(`dispatchV2Leaf: unexpected node type ${sub.type}`);
  }
  const content = sub.content;
  const traceId = `${sub.case_id}:${sub.id}`;

  // Stamp trace_id on the node BEFORE dispatch so scripts/trace.ts can find
  // in-flight leaves. STORY-007/008 will write the rest of the result back;
  // this minimal pre-write is just the correlator anchor.
  await stampTraceId(sub.id, traceId);

  const output = await createInvestigatorSession({
    traceId,
    hypothesis: {
      id: sub.id,
      claim: content.claim,
      templateId: content.templateId ?? "",
    },
    falsifier: content.falsifier,
    threshold: {
      metric: content.test.metric,
      value: content.test.target,
    },
    caseContext: {
      caseId: sub.case_id,
      runId,
      question: ctx.caseQuestion,
      // documentIds left empty by default — retrieve_documents falls back to
      // case-wide pgvector search, which is what we want for the demo. If a
      // future skill needs to scope to specific sources, populate this from
      // ctx or a new param.
      documentIds: [],
      weights: {},
      siblingLeafIds,
    },
  });

  // STORY-007: persist the full output. Cost telemetry, reasoning trace,
  // tree_nodes confidence/status all written here. Failures are logged but
  // don't propagate — the Investigator did its work and the run continues.
  // The model label drives cost-telemetry pricing in v2-persistence; INVESTIGATOR_MODEL
  // mirrors what register-investigator.ts read at registration time.
  await persistInvestigatorOutput(output, {
    runId,
    nodeId: sub.id,
    traceId,
    modelLabel: process.env.INVESTIGATOR_MODEL ?? "claude-opus-4-7",
  });
  console.log(
    `[v2] leaf ${sub.id} → session=${output.managedAgentSessionId} ` +
      `confidence=${output.confidence} artifacts=${output.artifacts.length} ` +
      `escalations=${output.escalations.length} ` +
      `tokens=in:${output.usage.inputTokens}+cache:${output.usage.cacheReadInputTokens} ` +
      `out:${output.usage.outputTokens}`,
  );
}

async function stampTraceId(nodeId: string, traceId: string): Promise<void> {
  const { error } = await insforge.database
    .from("tree_nodes")
    .update({ trace_id: traceId })
    .eq("id", nodeId);
  if (error) {
    // Non-fatal — the dispatch can proceed without the correlator anchor;
    // we just lose scripts/trace.ts visibility for this leaf.
    console.warn(`stampTraceId(${nodeId}): ${error.message}`);
  }
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

