// SPEC §6.4 web mode. Tavily multi-query search → Mistral scoring → evidence
// node + sources + evidence_sources rows.
//
// v2 changes:
//  - WEB_RESULTS_PER_LEAF bumped 3 → 6 (per leaf, post-dedup)
//  - 3 queries per leaf: original + 2 Mistral-generated variants, each
//    fetching 4 raw results, then deduped by URL and capped at 6
//  - Full Tavily `content` (capped at 3000 chars) is what reaches the scorer
//    and what's stored in sources.content_extract — not the 280-char snippet

import { search, type SearchResult } from "@/lib/search";
import { insforge } from "@/lib/db";
import { MODELS, completeJson, type Message } from "@/lib/llm-client";
import { buildTestDrivenQueries } from "@/lib/query-builder";
import { scoreEvidence } from "./score";
import type {
  EvidenceContent,
  HypothesisContent,
  TreeNode,
} from "@/lib/schema";

export interface CaseContext {
  /** DB uuid of the case row. */
  caseId: string;
  caseTitle: string;
  caseQuestion: string;
  /** Framework id from cases/<id>.yaml, used to load test-driven query
   *  templates (improve.md §3). */
  frameworkId: string;
  substitutions: Record<string, string>;
}

const MAX_TEST_DRIVEN_QUERIES = 4;

const WEB_RESULTS_PER_LEAF = 6;
const RAW_PER_QUERY = 4;
const MAX_CONTENT_CHARS = 3000;

export async function gatherWebEvidence(
  hypothesis: TreeNode,
  ctx: CaseContext,
): Promise<TreeNode[]> {
  if (
    hypothesis.type !== "sub_hypothesis" &&
    hypothesis.type !== "hypothesis"
  ) {
    return [];
  }

  const content = hypothesis.content as HypothesisContent;
  const claim = content.claim;

  // Test-driven path (improve.md §3): when the test.metric matches a template,
  // drive search from the test variable, not the topic. Mistral expansion is
  // reserved for the fallback path where no template exists.
  const testDriven = buildTestDrivenQueries(content, {
    frameworkId: ctx.frameworkId,
    substitutions: ctx.substitutions,
  }).slice(0, MAX_TEST_DRIVEN_QUERIES);

  let queries: string[];
  if (testDriven.length > 0) {
    queries = testDriven;
  } else {
    const baseQuery = buildQuery(hypothesis.label, ctx.substitutions);
    const variants = await expandQueries(
      hypothesis.label,
      claim,
      ctx.substitutions,
    );
    queries = [baseQuery, ...variants].slice(0, 3);
  }

  // Run all queries in parallel.
  const settled = await Promise.allSettled(
    queries.map((q) => search(q, RAW_PER_QUERY)),
  );
  const allResults: SearchResult[] = [];
  for (const r of settled) {
    if (r.status === "fulfilled") allResults.push(...r.value);
  }
  if (allResults.length === 0) return [];

  // Dedupe by URL, prefer the highest-scoring instance.
  const byUrl = new Map<string, SearchResult>();
  for (const r of allResults) {
    const existing = byUrl.get(r.url);
    if (!existing || (r.score ?? 0) > (existing.score ?? 0)) {
      byUrl.set(r.url, r);
    }
  }
  const deduped = Array.from(byUrl.values()).sort(
    (a, b) => (b.score ?? 0) - (a.score ?? 0),
  );
  const top = deduped.slice(0, WEB_RESULTS_PER_LEAF);

  const scored = await scoreEvidence(
    "evidence-web",
    claim,
    top.map((r) => ({
      title: r.title,
      body: (r.content ?? r.snippet).slice(0, MAX_CONTENT_CHARS),
      origin: r.url,
      // Web sources default to third-party. Per-domain overrides could go
      // here later (e.g. tag a vendor's own marketing page as
      // pre-disposed-favourable).
      sourceStake: "third-party" as const,
    })),
  );

  const evidenceNodes: TreeNode[] = [];
  for (let i = 0; i < scored.length; i++) {
    const result = top[i];
    const item = scored[i];
    const fullContent = (result.content ?? result.snippet).slice(
      0,
      MAX_CONTENT_CHARS,
    );

    // sources row
    const { data: srcRows, error: srcErr } = await insforge.database
      .from("sources")
      .insert([
        {
          case_id: ctx.caseId,
          type: "web" as const,
          uri: result.url,
          title: result.title.slice(0, 200),
          content_extract: fullContent,
          metadata: { stake: "third-party" },
        },
      ])
      .select();
    if (srcErr) {
      console.warn(`gatherWebEvidence: source insert failed: ${srcErr.message}`);
      continue;
    }
    const sourceId = (srcRows as { id: string }[] | null)?.[0]?.id;
    if (!sourceId) continue;

    // tree_nodes evidence row
    const evContent: EvidenceContent = {
      finding: item.finding,
      supports: item.supports,
      strength: item.strength,
      sourceQuote: item.sourceQuote,
      sourceStake: item.sourceStake,
      rawStrength: item.rawStrength,
    };
    const { data: evRows, error: evErr } = await insforge.database
      .from("tree_nodes")
      .insert([
        {
          case_id: ctx.caseId,
          parent_id: hypothesis.id,
          type: "evidence" as const,
          label: result.title.slice(0, 80),
          content: evContent,
          status: "complete",
          model_used: MODELS.mistralLarge,
        },
      ])
      .select();
    if (evErr) {
      console.warn(`gatherWebEvidence: evidence insert failed: ${evErr.message}`);
      continue;
    }
    const evRow = (evRows as TreeNode[] | null)?.[0];
    if (!evRow) continue;

    // evidence_sources linkage — quote is full sourceQuote when the scorer
    // returned one, else the first ~500 chars of full content.
    const fallbackQuote = fullContent.slice(0, 500);
    const { error: linkErr } = await insforge.database
      .from("evidence_sources")
      .insert([
        {
          evidence_node_id: evRow.id,
          source_id: sourceId,
          quote: item.sourceQuote ?? fallbackQuote,
          page_number: null,
        },
      ]);
    if (linkErr) {
      console.warn(`gatherWebEvidence: linkage insert failed: ${linkErr.message}`);
    }

    evidenceNodes.push(evRow);
  }

  return evidenceNodes;
}

