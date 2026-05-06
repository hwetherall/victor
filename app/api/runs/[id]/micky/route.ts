import { readdirSync } from "node:fs";
import { join, parse } from "node:path";
import { NextResponse } from "next/server";
import { runMicky, startMickyAttempt } from "@/agents/micky";
import { insforge } from "@/lib/db";
import { loadCase } from "@/lib/framework-registry";
import type { Case, MickyRun, Run } from "@/lib/schema";

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

  const { data, error } = await insforge.database
    .from("micky_runs")
    .select("*")
    .eq("run_id", id)
    .is("deleted_at", null);
  if (error) return NextResponse.json({ error: error.message }, { status: 500 });

  await insforge.database
    .from("runs")
    .update({ last_accessed_at: new Date().toISOString() })
    .eq("id", id);

  const runs = ((data as MickyRun[] | null) ?? []).sort(
    (a, b) => b.attempt_number - a.attempt_number,
  );
  return NextResponse.json({ runs });
}

export async function POST(
  _request: Request,
  context: { params: Promise<{ id: string }> },
) {
  const { id } = await context.params;
  if (!id) {
    return NextResponse.json({ error: "id is required" }, { status: 400 });
  }

  try {
    const run = await fetchRun(id);
    if (run.status !== "complete") {
      return NextResponse.json(
        { error: "Micky can only run after the parent run is complete" },
        { status: 400 },
      );
    }

    const dbCase = await fetchCase(run.case_id);
    const caseConfigId = findCaseConfigIdByTitle(dbCase.title);
    const attempt = await startMickyAttempt(id);
    runMicky(id, caseConfigId, attempt).catch((e) => {
      console.error(`[run ${id}] micky attempt ${attempt.id} failed:`, e);
    });

    return NextResponse.json(
      { mickyRunId: attempt.id, attemptNumber: attempt.attemptNumber },
      { status: 202 },
    );
  } catch (e) {
    return NextResponse.json(
      { error: e instanceof Error ? e.message : String(e) },
      { status: 500 },
    );
  }
}

export async function DELETE(
  request: Request,
  context: { params: Promise<{ id: string }> },
) {
  const { id } = await context.params;
  const attemptId = new URL(request.url).searchParams.get("attemptId");
  if (!id || !attemptId) {
    return NextResponse.json(
      { error: "id and attemptId are required" },
      { status: 400 },
    );
  }

  const { error } = await insforge.database
    .from("micky_runs")
    .update({ deleted_at: new Date().toISOString() })
    .eq("run_id", id)
    .eq("id", attemptId);
  if (error) return NextResponse.json({ error: error.message }, { status: 500 });
  return NextResponse.json({ ok: true });
}

async function fetchRun(runId: string): Promise<Run> {
  const { data, error } = await insforge.database
    .from("runs")
    .select("*")
    .eq("id", runId)
    .limit(1);
  if (error) throw new Error(`fetch run: ${error.message}`);
  const run = (data as Run[] | null)?.[0];
  if (!run) throw new Error("run not found");
  return run;
}

async function fetchCase(caseId: string): Promise<Case> {
  const { data, error } = await insforge.database
    .from("cases")
    .select("*")
    .eq("id", caseId)
    .limit(1);
  if (error) throw new Error(`fetch case: ${error.message}`);
  const dbCase = (data as Case[] | null)?.[0];
  if (!dbCase) throw new Error("case not found");
  return dbCase;
}

function findCaseConfigIdByTitle(title: string): string {
  const dir = join(process.cwd(), "cases");
  for (const entry of readdirSync(dir)) {
    if (!entry.endsWith(".yaml")) continue;
    const caseId = parse(entry).name;
    try {
      if (loadCase(caseId).title === title) return caseId;
    } catch {
      // Ignore invalid case files; the route will fail if no match exists.
    }
  }
  throw new Error(`No case config found for DB case title: ${title}`);
}
