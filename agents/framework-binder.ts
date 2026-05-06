// SPEC §6.2 — v1 stub. Loads the configured framework and applies case
// substitutions to each slot's structured content. Real framework selection is
// deferred to v2 (SPEC §13).

import {
  applySubstitutionsDeep,
  loadCase,
  loadFramework,
  type Framework,
  type FrameworkSlot,
  type FrameworkSubSlot,
} from "@/lib/framework-registry";
import type { ConsideredAlternative, HypothesisContent } from "@/lib/schema";

export interface BoundSlot {
  id: string;
  displayLabel?: string;
  claim: string;
  falsifier: string;
  test: HypothesisContent["test"];
  modeDependence: HypothesisContent["modeDependence"];
  insightAtStake: string;
  weight: number;
  consideredAlternatives?: ConsideredAlternative[];
  decomposition: BoundSubSlot[];
}

export interface BoundSubSlot {
  id: string;
  displayLabel?: string;
  claim: string;
  falsifier: string;
  test: HypothesisContent["test"];
  modeDependence: HypothesisContent["modeDependence"];
  insightAtStake: string;
  consideredAlternatives?: ConsideredAlternative[];
}

export interface FrameworkBinding {
  frameworkId: string;
  framework: Framework;
  caseId: string;
  /** Tier-1 slots with substitutions applied. */
  slots: BoundSlot[];
}

/**
 * Convert a framework slot to a bound slot with substitutions applied.
 */
function bindSlot(
  slot: FrameworkSlot,
  subs: Record<string, string>,
): BoundSlot {
  const applied = applySubstitutionsDeep<FrameworkSlot>(slot, subs);
  return {
    id: applied.id,
    displayLabel: applied.displayLabel,
    claim: applied.claim,
    falsifier: applied.falsifier,
    test: applied.test,
    modeDependence: applied.modeDependence,
    insightAtStake: applied.insightAtStake,
    weight: applied.weight,
    consideredAlternatives: applied.consideredAlternatives ?? [],
    decomposition: (applied.decomposition ?? []).map((sub) => {
      const appliedSub = applySubstitutionsDeep<FrameworkSubSlot>(sub, subs);
      return {
        id: appliedSub.id,
        displayLabel: appliedSub.displayLabel,
        claim: appliedSub.claim,
        falsifier: appliedSub.falsifier,
        test: appliedSub.test,
        modeDependence: appliedSub.modeDependence,
        insightAtStake: appliedSub.insightAtStake,
        consideredAlternatives: appliedSub.consideredAlternatives ?? [],
      };
    }),
  };
}

export async function bindFramework(caseId: string): Promise<FrameworkBinding> {
  const config = loadCase(caseId);
  const framework = loadFramework(config.frameworkId);

  const tier1 = framework.tiers[0];
  const slots: BoundSlot[] = tier1.slots.map((slot) =>
    bindSlot(slot, config.substitutions),
  );

  const weightSum = slots.reduce((acc, s) => acc + s.weight, 0);
  if (Math.abs(weightSum - 1) > 0.001) {
    throw new Error(
      `Framework "${framework.id}" tier-1 slot weights sum to ${weightSum}, expected 1.0`,
    );
  }

  return {
    frameworkId: framework.id,
    framework,
    caseId,
    slots,
  };
}
