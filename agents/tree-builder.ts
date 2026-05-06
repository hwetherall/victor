// SPEC §6.3 — v1 config-driven tree builder (Q5 decision: stub, no LLM call).
// Produces the SPEC §8 tree: 1 decision + 5 hypothesis + 11 sub-hypothesis = 17 nodes.
// Sub-hypothesis labels are verbatim from SPEC §8.

import { insforge } from "@/lib/db";
import type { DecisionContent, HypothesisContent, TreeNode } from "@/lib/schema";
import type { FrameworkBinding } from "./framework-binder";

const DECISION_LABEL = "Should ABB pursue rack PDU? If yes, how?";

const EMPTY_DECISION_CONTENT: DecisionContent = {
  finalDecision: "",
  reasoning: "",
  weakestLinkNodeId: "",
  thresholdsMet: {},
};

/**
 * Build a HypothesisContent from a bound slot, selecting only the fields
 * that belong in tree_nodes.content.
 */
function slotToHypothesisContent(slot: {
  claim: string;
  falsifier: string;
  test: HypothesisContent["test"];
  modeDependence: HypothesisContent["modeDependence"];
  insightAtStake: string;
  id: string;
}): HypothesisContent {
  return {
    claim: slot.claim,
    falsifier: slot.falsifier,
    test: slot.test,
    modeDependence: slot.modeDependence,
    insightAtStake: slot.insightAtStake,
    templateId: slot.id,
  };
}

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
  for (const slot of binding.slots) {
    const weight = caseWeights[slot.id] ?? slot.weight;

    const hypRow = await insertNode({
      case_id: dbCaseId,
      parent_id: decisionRow.id,
      type: "hypothesis",
      label: slot.claim.substring(0, 60) + (slot.claim.length > 60 ? "..." : ""),
      content: slotToHypothesisContent(slot),
      weight,
    });
    hypothesisRows.push(hypRow);
  }

  // 3. Insert sub-hypotheses under their parent hypotheses.
  const subRows: TreeNode[] = [];
  for (let i = 0; i < binding.slots.length; i++) {
    const parent = hypothesisRows[i];
    const slot = binding.slots[i];
    for (const sub of slot.decomposition) {
      const subRow = await insertNode({
        case_id: dbCaseId,
        parent_id: parent.id,
        type: "sub_hypothesis",
        label: sub.claim.substring(0, 60) + (sub.claim.length > 60 ? "..." : ""),
        content: slotToHypothesisContent(sub),
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
