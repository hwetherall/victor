// STORY-021: Researcher rubric calibration eval. Runs a fixture set of
// research questions through the live Researcher agent and reports two
// signals per question:
//
//   • Mechanical rubric checks — does the parsed output satisfy each of
//     the four RUBRIC.md pass conditions? This is the ground truth for
//     what the grader SHOULD have caught.
//   • Grader verdict — the actual `span.outcome_evaluation_end` result
//     from the latest iteration. This is what the grader DID catch.
//
// The gap between the two is the rubric calibration work. When mechanical
// checks fail but the grader returns `satisfied`, the rubric language is
// too soft. When the grader returns `needs_revision` for things mechanical
// checks pass, the rubric is too aggressive.
//
// Run:
//   curl -X POST http://localhost:3000/api/dev/eval-researcher \
//        -H "content-type: application/json" \
//        --max-time 1800
//
// Optional body to override the fixture:
//   { questions: [{label, question, contextHint?}], maxSearches?: number,
//     confidenceTarget?: number }
//
// Returns a structured summary table — one row per question plus a
// summary row. Re-run after each prompt iteration to compare.

import { NextResponse } from "next/server";
import { createResearcherSession } from "@/lib/managed-agents-client";
import type { ResearcherOutput } from "@/lib/schema";

export const dynamic = "force-dynamic";
// 30-min cap. Each question is 1-5 min on Sonnet; 5 questions × 5 min worst
// case = 25 min. The Researcher's own search-cap stops it well before that.
export const maxDuration = 1800;

interface EvalQuestion {
  label: string;
  question: string;
  contextHint?: string;
}

interface RequestBody {
  questions?: EvalQuestion[];
  maxSearches?: number;
  confidenceTarget?: number;
}

// Default fixture — five questions covering the rubric's intended coverage:
// margin benchmarks, customer concentration, regulatory thresholds, base
// rates, and comparable-transaction multiples. All five are pre-verified
// findable in ≤3 web searches with a real citable source — keeps the eval
// signal about format discipline, not evidence availability.
const DEFAULT_QUESTIONS: EvalQuestion[] = [
  {
    label: "margin-benchmark",
    question:
      "What gross margin did Vertiv report for its Critical Infrastructure & Solutions segment in its most recent annual 10-K filing? Cite the specific figure.",
    contextHint:
      "Public 10-K disclosure on SEC EDGAR. Single segment-level number.",
  },
  {
    label: "customer-concentration",
    question:
      "Per Eaton's most recent 10-K or investor day, what share of its Electrical Sector revenue is exposed to data-center end-markets?",
    contextHint:
      "Eaton breaks out data-center exposure in investor materials. Single figure or narrow range.",
  },
  {
    label: "regulatory-threshold",
    question:
      "Under the EU Energy Efficiency Directive recast (Directive 2023/1791, EED), what is the energy capacity threshold (in kW or MW) at which data centers must report their energy performance to the European database?",
    contextHint:
      "Public EU regulation; the threshold is in Article 12 / annex VII of Directive 2023/1791. Direct citation should be from EUR-Lex or an official Commission factsheet.",
  },
  {
    label: "base-rate",
    question:
      "What is the combined FY2025 capital expenditure guidance announced by the major US hyperscalers (Amazon/AWS, Microsoft/Azure, Alphabet/GCP, Meta) for AI and data-center infrastructure?",
    contextHint:
      "Each hyperscaler discloses capex in earnings calls or annual reports. Aggregate the four announced figures.",
  },
  {
    label: "comparable-transaction",
    question:
      "What enterprise-value multiple (EV/revenue or EV/EBITDA) did Vertiv pay in its 2021/2022 acquisition of E&I Engineering Group?",
    contextHint:
      "Disclosed in Vertiv's 8-K and the press release announcing the deal. Single figure.",
  },
];

// ─── Mechanical rubric checks ───────────────────────────────────────────────
//
// Mirrors agents/managed/researcher/RUBRIC.md. Each function returns
// { passed: boolean, reason?: string } so the failure mode is observable.

interface CheckResult {
  passed: boolean;
  reason?: string;
}

