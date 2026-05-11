// STORY-007: persist Investigator session output to Postgres.
// STORY-019-R: also persist Researcher sub-thread traces spawned during the
// Investigator's session via the multiagent.agents roster.
//
// Splits cleanly from lib/managed-agents-client.ts (SDK adapter) and
// lib/investigator-tools.ts (per-session handlers). The orchestrator's
// dispatchV2Leaf calls persistInvestigatorOutput once after
// createInvestigatorSession returns.
//
// Idempotency: reasoning_traces and session_costs both use a delete-then-
// insert pattern keyed on the Anthropic session_id. If this function runs
// twice for the same session (recovery, retry), the end state is the same.

import { insforge } from "./db";
import {
  anthropicClient,
  parseCitations,
  parseSearchPath,
  parseStoppedBecause,
} from "./managed-agents-client";
import type { InvestigatorOutput, ReasoningStep } from "./schema";

// Anthropic published per-million-token pricing (USD). Cache rates follow
// Anthropic's standard ratio: cache_creation = 1.25× base input,
// cache_read = 0.1× base input. Lookup is by exact model id (the family
// alias the registration script passes to client.beta.agents.create); when
// the cost telemetry is computed, we fall back to Opus rates with a warn
// log if the model isn't in the table — better to overestimate than
// silently miss the bill.
interface ModelRates {
  input: number;
  output: number;
  cacheCreation: number;
  cacheRead: number;
}

const MODEL_RATES: Record<string, ModelRates> = {
  "claude-opus-4-7": {
    input: 15,
    output: 75,
    cacheCreation: 18.75,
    cacheRead: 1.5,
  },
  "claude-sonnet-4-6": {
    input: 3,
    output: 15,
    cacheCreation: 3.75,
    cacheRead: 0.3,
  },
  "claude-haiku-4-5": {
    input: 1,
    output: 5,
    cacheCreation: 1.25,
    cacheRead: 0.1,
  },
};

function rateFor(model: string): ModelRates {
  const r = MODEL_RATES[model];
  if (r) return r;
  console.warn(
    `[v2] no pricing for model="${model}" — falling back to Opus rates ` +
      `(cost_usd will overestimate). Add the rate to MODEL_RATES in lib/v2-persistence.ts.`,
  );
  return MODEL_RATES["claude-opus-4-7"];
}

function computeCostUsd(model: string, usage: InvestigatorOutput["usage"]): number {
  const rate = rateFor(model);
  const cost =
    (usage.inputTokens * rate.input +
      usage.outputTokens * rate.output +
      usage.cacheCreationInputTokens * rate.cacheCreation +
      usage.cacheReadInputTokens * rate.cacheRead) /
    1_000_000;
  // Round to 4 decimals to match the numeric(10,4) column.
  return Math.round(cost * 10_000) / 10_000;
}

export interface PersistOpts {
  runId: string;
  nodeId: string;
  /** Same trace_id we set on session.title; correlator anchor (STORY-002b). */
  traceId: string;
  /** Model name to record on tree_nodes.model_used. */
  modelLabel?: string;
}

/**
 * Persist a completed Investigator session. Updates the leaf's tree_nodes
 * row, writes the reasoning trace, records cost telemetry. Each step is
 * isolated — a failure in one is logged but does not abort the others, so a
 * partial persist is still useful for debugging via scripts/trace.ts.
 */
