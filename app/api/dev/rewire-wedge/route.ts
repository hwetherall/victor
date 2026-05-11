// Wedge-demo wiring helper. integration-sh42 creates a fresh "orphan"
// sub_hypothesis node with parent_id=null so the dispatch path can be
// exercised in isolation. The drill-down UI renders the case's existing
// V1 tree though, so the orphan never reaches a viewer.
//
// This route stitches a wedge run's outputs (artifact, reasoning trace, HITL
// question) onto the canonical SH4.2 node (child of H4) in the V1 ABB tree,
// and marks that node `complete` with the wedge confidence so it lights up
// in the kanban + drill-down.
//
// Idempotent: if the canonical node already has artifacts/traces from a
// previous rewire, this route adds the NEW ones rather than clobbering.
//
// Run:
//   curl -X POST http://localhost:3000/api/dev/rewire-wedge \
//        -H "content-type: application/json" \
//        -d '{"orphan_node_id":"b85b1f41-9164-4e42-9064-cfb7b270eede"}'
//
// Body (all optional, sensible defaults):
//   {
//     orphan_node_id?: string,        // default: most recent orphan SH4.2
//     canonical_node_id?: string,     // default: 447a9267-7693-47f3-a17d-3dd3d0c6f7dd (V1 SH4.2 child of H4)
//     confidence?: number,            // default: read from orphan's tree_nodes.confidence, fallback 0.55
//     status?: "complete" | "pending" // default: "complete"
//     delete_orphan?: boolean         // default: true
//   }

import { NextResponse } from "next/server";
import { insforge } from "@/lib/db";

export const dynamic = "force-dynamic";

const DEFAULT_CANONICAL_SH42 = "447a9267-7693-47f3-a17d-3dd3d0c6f7dd";

interface RequestBody {
  orphan_node_id?: string;
  canonical_node_id?: string;
  confidence?: number;
  status?: "complete" | "pending";
  delete_orphan?: boolean;
}

