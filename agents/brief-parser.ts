// SPEC §6.1 — v1 stub. Returns hardcoded values from cases/<id>.yaml.
// Real LLM parsing is deferred to v2 (SPEC §13).

import { loadCase } from "@/lib/framework-registry";
import type { ParsedBrief } from "@/lib/schema";

export async function parseBrief(caseId: string): Promise<ParsedBrief> {
  const config = loadCase(caseId);

  return {
    thresholds: config.thresholds,
    constraints: [],
    weights: config.weights,
    infoGaps: [],
    risks: [],
    stakeholderQuestions: [],
    documentProvenance: config.inputDocs.map((d, i) => ({
      sourceId: `doc-${i}`,
      author: d.author,
      stake: d.stake,
    })),
  };
}