export async function persistInvestigatorOutput(
  output: InvestigatorOutput,
  opts: PersistOpts,
): Promise<void> {
  const errors: string[] = [];

  // 1. Update the leaf row — confidence + status + model_used. This is the
  //    one step we DON'T swallow: a silent failure here means rollup reads
  //    stale null confidence and the run completes with a wrong answer
  //    (guardian M1). Telemetry steps below stay log-and-continue.
  const treeUpd = await insforge.database
    .from("tree_nodes")
    .update({
      confidence: output.confidence,
      status: "complete",
      model_used: opts.modelLabel ?? "investigator-v2",
    })
    .eq("id", opts.nodeId);
  if (treeUpd.error) {
    throw new Error(
      `persistInvestigatorOutput: tree_nodes.update for node=${opts.nodeId} failed: ${treeUpd.error.message}`,
    );
  }

  // 2. Reasoning trace. Idempotent via delete-where-session-id then insert.
  //    No unique constraint on managed_agent_session_id (intentional — V2
  //    Researcher sub-sessions write their own rows with the same parent
  //    node), so we scope the delete to (node_id, agent_type, session_id).
  try {
    await insforge.database
      .from("reasoning_traces")
      .delete()
      .eq("node_id", opts.nodeId)
      .eq("agent_type", "investigator")
      .eq("managed_agent_session_id", output.managedAgentSessionId);

    const { error } = await insforge.database.from("reasoning_traces").insert([
      {
        node_id: opts.nodeId,
        agent_type: "investigator",
        managed_agent_session_id: output.managedAgentSessionId,
        trace_id: opts.traceId,
        steps: output.reasoningTrace,
        rejected_alternatives: output.rejectedAlternatives,
        // Persist outcomes grades structured (guardian M2). Empty array if
        // the agent didn't run an outcome — null only when truly missing.
        outcomes_grades: output.outcomesGrades.length > 0 ? output.outcomesGrades : null,
      },
    ]);
    if (error) errors.push(`reasoning_traces.insert: ${error.message}`);
  } catch (e) {
    errors.push(`reasoning_traces.insert threw: ${formatErr(e)}`);
  }

  // 3. Cost telemetry. session_costs PK is session_id, so an insert that
  //    races with a duplicate persist call would conflict — handle with
  //    delete-then-insert just like reasoning_traces.
  try {
    await insforge.database
      .from("session_costs")
      .delete()
      .eq("session_id", output.managedAgentSessionId);

    const costModel = opts.modelLabel ?? "claude-opus-4-7";
    const { error } = await insforge.database.from("session_costs").insert([
      {
        session_id: output.managedAgentSessionId,
        parent_session_id: null, // Investigator is top-level for this leaf
        run_id: opts.runId,
        node_id: opts.nodeId,
        agent_type: "investigator",
        model: costModel,
        input_tokens: output.usage.inputTokens,
        output_tokens: output.usage.outputTokens,
        cached_tokens: output.usage.cacheReadInputTokens,
        cost_usd: computeCostUsd(costModel, output.usage),
      },
    ]);
    if (error) errors.push(`session_costs.insert: ${error.message}`);
  } catch (e) {
    errors.push(`session_costs.insert threw: ${formatErr(e)}`);
  }

  // 4. STORY-019-R: persist Researcher sub-threads. Best-effort — a failure
  //    here doesn't invalidate the Investigator's main result. Sub-threads
  //    only exist when the Investigator is registered as a multi-agent
  //    coordinator AND chose to delegate during the session, so this is a
  //    no-op for V1-only or pre-STORY-017 deployments.
  try {
    await persistResearcherSubThreads(
      output.managedAgentSessionId,
      opts.nodeId,
      opts.traceId,
    );
  } catch (e) {
    console.warn(
      `[v2] persistResearcherSubThreads (non-fatal) failed for ` +
        `session=${output.managedAgentSessionId}: ${formatErr(e)}`,
    );
  }

  if (errors.length) {
    console.warn(
      `[v2] persistInvestigatorOutput partial failure for node=${opts.nodeId} ` +
        `session=${output.managedAgentSessionId}:\n  ${errors.join("\n  ")}`,
    );
  }
}

// ─── Researcher sub-thread persistence (STORY-019-R) ────────────────────────
//
// When the Investigator delegates to the Researcher mid-investigation, the
// Researcher runs in its own session thread (sharing the parent session ID).
// The primary thread's stream surfaces lifecycle + cross-posted tool events,
// but the Researcher's full OODA trace lives on its own thread. We list the
// session's threads post-completion, fetch each Researcher sub-thread's
// events, parse the final ANSWER block, and write a separate
// `reasoning_traces` row with `agent_type='researcher'` per spawned thread.
//
// Cost attribution caveat: session.usage on the parent rolls up across all
// threads — there's no per-thread usage API today. We don't write separate
// session_costs rows for sub-threads to avoid double-counting; per-thread
// cost attribution is a future story.

const RESEARCHER_AGENT_NAME = "agent-victor-researcher";

interface ThreadSummary {
  id: string;
  parent_thread_id: string | null;
  agent: { name?: string } | null;
}

interface ThreadEvent {
  type: string;
  processed_at?: string;
  content?: Array<{ type?: string; text?: string }>;
  thinking?: string;
  name?: string;
  input?: unknown;
  result?: string;
  explanation?: string;
}

