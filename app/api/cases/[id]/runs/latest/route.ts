// GET /api/cases/[id]/runs/latest — most recent complete run for a case
// (looked up by YAML config id). Returns 404 if the case has no completed runs
// yet — the case page uses this to decide between "Run analysis" vs "View
// Results". Read-only: never creates a case row.

import { NextResponse } from "next/server";
import { insforge } from "@/lib/db";
import { loadCase } from "@/lib/framework-registry";
import type { Run } from "@/lib/schema";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

export async function GET(
  _request: Request,
  context: { params: Promise<{ id: string }> },
) {
  const { id } = await context.params;
  if (!id) {
    return NextResponse.json({ error: "id is required" }, { status: 400 });
  }

  let title: string;
  try {
    title = loadCase(id).title;
  } catch {
    return NextResponse.json(
      { error: `case config '${id}' not found` },
      { status: 404 },
    );
  }

  const { data: caseRows, error: caseErr } = await insforge.database
    .from("cases")
    .select("id")
    .eq("title", title)
    .limit(1);
  if (caseErr) {
    return NextResponse.json({ error: caseErr.message }, { status: 500 });
  }
  const dbCaseId = (caseRows as { id: string }[] | null)?.[0]?.id;
  if (!dbCaseId) {
    // Case has never been run — no row exists yet.
    return NextResponse.json({ run: null }, { status: 404 });
  }

  const { data: runRows, error: runErr } = await insforge.database
    .from("runs")
    .select("*")
    .eq("case_id", dbCaseId)
    .eq("status", "complete")
    .order("started_at", { ascending: false })
    .limit(1);
  if (runErr) {
    return NextResponse.json({ error: runErr.message }, { status: 500 });
  }
  const run = (runRows as Run[] | null)?.[0];
  if (!run) {
    return NextResponse.json({ run: null }, { status: 404 });
  }

  return NextResponse.json({ run });
}
