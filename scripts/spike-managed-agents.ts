// STORY-001 day-1 spike. Exercises every Managed Agents capability the V2
// plan rests on. See docs/spike-day-1-report.md for findings and plan deltas.
//
// Run:   npx tsx scripts/spike-managed-agents.ts
// Needs: ANTHROPIC_API_KEY in .env.local (managed-agents-2026-04-01 beta).
//
// This script creates real Anthropic resources and consumes real budget.
// Resources are cleaned up in `finally` even on partial failure. Ballpark
// cost ~ a few cents (one short Opus session + one short Sonnet thread).

import { config as loadEnv } from "dotenv";
loadEnv({ path: ".env.local" });

import Anthropic from "@anthropic-ai/sdk";

const client = new Anthropic();

// Track everything we create so we can delete it on the way out.
const cleanup = {
  agents: [] as string[],
  environments: [] as string[],
  sessions: [] as string[],
};

const findings: Array<{ n: number; name: string; ok: boolean; note: string }> = [];

function record(n: number, name: string, ok: boolean, note: string) {
  findings.push({ n, name, ok, note });
  console.log(`  ${ok ? "✓" : "✗"} ${note}`);
}

function header(n: number, title: string) {
  console.log(`\n━━━ Test ${n}: ${title} ━━━`);
}

// ─── Test 1 ─────────────────────────────────────────────────────────────────
async function test1_auth() {
  header(1, "SDK auth + list agents");
  try {
    const list = await client.beta.agents.list();
    const count = list.data?.length ?? 0;
    record(1, "auth", true, `Auth OK. Existing agents in org: ${count}`);
  } catch (e) {
    record(1, "auth", false, `Auth failed: ${formatErr(e)}`);
    throw e; // hard stop — nothing else will work
  }
}

// ─── Test 2 ─────────────────────────────────────────────────────────────────
async function test2_createAgent(): Promise<string> {
  header(2, "Create + retrieve agent");
  const agent = await client.beta.agents.create({
    name: `spike-${Date.now()}`,
    model: "claude-opus-4-7",
    system: "You are a test harness. Reply concisely.",
    tools: [{ type: "agent_toolset_20260401" }],
  });
  cleanup.agents.push(agent.id);
  record(2, "agent.create", true, `Agent ${agent.id} v${agent.version}`);
  return agent.id;
}

// ─── Test 3 ─────────────────────────────────────────────────────────────────
async function test3_createEnvironment(): Promise<string> {
  header(3, "Cloud environment with pip:[openpyxl]");
  const env = await client.beta.environments.create({
    name: `spike-env-${Date.now()}`,
    config: {
      type: "cloud",
      packages: { pip: ["openpyxl"] },
      networking: { type: "unrestricted" },
    },
  });
  cleanup.environments.push(env.id);
  record(3, "environment.create", true, `Env ${env.id} (pip:[openpyxl])`);
  return env.id;
}

// ─── Test 4 + 10 (combined) ─────────────────────────────────────────────────
// Session lifecycle + openpyxl check in one shot. Combined because
// re-streaming an idle session throws TypeError: terminated in undici (real
// finding for STORY-007 — recorded in spike report).
async function test4_sessionLifecycle(agentId: string, envId: string): Promise<string> {
  header(4, "Session lifecycle + openpyxl (combined)");
  const traceId = `t_${Date.now()}`;
  const session = await client.beta.sessions.create({
    agent: agentId,
    environment_id: envId,
    title: traceId, // Test 11: does this round-trip?
  });
  cleanup.sessions.push(session.id);

  const stream = await client.beta.sessions.events.stream(session.id);
  await client.beta.sessions.events.send(session.id, {
    events: [
      {
        type: "user.message",
        content: [
          {
            type: "text",
            text:
              "Two things in one bash run, then reply with both lines: " +
              "(1) `python --version`, (2) `pip show openpyxl | head -1`.",
          },
        ],
      },
    ],
  });

  let messageBlocks = 0;
  let toolUses: string[] = [];
  let lastText = "";
  for await (const ev of stream as AsyncIterable<any>) {
    if (ev.type === "agent.message") {
      messageBlocks += ev.content?.length ?? 0;
      for (const b of ev.content ?? []) if (b.type === "text") lastText = b.text;
    } else if (ev.type === "agent.tool_use") {
      toolUses.push(ev.name);
    } else if (ev.type === "session.status_idle") {
      break;
    }
  }
  record(
    4,
    "session.lifecycle",
    true,
    `Idle reached. ${messageBlocks} message blocks, ${toolUses.length} tool calls (${toolUses.join(",") || "none"}).`,
  );
  const openpyxlFound = /openpyxl/i.test(lastText);
  record(10, "openpyxl", openpyxlFound, `openpyxl in agent reply: ${openpyxlFound}. tail="${lastText.trim().slice(-120)}"`);

  // Test 11: title round-trips
  const retrieved = await client.beta.sessions.retrieve(session.id);
  const titleOk = retrieved.title === traceId;
  record(11, "trace_id.via.title", titleOk, `title round-trip via session.title: ${titleOk ? "OK" : "FAILED"} (got ${retrieved.title})`);

  return session.id;
}

