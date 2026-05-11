// STORY-005: register the Investigator agent and (if missing) the cloud
// environment. Outputs the IDs to copy into .env.local. Idempotent on the
// agent — refuses to re-register if INVESTIGATOR_AGENT_ID is already set, so
// you can re-run safely without leaking duplicate agents in the org.
//
// Run: npx tsx scripts/register-investigator.ts
// Needs: ANTHROPIC_API_KEY in .env.local with managed-agents access.

import { config as loadEnv } from "dotenv";
loadEnv({ path: ".env.local" });

import * as fs from "node:fs";
import * as path from "node:path";
import Anthropic from "@anthropic-ai/sdk";

const AGENT_NAME = "agent-victor-investigator";
// Default Opus per spec. Override via INVESTIGATOR_MODEL for cheap-and-fast
// testing — e.g. INVESTIGATOR_MODEL=claude-haiku-4-5 when you only care that
// the plumbing (multi-agent, custom tools, outcomes) wires up, not the
// quality of the analysis. Cost telemetry in lib/v2-persistence.ts still
// applies Opus pricing — numbers will be off when downgraded; fine for
// integration smoke runs, not for budget decisions.
const AGENT_MODEL = process.env.INVESTIGATOR_MODEL ?? "claude-opus-4-7";

/** Read the canonical system prompt out of AGENT.md so this script and the
 *  human-readable doc never drift. Extracts the "## System prompt" section
 *  through either the next H2 or end-of-file (the EOF alternative makes the
 *  regex robust if AGENT.md is ever shortened). */
