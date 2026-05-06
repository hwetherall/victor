// GET /api/runs/[id]/nodes/[nodeId]/evidence — evidence children of a
// sub-hypothesis (or hypothesis), each joined with its source row + the
// evidence_sources linkage (quote, page_number). Drives the evidence list view
// and the source modal — pre-loads source data so the modal opens instantly
// (SPEC §12: cache resolved sources at run time).

import { NextResponse } from "next/server";
import { insforge } from "@/lib/db";
import type {
  EvidenceSourceLink,
  Run,
  Source,
  TreeNode,
} from "@/lib/schema";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

export interface EvidenceItem {
  node: TreeNode;
  source: Source | null;
  link: EvidenceSourceLink | null;
}

interface EvidenceResponse {
  parentNode: TreeNode;
  evidence: EvidenceItem[];
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

  // Parent node (the sub-hypothesis the user clicked on).
  const { data: parentRows, error: parentErr } = await insforge.database
    .from("tree_nodes")
    .select("*")
    .eq("id", nodeId)
    .eq("case_id", run.case_id)
    .limit(1);
  if (parentErr) {
    return NextResponse.json({ error: parentErr.message }, { status: 500 });
  }
  const parentNode = (parentRows as TreeNode[] | null)?.[0];
  if (!parentNode) {
    return NextResponse.json({ error: "node not found" }, { status: 404 });
  }

  // Evidence children of this node.
  const { data: evRows, error: evErr } = await insforge.database
    .from("tree_nodes")
    .select("*")
    .eq("parent_id", nodeId)
    .eq("case_id", run.case_id)
    .eq("type", "evidence");
  if (evErr) {
    return NextResponse.json({ error: evErr.message }, { status: 500 });
  }
  const evidenceNodes = (evRows as TreeNode[] | null) ?? [];

  if (evidenceNodes.length === 0) {
    const body: EvidenceResponse = { parentNode, evidence: [] };
    return NextResponse.json(body);
  }

  // Linkage rows for these evidence nodes.
  const evIds = evidenceNodes.map((e) => e.id);
  const { data: linkRows, error: linkErr } = await insforge.database
    .from("evidence_sources")
    .select("*")
    .in("evidence_node_id", evIds);
  if (linkErr) {
    return NextResponse.json({ error: linkErr.message }, { status: 500 });
  }
  const links = (linkRows as EvidenceSourceLink[] | null) ?? [];
  const linkByNode = new Map<string, EvidenceSourceLink>();
  for (const l of links) linkByNode.set(l.evidence_node_id, l);

  // Source rows for the linked sources.
  const sourceIds = Array.from(
    new Set(links.map((l) => l.source_id).filter(Boolean)),
  );
  let sources: Source[] = [];
  if (sourceIds.length > 0) {
    const { data: srcRows, error: srcErr } = await insforge.database
      .from("sources")
      .select("id, case_id, type, uri, title, content_extract, metadata, created_at")
      .in("id", sourceIds);
    if (srcErr) {
      return NextResponse.json({ error: srcErr.message }, { status: 500 });
    }
    sources = (srcRows as Source[] | null) ?? [];
  }
  const sourceById = new Map<string, Source>();
  for (const s of sources) sourceById.set(s.id, s);

  const evidence: EvidenceItem[] = evidenceNodes.map((node) => {
    const link = linkByNode.get(node.id) ?? null;
    const source = link ? sourceById.get(link.source_id) ?? null : null;
    return { node, source, link };
  });

  const body: EvidenceResponse = { parentNode, evidence };
  return NextResponse.json(body);
}
