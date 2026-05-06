// Smoke check for EPIC-V3-02 (improve.md §4): case-config weights propagate to
// every framework slot. Before the v3 fix, case yaml keys (camelCase) didn't
// match framework slot ids (kebab-case), so caseWeights[slot.id] was undefined
// for every slot — slot defaults silently won.
//
// Run: tsx scripts/smoke-tree-builder-weights.ts

import { loadCase, loadFramework } from "@/lib/framework-registry";

const CASE_ID = "abb-rack-pdu";
const EXPECTED_WEIGHTS: Record<string, number> = {
  "market-attractive": 0.25,
  "can-win": 0.20,
  "can-reach": 0.15,
  "financials-clear": 0.20,
  "tech-resilient": 0.20,
};

function assert(cond: boolean, msg: string): void {
  if (!cond) {
    console.error(`FAIL: ${msg}`);
    process.exit(1);
  }
  console.log(`  ok: ${msg}`);
}

function approxEq(a: number, b: number, eps = 1e-6): boolean {
  return Math.abs(a - b) < eps;
}

function main(): void {
  console.log(`smoke: tree-builder weight resolution for case "${CASE_ID}"`);

  const caseConfig = loadCase(CASE_ID);
  const framework = loadFramework(caseConfig.frameworkId);
  const tier1Slots = framework.tiers[0].slots;

  // 1. Every framework slot id has a matching case weight (the bug surface).
  for (const slot of tier1Slots) {
    assert(
      slot.id in caseConfig.weights,
      `case yaml has weight for slot "${slot.id}"`,
    );
  }

  // 2. Replicate tree-builder.ts:58 — caseWeights[slot.id] ?? slot.weight.
  //    After fix, the case override always wins; no slot fallback fires.
  for (const slot of tier1Slots) {
    const resolved = caseConfig.weights[slot.id] ?? slot.weight;
    const expected = EXPECTED_WEIGHTS[slot.id];
    assert(
      approxEq(resolved, expected),
      `slot "${slot.id}" resolves to ${resolved} (expected ${expected})`,
    );
  }

  // 3. H5 (tech-resilient) specifically, called out in improve.md §4.
  const h5 = caseConfig.weights["tech-resilient"];
  assert(approxEq(h5, 0.20), `H5 (tech-resilient) weight is 0.20 from case yaml`);

  // 4. Case weights sum to 1.00 (improve.md §4 Notes recommendation).
  const sum = Object.values(caseConfig.weights).reduce((a, b) => a + b, 0);
  assert(approxEq(sum, 1.0), `case weights sum to 1.00 (got ${sum})`);

  // 5. Framework slot weights also sum to 1.00 (binder enforces, but lock it).
  const slotSum = tier1Slots.reduce((a, s) => a + s.weight, 0);
  assert(approxEq(slotSum, 1.0), `framework slot weights sum to 1.00 (got ${slotSum})`);

  console.log("smoke: all assertions passed");
}

main();
