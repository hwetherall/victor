// SPEC §6.4 doc-mode retrieval. Embeds the query, calls the `similar_chunks`
// Postgres function via the InsForge SDK rpc(), returns the top-K rows by
// cosine similarity. The function is defined in
// migrations/20260505231915_similar-chunks-fn.sql.

import { insforge } from "./db";
import { embedSingle } from "./embeddings";
import type { Source, SourceMetadata } from "./schema";

export interface RetrievedChunk extends Source {
  /** Cosine similarity in [0, 1] (higher = more similar). */
  similarity?: number;
}

export async function retrieveEvidence(
  query: string,
  caseId: string,
  topK = 5,
): Promise<RetrievedChunk[]> {
  const queryVec = await embedSingle(query);
  const { data, error } = await insforge.database.rpc("similar_chunks", {
    q_embedding: `[${queryVec.join(",")}]`,
    q_case_id: caseId,
    q_top_k: topK,
  });

  if (error) {
    throw new Error(`retrieveEvidence rpc: ${error.message}`);
  }
  return (data as RetrievedChunk[] | null) ?? [];
}

export type { Source, SourceMetadata };
