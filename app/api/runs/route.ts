// POST /api/runs — fire-and-forget pipeline trigger.
// Body: { caseId: string }   where caseId is the YAML id (e.g. "abb-rack-pdu").
// Response: 202 with { runId, caseId } once the run row exists; the pipeline
// runs in the background. Poll GET /api/runs/[id] for status.

import { NextResponse } from "next/server";
import { startRun } from "@/agents/orchestrator";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

export async function POST(request: Request) {
  let body: { caseId?: string };
  try {
    body = await request.json();
  } catch {
    return NextResponse.json(
      { error: "Body must be JSON: { caseId: string }" },
      { status: 400 },
    );
  }

  const caseId = body.caseId?.trim();
  if (!caseId) {
    return NextResponse.json({ error: "caseId is required" }, { status: 400 });
  }

  try {
    const { ids, pipeline } = await startRun(caseId);

    // Detach: log unhandled rejections so the run row's `status='failed'` is
    // the source of truth, not the process logs.
    pipeline.catch((e) => {
      console.error(`[run ${ids.runId}] pipeline error:`, e);
    });

    return NextResponse.json(ids, { status: 202 });
  } catch (e) {
    return NextResponse.json(
      { error: e instanceof Error ? e.message : String(e) },
      { status: 500 },
    );
  }
}
