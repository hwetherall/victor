// STORY-002b: trace_id correlator.
//
// Usage: npx tsx scripts/trace.ts <trace_id>
//
// Prints, in timestamp order, every row across our V2 tables that share the
// given trace_id, plus the Anthropic Console URL for the underlying session.
// When a leaf fails on day 12 and you need to debug across orchestrator logs +
// the Console + Postgres, this is the entry point.

import { config as loadEnv } from "dotenv";
loadEnv({ path: ".env.local" });

import { insforge } from "../lib/db";

interface OrderedRow {
  ts: string;
  source: string;
  detail: string;
}

async function fetchTreeNodes(traceId: string): Promise<OrderedRow[]> {
  const { data, error } = await insforge.database
    .from("tree_nodes")
    .select("id, label, type, status, confidence, updated_at")
    .eq("trace_id", traceId);
  if (error) throw new Error(`tree_nodes: ${error.message}`);
  return ((data as Array<{
    id: string;
    label: string;
    type: string;
    status: string;
    confidence: number | null;
    updated_at: string;
  }>) ?? []).map((r) => ({
    ts: r.updated_at,
    source: "tree_nodes",
    detail: `${r.id} [${r.type}] ${r.label} status=${r.status} conf=${r.confidence}`,
  }));
}

async function fetchReasoningTraces(traceId: string): Promise<OrderedRow[]> {
  const { data, error } = await insforge.database
    .from("reasoning_traces")
    .select("id, node_id, agent_type, managed_agent_session_id, steps, created_at")
    .eq("trace_id", traceId);
  if (error) throw new Error(`reasoning_traces: ${error.message}`);
  return ((data as Array<{
    id: string;
    node_id: string;
    agent_type: string;
    managed_agent_session_id: string | null;
    steps: unknown[];
    created_at: string;
  }>) ?? []).map((r) => ({
    ts: r.created_at,
    source: "reasoning_traces",
    detail:
      `${r.id} agent=${r.agent_type} node=${r.node_id} ` +
      `session=${r.managed_agent_session_id ?? "—"} steps=${(r.steps ?? []).length}`,
  }));
}

async function fetchSessionCosts(traceId: string): Promise<OrderedRow[]> {
  // session_costs is keyed on session_id, not trace_id directly. Join via
  // reasoning_traces to find sessions linked to this trace.
  const { data: traces, error } = await insforge.database
    .from("reasoning_traces")
    .select("managed_agent_session_id")
    .eq("trace_id", traceId);
  if (error) throw new Error(`reasoning_traces (for costs): ${error.message}`);
  const sessionIds = ((traces as Array<{ managed_agent_session_id: string | null }>) ?? [])
    .map((r) => r.managed_agent_session_id)
    .filter((id): id is string => id !== null);
  if (sessionIds.length === 0) return [];

  const { data, error: costsErr } = await insforge.database
    .from("session_costs")
    .select("session_id, agent_type, model, input_tokens, output_tokens, cost_usd, created_at")
    .in("session_id", sessionIds);
  if (costsErr) throw new Error(`session_costs: ${costsErr.message}`);
  return ((data as Array<{
    session_id: string;
    agent_type: string;
    model: string;
    input_tokens: number;
    output_tokens: number;
    cost_usd: string | number;
    created_at: string;
  }>) ?? []).map((r) => ({
    ts: r.created_at,
    source: "session_costs",
    detail:
      `${r.session_id} ${r.agent_type}/${r.model} ` +
      `in=${r.input_tokens} out=${r.output_tokens} $${r.cost_usd}`,
  }));
}

async function main() {
  const traceId = process.argv[2];
  if (!traceId) {
    console.error("usage: npx tsx scripts/trace.ts <trace_id>");
    process.exit(1);
  }
  console.log(`Trace: ${traceId}\n`);

  const [nodes, traces, costs] = await Promise.all([
    fetchTreeNodes(traceId),
    fetchReasoningTraces(traceId),
    fetchSessionCosts(traceId),
  ]);

  const all = [...nodes, ...traces, ...costs].sort((a, b) =>
    a.ts.localeCompare(b.ts),
  );

  if (all.length === 0) {
    console.log("(no rows found across tree_nodes, reasoning_traces, session_costs)");
    return;
  }

  for (const row of all) {
    console.log(`${row.ts}  ${row.source.padEnd(18)}  ${row.detail}`);
  }

  // Anthropic Console URLs for the sessions in this trace. Pull session IDs
  // from a typed re-fetch rather than re-parsing the formatted detail string,
  // so a future change to detail formatting can't silently break the URLs.
  const consoleIds = await fetchSessionIdsForTrace(traceId);
  if (consoleIds.length) {
    console.log("\nAnthropic Console:");
    for (const sid of consoleIds) {
      console.log(`  https://console.anthropic.com/managed-agents/sessions/${sid}`);
    }
  }
}

async function fetchSessionIdsForTrace(traceId: string): Promise<string[]> {
  const { data, error } = await insforge.database
    .from("reasoning_traces")
    .select("managed_agent_session_id")
    .eq("trace_id", traceId);
  if (error) return [];
  return ((data as Array<{ managed_agent_session_id: string | null }>) ?? [])
    .map((r) => r.managed_agent_session_id)
    .filter((s): s is string => s !== null);
}

main().catch((e) => {
  console.error("trace failed:", e instanceof Error ? e.message : e);
  process.exit(1);
});
