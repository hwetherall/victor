// Shared scoring helper used by web-search and doc-retrieval evidence agents.
// Sends a hypothesis claim + N text items in a single LLM call and gets back
// EvidenceContent-shaped JSON per item, preserving input order.

import { completeJson, type AgentRole, type Message } from "@/lib/llm-client";
import type {
  EvidenceContent,
  EvidenceStrength,
  EvidenceSupports,
  SourceStake,
} from "@/lib/schema";

export interface ScoredItem {
  finding: string;
  supports: EvidenceSupports;
  /** Final strength after stake adjustment. */
  strength: EvidenceStrength;
  sourceQuote?: string;
  sourceStake?: SourceStake;
  /** Pre-adjustment strength when stake adjustment fired. */
  rawStrength?: EvidenceStrength;
}

export interface EvidenceItem {
  title: string;
  body: string;
  /** Optional context to surface in the prompt. */
  origin?: string;
  /** Bias of the source this item came from. Drives the post-LLM stake
   *  adjustment (improve.md §5). */
  sourceStake?: SourceStake;
}

export async function scoreEvidence(
  role: AgentRole,
  claim: string,
  items: EvidenceItem[],
): Promise<ScoredItem[]> {
  if (items.length === 0) return [];

  const itemsBlock = items
    .map(
      (item, i) =>
        `[${i + 1}] ${item.title}${item.origin ? ` — ${item.origin}` : ""}\n${item.body}`,
    )
    .join("\n\n---\n\n");

  const messages: Message[] = [
    {
      role: "system",
      content: [
        "You score evidence for a strategic-analysis claim. For EACH item",
        "you receive (numbered 1..N), produce one entry in the output array.",
        "Order MUST match the input order — index k maps to input k.",
        "",
        "For each item return:",
        "  finding:    one-sentence summary of how this item bears on the claim",
        '  supports:   "for" | "against" | "mixed"',
        '  strength:   "weak" | "moderate" | "strong"',
        "  sourceQuote: a verbatim 1–2 sentence excerpt from the item that justifies the rating",
        "",
        "Calibration:",
        "  strong  = direct quantitative or named-source data on the claim",
        "  moderate = relevant qualitative or indirect data",
        "  weak     = tangential or generic",
        "",
        "Return JSON with shape:",
        '{ "items": [ { "finding":..., "supports":..., "strength":..., "sourceQuote":... }, ... ] }',
      ].join("\n"),
    },
    {
      role: "user",
      content: [
        `Hypothesis claim: ${claim}`,
        "",
        `Items (${items.length}):`,
        itemsBlock,
        "",
        "Respond with JSON only.",
      ].join("\n"),
    },
  ];

  const parsed = await completeJson<{ items?: unknown }>(role, messages, {
    temperature: 0.2,
  });

  const arr = parsed.items;
  if (!Array.isArray(arr)) {
    throw new Error('scoreEvidence: response missing "items" array');
  }

  return arr
    .slice(0, items.length)
    .map((raw, i) => normalize(raw, i))
    .map((scored, i) => applyStakeAdjustment(scored, items[i].sourceStake));
}

function normalize(raw: unknown, idx: number): ScoredItem {
  const r = (raw ?? {}) as Partial<ScoredItem>;
  return {
    finding:
      typeof r.finding === "string" && r.finding.length > 0
        ? r.finding
        : `(no finding extracted for item ${idx + 1})`,
    supports: ["for", "against", "mixed"].includes(r.supports as string)
      ? (r.supports as EvidenceSupports)
      : "mixed",
    strength: ["weak", "moderate", "strong"].includes(r.strength as string)
      ? (r.strength as EvidenceStrength)
      : "weak",
    sourceQuote:
      typeof r.sourceQuote === "string" && r.sourceQuote.length > 0
        ? r.sourceQuote
        : undefined,
  };
}

/**
 * One-step asymmetric stake adjustment (improve.md §5, EPIC-V3-03).
 *
 * Rule:
 *  - `third-party` / `neutral-advocate` / undefined → no change (the brief
 *    author has no financial stake in the outcome)
 *  - `pre-disposed-favourable` (e.g. ABB deck): supportive findings get
 *    demoted one step (the source would have surfaced these regardless);
 *    contradicting findings get promoted (the source's bias would have
 *    suppressed them — their presence is high information value)
 *  - `pre-disposed-against`: mirror
 *  - `mixed` evidence is never adjusted
 *
 *  This is deterministic and runs AFTER the LLM scorer — never inside the
 *  prompt.
 */
export function applyStakeAdjustment(
  item: ScoredItem,
  stake: SourceStake | undefined,
): ScoredItem {
  if (!stake || stake === "third-party" || stake === "neutral-advocate") {
    return { ...item, sourceStake: stake };
  }
  if (item.supports === "mixed") {
    return { ...item, sourceStake: stake };
  }

  const biasDirection: EvidenceSupports =
    stake === "pre-disposed-favourable" ? "for" : "against";
  const adjusted: EvidenceStrength =
    item.supports === biasDirection
      ? demoteStep(item.strength)
      : promoteStep(item.strength);

  if (adjusted === item.strength) {
    return { ...item, sourceStake: stake };
  }
  return {
    ...item,
    strength: adjusted,
    rawStrength: item.strength,
    sourceStake: stake,
  };
}

function demoteStep(s: EvidenceStrength): EvidenceStrength {
  if (s === "strong") return "moderate";
  if (s === "moderate") return "weak";
  return "weak";
}

function promoteStep(s: EvidenceStrength): EvidenceStrength {
  if (s === "weak") return "moderate";
  if (s === "moderate") return "strong";
  return "strong";
}

export type { EvidenceContent };
