// One-shot session inspector. Focused on termination + last agent.message.

import { config as loadEnv } from "dotenv";
loadEnv({ path: ".env.local" });

import Anthropic from "@anthropic-ai/sdk";

async function main() {
  const sessionId = process.argv[2];
  if (!sessionId) {
    console.error("Usage: npx tsx tmp/inspect-session.ts <session_id>");
    process.exit(1);
  }

  const client = new Anthropic();

  console.log("━━━ Session status ━━━");
  const session = (await client.beta.sessions.retrieve(sessionId)) as {
    id: string;
    status?: string;
    created_at?: string;
    archived_at?: string | null;
    metadata?: unknown;
    agent?: { model?: { id?: string } };
    outcome_evaluations?: Array<{ description?: string; satisfied?: boolean | null; completed_at?: string | null; explanation?: string | null }>;
  };
  console.log(`  id:             ${session.id}`);
  console.log(`  status:         ${session.status ?? "(not set)"}`);
  console.log(`  model:          ${session.agent?.model?.id}`);
  console.log(`  created_at:     ${session.created_at}`);
  console.log(`  archived_at:    ${session.archived_at}`);
  if (session.outcome_evaluations?.length) {
    console.log(`  outcome_evaluations:`);
    for (const oe of session.outcome_evaluations) {
      console.log(`    - satisfied=${oe.satisfied} completed_at=${oe.completed_at}`);
      console.log(`      description=${(oe.description ?? "").slice(0, 120)}...`);
      if (oe.explanation) console.log(`      explanation=${oe.explanation.slice(0, 240)}`);
    }
  }

  console.log("\n━━━ Walking events ━━━");
  const events: Array<Record<string, unknown>> = [];
  for await (const evt of client.beta.sessions.events.list(sessionId)) {
    events.push(evt as unknown as Record<string, unknown>);
  }
  console.log(`  total: ${events.length}`);

  console.log("\n━━━ Last 25 event types ━━━");
  const tail = events.slice(-25);
  for (const e of tail) {
    const stop = e.stop_reason ? ` stop=${JSON.stringify(e.stop_reason)}` : "";
    const name = e.name ? ` name=${e.name}` : "";
    console.log(`  ${e.processed_at} ${e.type}${name}${stop}`);
  }

  console.log("\n━━━ Last 3 agent.message events (full text) ━━━");
  const agentMessages = events.filter((e) => e.type === "agent.message");
  console.log(`  total agent.message: ${agentMessages.length}`);
  for (const m of agentMessages.slice(-3)) {
    console.log(`\n  ─── ${m.processed_at} ───`);
    console.log(JSON.stringify(m, null, 2).slice(0, 2500));
  }

  // Look for any terminal/error/limit-hit events
  console.log("\n━━━ Terminal / error / limit signals ━━━");
  for (const e of events) {
    const t = String(e.type ?? "");
    if (t.includes("error") || t.includes("limit") || t.includes("terminat") || t.includes("end") || t.includes("max")) {
      console.log(`  ${e.processed_at} ${t} ${JSON.stringify(e).slice(0, 300)}`);
    }
  }
}

main().catch((e) => {
  console.error("✗ inspect failed:", e instanceof Error ? e.message : e);
  process.exit(1);
});