// ─── Test 5 ─────────────────────────────────────────────────────────────────
// Custom tool round-trip using the canonical pattern: stream until idle with
// stop_reason.type === "requires_action", read stop_reason.event_ids, post
// user.custom_tool_result for each, then continue streaming.
async function test5_customTool(envId: string) {
  header(5, "Custom tool round-trip (OPEN-Q-1)");
  const agent = await client.beta.agents.create({
    name: `spike-customtool-${Date.now()}`,
    model: "claude-opus-4-7",
    system:
      "You are a research agent. When you need a document, call lookup_doc(query). Reply with the doc content you receive.",
    tools: [
      { type: "agent_toolset_20260401" },
      {
        type: "custom",
        name: "lookup_doc",
        description:
          "Returns the content of an internal document for a given query. Always call this before answering questions about ABB's intelligent PDU strategy.",
        input_schema: {
          type: "object",
          properties: { query: { type: "string", description: "Search query" } },
          required: ["query"],
        },
      },
    ],
  });
  cleanup.agents.push(agent.id);

  const session = await client.beta.sessions.create({
    agent: agent.id,
    environment_id: envId,
    title: "spike-customtool",
  });
  cleanup.sessions.push(session.id);

  // Track custom_tool_use events by id so we can reply when idle requires_action.
  const pendingToolUses = new Map<string, { name: string; input: unknown }>();
  let toolUseSeen = false;
  let agentSawResult = false;
  let finalText = "";
  let loops = 0;

  // Open the first stream + send the user message.
  let stream = await client.beta.sessions.events.stream(session.id);
  await client.beta.sessions.events.send(session.id, {
    events: [
      {
        type: "user.message",
        content: [{ type: "text", text: "What does ABB's strategy say about intelligent PDU pricing? Use lookup_doc." }],
      },
    ],
  });

  // Drain stream → idle → respond → repeat. Cap at 5 loops to avoid infinite loops.
  while (loops < 5) {
    loops++;
    let stopReason: any = null;
    for await (const ev of stream as AsyncIterable<any>) {
      if (ev.type === "agent.custom_tool_use") {
        toolUseSeen = true;
        pendingToolUses.set(ev.id, { name: ev.name, input: ev.input });
      } else if (ev.type === "agent.message") {
        for (const b of ev.content ?? []) {
          if (b.type === "text") {
            finalText = b.text;
            if (/ABB-DOC-7421|28%|1,?290|15%/.test(b.text)) agentSawResult = true;
          }
        }
      } else if (ev.type === "session.status_idle") {
        stopReason = ev.stop_reason;
        break;
      }
    }

    if (!stopReason || stopReason.type !== "requires_action") break;

    // Reply with a fake but distinctive document so we can verify the agent reads it.
    const eventIds: string[] = stopReason.event_ids ?? [];
    for (const id of eventIds) {
      await client.beta.sessions.events.send(session.id, {
        events: [
          {
            type: "user.custom_tool_result",
            custom_tool_use_id: id,
            content: [
              {
                type: "text",
                text: "ABB-DOC-7421: Intelligent PDU pricing targets a 28% gross margin at $1,290/unit list, 15% IRR hurdle, year-3 channel ramp.",
              },
            ],
          },
        ],
      });
    }

    // Re-attach the stream for the next round of agent activity.
    stream = await client.beta.sessions.events.stream(session.id);
  }

  record(
    5,
    "custom_tool",
    toolUseSeen && agentSawResult,
    `loops=${loops} tool_use_seen=${toolUseSeen} agent_used_result=${agentSawResult} final="${finalText.trim().slice(0, 100)}"`,
  );
}

