// STORY-005 smoke test: dispatch SH4.2 to the Investigator and confirm a
// real Anthropic session ID comes back.
//
// Acceptance criterion: "A call to createInvestigatorSession with a minimal
// InvestigatorInput (SH4.2 hypothesis, no documents) completes without API
// error — the agent may produce a low-quality result, that is acceptable."
//
// Run: npx tsx scripts/smoke-investigator-sh42.ts
// Needs: ANTHROPIC_API_KEY, INVESTIGATOR_AGENT_ID, MANAGED_AGENTS_ENVIRONMENT_ID
// in .env.local. Run scripts/register-investigator.ts first if those IDs
// aren't set.

import { config as loadEnv } from "dotenv";
loadEnv({ path: ".env.local" });

import { createInvestigatorSession } from "../lib/managed-agents-client";

async function main() {
  const start = Date.now();

  // SH4.2 = "Investment vs revenue ramp" sub-hypothesis under the
  // "financials-clear" tier-1 slot. Pulled verbatim from
  // frameworks/market-entry-tiered.yaml + cases/abb-rack-pdu.yaml.
  const result = await createInvestigatorSession({
    traceId: `smoke:sh4.2:${Date.now()}`,
    hypothesis: {
      id: "sh4.2-smoke",
      claim: "Investment required vs revenue ramp clears 15% IRR hurdle",
      templateId: "investment-vs-ramp",
    },
    falsifier: "NPV at 15% is negative or payback period exceeds 3 years",
    threshold: { metric: "npv_at_hurdle", value: 0 },
    caseContext: {
      // The smoke test runs outside an orchestrated run — there's no real
      // case row or run row in the DB to point at. Use a synthetic UUID
      // shape that will fail FK checks if the agent tries to upload an
      // artifact / ask_user (those are STORY-006 features and would write
      // to live tables). Acceptable here: the SH4.2 smoke goal is "session
      // completes," not "every tool path persists."
      caseId: "00000000-0000-0000-0000-000000000000",
      runId: "00000000-0000-0000-0000-000000000000",
      question:
        "Should ABB pursue the rack PDU business, and if yes, should it be " +
        "built internally, acquired, or partnered into?",
      documentIds: [],
      weights: {},
      siblingLeafIds: [],
    },
  });

  const elapsed = ((Date.now() - start) / 1000).toFixed(1);
  console.log(`\n━━━ Result (${elapsed}s) ━━━`);
  console.log(`session_id:        ${result.managedAgentSessionId}`);
  console.log(`confidence:        ${result.confidence}`);
  console.log(`evidence_summary:  ${result.evidenceSummary.slice(0, 240)}`);
  console.log(`artifacts:         ${result.artifacts.length}`);
  console.log(`escalations:       ${result.escalations.length}`);
  console.log(`reasoning_steps:   ${result.reasoningTrace.length}`);
  console.log(
    `usage:             input=${result.usage.inputTokens} ` +
      `output=${result.usage.outputTokens} ` +
      `cache_read=${result.usage.cacheReadInputTokens} ` +
      `cache_create=${result.usage.cacheCreationInputTokens}`,
  );

  if (!result.managedAgentSessionId?.startsWith("sesn_")) {
    console.error("\n✗ session_id does not look like a real Anthropic session ID");
    process.exit(1);
  }
  console.log("\n✓ STORY-005 smoke passed");
  console.log(
    `  Anthropic Console: https://console.anthropic.com/managed-agents/sessions/${result.managedAgentSessionId}`,
  );
}

main().catch((e) => {
  console.error("✗ smoke failed:", e instanceof Error ? e.message : e);
  if (e instanceof Error && e.stack) console.error(e.stack);
  process.exit(1);
});
