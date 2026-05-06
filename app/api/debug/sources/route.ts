// Throwaway diagnostic route. DELETE before production.

import { NextResponse } from "next/server";
import { insforge } from "@/lib/db";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

interface SourceRow {
  id: string;
  type: string;
  uri: string | null;
  title: string | null;
  content_extract: string | null;
  metadata: { pageNumber?: number; author?: string; stake?: string } | null;
  embedding: unknown;
}

export async function GET(request: Request) {
  const url = new URL(request.url);
  const page = url.searchParams.get("page");
  const fullPage = page ? parseInt(page, 10) : null;

  const { data: cases } = await insforge.database
    .from("cases")
    .select("id, title");
  const caseRows = (cases as { id: string; title: string }[] | null) ?? [];
  if (caseRows.length === 0) {
    return NextResponse.json({ error: "no cases" }, { status: 404 });
  }
  const c = caseRows[0];

  const { data: srcs } = await insforge.database
    .from("sources")
    .select("id, type, uri, title, content_extract, metadata, embedding")
    .eq("case_id", c.id);
  const rows = (srcs as SourceRow[] | null) ?? [];

  // Full page mode: dump one page's full content_extract for inspection.
  if (fullPage !== null) {
    const match = rows.find(
      (r) =>
        r.type === "pdf" &&
        r.metadata?.pageNumber === fullPage &&
        (r.title ?? "").toLowerCase().includes("deck"),
    );
    return NextResponse.json({
      page: fullPage,
      title: match?.title,
      content: match?.content_extract,
      length: match?.content_extract?.length,
    });
  }

  const byType: Record<string, number> = {};
  for (const s of rows) byType[s.type] = (byType[s.type] ?? 0) + 1;

  const pdfs = rows.filter((s) => s.type === "pdf");
  const byTitle: Record<string, number[]> = {};
  for (const p of pdfs) {
    const t = p.title ?? "?";
    byTitle[t] = byTitle[t] ?? [];
    if (typeof p.metadata?.pageNumber === "number") {
      byTitle[t].push(p.metadata.pageNumber);
    }
  }
  for (const k of Object.keys(byTitle)) byTitle[k].sort((a, b) => a - b);

  const matches = pdfs
    .filter((p) => {
      const t = p.content_extract ?? "";
      return (
        t.toUpperCase().includes("OMDIA") ||
        t.includes("10.4%") ||
        t.includes("10.4 %") ||
        t.includes("CAGR") ||
        t.includes("2.26") ||
        t.includes("$2.26B")
      );
    })
    .map((p) => ({
      title: p.title,
      page: p.metadata?.pageNumber,
      preview: (p.content_extract ?? "").slice(0, 240),
      length: p.content_extract?.length ?? 0,
    }));

  const page8Deck = pdfs.find(
    (p) =>
      p.metadata?.pageNumber === 8 &&
      (p.title ?? "").toLowerCase().includes("deck"),
  );

  const noEmbedding = pdfs.filter((p) => !p.embedding).length;

  return NextResponse.json({
    case: c,
    total: rows.length,
    byType,
    pdfPagesByDoc: byTitle,
    page8DeckSnippet: page8Deck?.content_extract?.slice(0, 600) ?? null,
    page8DeckTextLength: page8Deck?.content_extract?.length ?? null,
    keywordMatches: matches,
    pdfChunksWithoutEmbedding: noEmbedding,
  });
}