/** C1 (HARD — LEGAL-003): at least one citation, each with url + title + quote. */
function checkCitations(o: ResearcherOutput): CheckResult {
  if (o.citations.length === 0) {
    return { passed: false, reason: "citations array is empty" };
  }
  for (let i = 0; i < o.citations.length; i++) {
    const c = o.citations[i];
    if (!c.url || !c.url.startsWith("http")) {
      return { passed: false, reason: `citation[${i}] missing or invalid url` };
    }
    if (!c.title) {
      return { passed: false, reason: `citation[${i}] missing title` };
    }
    if (!c.quote) {
      return { passed: false, reason: `citation[${i}] missing verbatim quote` };
    }
  }
  return { passed: true };
}

/** C2: STOPPED_BECAUSE is one of three valid options (parser type-narrows
 *  this, but if the field was missing entirely we'd see undefined at runtime
 *  even though TS thinks it's narrowed — defensive). */
function checkStopReason(o: ResearcherOutput): CheckResult {
  const valid = ["answered", "diminishing_returns", "cap_reached"];
  if (!valid.includes(o.stoppedBecause)) {
    return {
      passed: false,
      reason: `stoppedBecause="${o.stoppedBecause}" not in ${valid.join("|")}`,
    };
  }
  return { passed: true };
}

/** C3: search path shows query diversity — no two queries share >3 consecutive
 *  words. Tokenizes lowercase alphanumeric, finds the longest run of matching
 *  consecutive words across each pair. */
function checkQueryDiversity(o: ResearcherOutput): CheckResult {
  if (o.searchPath.length < 2) {
    return {
      passed: false,
      reason: `searchPath has ${o.searchPath.length} entries (need ≥2)`,
    };
  }
  const tokenize = (q: string) =>
    q.toLowerCase().match(/[a-z0-9]+/g) ?? [];
  const queries = o.searchPath.map((s) => tokenize(s.query));
  for (let i = 0; i < queries.length; i++) {
    for (let j = i + 1; j < queries.length; j++) {
      const a = queries[i];
      const b = queries[j];
      // Longest common consecutive substring of words.
      const dp: number[][] = Array.from({ length: a.length + 1 }, () =>
        new Array(b.length + 1).fill(0),
      );
      let maxRun = 0;
      for (let x = 1; x <= a.length; x++) {
        for (let y = 1; y <= b.length; y++) {
          if (a[x - 1] === b[y - 1]) {
            dp[x][y] = dp[x - 1][y - 1] + 1;
            if (dp[x][y] > maxRun) maxRun = dp[x][y];
          }
        }
      }
      if (maxRun > 3) {
        return {
          passed: false,
          reason: `queries [${i}] and [${j}] share ${maxRun} consecutive words`,
        };
      }
    }
  }
  return { passed: true };
}

/** C4: confidence calibrated to stop reason. Only enforces when stoppedBecause
 *  === 'answered' (other stop reasons are explicitly permitted any confidence
 *  per the rubric). */
function checkConfidenceCalibration(o: ResearcherOutput): CheckResult {
  if (o.stoppedBecause === "answered" && o.confidence < 0.6) {
    return {
      passed: false,
      reason: `stopped="answered" but confidence=${o.confidence} < 0.6`,
    };
  }
  return { passed: true };
}

/** Canary for the structured-block-to-file drift mode (gotcha #10): the
 *  agent's final agent.message text MUST start with `ANSWER:`. When this is
 *  false but the parser still extracted partial fields (e.g., the agent
 *  emitted ANSWER mid-message), it tells us the rubric needs to enforce
 *  emission-as-final-message, not just block presence. */
function checkBlockEmittedAsFinalMessage(text: string): CheckResult {
  const firstNonEmptyLine = text.split("\n").map((l) => l.trim()).find((l) => l.length > 0);
  if (!firstNonEmptyLine) {
    return { passed: false, reason: "lastAgentText is empty" };
  }
  if (!/^ANSWER:/i.test(firstNonEmptyLine)) {
    return {
      passed: false,
      reason: `first line is "${firstNonEmptyLine.slice(0, 80)}..." (expected "ANSWER:")`,
    };
  }
  return { passed: true };
}

// ─── Route ──────────────────────────────────────────────────────────────────

