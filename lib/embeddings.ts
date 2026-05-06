import OpenAI from "openai";
import { config } from "./config";

export const EMBEDDING_MODEL = "text-embedding-3-small";
export const EMBEDDING_DIMS = 1536;

let client: OpenAI | null = null;

function getClient(): OpenAI {
  if (!client) {
    client = new OpenAI({ apiKey: config.openAiKey });
  }
  return client;
}

/** Embed a batch of texts. OpenAI accepts up to ~2048 inputs per call. */
export async function embedBatch(texts: string[]): Promise<number[][]> {
  if (texts.length === 0) return [];
  const response = await getClient().embeddings.create({
    model: EMBEDDING_MODEL,
    input: texts,
  });
  return response.data.map((d) => d.embedding);
}

export async function embedSingle(text: string): Promise<number[]> {
  const [v] = await embedBatch([text]);
  return v;
}

/** Format a vector for pgvector storage: '[v1,v2,...]' as text. */
export function vectorToString(vec: number[]): string {
  return `[${vec.join(",")}]`;
}