// ─── Test 6 ─────────────────────────────────────────────────────────────────
// Files API: agent writes a file in the sandbox, we list + download it.
async function test6_filesApi(agentId: string, envId: string) {
  header(6, "Files API artifact retrieval (OPEN-Q-3)");
  const session = await client.beta.sessions.create({
    agent: agentId,
    environment_id: envId,
    title: "spike-files",
  });
  cleanup.sessions.push(session.id);

  const stream = await client.beta.sessions.events.stream(session.id);
  await client.beta.sessions.events.send(session.id, {
    events: [
      {
        type: "user.message",
        content: [
          {
            type: "text",
            text:
              "Step 1: run `pwd && mkdir -p /mnt/session/outputs && ls -la /mnt/session/`. " +
              "Step 2: write a Python script that uses openpyxl to create /mnt/session/outputs/test.xlsx " +
              "with one sheet 'Hello' containing 'world' in A1, run it, then `ls -la /mnt/session/outputs/`. " +
              "Reply with the final ls output verbatim.",
          },
        ],
      },
    ],
  });

  let lastAgentText = "";
  let toolResults: string[] = [];
  for await (const ev of stream as AsyncIterable<any>) {
    if (ev.type === "agent.message") for (const b of ev.content ?? []) if (b.type === "text") lastAgentText = b.text;
    if (ev.type === "agent.tool_result") {
      const t = (ev.content ?? []).map((b: any) => b.text ?? "").join("");
      if (t) toolResults.push(t.slice(0, 200));
    }
    if (ev.type === "session.status_idle") break;
  }
  console.log(`    agent reply tail: "${lastAgentText.trim().slice(-200)}"`);
  console.log(`    tool results: ${toolResults.length} captured`);
  if (toolResults.length) console.log(`    last result: ${toolResults[toolResults.length - 1]}`);

  // Files API requires its own beta header alongside managed-agents.
  // Try scoped list first; if it 400s, fall back to listing all + filtering.
  let data: any[] = [];
  try {
    const files = await client.beta.files.list(
      { scope_id: session.id },
      { headers: { "anthropic-beta": "managed-agents-2026-04-01,files-api-2025-04-14" } },
    );
    data = (files as any).data ?? [];
  } catch (e) {
    console.log(`    scoped list failed: ${formatErr(e)} — falling back to unfiltered list`);
    const all = await client.beta.files.list(
      {},
      { headers: { "anthropic-beta": "managed-agents-2026-04-01,files-api-2025-04-14" } },
    );
    data = (all as any).data ?? [];
  }
  const xlsx = data.find((f) => f.filename?.endsWith(".xlsx"));
  if (!xlsx) {
    record(6, "files.list", false, `No xlsx file found. Listed: ${data.map((f) => f.filename).join(",") || "(empty)"}`);
    return;
  }
  const blob = await client.beta.files.download(xlsx.id, undefined, {
    headers: { "anthropic-beta": "managed-agents-2026-04-01,files-api-2025-04-14" },
  });
  const buf = Buffer.from(await (blob as any).arrayBuffer());
  const isZip = buf[0] === 0x50 && buf[1] === 0x4b && buf[2] === 0x03 && buf[3] === 0x04;
  record(6, "files.api", isZip, `Downloaded ${xlsx.filename} (${buf.length}B), zip-magic ok=${isZip}`);
}

