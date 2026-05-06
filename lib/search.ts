import { tavily, type TavilyClient } from "@tavily/core";
import { config } from "./config";

export interface SearchResult {
  title: string;
  url: string;
  snippet: string;
  content?: string;
  score?: number;
}

let client: TavilyClient | null = null;

function getClient(): TavilyClient {
  if (!client) {
    client = tavily({ apiKey: config.tavilyKey });
  }
  return client;
}

export async function search(
  query: string,
  maxResults = 5,
): Promise<SearchResult[]> {
  const response = await getClient().search(query, {
    maxResults,
    searchDepth: "advanced",
  });

  return response.results.map((r) => ({
    title: r.title,
    url: r.url,
    snippet: r.content?.slice(0, 280) ?? "",
    content: r.content,
    score: r.score,
  }));
}
