// v2 contrarian / red-team pass. After confidence rollup, picks the top-2
// highest-confidence hypotheses and asks Sonnet for the single strongest
// counter-argument or disconfirming data point per hypothesis. Counter-findings
// are written as evidence children of the *hypothesis* (not sub-hypothesis)
// with `model_used = "sonnet-contrarian"` so the UI can render a distinct
// red-team badge.
//
// Failures are caught — a contrarian outage never blocks the run.

import { insforge } from "@/lib/db";
import { completeJson, type Message } from "@/lib/llm-client";
import type {
  EvidenceContent,
  EvidenceNode,
  HypothesisContent,
  HypothesisNode,
  TreeNode,
} from "@/lib/schema";

const CONTRARIAN_MODEL_LABEL = "sonnet-contrarian";
const TARGET_COUNT = 2;
const SUPPORT_EVIDENCE_PER_HYPOTHESIS = 3;

interface CounterFinding {
  counterFinding: string;
  sourceQuote?: string;
}

export async function runContrarianPass(
  caseId: string,
  hypotheses: TreeNode[],
): Promise<TreeNode[]> {
  const targets = pickTargets(hypotheses);
  if (targets.length === 0) return [];

  const inserted: TreeNode[] = [];
  for (const h of targets) {
    try {
      const supportFindings = await fetchSupportingFindings(caseId, h.id);
      const counter = await generateCounter(h, supportFindings);
      if (!counter) continue;

      const evRow = await persistContrarian(caseId, h, counter);
      if (evRow) inserted.push(evRow);
    } catch (e) {
      console.warn(
        `runContrarianPass: failed for hypothesis ${h.id}: ${e instanceof Error ? e.message : e}`,
      );
    }
  }
  return inserted;
}

// ─── Target selection ───────────────────────────────────────────────────────

function pickTargets(hypotheses: TreeNode[]): HypothesisNode[] {
  const tier1 = hypotheses.filter(
    (h): h is HypothesisNode =>
      h.type === "hypothesis" && typeof h.confidence === "number",
  );
  return [...tier1]
    .sort((a, b) => (b.confidence ?? 0) - (a.confidence ?? 0))
    .slice(0, TARGET_COUNT);
}

// ─── Support evidence fetch ─────────────────────────────────────────────────

async function fetchSupportingFindings(
  caseId: string,
  hypothesisId: string,
): Promise<string[]> {
  // Walk one level down: evidence rows under the hypothesis itself, plus
  // evidence rows under each of its sub-hypothesis children.
  const { data: subs, error: subErr } = await insforge.database
    .from("tree_nodes")
    .select("id")
    .eq("case_id", caseId)
    .eq("parent_id", hypothesisId)
    .eq("type", "sub_hypothesis");
  if (subErr) throw new Error(`fetchSupportingFindings subs: ${subErr.message}`);
  const subIds = ((subs as { id: string }[] | null) ?? []).map((s) => s.id);

  const parentIds = [hypothesisId, ...subIds];
  const { data: ev, error: evErr } = await insforge.database
    .from("tree_nodes")
    .select("content, model_used")
    .eq("case_id", caseId)
    .eq("type", "evidence")
    .in("parent_id", parentIds);
  if (evErr) throw new Error(`fetchSupportingFindings ev: ${evErr.message}`);

  const rows = (ev as Pick<EvidenceNode, "content" | "model_used">[] | null) ?? [];
  return rows
    .filter((r) => {
      const c = r.content as EvidenceContent;
      return (
        c.supports === "for" &&
        r.model_used !== CONTRARIAN_MODEL_LABEL &&
        typeof c.finding === "string" &&
        c.finding.length > 0
      );
    })
    .slice(0, SUPPORT_EVIDENCE_PER_HYPOTHESIS)
    .map((r) => (r.content as EvidenceContent).finding);
}

// ─── Sonnet call ────────────────────────────────────────────────────────────

