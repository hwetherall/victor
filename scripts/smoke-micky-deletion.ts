import { strict as assert } from "node:assert";
import { config as loadEnv } from "dotenv";
import type { MickyRun } from "../lib/schema";

loadEnv({ path: ".env.local" });

async function main() {
  const { insforge } = await import("../lib/db");
  const runId = process.argv[2];
  assert(runId, "usage: smoke-micky-deletion.ts <runId>");

  const attemptNumber = Math.floor(Date.now() % 1_000_000_000);
  const { data, error } = await insforge.database
    .from("micky_runs")
    .insert([
      {
        run_id: runId,
        attempt_number: attemptNumber,
        status: "failed",
        error: "smoke deletion fixture",
      },
    ])
    .select();
  if (error) throw new Error(`insert fixture: ${error.message}`);
  const row = (data as MickyRun[] | null)?.[0];
  assert(row?.id, "insert returned no micky run");

  const { error: deleteErr } = await insforge.database
    .from("micky_runs")
    .update({ deleted_at: new Date().toISOString() })
    .eq("id", row.id);
  if (deleteErr) throw new Error(`soft delete: ${deleteErr.message}`);

  const { data: remaining, error: fetchErr } = await insforge.database
    .from("micky_runs")
    .select("*")
    .eq("run_id", runId)
    .is("deleted_at", null);
  if (fetchErr) throw new Error(`fetch remaining: ${fetchErr.message}`);
  assert(!((remaining as MickyRun[] | null) ?? []).some((run) => run.id === row.id));
}

main().catch((e) => {
  console.error("smoke-micky-deletion failed:", e);
  process.exit(1);
});
