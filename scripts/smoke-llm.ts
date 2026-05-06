// One-shot smoke test for lib/llm-client.ts. Calls Sonnet via OpenRouter with
// a trivial prompt. Run: npx tsx scripts/smoke-llm.ts

import { config as loadEnv } from "dotenv";
loadEnv({ path: ".env.local" });

import { completeAs, MODELS } from "../lib/llm-client";

async function main() {
  for (const [role, model] of [
    ["evaluator", MODELS.sonnet],
    ["decision", MODELS.opus],
    ["evidence-web", MODELS.mistralLarge],
    ["evidence-doc", MODELS.geminiPro],
  ] as const) {
    const t = Date.now();
    try {
      const r = await completeAs(role, [
        { role: "user", content: 'Reply with the single word: "ok"' },
      ]);
      console.log(`✓ ${role.padEnd(14)} ${model.padEnd(30)} ${Date.now() - t}ms  → ${r.trim()}`);
    } catch (e) {
      console.log(`✗ ${role.padEnd(14)} ${model.padEnd(30)} FAILED: ${e instanceof Error ? e.message : e}`);
    }
  }
}

main().catch((e) => {
  console.error("✗ smoke failed:", e instanceof Error ? e.message : e);
  process.exit(1);
});