async function generateCounter(
  h: HypothesisNode,
  supportFindings: string[],
): Promise<CounterFinding | null> {
  const claim = (h.content as HypothesisContent).claim;
  const supportBlock =
    supportFindings.length > 0
      ? supportFindings.map((f, i) => `  ${i + 1}. ${f}`).join("\n")
      : "  (none recorded)";

  const messages: Message[] = [
    {
      role: "system",
      content: [
        "You are a red-team strategy analyst. Given a hypothesis the rest of the",
        "team is leaning toward accepting, your job is to surface the SINGLE strongest",
        "counter-argument or disconfirming data point that a skeptical investor would",
        "raise. Focus on what the supporting evidence is missing, what assumptions",
        "look fragile, or what alternative interpretations of the data are possible.",
        "",
        "Return JSON:",
        '{ "counterFinding": "<one-sentence counter-argument, specific and concrete>",',
        '  "sourceQuote": "<optional: a verbatim 1-2 sentence concern as if quoted from a skeptic>" }',
        "",
        "Be substantive — no hedge words, no 'it could be argued'. State the strongest",
        "objection plainly.",
      ].join("\n"),
    },
    {
      role: "user",
      content: [
        `Hypothesis: ${h.label} — ${claim}`,
        `Current confidence: ${h.confidence?.toFixed(2) ?? "—"}`,
        "",
        "Top supporting evidence findings the team has gathered:",
        supportBlock,
        "",
        "Produce the strongest counter-argument as JSON.",
      ].join("\n"),
    },
  ];

  const parsed = await completeJson<Partial<CounterFinding>>(
    "contrarian",
    messages,
    { temperature: 0.4 },
  );
  if (typeof parsed.counterFinding !== "string" || parsed.counterFinding.length === 0) {
    return null;
  }
  return {
    counterFinding: parsed.counterFinding,
    sourceQuote:
      typeof parsed.sourceQuote === "string" && parsed.sourceQuote.length > 0
        ? parsed.sourceQuote
        : undefined,
  };
}

// ─── Persistence ────────────────────────────────────────────────────────────

async function persistContrarian(
  caseId: string,
  hypothesis: HypothesisNode,
  counter: CounterFinding,
): Promise<TreeNode | null> {
  // Synthetic source row so the source modal has something to render.
  const { data: srcRows, error: srcErr } = await insforge.database
    .from("sources")
    .insert([
      {
        case_id: caseId,
        type: "user_input" as const,
        uri: null,
        title: "Red-team analysis",
        content_extract: counter.counterFinding,
        metadata: { stake: "contrarian", author: "Agent Victor red-team" },
      },
    ])
    .select();
  if (srcErr) {
    console.warn(`persistContrarian: source insert failed: ${srcErr.message}`);
    return null;
  }
  const sourceId = (srcRows as { id: string }[] | null)?.[0]?.id;
  if (!sourceId) return null;

  const evContent: EvidenceContent = {
    finding: counter.counterFinding,
    supports: "against",
    strength: "moderate",
    sourceQuote: counter.sourceQuote,
  };

  const { data: evRows, error: evErr } = await insforge.database
    .from("tree_nodes")
    .insert([
      {
        case_id: caseId,
        parent_id: hypothesis.id,
        type: "evidence" as const,
        label: `Red-team challenge: ${hypothesis.label.slice(0, 60)}`,
        content: evContent,
        status: "complete",
        model_used: CONTRARIAN_MODEL_LABEL,
      },
    ])
    .select();
  if (evErr) {
    console.warn(`persistContrarian: evidence insert failed: ${evErr.message}`);
    return null;
  }
  const evRow = (evRows as TreeNode[] | null)?.[0];
  if (!evRow) return null;

  const { error: linkErr } = await insforge.database
    .from("evidence_sources")
    .insert([
      {
        evidence_node_id: evRow.id,
        source_id: sourceId,
        quote: counter.sourceQuote ?? counter.counterFinding,
        page_number: null,
      },
    ]);
  if (linkErr) {
    console.warn(`persistContrarian: linkage insert failed: ${linkErr.message}`);
  }

  return evRow;
}

export const CONTRARIAN_MODEL = CONTRARIAN_MODEL_LABEL;
