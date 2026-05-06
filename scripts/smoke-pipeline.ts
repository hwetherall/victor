// End-to-end smoke: runs the full orchestrator against the ABB case with stub
// evidence. Exercises every DB op (cases insert, tree_nodes insert/update/delete,
// runs insert/update) and every LLM agent (evaluator × 11, optionally Tier 2,
// decision). Cost ~$0.08, time 1-2 min.
//
// Run: npx tsx --conditions=import scripts/smoke-pipeline.ts

import { config as loadEnv } from "dotenv";
loadEnv({ path: ".env.local" });

import type { TreeNode } from "../lib/schema";

async function main() {
  const [{ runCase }, { insforge }] = await Promise.all([
    import("../agents/orchestrator"),
    import("../lib/db"),
  ]);

  console.log("─── Pipeline smoke: abb-rack-pdu ───");
  const t0 = Date.now();

  const result = await runCase("abb-rack-pdu");
  const elapsed = Date.now() - t0;

  console.log(`run ${result.runId} → ${result.status} (${elapsed}ms)`);
  if (result.error) console.log(`  error: ${result.error}`);

  // Pull the decision node + a count of every node type to sanity-check tree shape.
  const { data: nodeRows } = await insforge.database
    .from("tree_nodes")
    .select("*")
    .eq("case_id", result.caseId);
  const nodes = (nodeRows as TreeNode[] | null) ?? [];

  const counts = nodes.reduce<Record<string, number>>((acc, n) => {
    acc[n.type] = (acc[n.type] ?? 0) + 1;
    return acc;
  }, {});
  console.log("\nTree shape:");
  for (const [k, v] of Object.entries(counts)) {
    console.log(`  ${k.padEnd(16)} ${v}`);
  }

  const decision = nodes.find((n) => n.type === "decision");
  if (decision && decision.type === "decision") {
    console.log("\nDecision:");
    console.log(`  confidence: ${decision.confidence}`);
    console.log(`  finalDecision: ${decision.content.finalDecision}`);
    console.log(`  weakest link: ${decision.content.weakestLinkNodeId}`);
  }

  const hyps = nodes.filter((n) => n.type === "hypothesis");
  console.log("\nHypotheses (rolled up):");
  for (const h of hyps) {
    console.log(
      `  [${h.confidence?.toFixed(3) ?? "—"} × w=${h.weight ?? "—"}] ${h.label}`,
    );
  }
}

main().catch((e) => {
  console.error("✗ pipeline smoke failed:", e);
  process.exit(1);
});