export async function POST(req: Request) {
  const start = Date.now();
  let body: RequestBody = {};
  try {
    body = (await req.json()) as RequestBody;
  } catch {
    // tolerate empty body — fixture defaults below
  }
  const questions = body.questions ?? DEFAULT_QUESTIONS;
  const maxSearches = body.maxSearches ?? 8;
  const confidenceTarget = body.confidenceTarget ?? 0.8;

  interface QResult {
    label: string;
    question: string;
    ok: boolean;
    error?: string;
    elapsed_s?: number;
    session_id?: string;
    console_url?: string;
    parsed?: {
      confidence: number;
      stoppedBecause: string;
      citations_count: number;
      search_path_count: number;
      answer_first_300: string;
    };
    last_message_first_200?: string;
    grader?: {
      iterations: number;
      last_result: string | null;
      last_explanation: string | null;
    };
    checks?: {
      c1_citations: CheckResult;
      c2_stop_reason: CheckResult;
      c3_query_diversity: CheckResult;
      c4_confidence: CheckResult;
      block_emitted_as_final_message: CheckResult;
      passed_all_4: boolean;
    };
  }

  const results: QResult[] = [];

  for (const q of questions) {
    const qStart = Date.now();
    const traceId = `eval-researcher:${q.label}:${qStart}`;
    try {
      const output = await createResearcherSession({
        traceId,
        question: q.question,
        contextHint: q.contextHint,
        stoppingCriteria: { maxSearches, confidenceTarget },
      });
      const c1 = checkCitations(output);
      const c2 = checkStopReason(output);
      const c3 = checkQueryDiversity(output);
      const c4 = checkConfidenceCalibration(output);
      const blockCheck = checkBlockEmittedAsFinalMessage(output.lastAgentText);
      const passedAll4 = c1.passed && c2.passed && c3.passed && c4.passed;
      const lastGrade =
        output.outcomesGrades.length > 0
          ? output.outcomesGrades[output.outcomesGrades.length - 1]
          : null;
      results.push({
        label: q.label,
        question: q.question,
        ok: true,
        elapsed_s: Number(((Date.now() - qStart) / 1000).toFixed(1)),
        session_id: output.managedAgentSessionId,
        console_url: `https://console.anthropic.com/managed-agents/sessions/${output.managedAgentSessionId}`,
        parsed: {
          confidence: output.confidence,
          stoppedBecause: output.stoppedBecause,
          citations_count: output.citations.length,
          search_path_count: output.searchPath.length,
          answer_first_300: output.answer.slice(0, 300),
        },
        last_message_first_200: output.lastAgentText.slice(0, 200),
        grader: {
          iterations: output.outcomesGrades.length,
          last_result: lastGrade?.result ?? null,
          last_explanation: lastGrade?.explanation ?? null,
        },
        checks: {
          c1_citations: c1,
          c2_stop_reason: c2,
          c3_query_diversity: c3,
          c4_confidence: c4,
          block_emitted_as_final_message: blockCheck,
          passed_all_4: passedAll4,
        },
      });
    } catch (e) {
      results.push({
        label: q.label,
        question: q.question,
        ok: false,
        elapsed_s: Number(((Date.now() - qStart) / 1000).toFixed(1)),
        error: e instanceof Error ? e.message : String(e),
      });
    }
  }

  // Aggregate.
  const ok_runs = results.filter((r) => r.ok).length;
  const tally = (pred: (r: QResult) => boolean) =>
    results.filter((r) => r.ok && pred(r)).length;

  const summary = {
    questions: questions.length,
    ok_runs,
    failed_runs: questions.length - ok_runs,
    passed_all_4: tally((r) => !!r.checks?.passed_all_4),
    passed_c1_citations: tally((r) => !!r.checks?.c1_citations.passed),
    passed_c2_stop_reason: tally((r) => !!r.checks?.c2_stop_reason.passed),
    passed_c3_diversity: tally((r) => !!r.checks?.c3_query_diversity.passed),
    passed_c4_confidence: tally((r) => !!r.checks?.c4_confidence.passed),
    block_emitted: tally(
      (r) => !!r.checks?.block_emitted_as_final_message.passed,
    ),
    grader_satisfied: tally((r) => r.grader?.last_result === "satisfied"),
    // The gap that matters: how often does the grader say satisfied while
    // mechanical checks fail? That's the rubric-too-soft signal.
    grader_satisfied_but_mechanical_fail: tally(
      (r) =>
        r.grader?.last_result === "satisfied" && !r.checks?.passed_all_4,
    ),
  };

  return NextResponse.json({
    ok: ok_runs === questions.length,
    elapsed_s: Number(((Date.now() - start) / 1000).toFixed(1)),
    config: { maxSearches, confidenceTarget },
    summary,
    results,
  });
}
