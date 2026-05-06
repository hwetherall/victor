// POST /api/ingest — ingest the PDFs declared in cases/<id>.yaml inputDocs.
// Body: {
//   caseId: string,           // YAML id, e.g. "abb-rack-pdu"
//   force?: boolean,          // when true, deletes existing PDF source rows
//                             // for this case before re-running ingestPDF()
//   enableVision?: boolean    // when true, runs the Sonnet vision pass to
//                             // extract chart data invisible to unpdf
// }
// Idempotent unless force=true. Re-running with force=true wipes evidence_sources
// linkages via FK cascade — call BEFORE starting a new pipeline run.

import { NextResponse } from "next/server";
import { ensureCaseRow } from "@/lib/case";
import { loadCase } from "@/lib/framework-registry";
import { ingestPDF, type IngestResult } from "@/lib/ingest";
import { insforge } from "@/lib/db";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";
// Ingestion is long-running — vision call + embeddings + DB inserts. Default
// 10s timeout would kill the request on cold start.
export const maxDuration = 300;

export async function POST(request: Request) {
  let body: { caseId?: string; force?: boolean; enableVision?: boolean };
  try {
    body = await request.json();
  } catch {
    return NextResponse.json(
      {
        error:
          "Body must be JSON: { caseId: string, force?: boolean, enableVision?: boolean }",
      },
      { status: 400 },
    );
  }

  const caseConfigId = body.caseId?.trim();
  if (!caseConfigId) {
    return NextResponse.json({ error: "caseId is required" }, { status: 400 });
  }
  const force = body.force === true;
  const enableVision = body.enableVision === true;

  let dbCaseId: string;
  let docs: ReturnType<typeof loadCase>["inputDocs"];
  try {
    const config = loadCase(caseConfigId);
    docs = config.inputDocs;
    dbCaseId = await ensureCaseRow(caseConfigId);
  } catch (e) {
    return NextResponse.json(
      { error: e instanceof Error ? e.message : String(e) },
      { status: 500 },
    );
  }

  // Force re-ingest: wipe existing PDF source rows for this case. evidence_sources
  // FK cascades, so any prior run's evidence linkages are removed too — caller
  // must start a fresh pipeline run after this returns.
  if (force) {
    const { error: delErr } = await insforge.database
      .from("sources")
      .delete()
      .eq("case_id", dbCaseId)
      .eq("type", "pdf");
    if (delErr) {
      return NextResponse.json(
        { error: `force delete failed: ${delErr.message}` },
        { status: 500 },
      );
    }
  }

  const results: (IngestResult & { error?: string })[] = [];
  for (const doc of docs) {
    try {
      const r = await ingestPDF(
        doc.path,
        dbCaseId,
        { type: "pdf", author: doc.author, stake: doc.stake },
        undefined,
        enableVision,
      );
      results.push(r);
    } catch (e) {
      results.push({
        filePath: doc.path,
        inserted: 0,
        skipped: 0,
        pages: 0,
        visionPages: 0,
        error: e instanceof Error ? e.message : String(e),
      });
    }
  }

  const totals = results.reduce(
    (acc, r) => ({
      inserted: acc.inserted + r.inserted,
      skipped: acc.skipped + r.skipped,
      visionPages: acc.visionPages + r.visionPages,
    }),
    { inserted: 0, skipped: 0, visionPages: 0 },
  );

  return NextResponse.json({
    caseId: dbCaseId,
    force,
    enableVision,
    totals,
    results,
  });
}