async function persistResearcherSubThreads(
  sessionId: string,
  parentNodeId: string,
  parentTraceId: string,
): Promise<void> {
  const client = anthropicClient();

  // List threads. SDK returns an auto-paginating iterator; for our N (rarely
  // more than 1-2 sub-threads per leaf) eagerly collecting is fine.
  const threads: ThreadSummary[] = [];
  try {
    const list = await client.beta.sessions.threads.list(sessionId);
    for await (const t of list as AsyncIterable<ThreadSummary>) {
      threads.push(t);
    }
  } catch (e) {
    // Listing threads can fail if the session was already cleaned up; treat
    // as no sub-threads. This also keeps us from blocking on transient API
    // errors during the persist hot-path.
    console.warn(
      `[v2] persistResearcherSubThreads: list threads for session=${sessionId} ` +
        `failed: ${formatErr(e)}`,
    );
    return;
  }

  for (const thread of threads) {
    // Skip the primary thread (parent_thread_id null per multi-agent docs).
    if (!thread.parent_thread_id) continue;
    if ((thread.agent?.name ?? "") !== RESEARCHER_AGENT_NAME) continue;

    const events: ThreadEvent[] = [];
    try {
      const evList = await client.beta.sessions.threads.events.list(thread.id, {
        session_id: sessionId,
      });
      for await (const ev of evList as AsyncIterable<ThreadEvent>) {
        events.push(ev);
      }
    } catch (e) {
      console.warn(
        `[v2] persistResearcherSubThreads: list events for thread=${thread.id} ` +
          `failed: ${formatErr(e)}`,
      );
      continue;
    }

    const { steps, lastAgentText } = buildResearcherSteps(events);

    // Append synthesized summary steps so the OODATimeline can render the
    // Researcher's structured output (citations, query diversity, stop
    // reason) as first-class items rather than buried in the final
    // agent.message body.
    const citations = parseCitations(lastAgentText);
    const searchPath = parseSearchPath(lastAgentText);
    const stoppedBecause = parseStoppedBecause(lastAgentText);
    const finalTs = new Date().toISOString();
    if (citations.length > 0) {
      steps.push({
        phase: "researcher_citations",
        content: JSON.stringify(citations),
        timestamp: finalTs,
      });
    }
    if (searchPath.length > 0) {
      steps.push({
        phase: "researcher_search_path",
        content: JSON.stringify(searchPath),
        timestamp: finalTs,
      });
    }
    steps.push({
      phase: `stopped_because:${stoppedBecause}`,
      content: "",
      timestamp: finalTs,
    });

    try {
      await insforge.database
        .from("reasoning_traces")
        .delete()
        .eq("node_id", parentNodeId)
        .eq("agent_type", "researcher")
        .eq("managed_agent_session_id", thread.id);

      const { error } = await insforge.database.from("reasoning_traces").insert([
        {
          node_id: parentNodeId,
          agent_type: "researcher",
          managed_agent_session_id: thread.id,
          trace_id: parentTraceId,
          steps,
          rejected_alternatives: [],
          outcomes_grades: null,
        },
      ]);
      if (error) {
        console.warn(
          `[v2] persistResearcherSubThreads: insert thread=${thread.id} ` +
            `failed: ${error.message}`,
        );
      } else {
        console.log(
          `[v2] researcher sub-trace persisted: thread=${thread.id} ` +
            `steps=${steps.length} citations=${citations.length} ` +
            `stopped=${stoppedBecause}`,
        );
      }
    } catch (e) {
      console.warn(
        `[v2] persistResearcherSubThreads: insert thread=${thread.id} ` +
          `threw: ${formatErr(e)}`,
      );
    }
  }
}

/** Walk a sub-thread's event list and build the equivalent reasoning-trace
 *  steps that consumeStreamEvents would have emitted live. Mirrors the
 *  primary thread's mechanical phase tags so the OODATimeline can render
 *  Investigator + Researcher traces with the same component. */
function buildResearcherSteps(events: ThreadEvent[]): {
  steps: ReasoningStep[];
  lastAgentText: string;
} {
  const steps: ReasoningStep[] = [];
  let lastAgentText = "";
  for (const ev of events) {
    const ts = ev.processed_at ?? new Date().toISOString();
    switch (ev.type) {
      case "agent.message": {
        const blocks = ev.content ?? [];
        const text = blocks
          .filter((b) => b.type === "text" && b.text)
          .map((b) => b.text!)
          .join("\n");
        if (text) {
          lastAgentText = text;
          steps.push({ phase: "message", content: text, timestamp: ts });
        }
        break;
      }
      case "agent.thinking": {
        const blocks = ev.content ?? [];
        const text =
          blocks.map((b) => b.text ?? "").join("\n").trim() ||
          (typeof ev.thinking === "string" ? ev.thinking : "");
        if (text) steps.push({ phase: "thinking", content: text, timestamp: ts });
        break;
      }
      case "agent.tool_use":
      case "agent.custom_tool_use": {
        steps.push({
          phase: `tool_use:${ev.name ?? "unknown"}`,
          content: safeStringify(ev.input),
          timestamp: ts,
        });
        break;
      }
      case "agent.tool_result": {
        const blocks = ev.content ?? [];
        const text = blocks
          .map((b) => b.text ?? "")
          .join("\n")
          .slice(0, 4000);
        if (text) steps.push({ phase: "tool_result", content: text, timestamp: ts });
        break;
      }
      case "span.outcome_evaluation_end": {
        steps.push({
          phase: `outcome_eval:${ev.result ?? "unknown"}`,
          content: ev.explanation ?? "",
          timestamp: ts,
        });
        break;
      }
    }
  }
  return { steps, lastAgentText };
}

function safeStringify(value: unknown): string {
  try {
    return JSON.stringify(value).slice(0, 4000);
  } catch {
    return String(value).slice(0, 4000);
  }
}

function formatErr(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
}
