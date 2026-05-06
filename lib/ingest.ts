// SPEC §6.4 doc-mode prerequisite. Extracts page-text from a PDF, embeds each
// page as one chunk, and stores Source rows tagged with author + stake.
// Idempotent: re-runs against the same (case_id, uri) skip.
//
// v2 adds an optional vision pass: when enableVision=true, the entire PDF is
// sent to a vision-capable model (Sonnet via OpenRouter) which returns
// per-page extractions including chart data, numbers, and labels that are
// invisible to text-only PDF parsers. Vision output is merged into each
// page's content_extract before embedding.

import { readFile } from "node:fs/promises";
import path from "node:path";
import { extractText, getDocumentProxy } from "unpdf";
import { insforge } from "./db";
import { embedBatch, vectorToString } from "./embeddings";
import {
  completeMultimodalJson,
  type MultimodalMessage,
} from "./llm-client";

export interface PageChunk {
  pageNumber: number;
  text: string;
}

export interface IngestResult {
  filePath: string;
  inserted: number;
  skipped: number;
  pages: number;
  /** Number of pages where the vision pass added non-empty content. */
  visionPages: number;
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

// ─── Vision extraction ───────────────────────────────────────────────────────

interface VisionPage {
  pageNumber: number;
  extractedText: string;
}

/**
 * Send the full PDF to a vision-capable model in one call and request
 * per-page text extraction including chart data, numbers, and visual labels
 * that text-only parsers miss. Returns a map of pageNumber → extracted text.
 *
 * Failures (network, parse, empty response) are caught and return an empty
 * map so ingestion falls back to text-only without crashing.
 */
export async function extractPdfVision(
  pdfBuffer: Buffer,
): Promise<Map<number, string>> {
  const base64 = pdfBuffer.toString("base64");
  const dataUrl = `data:application/pdf;base64,${base64}`;

  const messages: MultimodalMessage[] = [
    {
      role: "system",
      content: [
        "You extract content from PDF pages for downstream retrieval.",
        "For EVERY page in the document, produce a thorough extraction including:",
        "  - all visible body text",
        "  - chart titles, axis labels, legend entries, and EVERY data point value visible in any chart or table",
        "  - figure captions, footnotes, and source citations",
        "  - any numbers, percentages, dollar amounts, or dates",
        "Do not summarise. Reproduce values verbatim. If a chart shows '10.4% CAGR' that string must appear in your output for that page.",
        "",
        'Return JSON: { "pages": [{ "pageNumber": 1, "extractedText": "..." }, ...] }',
        "Page numbering starts at 1.",
      ].join("\n"),
    },
    {
      role: "user",
      content: [
        { type: "text", text: "Extract all text and chart data from every page of this PDF." },
        { type: "file", file: { filename: "document.pdf", file_data: dataUrl } },
      ],
    },
  ];

  try {
    const parsed = await completeMultimodalJson<{ pages?: VisionPage[] }>(
      "vision",
      messages,
      { temperature: 0.1, maxTokens: 50000 },
    );
    const map = new Map<number, string>();
    for (const p of parsed.pages ?? []) {
      if (typeof p.pageNumber === "number" && typeof p.extractedText === "string") {
        map.set(p.pageNumber, p.extractedText);
      }
    }
    return map;
  } catch (e) {
    console.warn(
      `extractPdfVision failed (falling back to text-only): ${e instanceof Error ? e.message : e}`,
    );
    return new Map();
  }
}

/**
 * Ingest a PDF into the sources table for a given case. Returns counts.
 *  - Idempotent on (case_id, uri).
 *  - Each page becomes one Source row with metadata.pageNumber.
 *  - Embeddings are batched in one OpenAI call.
 *  - When enableVision=true, augments each page's content with a vision-model
 *    extraction (chart data, numbers, labels invisible to text parsers).
 */
export async function ingestPDF(
  filePath: string,
  caseId: string,
  meta: IngestSourceMeta,
  title?: string,
  enableVision = false,
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
      visionPages: 0,
    };
  }

  const chunks = await extractPdfPages(filePath);
  if (chunks.length === 0) {
    return { filePath, inserted: 0, skipped: 0, pages: 0, visionPages: 0 };
  }

  // Vision pass — one whole-PDF call returning per-page extractions.
  let visionByPage: Map<number, string> = new Map();
  if (enableVision) {
    const buffer = await readFile(filePath);
    visionByPage = await extractPdfVision(buffer);
  }

  const merged = chunks.map((c) => {
    const visionText = visionByPage.get(c.pageNumber)?.trim() ?? "";
    if (!visionText) return { ...c, content: c.text };
    const combined = `${c.text}\n\n[vision]\n${visionText}`;
    // Embeddings model handles up to ~8K tokens; cap at 8000 chars to keep DB
    // rows sane and avoid edge-case API rejections.
    const capped = combined.length > 8000 ? combined.slice(0, 8000) : combined;
    return { ...c, content: capped };
  });

  const visionPages = merged.filter(
    (m) => (visionByPage.get(m.pageNumber)?.trim() ?? "").length > 0,
  ).length;

  const embeddings = await embedBatch(merged.map((c) => c.content));
  const docTitle = title ?? path.basename(filePath);

  const rows = merged.map((c, i) => ({
    case_id: caseId,
    type: "pdf" as const,
    uri: filePath,
    title: docTitle,
    content_extract: c.content,
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

  return {
    filePath,
    inserted: rows.length,
    skipped: 0,
    pages: chunks.length,
    visionPages,
  };
}
