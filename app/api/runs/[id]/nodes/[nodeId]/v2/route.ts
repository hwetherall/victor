// V2-only data for a leaf: artifacts + reasoning_trace + HITL escalations.
// Returns empty arrays for V1 leaves so the UI can render unconditionally.

import { NextResponse } from "next/server";
import { insforge } from "@/lib/db";
import type { Artifact, ReasoningTrace, UserQuestion } from "@/lib/schema";

export const dynamic = "force-dynamic";

interface V2NodeData {
  artifacts: Artifact[];
  trace: ReasoningTrace | null;
  escalations: UserQuestion[];
}

export async function GET(
  _req: Request,
  { params }: { params: Promise<{ id: string; nodeId: string }> },
) {
  const { nodeId } = await params;

  const [aRes, tRes, qRes] = await Promise.all([
    insforge.database
      .from("artifacts")
      .select("*")
      .eq("evidence_node_id", nodeId)
      .order("version", { ascending: true }),
    insforge.database
      .from("reasoning_traces")
      .select("*")
      .eq("node_id", nodeId)
      .order("created_at", { ascending: false })
      .limit(1),
    insforge.database
      .from("user_questions")
      .select("*")
      .contains("affects_node_ids", [nodeId])
      .order("created_at", { ascending: false }),
  ]);

  if (aRes.error) {
    return NextResponse.json(
      { error: `artifacts: ${aRes.error.message}` },
      { status: 500 },
    );
  }
  if (tRes.error) {
    return NextResponse.json(
      { error: `reasoning_traces: ${tRes.error.message}` },
      { status: 500 },
    );
  }
  if (qRes.error) {
    return NextResponse.json(
      { error: `user_questions: ${qRes.error.message}` },
      { status: 500 },
    );
  }

  const traceRow = (tRes.data as ReasoningTrace[] | null)?.[0] ?? null;
  const data: V2NodeData = {
    artifacts: (aRes.data as Artifact[] | null) ?? [],
    trace: traceRow,
    escalations: (qRes.data as UserQuestion[] | null) ?? [],
  };
  return NextResponse.json(data);
}
