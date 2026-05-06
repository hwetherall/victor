// GET /api/runs/[id]/nodes/[nodeId] — a single node with its direct children.
// Drives the hypothesis drill-down view (hypothesis + sub-hypothesis kids).

import { NextResponse } from "next/server";
import { insforge } from "@/lib/db";
import type { Run, TreeNode } from "@/lib/schema";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

interface NodeWithChildrenResponse {
  node: TreeNode;
  children: TreeNode[];
}

export async function GET(
  _request: Request,
  context: { params: Promise<{ id: string; nodeId: string }> },
) {
  const { id, nodeId } = await context.params;
  if (!id || !nodeId) {
    return NextResponse.json(
      { error: "id and nodeId are required" },
      { status: 400 },
    );
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
    .eq("id", nodeId)
    .eq("case_id", run.case_id)
    .limit(1);
  if (nodeErr) {
    return NextResponse.json({ error: nodeErr.message }, { status: 500 });
  }
  const node = (nodeRows as TreeNode[] | null)?.[0];
  if (!node) {
    return NextResponse.json({ error: "node not found" }, { status: 404 });
  }

  const { data: kidRows, error: kidErr } = await insforge.database
    .from("tree_nodes")
    .select("*")
    .eq("parent_id", nodeId)
    .eq("case_id", run.case_id);
  if (kidErr) {
    return NextResponse.json({ error: kidErr.message }, { status: 500 });
  }
  const children = (kidRows as TreeNode[] | null) ?? [];

  const body: NodeWithChildrenResponse = { node, children };
  return NextResponse.json(body);
}
