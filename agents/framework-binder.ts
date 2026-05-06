// SPEC §6.2 — v1 stub. Loads the configured framework and applies case
// substitutions to each slot's templateClaim. Real framework selection is
// deferred to v2 (SPEC §13).

import {
  applySubstitutions,
  loadCase,
  loadFramework,
  type Framework,
} from "@/lib/framework-registry";

export interface BoundSlot {
  id: string;
  claim: string;
  weight: number;
  decomposition: string[];
}

export interface FrameworkBinding {
  frameworkId: string;
  framework: Framework;
  caseId: string;
  /** Tier-1 slots with substitutions applied. */
  slots: BoundSlot[];
}

export async function bindFramework(caseId: string): Promise<FrameworkBinding> {
  const config = loadCase(caseId);
  const framework = loadFramework(config.frameworkId);

  const tier1 = framework.tiers[0];
  const slots: BoundSlot[] = tier1.slots.map((slot) => ({
    id: slot.id,
    claim: applySubstitutions(slot.templateClaim, config.substitutions),
    weight: slot.weight,
    decomposition: slot.decomposition ?? [],
  }));

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