// ─── Query construction ─────────────────────────────────────────────────────

function buildQuery(
  hypothesisLabel: string,
  subs: Record<string, string>,
): string {
  const company = subs.COMPANY ?? "";
  const product = subs.PRODUCT ?? "";
  // Strip parenthetical aside from product to keep the query tight.
  const productClean = product.replace(/\s*\(.*?\)\s*/g, " ").trim();
  return [company, productClean, hypothesisLabel].filter(Boolean).join(" ").trim();
}

/**
 * Ask Mistral for 2 alternative search queries that probe the same hypothesis
 * from different angles (e.g. quantitative vs competitive vs regulatory). On
 * failure (parse error, model unavailable) returns an empty array — caller
 * falls back to the single base query.
 */
async function expandQueries(
  label: string,
  claim: string,
  subs: Record<string, string>,
): Promise<string[]> {
  const company = subs.COMPANY ?? "";
  const product = subs.PRODUCT ?? "";
  const messages: Message[] = [
    {
      role: "system",
      content: [
        "You generate web search query variants for strategic-analysis evidence gathering.",
        "Given a hypothesis claim and the company/product context, write 2 alternative",
        "search queries that probe the SAME claim from DIFFERENT angles — e.g.",
        "quantitative data, competitive landscape, regulatory or technical risk.",
        "Each query should be 4-10 words, web-search-friendly, and NOT a verbatim",
        "copy of the hypothesis label.",
        "",
        'Return JSON: { "queries": ["...", "..."] } — exactly 2 strings.',
      ].join("\n"),
    },
    {
      role: "user",
      content: [
        `Company: ${company}`,
        `Product: ${product}`,
        `Hypothesis label: ${label}`,
        `Claim: ${claim}`,
      ].join("\n"),
    },
  ];

  try {
    const parsed = await completeJson<{ queries?: unknown }>(
      "evidence-web",
      messages,
      { temperature: 0.4 },
    );
    const arr = Array.isArray(parsed.queries) ? parsed.queries : [];
    return arr
      .filter((q): q is string => typeof q === "string" && q.trim().length > 0)
      .slice(0, 2)
      .map((q) => q.trim());
  } catch (e) {
    console.warn(
      `expandQueries fallback (single query): ${e instanceof Error ? e.message : e}`,
    );
    return [];
  }
}
