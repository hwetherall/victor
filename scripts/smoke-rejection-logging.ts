import { strict as assert } from "node:assert";
import { parseBrief } from "../agents/brief-parser";
import { bindFramework } from "../agents/framework-binder";
import type { DecisionContent, HypothesisContent, ParsedBrief } from "../lib/schema";

async function main() {
  const parsed: ParsedBrief = {
    thresholds: {},
    constraints: [],
    weights: {},
    infoGaps: [],
    risks: [],
    stakeholderQuestions: [],
    documentProvenance: [],
    consideredAlternatives: [],
    consideredFrameworks: [],
  };
  assert(Array.isArray(parsed.consideredAlternatives));
  assert(Array.isArray(parsed.consideredFrameworks));

  const hypothesis: HypothesisContent = {
    claim: "Claim",
    displayLabel: "Short label",
    falsifier: "Falsifier",
    test: { type: "binary", metric: "proof", target: "yes" },
    modeDependence: "agnostic",
    insightAtStake: "Insight",
    consideredAlternatives: [],
  };
  assert(Array.isArray(hypothesis.consideredAlternatives));

  const decision: DecisionContent = {
    finalDecision: "Decision",
    reasoning: "Reasoning",
    weakestLinkNodeId: "node-1",
    thresholdsMet: {},
    consideredAlternatives: [],
  };
  assert(Array.isArray(decision.consideredAlternatives));

  const parsedBrief = await parseBrief("abb-rack-pdu");
  assert(Array.isArray(parsedBrief.consideredAlternatives));
  assert(Array.isArray(parsedBrief.consideredFrameworks));

  const binding = await bindFramework("abb-rack-pdu");
  assert(
    (binding.framework.consideredAlternatives ?? []).some(
      (item) => item.type === "framework",
    ),
    "framework should log real rejected framework alternatives",
  );
  for (const slot of binding.slots) {
    assert(slot.displayLabel, `slot ${slot.id} missing displayLabel`);
    assert(Array.isArray(slot.consideredAlternatives));
    assert(
      slot.consideredAlternatives.length > 0,
      `slot ${slot.id} should log at least one typed alternative`,
    );
    for (const sub of slot.decomposition) {
      assert(sub.displayLabel, `subslot ${sub.id} missing displayLabel`);
      assert(Array.isArray(sub.consideredAlternatives));
    }
  }
}

main().catch((e) => {
  console.error("smoke-rejection-logging failed:", e);
  process.exit(1);
});
