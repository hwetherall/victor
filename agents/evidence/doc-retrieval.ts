// SPEC §6.4 doc mode. pgvector top-K retrieval → Gemini scoring → evidence
// node + evidence_sources linkage (page-number preserved). Sources are NOT
// re-inserted here — they were created by /api/ingest. We re-use them.

import { insforge } from "@/lib/db";
import { MODELS } from "@/lib/llm-client";
import { retrieveEvidence } from "@/lib/retrieval";
import { scoreEvidence } from "./score";
import type {
  EvidenceContent,
  HypothesisContent,
  SourceMetadata,
  TreeNode,
} from "@/lib/schema";
import type { CaseContext } from "./web-search";

const DOC_TOPK_PER_LEAF = 3;

export async function gatherDocEvidence(
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
  const chunks = await retrieveEvidence(claim, ctx.caseId, DOC_TOPK_PER_LEAF);
  if (chunks.length === 0) return [];

  const scored = await scoreEvidence(
    "evidence-doc",
    claim,
    chunks.map((c) => {
      const meta = (c.metadata ?? {}) as SourceMetadata;
      const pageInfo =
        typeof meta.pageNumber === "number" ? `p.${meta.pageNumber}` : "";
      return {
        title: c.title ?? "(unknown)",
        body: c.content_extract ?? "",
        origin: [pageInfo, meta.author, meta.stake].filter(Boolean).join(" · "),
      };
    }),
  );

  const evidenceNodes: TreeNode[] = [];
  for (let i = 0; i < scored.length; i++) {
    const chunk = chunks[i];
    const item = scored[i];
    const meta = (chunk.metadata ?? {}) as SourceMetadata;

    const evContent: EvidenceContent = {
      finding: item.finding,
      supports: item.supports,
      strength: item.strength,
      sourceQuote: item.sourceQuote,
    };

    const labelBase = chunk.title ?? "Source";
    const labelPage =
      typeof meta.pageNumber === "number" ? ` · p.${meta.pageNumber}` : "";
    const label = `${labelBase}${labelPage}`.slice(0, 80);

    const { data: evRows, error: evErr } = await insforge.database
      .from("tree_nodes")
      .insert([
        {
          case_id: ctx.caseId,
          parent_id: hypothesis.id,
          type: "evidence" as const,
          label,
          content: evContent,
          status: "complete",
          model_used: MODELS.geminiPro,
        },
      ])
      .select();
    if (evErr) {
      console.warn(`gatherDocEvidence: evidence insert failed: ${evErr.message}`);
      continue;
    }
    const evRow = (evRows as TreeNode[] | null)?.[0];
    if (!evRow) continue;

    const { error: linkErr } = await insforge.database
      .from("evidence_sources")
      .insert([
        {
          evidence_node_id: evRow.id,
          source_id: chunk.id,
          quote:
            item.sourceQuote ??
            (chunk.content_extract ?? "").slice(0, 280),
          page_number:
            typeof meta.pageNumber === "number" ? meta.pageNumber : null,
        },
      ]);
    if (linkErr) {
      console.warn(`gatherDocEvidence: linkage insert failed: ${linkErr.message}`);
    }

    evidenceNodes.push(evRow);
  }

  return evidenceNodes;
}
