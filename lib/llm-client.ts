import OpenAI from "openai";
import { config } from "./config";

// ─── Models ──────────────────────────────────────────────────────────────────
// Slugs use OpenRouter's namespaced format (vendor/model). Update against
// https://openrouter.ai/models if any are renamed or replaced.
//
// SPEC §6.4 model assignment:
//   web evidence  → Mistral (cheap, parallel)
//   doc retrieval → Gemini (long context)
//   evaluator     → Sonnet  (judgment)
//   decision      → Opus    (final synthesis)

export const MODELS = {
  sonnet: "anthropic/claude-sonnet-4.6",
  opus: "anthropic/claude-opus-4.7",
  haiku: "anthropic/claude-haiku-4.5",
  mistralLarge: "mistralai/mistral-medium-3-5",
  geminiPro: "google/gemini-3.1-pro-preview",
} as const;

export type LLMModel = (typeof MODELS)[keyof typeof MODELS];

export type AgentRole =
  | "evidence-web"
  | "evidence-doc"
  | "evaluator"
  | "tier2"
  | "decision"
  | "vision"
  | "contrarian";

export const MODEL_MAP: Record<AgentRole, LLMModel> = {
  "evidence-web": MODELS.mistralLarge,
  "evidence-doc": MODELS.geminiPro,
  evaluator: MODELS.sonnet,
  tier2: MODELS.sonnet,
  decision: MODELS.opus,
  // Sonnet 4.6 has the most reliable PDF understanding via OpenRouter.
  vision: MODELS.sonnet,
  // Contrarian uses Sonnet but is labelled distinctly via model_used so the
  // UI can render a red-team badge separate from regular evaluator outputs.
  contrarian: MODELS.sonnet,
};

// ─── Client ──────────────────────────────────────────────────────────────────

let openrouter: OpenAI | null = null;

function getClient(): OpenAI {
  if (!openrouter) {
    openrouter = new OpenAI({
      apiKey: config.openRouterKey,
      baseURL: "https://openrouter.ai/api/v1",
      defaultHeaders: {
        "HTTP-Referer": "https://agent-victor.local",
        "X-Title": "Agent Victor",
      },
    });
  }
  return openrouter;
}

// ─── API ─────────────────────────────────────────────────────────────────────

export interface Message {
  role: "system" | "user" | "assistant";
  content: string;
}

export interface CompletionOptions {
  temperature?: number;
  maxTokens?: number;
  /** When true, the response_format requests strict JSON. */
  jsonMode?: boolean;
}

export async function complete(
  model: LLMModel,
  messages: Message[],
  options: CompletionOptions = {},
): Promise<string> {
  const response = await getClient().chat.completions.create({
    model,
    messages,
    temperature: options.temperature ?? 0.2,
    max_tokens: options.maxTokens,
    ...(options.jsonMode ? { response_format: { type: "json_object" } } : {}),
  });

  const text = response.choices[0]?.message?.content;
  if (!text) {
    throw new Error(
      `LLM returned empty response (model=${model}, finish_reason=${response.choices[0]?.finish_reason})`,
    );
  }
  return text;
}

/** Convenience: route by agent role rather than raw model slug. */
export function completeAs(
  role: AgentRole,
  messages: Message[],
  options: CompletionOptions = {},
): Promise<string> {
  return complete(MODEL_MAP[role], messages, options);
}

/**
 * JSON variant: forces jsonMode, strips Markdown code-fences (Anthropic models
 * on OpenRouter sometimes wrap JSON in ```json...``` despite response_format),
 * and returns the parsed object. Throws with the raw text on parse failure so
 * callers can see what the model actually said.
 */
export async function completeJson<T = unknown>(
  role: AgentRole,
  messages: Message[],
  options: CompletionOptions = {},
): Promise<T> {
  const raw = await completeAs(role, messages, { ...options, jsonMode: true });
  const stripped = stripJsonFences(raw);
  try {
    return JSON.parse(stripped) as T;
  } catch (e) {
    throw new Error(
      `completeJson(${role}): JSON.parse failed (${e instanceof Error ? e.message : e})\n` +
        `raw response:\n${raw}`,
    );
  }
}

/** Strip surrounding ```json ... ``` or ``` ... ``` fences if present. */
export function stripJsonFences(s: string): string {
  const trimmed = s.trim();
  const fenced = trimmed.match(/^```(?:json)?\s*([\s\S]*?)\s*```$/);
  if (fenced) return fenced[1].trim();
  return trimmed;
}

// ─── Multimodal (PDF + image input) ──────────────────────────────────────────
// OpenRouter accepts PDF and image content blocks directly in the user message.
// The OpenAI SDK's strict types don't include the `file` block, so we cast to
// `any` at the call boundary. The request body is JSON-serialised as-is.

export type ContentBlock =
  | { type: "text"; text: string }
  | { type: "image_url"; image_url: { url: string } }
  | { type: "file"; file: { filename: string; file_data: string } };

export interface MultimodalMessage {
  role: "system" | "user" | "assistant";
  content: string | ContentBlock[];
}

export async function completeMultimodal(
  role: AgentRole,
  messages: MultimodalMessage[],
  options: CompletionOptions = {},
): Promise<string> {
  const model = MODEL_MAP[role];
  const body = {
    model,
    messages,
    temperature: options.temperature ?? 0.2,
    max_tokens: options.maxTokens,
    stream: false as const,
    ...(options.jsonMode ? { response_format: { type: "json_object" } } : {}),
  };
  // The OpenAI SDK's strict types reject `type: "file"` content blocks, but
  // OpenRouter accepts and forwards them. Cast at the call boundary.
  const response = (await getClient().chat.completions.create(
    body as unknown as Parameters<
      ReturnType<typeof getClient>["chat"]["completions"]["create"]
    >[0],
  )) as OpenAI.Chat.ChatCompletion;

  const text = response.choices[0]?.message?.content;
  if (!text) {
    throw new Error(
      `LLM returned empty response (model=${model}, finish_reason=${response.choices[0]?.finish_reason})`,
    );
  }
  return typeof text === "string" ? text : JSON.stringify(text);
}

export async function completeMultimodalJson<T = unknown>(
  role: AgentRole,
  messages: MultimodalMessage[],
  options: CompletionOptions = {},
): Promise<T> {
  const raw = await completeMultimodal(role, messages, {
    ...options,
    jsonMode: true,
  });
  const stripped = stripJsonFences(raw);
  try {
    return JSON.parse(stripped) as T;
  } catch (e) {
    throw new Error(
      `completeMultimodalJson(${role}): JSON.parse failed (${e instanceof Error ? e.message : e})\n` +
        `raw response:\n${raw}`,
    );
  }
}
