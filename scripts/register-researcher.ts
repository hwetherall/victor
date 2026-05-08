// STORY-017: register the Researcher agent. Outputs RESEARCHER_AGENT_ID
// for .env.local. Idempotent on RESEARCHER_AGENT_ID — refuses to re-register
// if already set, so re-running won't leak duplicate agents in the org.
//
// Run: npx tsx scripts/register-researcher.ts
// Needs: ANTHROPIC_API_KEY in .env.local with managed-agents access.
//
// After this lands, unset INVESTIGATOR_AGENT_ID and re-run
// scripts/register-investigator.ts to attach the Researcher to the
// Investigator's multiagent.agents roster (a new Investigator version
// gets created — update INVESTIGATOR_AGENT_ID accordingly).

import { config as loadEnv } from "dotenv";
loadEnv({ path: ".env.local" });

import * as fs from "node:fs";
import * as path from "node:path";
import Anthropic from "@anthropic-ai/sdk";

const AGENT_NAME = "agent-victor-researcher";
// Sonnet per spec-v2.md §3.2: faster + cheaper than Opus, parallel-friendly,
// right for compressed research that reads many pages and hands back a few
// paragraphs.
const AGENT_MODEL = "claude-sonnet-4-6";

/** Read the canonical system prompt out of AGENT.md so this script and the
 *  human-readable doc never drift. Same extraction pattern as
 *  scripts/register-investigator.ts. */
function readSystemPrompt(): string {
  const md = fs.readFileSync(
    path.resolve("agents/managed/researcher/AGENT.md"),
    "utf-8",
  );
  const match = md.match(/##\s+System prompt\s*\n+([\s\S]*?)(?=\n##\s|$)/);
  if (!match) throw new Error("Could not find '## System prompt' section in AGENT.md");
  return match[1].trim();
}

async function main() {
  if (!process.env.ANTHROPIC_API_KEY) {
    console.error("✗ ANTHROPIC_API_KEY missing from .env.local");
    process.exit(1);
  }

  const client = new Anthropic();

  if (process.env.RESEARCHER_AGENT_ID) {
    console.log(
      `• RESEARCHER_AGENT_ID already set: ${process.env.RESEARCHER_AGENT_ID}`,
    );
    console.log(
      "  To re-register (e.g., after a system-prompt edit), unset it in " +
        ".env.local first. Re-registration creates a new agent ID; the " +
        "Investigator must also be re-registered so its multiagent roster " +
        "pins the new ID.",
    );
    return;
  }

  const system = readSystemPrompt();
  console.log(
    `• Registering Researcher agent (model=${AGENT_MODEL}, ` +
      `system_prompt_len=${system.length}, custom_tools=0, ` +
      `built-in: agent_toolset_20260401)...`,
  );

  // No custom tools at this stage — the Researcher uses built-in web_search +
  // web_fetch only. LEGAL-003 deferred Tavily; if quality on real ABB queries
  // is insufficient, swap to Tavily as a custom tool later.
  const agent = await client.beta.agents.create({
    name: AGENT_NAME,
    model: AGENT_MODEL,
    system,
    tools: [{ type: "agent_toolset_20260401" }],
  });
  console.log(`  ✓ Researcher: ${agent.id} (version ${agent.version})`);

  console.log("\nAdd to .env.local:");
  console.log("---");
  console.log(`RESEARCHER_AGENT_ID=${agent.id}`);
  console.log("---");
  console.log(
    "\nNext: unset INVESTIGATOR_AGENT_ID and re-run " +
      "scripts/register-investigator.ts to attach the Researcher to the " +
      "Investigator's multiagent.agents roster. Restart the Next dev server " +
      "after the new IDs land in .env.local (env hot-reload doesn't catch " +
      "process.env updates — see session-1 gotcha #7).",
  );
}

main().catch((e) => {
  console.error("✗ register-researcher failed:", e instanceof Error ? e.message : e);
  if (e instanceof Error && e.stack) console.error(e.stack);
  process.exit(1);
});
