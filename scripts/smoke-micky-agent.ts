import { strict as assert } from "node:assert";
import { config as loadEnv } from "dotenv";
import { loadCase } from "../lib/framework-registry";
import type { Case, Run } from "../lib/schema";

loadEnv({ path: ".env.local" });

const BANNED = ["delve", "tapestry", "robust", "comprehensive", "multifaceted"];

async function main() {
  const [{ runMicky }] = await Promise.all([import("../agents/micky")]);
  const runId = process.argv[2] ?? (await latestCompleteRunId("abb-rack-pdu"));
  const output = await runMicky(runId, "abb-rack-pdu");

  assert(output.reframe, "ABB case should produce a non-null reframe");
  assert(
    !/^pre-decision diligence question\s*:/i.test(output.reframe.headline),
    "reframe should not be a restated question header",
  );
  assert(
    /financial case|not built|cannot|can't|not answerable|premature|downstream/i.test(
      `${output.reframe.headline} ${output.reframe.reasoning}`,
    ),
    "reframe should challenge the enter/how assumption",
  );
  assert(output.recommendation.oneLiner.trim().length > 0);
  assert.equal(output.hypothesisRanking.length, 5);
  for (const entry of output.hypothesisRanking) {
    assert(entry.hypothesisId.trim().length > 0);
    assert(entry.hypothesisLabel.trim().length > 0);
    assert(
      entry.hypothesisLabel.length <= 60,
      `ranking label should be short: ${entry.hypothesisLabel}`,
    );
    assert(
      !/\$50M annual revenue|IRR hurdle|credible path|within 2028|threshold/i.test(
        entry.hypothesisLabel,
      ),
      `ranking label looks like a full claim: ${entry.hypothesisLabel}`,
    );
    assert(entry.rationale.trim().length > 0);
  }
  assert(
    !JSON.stringify(output.frameworkRationale).includes("market-entry-tiered") &&
      !JSON.stringify(output.frameworkRationale).includes(
        "ge-9-box-with-make-buy-ally",
      ),
    "framework rationale leaked YAML id",
  );
  assert(
    output.frameworkRationale.rejected.some((item) => item.type === "framework"),
    "Micky should surface at least one real framework alternative",
  );
  assert(
    output.hypothesisDecomposition.flatMap((entry) => entry.whatWasCut).some(
      (item) =>
        item.type === "hypothesis" ||
        item.type === "method" ||
        item.type === "scope",
    ),
    "Micky should surface at least one real non-framework cut item",
  );
  for (const entry of output.hypothesisDecomposition) {
    assert(
      countSentences(entry.rationale) <= 4,
      `decomposition rationale too long for ${entry.hypothesisLabel}`,
    );
  }
  assert(
    countNumericConfidenceMentions(output) <= 3,
    "Micky should not foreground confidence scores throughout the memo",
  );
  assert.equal(output.signOff.monogram, "MB");
  assert(output.pushback.length >= 1);

  const serialized = JSON.stringify(output);
  for (const word of BANNED) {
    const match = serialized.match(new RegExp(`\\b${word}\\b`, "i"));
    assert(!match, `banned word found in Micky output: ${word}`);
  }
}

function countSentences(value: string): number {
  const matches = value
    .trim()
    .match(/[^.!?]+[.!?]+(?=\s|$)|[^.!?]+$/g);
  return matches?.filter((sentence) => sentence.trim().length > 0).length ?? 0;
}

function countNumericConfidenceMentions(output: unknown): number {
  const prose = JSON.stringify(output);
  return (prose.match(/\bconfidence(?:\s+(?:score|scores|sits|is|of|at))?[^.\n]{0,40}\b0\.\d+\b|\b0\.\d+\b/gi) ?? [])
    .length;
}

async function latestCompleteRunId(caseConfigId: string): Promise<string> {
  const { insforge } = await import("../lib/db");
  const config = loadCase(caseConfigId);
  const { data: caseRows, error: caseErr } = await insforge.database
    .from("cases")
    .select("*")
    .eq("title", config.title)
    .limit(1);
  if (caseErr) throw new Error(`fetch case: ${caseErr.message}`);
  const dbCase = (caseRows as Case[] | null)?.[0];
  if (!dbCase) throw new Error(`No DB case found for ${caseConfigId}`);

  const { data: runRows, error: runErr } = await insforge.database
    .from("runs")
    .select("*")
    .eq("case_id", dbCase.id)
    .eq("status", "complete");
  if (runErr) throw new Error(`fetch runs: ${runErr.message}`);
  const runs = ((runRows as Run[] | null) ?? []).sort((a, b) =>
    b.started_at.localeCompare(a.started_at),
  );
  const run = runs[0];
  if (!run) throw new Error(`No complete runs found for ${caseConfigId}`);
  return run.id;
}

main().catch((e) => {
  console.error("smoke-micky-agent failed:", e);
  process.exit(1);
});
