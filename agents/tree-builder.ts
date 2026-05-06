// SPEC §6.3 — v1 config-driven tree builder (Q5 decision: stub, no LLM call).
// Produces the SPEC §8 tree: 1 decision + 5 hypothesis + 11 sub-hypothesis = 17 nodes.
// Sub-hypothesis labels are verbatim from SPEC §8.

import { applySubstitutions } from "@/lib/framework-registry";
import { insforge } from "@/lib/db";
import type {
  HypothesisContent,
  DecisionContent,
  TreeNode,
} from "@/lib/schema";
import type { FrameworkBinding } from "./framework-binder";

interface SpecHypothesis {
  /** Stable id used to look up the slot in the framework binding. */
  slotId: string;
  /** Short label shown in the UI (SPEC §8 verbatim). */
  label: string;
  /** Case-level weight key — overrides the framework slot weight when present. */
  caseWeightKey: string;
  subs: { label: string }[];
}

// SPEC §8 verbatim. Slot ids match frameworks/ge-9-box-make-buy-ally.yaml.
const ABB_HYPOTHESES: SpecHypothesis[] = [
  {
    slotId: "market-attractive",
    label: "Accessible market clears $100M/3yr threshold",
    caseWeightKey: "marketSize",
    subs: [
      { label: "TAM-SAM-SOM bridge supports $100M" },
      { label: "Growth trajectory is favourable" },
      { label: "Intelligent vs basic mix favours ABB entry" },
    ],
  },
  {
    slotId: "can-win",
    label: "ABB can build a winning product",
    caseWeightKey: "strategicFit",
    subs: [
      { label: "Intelligent PDU capability gap is closeable" },
      { label: "Brand has permission in target segments" },
    ],
  },
  {
    slotId: "can-reach",
    label: "ABB can reach IT-channel customers fast enough",
    caseWeightKey: "timeToMarket",
    subs: [
      { label: "Existing electrical channels are insufficient" },
      { label: "Acquisition or partnership opens IT channels" },
    ],
  },
  {
    slotId: "financials-clear",
    label: "Unit economics clear ABB's IRR hurdle",
    caseWeightKey: "roi",
    subs: [
      { label: "Achievable margins (25–30% claim) are credible" },
      { label: "Investment vs revenue ramp clears hurdle" },
    ],
  },
  {
    slotId: "tech-resilient",
    label: "Product will not be obsolete within 3 years",
    caseWeightKey: "techResilience",
    subs: [
      { label: "25kW+ migration timeline is manageable" },
      { label: "DC distribution disruption is unlikely in window" },
    ],
  },
];

const DECISION_LABEL = "Should ABB pursue rack PDU? If yes, how?";

const EMPTY_DECISION_CONTENT: DecisionContent = {
  finalDecision: "",
  reasoning: "",
  weakestLinkNodeId: "",
  thresholdsMet: {},
};

export async function buildTree(
  dbCaseId: string,
  binding: FrameworkBinding,
  caseWeights: Record<string, number>,
): Promise<TreeNode[]> {
  // 1. Insert decision root.
  const decisionRow = await insertNode({
    case_id: dbCaseId,
    parent_id: null,
    type: "decision",
    label: DECISION_LABEL,
    content: EMPTY_DECISION_CONTENT,
    weight: null,
  });

  // 2. Insert 5 hypotheses under decision.
  const hypothesisRows: TreeNode[] = [];
  for (const h of ABB_HYPOTHESES) {
    const slot = binding.slots.find((s) => s.id === h.slotId);
    if (!slot) {
      throw new Error(
        `Framework binding missing slot "${h.slotId}" — check frameworks/${binding.frameworkId}.yaml`,
      );
    }
    const claim = applySubstitutions(slot.claim, {});
    const weight = caseWeights[h.caseWeightKey] ?? slot.weight;

    const hypRow = await insertNode({
      case_id: dbCaseId,
      parent_id: decisionRow.id,
      type: "hypothesis",
      label: h.label,
      content: {
        claim,
        templateId: slot.id,
      } satisfies HypothesisContent,
      weight,
    });
    hypothesisRows.push(hypRow);
  }

  // 3. Insert 11 sub-hypotheses under their parent hypotheses.
  const subRows: TreeNode[] = [];
  for (let i = 0; i < ABB_HYPOTHESES.length; i++) {
    const parent = hypothesisRows[i];
    const h = ABB_HYPOTHESES[i];
    for (const sub of h.subs) {
      const subRow = await insertNode({
        case_id: dbCaseId,
        parent_id: parent.id,
        type: "sub_hypothesis",
        label: sub.label,
        content: {
          claim: sub.label,
        } satisfies HypothesisContent,
        weight: null,
      });
      subRows.push(subRow);
    }
  }

  return [decisionRow, ...hypothesisRows, ...subRows];
}

interface InsertArgs {
  case_id: string;
  parent_id: string | null;
  type: TreeNode["type"];
  label: string;
  content: TreeNode["content"];
  weight: number | null;
}

async function insertNode(args: InsertArgs): Promise<TreeNode> {
  const { data, error } = await insforge.database
    .from("tree_nodes")
    .insert([
      {
        case_id: args.case_id,
        parent_id: args.parent_id,
        type: args.type,
        label: args.label,
        content: args.content,
        weight: args.weight,
        status: "pending",
      },
    ])
    .select();

  if (error) {
    throw new Error(`tree_nodes insert failed: ${error.message}`);
  }
  if (!data || data.length === 0) {
    throw new Error("tree_nodes insert returned no rows");
  }
  return data[0] as TreeNode;
}