// ─── Test 7 ─────────────────────────────────────────────────────────────────
// user.define_outcome with a rubric. Likely fails with 403 if research-preview
// access is not yet granted — record the failure mode clearly.
async function test7_defineOutcome(agentId: string, envId: string) {
  header(7, "user.define_outcome + revision loop (OPEN-Q-4)");
  const session = await client.beta.sessions.create({
    agent: agentId,
    environment_id: envId,
    title: "spike-outcome",
  });
  cleanup.sessions.push(session.id);

  const rubric = [
    "# Test rubric",
    "",
    "## Output",
    "- The reply must contain the exact phrase 'all-clear'",
    "- The reply must mention the falsifier text passed in the description",
  ].join("\n");

  try {
    const stream = await client.beta.sessions.events.stream(session.id);
    await client.beta.sessions.events.send(session.id, {
      events: [
        {
          type: "user.define_outcome",
          description:
            "Reply with a one-line message that says 'all-clear' and references the falsifier 'IRR is below 15%'.",
          rubric: { type: "text", content: rubric },
          max_iterations: 3,
        } as any,
      ],
    });

    let evaluations = 0;
    let finalResult: string | null = null;
    let usage: any = null;
    for await (const ev of stream as AsyncIterable<any>) {
      if (ev.type === "span.outcome_evaluation_end") {
        evaluations++;
        finalResult = ev.result;
        usage = ev.usage;
      } else if (ev.type === "session.status_idle") {
        break;
      }
    }
    record(
      7,
      "outcome",
      finalResult === "satisfied" || finalResult === "needs_revision" || finalResult === "max_iterations_reached",
      `${evaluations} evaluation(s), final=${finalResult}, grader_usage=${JSON.stringify(usage)}`,
    );
  } catch (e) {
    record(7, "outcome", false, `define_outcome failed (research preview access?): ${formatErr(e)}`);
  }
}

// ─── Test 8 ─────────────────────────────────────────────────────────────────
// Multi-agent: coordinator + roster of one Sonnet agent. May fail with 403 if
// research-preview access is not granted.
async function test8_multiAgent(envId: string) {
  header(8, "Multi-agent coordinator + roster");
  let coordinator: any = null;
  let helper: any = null;
  try {
    helper = await client.beta.agents.create({
      name: `spike-helper-${Date.now()}`,
      model: "claude-sonnet-4-6",
      system: "You are a helper. When asked, reply with exactly: 'helper-says-hi'.",
      tools: [{ type: "agent_toolset_20260401" }],
    });
    cleanup.agents.push(helper.id);

    coordinator = await client.beta.agents.create({
      name: `spike-coord-${Date.now()}`,
      model: "claude-opus-4-7",
      system: "You coordinate. Delegate any greeting request to the helper agent and report what it said.",
      tools: [{ type: "agent_toolset_20260401" }],
      multiagent: {
        type: "coordinator",
        agents: [{ type: "agent", id: helper.id }],
      } as any,
    });
    cleanup.agents.push(coordinator.id);
  } catch (e) {
    record(8, "multiagent.create", false, `Coordinator agent create failed (research preview?): ${formatErr(e)}`);
    return;
  }

  const session = await client.beta.sessions.create({
    agent: coordinator.id,
    environment_id: envId,
    title: "spike-multiagent",
  });
  cleanup.sessions.push(session.id);

  const stream = await client.beta.sessions.events.stream(session.id);
  await client.beta.sessions.events.send(session.id, {
    events: [
      { type: "user.message", content: [{ type: "text", text: "Please greet me." }] },
    ],
  });

  let threadCreated = 0;
  let helperReplied = false;
  let lastText = "";
  for await (const ev of stream as AsyncIterable<any>) {
    if (ev.type === "session.thread_created") threadCreated++;
    if (ev.type === "agent.thread_message_received") {
      const txt = (ev.content ?? []).map((b: any) => b.text ?? "").join("");
      if (/helper-says-hi/.test(txt)) helperReplied = true;
    }
    if (ev.type === "agent.message") for (const b of ev.content ?? []) if (b.type === "text") lastText = b.text;
    if (ev.type === "session.status_idle") break;
  }
  record(
    8,
    "multiagent",
    threadCreated > 0,
    `threads_created=${threadCreated}, helper_replied=${helperReplied}, coordinator_final="${lastText.trim().slice(0, 80)}"`,
  );
}

