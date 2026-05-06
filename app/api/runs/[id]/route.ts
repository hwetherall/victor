// GET /api/runs/[id] — poll a run's status. When complete, also returns the
// decision node's content for quick UI rendering.

import { NextResponse } from "next/server";
import { insforge } from "@/lib/db";
import type { Run, TreeNode } from "@/lib/schema";

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

  const { data: runRows, error: runErr } = await insforge.database
    .from("runs")
    .select("*")
    .eq("id", id)
    .limit(1);
  if (runErr) {
    return NextResponse.json({ error: runErr.message }, { status: 500 });
  }
  const run = (runRows as Run[] | null)?.[0];
  if (!run) {
    return NextResponse.json({ error: "run not found" }, { status: 404 });
  }

  const body: {
    run: Run;
    decision?: TreeNode;
  } = { run };

  if (run.status === "complete") {
    const { data: decRows, error: decErr } = await insforge.database
      .from("tree_nodes")
      .select("*")
      .eq("case_id", run.case_id)
      .eq("type", "decision")
      .limit(1);
    if (decErr) {
      return NextResponse.json({ error: decErr.message }, { status: 500 });
    }
    body.decision = (decRows as TreeNode[] | null)?.[0];
  }

  return NextResponse.json(body);
}
