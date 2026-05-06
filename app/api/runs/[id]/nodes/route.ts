// GET /api/runs/[id]/nodes — every tree node for the run's case, grouped by
// type. Drives the Kanban view (top-level hypotheses + decision card).

import { NextResponse } from "next/server";
import { insforge } from "@/lib/db";
import type { Run, TreeNode } from "@/lib/schema";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

interface NodesResponse {
  run: Run;
  nodes: TreeNode[];
  byType: {
    decision: TreeNode[];
    hypothesis: TreeNode[];
    sub_hypothesis: TreeNode[];
    evidence: TreeNode[];
    question: TreeNode[];
  };
}

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

  const { data: nodeRows, error: nodeErr } = await insforge.database
    .from("tree_nodes")
    .select("*")
    .eq("case_id", run.case_id);
  if (nodeErr) {
    return NextResponse.json({ error: nodeErr.message }, { status: 500 });
  }
  const nodes = (nodeRows as TreeNode[] | null) ?? [];

  const byType: NodesResponse["byType"] = {
    decision: [],
    hypothesis: [],
    sub_hypothesis: [],
    evidence: [],
    question: [],
  };
  for (const n of nodes) byType[n.type].push(n);

  const body: NodesResponse = { run, nodes, byType };
  return NextResponse.json(body);
}
