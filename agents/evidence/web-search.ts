// SPEC §6.4 web mode. Tavily query → 3 results → Mistral scoring (one batched
// call) → evidence_node + sources + evidence_sources rows.

import { search } from "@/lib/search";
import { insforge } from "@/lib/db";
import { MODELS } from "@/lib/llm-client";
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
  substitutions: Record<string, string>;
}

const WEB_RESULTS_PER_LEAF = 3;

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

  const claim = (hypothesis.content as HypothesisContent).claim;
  const query = buildQuery(hypothesis.label, ctx.substitutions);

  const results = await search(query, WEB_RESULTS_PER_LEAF);
  if (results.length === 0) return [];

  const scored = await scoreEvidence(
    "evidence-web",
    claim,
    results.map((r) => ({
      title: r.title,
      body: r.snippet,
      origin: r.url,
    })),
  );

  const evidenceNodes: TreeNode[] = [];
  for (let i = 0; i < scored.length; i++) {
    const result = results[i];
    const item = scored[i];

    // sources row
    const { data: srcRows, error: srcErr } = await insforge.database
      .from("sources")
      .insert([
        {
          case_id: ctx.caseId,
          type: "web" as const,
          uri: result.url,
          title: result.title.slice(0, 200),
          content_extract: result.snippet,
          metadata: { stake: "neutral" },
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

    // evidence_sources linkage
    const { error: linkErr } = await insforge.database
      .from("evidence_sources")
      .insert([
        {
          evidence_node_id: evRow.id,
          source_id: sourceId,
          quote: item.sourceQuote ?? result.snippet.slice(0, 280),
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
