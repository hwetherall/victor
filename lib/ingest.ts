// SPEC §6.4 doc-mode prerequisite. Extracts page-text from a PDF, embeds each
// page as one chunk, and stores Source rows tagged with author + stake.
// Idempotent: re-runs against the same (case_id, uri) skip.

import { readFile } from "node:fs/promises";
import path from "node:path";
import { extractText, getDocumentProxy } from "unpdf";
import { insforge } from "./db";
import { embedBatch, vectorToString } from "./embeddings";

export interface PageChunk {
  pageNumber: number;
  text: string;
}

export interface IngestResult {
  filePath: string;
  inserted: number;
  skipped: number;
  pages: number;
}

export interface IngestSourceMeta {
  type: "pdf" | "docx";
  author?: string;
  stake?: string;
}

/**
 * Extract per-page text from a PDF. One chunk per page, page numbers preserved.
 * Pages with empty text after cleaning are dropped.
 *
 * Uses `unpdf` instead of raw pdfjs-dist because Next/Turbopack can't bundle
 * pdfjs's worker file — unpdf ships a serverless build that disables the
 * worker entirely.
 */
export async function extractPdfPages(filePath: string): Promise<PageChunk[]> {
  const buffer = await readFile(filePath);
  const doc = await getDocumentProxy(new Uint8Array(buffer));
  const { text: perPageText } = await extractText(doc, { mergePages: false });

  const pages = Array.isArray(perPageText) ? perPageText : [perPageText];
  return pages
    .map((raw, i) => ({ pageNumber: i + 1, text: cleanText(raw) }))
    .filter((p) => p.text.length >= 20);
}

function cleanText(s: string): string {
  return s.replace(/\s+/g, " ").trim();
}

/**
 * Ingest a PDF into the sources table for a given case. Returns counts.
 *  - Idempotent on (case_id, uri).
 *  - Each page becomes one Source row with metadata.pageNumber.
 *  - Embeddings are batched in one OpenAI call.
 */
export async function ingestPDF(
  filePath: string,
  caseId: string,
  meta: IngestSourceMeta,
  title?: string,
): Promise<IngestResult> {
  // Idempotency check.
  const { data: existing, error: selErr } = await insforge.database
    .from("sources")
    .select("id")
    .eq("case_id", caseId)
    .eq("uri", filePath);
  if (selErr) throw new Error(`ingestPDF select: ${selErr.message}`);
  const existingCount = existing?.length ?? 0;
  if (existingCount > 0) {
    return {
      filePath,
      inserted: 0,
      skipped: existingCount,
      pages: existingCount,
    };
  }

  const chunks = await extractPdfPages(filePath);
  if (chunks.length === 0) {
    return { filePath, inserted: 0, skipped: 0, pages: 0 };
  }

  const embeddings = await embedBatch(chunks.map((c) => c.text));
  const docTitle = title ?? path.basename(filePath);

  const rows = chunks.map((c, i) => ({
    case_id: caseId,
    type: "pdf" as const,
    uri: filePath,
    title: docTitle,
    content_extract: c.text,
    embedding: vectorToString(embeddings[i]),
    metadata: {
      pageNumber: c.pageNumber,
      author: meta.author ?? null,
      stake: meta.stake ?? null,
    },
  }));

  // Insert in batches to keep payloads sane.
  const batchSize = 25;
  for (let i = 0; i < rows.length; i += batchSize) {
    const batch = rows.slice(i, i + batchSize);
    const { error } = await insforge.database.from("sources").insert(batch);
    if (error) throw new Error(`sources insert: ${error.message}`);
  }

  return { filePath, inserted: rows.length, skipped: 0, pages: chunks.length };
}