export async function POST(req: Request) {
  let body: RequestBody = {};
  try {
    body = (await req.json()) as RequestBody;
  } catch {
    // tolerate empty body
  }
  const canonicalNodeId = body.canonical_node_id ?? DEFAULT_CANONICAL_SH42;
  const deleteOrphan = body.delete_orphan ?? true;
  const desiredStatus = body.status ?? "complete";

  // 1. Resolve orphan node. Either explicit, or most recent SH4.2 with
  //    parent_id=null (created by integration-sh42).
  let orphanNodeId = body.orphan_node_id;
  if (!orphanNodeId) {
    const { data, error } = await insforge.database
      .from("tree_nodes")
      .select("id, created_at, label, content")
      .is("parent_id", null)
      .eq("type", "sub_hypothesis")
      .eq("label", "SH4.2")
      .order("created_at", { ascending: false })
      .limit(1);
    if (error) {
      return NextResponse.json(
        { error: `orphan lookup: ${error.message}` },
        { status: 500 },
      );
    }
    orphanNodeId = (data as { id: string }[] | null)?.[0]?.id;
    if (!orphanNodeId) {
      return NextResponse.json(
        { error: "no orphan SH4.2 node found; pass orphan_node_id explicitly" },
        { status: 400 },
      );
    }
  }

  // 2. Confirm canonical exists.
  const { data: canonicalCheck, error: canonicalErr } = await insforge.database
    .from("tree_nodes")
    .select("id, case_id, parent_id, status, content, confidence")
    .eq("id", canonicalNodeId)
    .single();
  if (canonicalErr || !canonicalCheck) {
    return NextResponse.json(
      { error: `canonical node ${canonicalNodeId} not found: ${canonicalErr?.message ?? "missing"}` },
      { status: 400 },
    );
  }
  const canonicalNode = canonicalCheck as {
    id: string;
    case_id: string;
    parent_id: string | null;
    status: string;
    content: Record<string, unknown>;
    confidence: number | null;
  };

  // 3. Read orphan state to copy over.
  const { data: orphanCheck, error: orphanErr } = await insforge.database
    .from("tree_nodes")
    .select("id, confidence, content, trace_id")
    .eq("id", orphanNodeId)
    .single();
  if (orphanErr || !orphanCheck) {
    return NextResponse.json(
      { error: `orphan node ${orphanNodeId} not found: ${orphanErr?.message ?? "missing"}` },
      { status: 400 },
    );
  }
  const orphan = orphanCheck as {
    id: string;
    confidence: number | null;
    content: Record<string, unknown>;
    trace_id: string | null;
  };

  const movedConfidence =
    body.confidence ?? orphan.confidence ?? 0.55;

  // 4. Move artifacts: evidence_node_id orphan → canonical.
  const { data: artifactsBefore, error: artListErr } = await insforge.database
    .from("artifacts")
    .select("id, type, version, metadata")
    .eq("evidence_node_id", orphanNodeId);
  if (artListErr) {
    return NextResponse.json(
      { error: `artifacts list: ${artListErr.message}` },
      { status: 500 },
    );
  }
  const movedArtifacts = (artifactsBefore ?? []) as Array<{
    id: string;
    type: string;
    version: number;
    metadata: Record<string, unknown> | null;
  }>;
  if (movedArtifacts.length > 0) {
    const { error } = await insforge.database
      .from("artifacts")
      .update({ evidence_node_id: canonicalNodeId })
      .eq("evidence_node_id", orphanNodeId);
    if (error) {
      return NextResponse.json(
        { error: `artifacts move: ${error.message}` },
        { status: 500 },
      );
    }
  }

  // 5. Move reasoning_traces: node_id orphan → canonical.
  const { data: tracesBefore, error: trListErr } = await insforge.database
    .from("reasoning_traces")
    .select("id, agent_type, managed_agent_session_id")
    .eq("node_id", orphanNodeId);
  if (trListErr) {
    return NextResponse.json(
      { error: `reasoning_traces list: ${trListErr.message}` },
      { status: 500 },
    );
  }
  const movedTraces = (tracesBefore ?? []) as Array<{
    id: string;
    agent_type: string;
    managed_agent_session_id: string;
  }>;
  if (movedTraces.length > 0) {
    const { error } = await insforge.database
      .from("reasoning_traces")
      .update({ node_id: canonicalNodeId })
      .eq("node_id", orphanNodeId);
    if (error) {
      return NextResponse.json(
        { error: `reasoning_traces move: ${error.message}` },
        { status: 500 },
      );
    }
  }

  // 6. Move user_questions: affects_node_ids array swap orphan → canonical.
  //    `contains` array filter to find rows whose affects_node_ids includes
  //    the orphan id, then patch the array.
  const { data: qsBefore, error: qsListErr } = await insforge.database
    .from("user_questions")
    .select("id, question, affects_node_ids")
    .contains("affects_node_ids", [orphanNodeId]);
  if (qsListErr) {
    return NextResponse.json(
      { error: `user_questions list: ${qsListErr.message}` },
      { status: 500 },
    );
  }
  const movedQuestions = (qsBefore ?? []) as Array<{
    id: string;
    question: string;
    affects_node_ids: string[];
  }>;
  for (const q of movedQuestions) {
    const next = q.affects_node_ids.map((id) =>
      id === orphanNodeId ? canonicalNodeId : id,
    );
    const { error } = await insforge.database
      .from("user_questions")
      .update({ affects_node_ids: next })
      .eq("id", q.id);
    if (error) {
      return NextResponse.json(
        { error: `user_question ${q.id} update: ${error.message}` },
        { status: 500 },
      );
    }
  }

  // 7. Update canonical node — set confidence/status/model_used/trace_id so
  //    the UI renders it as a real V2 completed leaf. Preserves the canonical
  //    content (claim/falsifier text) and just layers on the V2 metadata.
  const canonicalContentUpdate = {
    ...canonicalNode.content,
    // Pull through any evidence-summary-style fields the orphan had so the
    // drilldown shows the wedge's verdict line.
    ...(typeof (orphan.content as { evidenceSummary?: string }).evidenceSummary
      === "string"
      ? { evidenceSummary: (orphan.content as { evidenceSummary?: string }).evidenceSummary }
      : {}),
  };
  const { error: updErr } = await insforge.database
    .from("tree_nodes")
    .update({
      status: desiredStatus,
      confidence: movedConfidence,
      content: canonicalContentUpdate,
      model_used: "investigator-v2",
      trace_id: orphan.trace_id ?? `wedge-rewire:${orphanNodeId}`,
    })
    .eq("id", canonicalNodeId);
  if (updErr) {
    return NextResponse.json(
      { error: `canonical update: ${updErr.message}` },
      { status: 500 },
    );
  }

  // 8. Optionally drop the orphan tree node (its rows are now empty).
  let orphanDeleted = false;
  if (deleteOrphan) {
    const { error } = await insforge.database
      .from("tree_nodes")
      .delete()
      .eq("id", orphanNodeId);
    if (error) {
      return NextResponse.json(
        {
          ok: false,
          error: `orphan delete failed (rewire OK): ${error.message}`,
          moved: {
            artifacts: movedArtifacts.length,
            traces: movedTraces.length,
            questions: movedQuestions.length,
          },
        },
        { status: 500 },
      );
    }
    orphanDeleted = true;
  }

  return NextResponse.json({
    ok: true,
    moved: {
      orphan_node_id: orphanNodeId,
      canonical_node_id: canonicalNodeId,
      artifacts: movedArtifacts,
      traces: movedTraces,
      questions: movedQuestions.map((q) => ({ id: q.id, question: q.question })),
      orphan_deleted: orphanDeleted,
    },
    canonical_node_after: {
      status: desiredStatus,
      confidence: movedConfidence,
      model_used: "investigator-v2",
    },
    next_step:
      "Open /case/abb-rack-pdu in the browser and drill into the Unit Economics → SH4.2 leaf. Should now show the V2 artifact + OODA trace + HITL question.",
  });
}