// ─── Test 9 ─────────────────────────────────────────────────────────────────
// Walk usage fields from session events. Captures whatever shape the SDK exposes.
async function test9_costTelemetry(agentId: string, envId: string) {
  header(9, "Usage / cost telemetry (STORY-004b)");
  const session = await client.beta.sessions.create({
    agent: agentId,
    environment_id: envId,
    title: "spike-cost",
  });
  cleanup.sessions.push(session.id);

  const stream = await client.beta.sessions.events.stream(session.id);
  await client.beta.sessions.events.send(session.id, {
    events: [
      { type: "user.message", content: [{ type: "text", text: "Reply with 'pong'. Nothing else." }] },
    ],
  });

  const usagesSeen: any[] = [];
  for await (const ev of stream as AsyncIterable<any>) {
    if (ev.usage) usagesSeen.push({ type: ev.type, usage: ev.usage });
    if (ev.type === "session.status_idle") break;
  }

  // Also poll the session for aggregate fields.
  const retrieved: any = await client.beta.sessions.retrieve(session.id);
  const aggKeys = Object.keys(retrieved).filter((k) => /usage|cost|token/i.test(k));

  record(
    9,
    "usage",
    usagesSeen.length > 0 || aggKeys.length > 0,
    `event_usages_seen=${usagesSeen.length}, session.${aggKeys.join(",") || "(no usage keys on session)"}`,
  );
  if (usagesSeen.length) {
    console.log(`    sample: ${JSON.stringify(usagesSeen[0])}`);
  }
}

// ─── Cleanup ────────────────────────────────────────────────────────────────
async function cleanupAll() {
  console.log("\n━━━ Cleanup ━━━");
  for (const id of cleanup.sessions) {
    try {
      await client.beta.sessions.delete(id);
      console.log(`  deleted session ${id}`);
    } catch (e) {
      console.log(`  ! could not delete session ${id}: ${formatErr(e)}`);
    }
  }
  for (const id of cleanup.environments) {
    try {
      await client.beta.environments.delete(id);
      console.log(`  deleted environment ${id}`);
    } catch (e) {
      console.log(`  ! could not delete environment ${id}: ${formatErr(e)}`);
    }
  }
  for (const id of cleanup.agents) {
    try {
      await (client.beta.agents as any).delete?.(id);
      console.log(`  deleted agent ${id}`);
    } catch (e) {
      console.log(`  ! could not delete agent ${id}: ${formatErr(e)}`);
    }
  }
}

function formatErr(e: unknown): string {
  if (!e) return "(no error)";
  if (e instanceof Error) return `${e.name}: ${e.message}`;
  return String(e);
}

function summary() {
  console.log("\n━━━ Summary ━━━");
  for (const f of findings) {
    console.log(`  ${f.ok ? "✓" : "✗"} [${f.n}] ${f.name}: ${f.note}`);
  }
  console.log("");
  const passed = findings.filter((f) => f.ok).length;
  console.log(`${passed}/${findings.length} tests passed`);
}

async function safe(label: string, fn: () => Promise<void>) {
  try {
    await fn();
  } catch (e) {
    console.error(`  ✗ ${label} threw: ${formatErr(e)}`);
    findings.push({ n: -1, name: label, ok: false, note: `threw: ${formatErr(e)}` });
  }
}

async function main() {
  console.log(`Spike start at ${new Date().toISOString()}`);
  if (!process.env.ANTHROPIC_API_KEY) {
    console.error("ANTHROPIC_API_KEY missing from .env.local");
    process.exit(1);
  }
  try {
    await test1_auth();
    const agentId = await test2_createAgent();
    const envId = await test3_createEnvironment();
    await safe("test4+10+11", () => test4_sessionLifecycle(agentId, envId).then(() => undefined));
    await safe("test5", () => test5_customTool(envId));
    await safe("test6", () => test6_filesApi(agentId, envId));
    await safe("test7", () => test7_defineOutcome(agentId, envId));
    await safe("test8", () => test8_multiAgent(envId));
    await safe("test9", () => test9_costTelemetry(agentId, envId));
  } catch (e) {
    console.error(`\nspike halted (foundation step): ${formatErr(e)}`);
  } finally {
    await cleanupAll();
    summary();
  }
}

main().catch((e) => {
  console.error("fatal:", formatErr(e));
  process.exit(1);
});
