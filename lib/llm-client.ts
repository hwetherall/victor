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
  | "micky"
  | "vision"
  | "contrarian";

export const MODEL_MAP: Record<AgentRole, LLMModel> = {
  "evidence-web": MODELS.mistralLarge,
  "evidence-doc": MODELS.geminiPro,
  evaluator: MODELS.sonnet,
  tier2: MODELS.sonnet,
  decision: MODELS.opus,
  micky: MODELS.sonnet,
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
  return parseModelJson<T>(role, raw);
}

/**
 * Robust JSON extractor for model outputs. Models occasionally:
 *  - Wrap JSON in a single ```json ... ``` fence (handled by old code)
 *  - Emit MULTIPLE fenced blocks with free text between (a "first attempt"
 *    plus a self-corrected "let me redo that" — the failure mode that
 *    blew up evaluator runs in production)
 *  - Add a sentence of preamble or postamble around an otherwise-valid JSON
 *    object
 *
 * Strategy: try variants in increasing tolerance, return the FIRST one that
 * parses. If multiple fenced blocks exist we prefer the LAST — the model's
 * correction usually arrives last.
 */
export function extractModelJson(raw: string): unknown {
  const trimmed = raw.trim();

  // 1. Direct parse — the happy path.
  const direct = tryParse(trimmed);
  if (direct.ok) return direct.value;

  // 2. All fenced ```json ... ``` (or plain ``` ... ```) blocks. Last-first
  //    so a self-correction wins over the original.
  const fenceRe = /```(?:json)?\s*([\s\S]*?)\s*```/g;
  const blocks: string[] = [];
  let m: RegExpExecArray | null;
  while ((m = fenceRe.exec(trimmed)) !== null) blocks.push(m[1].trim());
  for (let i = blocks.length - 1; i >= 0; i--) {
    const r = tryParse(blocks[i]);
    if (r.ok) return r.value;
  }

  // 3. Embedded object/array — find the largest balanced {…} or […]
  //    substring and try that. Cheap heuristic: greedy match from first
  //    brace to last brace, parser does the validation.
  for (const re of [/\{[\s\S]*\}/, /\[[\s\S]*\]/]) {
    const match = trimmed.match(re);
    if (match) {
      const r = tryParse(match[0]);
      if (r.ok) return r.value;
    }
  }

  throw new Error("could not extract JSON from model response");
}

function tryParse(s: string): { ok: true; value: unknown } | { ok: false } {
  try {
    return { ok: true, value: JSON.parse(s) };
  } catch {
    return { ok: false };
  }
}

function parseModelJson<T>(
  role: AgentRole,
  raw: string,
  fnName: "completeJson" | "completeMultimodalJson" = "completeJson",
): T {
  try {
    return extractModelJson(raw) as T;
  } catch (e) {
    throw new Error(
      `${fnName}(${role}): JSON extraction failed (${e instanceof Error ? e.message : e})\n` +
        `raw response:\n${raw}`,
    );
  }
}

/** @deprecated kept for any external callers; new code should use extractModelJson. */
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
  return parseModelJson<T>(role, raw, "completeMultimodalJson");
}
