// POST /api/ingest — ingest the PDFs declared in cases/<id>.yaml inputDocs.
// Body: { caseId: string }   YAML id, e.g. "abb-rack-pdu".
// Idempotent: re-running skips already-ingested files for the same case_id+uri.

import { NextResponse } from "next/server";
import { ensureCaseRow } from "@/lib/case";
import { loadCase } from "@/lib/framework-registry";
import { ingestPDF, type IngestResult } from "@/lib/ingest";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";
// Ingestion is long-running — embeddings call + DB inserts. Default 10s timeout
// would kill the request on cold start.
export const maxDuration = 300;

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

  const caseConfigId = body.caseId?.trim();
  if (!caseConfigId) {
    return NextResponse.json({ error: "caseId is required" }, { status: 400 });
  }

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

  const results: (IngestResult & { error?: string })[] = [];
  for (const doc of docs) {
    try {
      const r = await ingestPDF(doc.path, dbCaseId, {
        type: "pdf",
        author: doc.author,
        stake: doc.stake,
      });
      results.push(r);
    } catch (e) {
      results.push({
        filePath: doc.path,
        inserted: 0,
        skipped: 0,
        pages: 0,
        error: e instanceof Error ? e.message : String(e),
      });
    }
  }

  const totals = results.reduce(
    (acc, r) => ({
      inserted: acc.inserted + r.inserted,
      skipped: acc.skipped + r.skipped,
    }),
    { inserted: 0, skipped: 0 },
  );

  return NextResponse.json({ caseId: dbCaseId, totals, results });
}