function readSystemPrompt(): string {
  const md = fs.readFileSync(
    path.resolve("agents/managed/investigator/AGENT.md"),
    "utf-8",
  );
  const match = md.match(/##\s+System prompt\s*\n+([\s\S]*?)(?=\n##\s|$)/);
  if (!match) throw new Error("Could not find '## System prompt' section in AGENT.md");
  return match[1].trim();
}

/** Custom skills attached to the Investigator. Looks for *_SKILL_ID env vars
 *  paired with optional *_SKILL_VERSION. Today this is bottoms-up only;
 *  STORY-012-015 add more. The map shape mirrors what register-bottoms-up-
 *  skill.ts prints. */
function readSkillsFromEnv(): Array<{ type: "custom"; skill_id: string; version?: string }> {
  const skills: Array<{ type: "custom"; skill_id: string; version?: string }> = [];
  const candidates: Array<[string, string]> = [
    ["BOTTOMS_UP_SKILL_ID", "BOTTOMS_UP_SKILL_VERSION"],
    // Future: COMPETITOR_TEARDOWN_SKILL_ID, SENSITIVITY_SKILL_ID, etc.
  ];
  for (const [idVar, versionVar] of candidates) {
    const id = process.env[idVar];
    if (!id) continue;
    const version = process.env[versionVar];
    skills.push({ type: "custom", skill_id: id, ...(version ? { version } : {}) });
  }
  return skills;
}

/** Multi-agent roster (STORY-017). Currently the Researcher only; future
 *  sub-agents (e.g., a competitor-research specialist) plug in here. The
 *  Investigator becomes a `coordinator` once any sub-agent is registered;
 *  without one, this function returns undefined and we register a plain
 *  agent. Per Anthropic docs: max 20 unique agents in roster, depth = 1. */
function readMultiagentFromEnv():
  | { type: "coordinator"; agents: Array<{ type: "agent"; id: string }> }
  | undefined {
  const agents: Array<{ type: "agent"; id: string }> = [];
  const researcherId = process.env.RESEARCHER_AGENT_ID;
  if (researcherId) agents.push({ type: "agent", id: researcherId });
  // Future: other roster entries.
  if (agents.length === 0) return undefined;
  return { type: "coordinator", agents };
}

// Custom tools the Investigator declares. Handlers are wired up in the
// orchestrator's stream consumer (lib/managed-agents-client.ts). STORY-005
// ships placeholder handlers; STORY-006 implements the real bindings.
const customTools = [
  {
    type: "custom" as const,
    name: "retrieve_documents",
    description:
      "Retrieve relevant chunks from the case's source corpus via pgvector " +
      "similarity search. Use whenever you need to ground a quantitative " +
      "claim or check what the brief / pitch deck actually says. Mid-loop " +
      "calls are supported — call this any number of times as the " +
      "investigation refines (e.g., a first pass at margins is weak, then a " +
      "second retrieval for ABB segment data in the 10-K). Returns top-k " +
      "chunks each with `source_id`, `quote`, and `page_number`. Scope to " +
      "specific documents by phrasing the query with their content (e.g., " +
      "include the document title or distinctive phrasing).",
    input_schema: {
      type: "object" as const,
      properties: {
        query: {
          type: "string",
          description: "Natural-language query to embed and search against.",
        },
        top_k: {
          type: "integer",
          description: "Max chunks to return. Default 8.",
        },
      },
      required: ["query"],
    },
  },
  {
    type: "custom" as const,
    name: "upload_artifact",
    description:
      "Persist a sandbox file to artifact storage. THE ONLY way to make a " +
      "file survive the session — files in /mnt/session/outputs/ are LOST on " +
      "session end unless you call this tool. Workflow (same turn): (1) bash " +
      "`base64 -w 0 /mnt/session/outputs/file.ext` — no redirection, no cat, " +
      "let the b64 land in the tool_result; (2) call upload_artifact with that " +
      "b64 string as content_b64, the path as filename, the type. Catting b64 " +
      "to stdout is NOT an upload — only this tool persists the file. Returns " +
      "{artifact_id, uri, version} — paste artifact_id into your final " +
      "CONFIDENCE block's ARTIFACTS field. For v2+ of an artifact (after " +
      "revision), pass parent_artifact_id to track the lineage.",
    input_schema: {
      type: "object" as const,
      properties: {
        filename: {
          type: "string",
          description:
            "Path of the file in the sandbox, e.g. /mnt/session/outputs/model.xlsx",
        },
        content_b64: {
          type: "string",
          description:
            "Base64-encoded contents of the file. Run `base64 -w 0 <path>` " +
            "in bash FIRST (without any output redirection or cat — just let " +
            "the tool_result carry the b64 string). Then call this tool with " +
            "the string copied from that tool_result. The orchestrator decodes " +
            "this string and uploads it to storage. Catting the b64 to stdout " +
            "is NOT a substitute for calling this tool.",
        },
        type: {
          type: "string",
          enum: ["xlsx", "csv", "png", "md", "json", "model_lineage"],
          description: "Artifact type — must match what's actually uploaded.",
        },
        change_reason: {
          type: "string",
          description:
            "Why this version differs from any prior version. Required for " +
            "v2+ of an artifact (used to render the version diff panel).",
        },
        parent_artifact_id: {
          type: "string",
          description:
            "Optional: artifact_id of the previous version. Pass to create " +
            "a v2/v3/... in a lineage.",
        },
        metadata: {
          type: "object",
          description:
            "Free-form metadata: skill name, inputs used, dominant " +
            "assumption, etc. Persisted as artifacts.metadata jsonb.",
          additionalProperties: true,
        },
      },
      required: ["filename", "content_b64", "type"],
    },
  },
  {
    type: "custom" as const,
    name: "ask_user",
    description:
      "Non-blocking HITL escalation. Posts a question to the case's user " +
      "queue (user_questions table). Use when a judgement call from the " +
      "user would meaningfully change your confidence — for example, " +
      "scenario-selection between bear/base/bull. Returns immediately; do " +
      "not wait for an answer. Continue the investigation with whatever " +
      "confidence the available evidence supports.",
    input_schema: {
      type: "object" as const,
      properties: {
        question: { type: "string", description: "The question to ask." },
        type: {
          type: "string",
          enum: ["yes_no", "yes_no_context", "open"],
          description:
            "yes_no = boolean, yes_no_context = boolean + reasoning, " +
            "open = free-text or option list.",
        },
        options: {
          type: "array",
          items: { type: "string" },
          description:
            "For 'open' questions where you want to constrain to a list, " +
            "the options. Omit for free-text.",
        },
        needed_because: {
          type: "string",
          description:
            "One sentence explaining how the answer would change your " +
            "investigation. Helps the user prioritise the queue.",
        },
      },
      required: ["question", "type", "needed_because"],
    },
  },
  {
    type: "custom" as const,
    name: "read_sibling_leaf",
    description:
      "Read another sub-hypothesis leaf's finding within this run. Returns " +
      "the leaf's evidence summary and confidence, or null if it isn't " +
      "complete yet. Use sparingly — prefer building your own evidence " +
      "lineage. Useful when your falsifier explicitly depends on another " +
      "leaf's outcome.",
    input_schema: {
      type: "object" as const,
      properties: {
        leaf_id: {
          type: "string",
          description: "tree_nodes.id of the sibling sub-hypothesis to read.",
        },
      },
      required: ["leaf_id"],
    },
  },
];

async function main() {
  if (!process.env.ANTHROPIC_API_KEY) {
    console.error("✗ ANTHROPIC_API_KEY missing from .env.local");
    process.exit(1);
  }

  const client = new Anthropic();
  const lines: string[] = [];

  // ─── Agent ────────────────────────────────────────────────────────────────
  if (process.env.INVESTIGATOR_AGENT_ID) {
    console.log(
      `• INVESTIGATOR_AGENT_ID already set: ${process.env.INVESTIGATOR_AGENT_ID}`,
    );
    console.log(
      "  To re-register (e.g., after a system-prompt edit or to attach a new " +
        "skill), unset it in .env.local first.",
    );
  } else {
    const system = readSystemPrompt();
    const skills = readSkillsFromEnv();
    const multiagent = readMultiagentFromEnv();
    console.log(
      `• Registering Investigator agent (model=${AGENT_MODEL}, ` +
        `system_prompt_len=${system.length}, custom_tools=${customTools.length}, ` +
        `skills=${skills.length}, ` +
        `multiagent=${multiagent ? `coordinator(${multiagent.agents.length})` : "none"})...`,
    );
    if (skills.length) {
      for (const s of skills) {
        console.log(`    skill: ${s.skill_id}${s.version ? ` @ ${s.version}` : " (latest)"}`);
      }
    }
    if (multiagent) {
      for (const a of multiagent.agents) {
        console.log(`    sub-agent: ${a.id}`);
      }
    }
    const agent = await client.beta.agents.create({
      name: AGENT_NAME,
      model: AGENT_MODEL,
      system,
      tools: [
        { type: "agent_toolset_20260401" },
        ...customTools,
      ],
      ...(skills.length ? { skills } : {}),
      ...(multiagent ? { multiagent } : {}),
    });
    console.log(`  ✓ Investigator: ${agent.id} (version ${agent.version})`);
    lines.push(`INVESTIGATOR_AGENT_ID=${agent.id}`);
  }

  // ─── Environment ──────────────────────────────────────────────────────────
  if (process.env.MANAGED_AGENTS_ENVIRONMENT_ID) {
    console.log(
      `• MANAGED_AGENTS_ENVIRONMENT_ID already set: ${process.env.MANAGED_AGENTS_ENVIRONMENT_ID}`,
    );
  } else {
    console.log("• Creating cloud environment with pip:[openpyxl, pandas, numpy]...");
    const env = await client.beta.environments.create({
      name: `agent-victor-${Date.now()}`,
      config: {
        type: "cloud",
        packages: { pip: ["openpyxl", "pandas", "numpy"] },
        networking: { type: "unrestricted" },
      },
    });
    console.log(`  ✓ Environment: ${env.id}`);
    lines.push(`MANAGED_AGENTS_ENVIRONMENT_ID=${env.id}`);
  }

  // ─── Print env-var bundle ─────────────────────────────────────────────────
  if (lines.length) {
    console.log("\nAdd to .env.local:");
    console.log("---");
    for (const line of lines) console.log(line);
    console.log("---");
  } else {
    console.log("\nNothing to write — both env vars already populated.");
  }
}

main().catch((e) => {
  console.error("✗ register-investigator failed:", e instanceof Error ? e.message : e);
  process.exit(1);
});
