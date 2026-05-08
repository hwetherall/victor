// STORY-018-lite: standalone Researcher smoke test, packaged as a dev API
// route. The standalone-tsx path hits the same InsForge CJS/ESM packaging
// issue as integration-sh42 (require("@insforge/shared-schemas") fails
// under tsx — Next bundling handles the interop transparently).
//
// Run:
//   curl -X POST http://localhost:3000/api/dev/test-researcher \
//        -H "content-type: application/json" \
//        -d '{"question":"...", "contextHint":"..."}' \
//        --max-time 600
//
// Returns the parsed ResearcherOutput plus the raw final agent.message
// (for debugging the parser when the agent drifts off-format).

import { NextResponse } from "next/server";
import { createResearcherSession } from "@/lib/managed-agents-client";

export const dynamic = "force-dynamic";
// 10 min cap — Researcher should finish in 1-3 min on Haiku; 10 covers a
// stuck loop that hits its 10-search cap.
export const maxDuration = 600;

interface RequestBody {
  question?: string;
  contextHint?: string;
  maxSearches?: number;
  confidenceTarget?: number;
}

export async function POST(req: Request) {
  const start = Date.now();
  let body: RequestBody = {};
  try {
    body = (await req.json()) as RequestBody;
  } catch {
    // tolerate missing body — fall back to a known-good ABB query
  }
  const question =
    body.question ??
    "What are typical gross margins for intelligent PDU products in the data center hardware market? Cite specific vendor disclosures.";
  const contextHint =
    body.contextHint ??
    "Context: ABB is evaluating entry into intelligent rack PDUs; we need benchmarks against incumbents (Vertiv, Schneider, Eaton).";

  try {
    const output = await createResearcherSession({
      traceId: `test-researcher:${Date.now()}`,
      question,
      contextHint,
      stoppingCriteria: {
        maxSearches: body.maxSearches ?? 10,
        confidenceTarget: body.confidenceTarget ?? 0.8,
      },
    });
    return NextResponse.json({
      ok: true,
      elapsed_s: Number(((Date.now() - start) / 1000).toFixed(1)),
      session_id: output.managedAgentSessionId,
      console_url: `https://console.anthropic.com/managed-agents/sessions/${output.managedAgentSessionId}`,
      // Top-line: did the parser find each structured field?
      parsed: {
        confidence: output.confidence,
        citations_count: output.citations.length,
        search_path_count: output.searchPath.length,
        stopped_because: output.stoppedBecause,
        answer_first_400: output.answer.slice(0, 400),
      },
      output,
    });
  } catch (e) {
    return NextResponse.json(
      {
        ok: false,
        elapsed_s: Number(((Date.now() - start) / 1000).toFixed(1)),
        error: e instanceof Error ? e.message : String(e),
        stack: e instanceof Error ? e.stack : undefined,
      },
      { status: 500 },
    );
  }
}
