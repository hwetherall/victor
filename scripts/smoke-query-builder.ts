// Smoke check for EPIC-V3-01 (improve.md §3): test-driven queries surface
// the test variable, not the topic. The first run failed because SH4.2's NPV
// question received six market-growth links. This smoke verifies that for
// each of the four critical leaves the spec calls out, the generated
// queries hit the keywords the spec's acceptance criteria require.
//
// Run: tsx scripts/smoke-query-builder.ts

import { loadCase, loadFramework } from "@/lib/framework-registry";
import { buildTestDrivenQueries, __test } from "@/lib/query-builder";
import type { HypothesisContent } from "@/lib/schema";

const CASE_ID = "abb-rack-pdu";

interface AcceptanceCheck {
  /** Sub-hypothesis decomposition id from the framework yaml. */
  templateId: string;
  /** The spec's reference shorthand (improve.md §3). */
  specLabel: string;
  /** Phrases that must appear in at least one generated query. */
  mustHitOneOf: string[][];
}

const CHECKS: AcceptanceCheck[] = [
  {
    templateId: "investment-vs-ramp",
    specLabel: "SH4.2 — npv_at_hurdle",
    mustHitOneOf: [
      ["IRR", "NPV", "payback", "WACC", "capex"],
      ["plant economics", "investment model", "R&D"],
    ],
  },
  {
    templateId: "brand-permission",
    specLabel: "SH3.2 — approved_vendor_status_count",
    mustHitOneOf: [
      ["AWS", "Azure", "GCP", "Meta", "Oracle", "hyperscaler"],
      ["approved vendor", "preferred supplier", "framework agreement"],
    ],
  },
  {
    templateId: "capability-gap",
    specLabel: "SH2.2 — months_to_parity_product",
    mustHitOneOf: [
      ["teardown", "spec comparison", "feature matrix"],
      ["Vertiv", "Schneider", "Eaton", "Geist", "NetShelter"],
    ],
  },
  {
    templateId: "dc-distribution-unlikely",
    specLabel: "SH5.2 — dc_distribution_penetration",
    mustHitOneOf: [
      ["OCP", "ODCC", "open compute"],
      ["800VDC", "48VDC", "DC bus", "DC architecture"],
    ],
  },
];

function assert(cond: boolean, msg: string): void {
  if (!cond) {
    console.error(`FAIL: ${msg}`);
    process.exit(1);
  }
  console.log(`  ok: ${msg}`);
}

function findSubByTemplateId(
  framework: ReturnType<typeof loadFramework>,
  templateId: string,
): { content: HypothesisContent } | null {
  for (const slot of framework.tiers[0].slots) {
    for (const sub of slot.decomposition ?? []) {
      if (sub.id === templateId) {
        return {
          content: {
            claim: sub.claim,
            falsifier: sub.falsifier,
            test: sub.test,
            modeDependence: sub.modeDependence,
            insightAtStake: sub.insightAtStake,
            templateId: sub.id,
          },
        };
      }
    }
  }
  return null;
}

function main(): void {
  __test.clearCache();
  console.log(`smoke: test-driven queries for case "${CASE_ID}"`);

  const caseConfig = loadCase(CASE_ID);
  const framework = loadFramework(caseConfig.frameworkId);

  for (const check of CHECKS) {
    const sub = findSubByTemplateId(framework, check.templateId);
    assert(sub !== null, `${check.specLabel}: template "${check.templateId}" exists in framework`);
    if (!sub) continue;

    // Apply substitutions like bindFramework does, so [SCOPE] etc resolve.
    const contentForBuilder: HypothesisContent = {
      ...sub.content,
      claim: applySubs(sub.content.claim, caseConfig.substitutions),
      falsifier: applySubs(sub.content.falsifier, caseConfig.substitutions),
      test: {
        ...sub.content.test,
        target: typeof sub.content.test.target === "string"
          ? applySubs(sub.content.test.target, caseConfig.substitutions)
          : sub.content.test.target,
        horizon: sub.content.test.horizon
          ? applySubs(sub.content.test.horizon, caseConfig.substitutions)
          : sub.content.test.horizon,
      },
    };

    const queries = buildTestDrivenQueries(contentForBuilder, {
      frameworkId: caseConfig.frameworkId,
      substitutions: caseConfig.substitutions,
    });
    assert(
      queries.length >= 3,
      `${check.specLabel}: produced ${queries.length} queries (≥3 required)`,
    );

    // Verify every generated query is fully substituted (no [BRACKETS] left).
    for (const q of queries) {
      assert(
        !/\[[A-Z_]+\]/.test(q),
        `${check.specLabel}: query is fully substituted — "${q}"`,
      );
    }

    // Each "mustHitOneOf" group must be matched by at least one query.
    const joined = queries.join(" | ").toLowerCase();
    for (const group of check.mustHitOneOf) {
      const hit = group.some((kw) => joined.includes(kw.toLowerCase()));
      assert(
        hit,
        `${check.specLabel}: queries mention one of [${group.join(", ")}]`,
      );
    }

    // Print queries for visual sanity.
    console.log(`    queries for ${check.specLabel}:`);
    for (const q of queries) console.log(`      - ${q}`);
  }

  console.log("smoke: all assertions passed");
}

function applySubs(s: string, subs: Record<string, string>): string {
  return s.replace(/\[([A-Z_]+)\]/g, (m, k: string) => subs[k] ?? m);
}

main();
