// Case-row lifecycle helpers — used by the orchestrator and the ingest route.
// The cases table doesn't have a stable slug column in v1, so we look up by
// title (set in cases/<id>.yaml). Single user, no conflict risk.

import { loadCase } from "./framework-registry";
import { insforge } from "./db";

export async function ensureCaseRow(caseConfigId: string): Promise<string> {
  const config = loadCase(caseConfigId);

  const { data: existing, error: selErr } = await insforge.database
    .from("cases")
    .select("id")
    .eq("title", config.title)
    .limit(1);
  if (selErr) throw new Error(`ensureCaseRow select: ${selErr.message}`);

  const found = (existing as { id: string }[] | null)?.[0];
  if (found) return found.id;

  const { data: inserted, error: insErr } = await insforge.database
    .from("cases")
    .insert([
      {
        title: config.title,
        question: config.question,
        framework_id: config.frameworkId,
        weights: config.weights,
        thresholds: config.thresholds,
      },
    ])
    .select();
  if (insErr) throw new Error(`ensureCaseRow insert: ${insErr.message}`);

  const row = (inserted as { id: string }[] | null)?.[0];
  if (!row) throw new Error("ensureCaseRow: insert returned no row");
  return row.id;
}
