// V2 leaf runtime adapter. Wraps @anthropic-ai/sdk for creating Investigator
// and Researcher sessions. The SDK auto-sets the `managed-agents-2026-04-01`
// beta header (confirmed in day-1 spike).
//
// STORY-005 implements `createInvestigatorSession` with placeholder custom-
// tool handlers. STORY-006 replaces the placeholders with real bindings.
// STORY-017 implements `createResearcherSession`.

import * as fs from "node:fs";
import * as path from "node:path";
import Anthropic from "@anthropic-ai/sdk";
import { buildToolHandlers } from "./investigator-tools";
import type {
  ArtifactType,
  InvestigatorInput,
  InvestigatorOutput,
  OutcomeGrade,
  ReasoningStep,
  RejectedAlternative,
  ResearcherInput,
  ResearcherOutput,
} from "./schema";

// ─── Client ──────────────────────────────────────────────────────────────────

let _client: Anthropic | null = null;

/** Lazy-init Anthropic client. Reads ANTHROPIC_API_KEY from env. */
export function anthropicClient(): Anthropic {
  if (!_client) {
    const apiKey = process.env.ANTHROPIC_API_KEY;
    if (!apiKey) {
      throw new Error(
        "ANTHROPIC_API_KEY missing. V2 leaf runtime requires direct Anthropic " +
          "access (separate from the OpenRouter key used by V1).",
      );
    }
    _client = new Anthropic({ apiKey });
  }
  return _client;
}

// ─── Agent / environment IDs ─────────────────────────────────────────────────

interface AgentRegistry {
  investigatorAgentId: string;
  researcherAgentId: string | null;
  environmentId: string;
}

/**
 * Read the registered agent + environment IDs from env. The Researcher is
 * optional at this stage — STORY-005 ships the Investigator alone; STORY-017
 * adds the Researcher. requireResearcher=true asks for the Researcher and
 * throws if it isn't registered yet.
 */
export function readAgentRegistry(opts: { requireResearcher?: boolean } = {}): AgentRegistry {
  const investigatorAgentId = process.env.INVESTIGATOR_AGENT_ID;
  const researcherAgentId = process.env.RESEARCHER_AGENT_ID ?? null;
  const environmentId = process.env.MANAGED_AGENTS_ENVIRONMENT_ID;
  const missing: string[] = [];
  if (!investigatorAgentId) missing.push("INVESTIGATOR_AGENT_ID");
  if (!environmentId) missing.push("MANAGED_AGENTS_ENVIRONMENT_ID");
  if (opts.requireResearcher && !researcherAgentId) missing.push("RESEARCHER_AGENT_ID");
  if (missing.length) {
    throw new Error(
      `V2 leaf runtime missing env vars: ${missing.join(", ")}. ` +
        `Run scripts/register-investigator.ts (and STORY-017's researcher ` +
        `registration when ready) to populate these.`,
    );
  }
  return {
    investigatorAgentId: investigatorAgentId!,
    researcherAgentId,
    environmentId: environmentId!,
  };
}

// ─── Rubric ──────────────────────────────────────────────────────────────────

/** Read RUBRIC.md and substitute per-session placeholders. */
function buildRubric(input: InvestigatorInput): string {
  const tmpl = fs.readFileSync(
    path.resolve("agents/managed/investigator/RUBRIC.md"),
    "utf-8",
  );
  return tmpl
    .replaceAll("{{falsifier}}", input.falsifier)
    .replaceAll("{{threshold_metric}}", String(input.threshold.metric))
    .replaceAll("{{threshold_value}}", String(input.threshold.value))
    .replaceAll("{{hypothesis_claim}}", input.hypothesis.claim);
}

/** Read Researcher RUBRIC.md and substitute per-session placeholders. */
function buildResearcherRubric(
  input: ResearcherInput,
  resolved: { confidenceTarget: number; maxSearches: number; diminishingReturnsThreshold: number },
): string {
  const tmpl = fs.readFileSync(
    path.resolve("agents/managed/researcher/RUBRIC.md"),
    "utf-8",
  );
  return tmpl
    .replaceAll("{{question}}", input.question)
    .replaceAll("{{confidence_target}}", String(resolved.confidenceTarget))
    .replaceAll("{{max_searches}}", String(resolved.maxSearches))
    .replaceAll(
      "{{diminishing_returns_threshold}}",
      String(resolved.diminishingReturnsThreshold),
    );
}

// Custom tool handlers live in lib/investigator-tools.ts. The factory there
// (buildToolHandlers, imported above) closes over the per-session
// InvestigatorInput so each handler has caseId / nodeId / documentIds /
// siblingLeafIds without thread-through. STORY-005 shipped placeholder
// handlers inline here; STORY-006 promoted them to real DB / storage
// bindings in the dedicated module.

// ─── Stream-loop primitives ──────────────────────────────────────────────────
//
// The Investigator's stream-and-respond loop has three concerns kept as
// separate helpers below:
//   • consumeStreamEvents — drain one stream, append to caller's collectors
//   • dispatchToolResponses — reply to event_ids using the captured pending
//     uses + the per-session handler map
//   • createInvestigatorSession — orchestrate cycles + final assembly
//
// STORY-017 (Researcher) reuses these helpers so the multi-agent surface
// doesn't duplicate stream-loop logic.

interface PendingToolUse {
  /** sevt_* of the agent.tool_use OR agent.custom_tool_use event. The Anthropic
   *  protocol field is `custom_tool_use_id` for custom tool replies and
   *  `tool_use_id` for built-in confirmations — see dispatchToolResponses. */
  eventId: string;
  name: string;
  input: unknown;
  /** "builtin" → respond with user.tool_confirmation; "custom" → user.custom_tool_result. */
  kind: "builtin" | "custom";
  /** Sub-thread the tool_use originated on (`sthr_*`), captured from
   *  `ev.session_thread_id`. Per Anthropic SDK docstring on agent.{tool_use,
   *  custom_tool_use}.session_thread_id: "Echo this on a user.{tool_confirmation,
   *  custom_tool_result} event to route the [approval/result] back." Without
   *  the echo on a multiagent session, the API rejects with
   *  "no non-archived thread is waiting on tool_use_id sevt_..." (the
   *  reply hits the primary thread which isn't actually the waiting thread).
   *  Empty/null when the tool_use was on the primary thread itself. */
  sessionThreadId?: string | null;
  /** Set true after we've replied. Prevents double-responding when the API
   *  re-emits idle with a still-pending event id from a prior cycle (which
   *  happens when the harness queues multiple agent.tool_use emits but only
   *  surfaces them in stop_reason.event_ids one at a time). */
  responded?: boolean;
}

interface StopReason {
  type: string;
  event_ids?: string[];
}

interface StreamCollectors {
  pendingToolUses: PendingToolUse[];
  reasoningTrace: ReasoningStep[];
  outcomesGrades: OutcomeGrade[];
  /** Untruncated content from `write` / `edit` tool calls targeting
   *  `/mnt/session/outputs/*`. STORY-021: the Researcher reliably writes its
   *  structured ANSWER block to a sandbox file but emits a chatty status
   *  report as its final agent.message — the parser walks this list as a
   *  fallback when lastAgentText has no parseable block. The reasoning-trace
   *  copy of the same content is truncated by `safeStringify` to 4000 chars,
   *  which loses the tail of long blocks; this collector keeps the full
   *  text for parsing. */
  sandboxBlockSources: string[];
}

interface ConsumeResult {
  /** Last `agent.message` text observed. Caller may pass this back in via
   *  the next call's `initialLastAgentText` to thread it across cycles. */
  lastAgentText: string;
  stopReason: StopReason | null;
  /** True if the stream threw `TypeError: terminated` (or similar undici
   *  "fetch failed" / "aborted") — meaning the session ended out from under
   *  us. Caller should break the cycle loop, not continue. */
  terminated: boolean;
}

/** Drain a single SSE stream until `session.status_idle` (or it terminates).
 *  Appends events to `collectors`; returns the stop_reason + whether the
 *  stream died unnaturally. Pure data-collection — no API calls. */
async function consumeStreamEvents(
  stream: AsyncIterable<unknown>,
  collectors: StreamCollectors,
  initialLastAgentText: string,
): Promise<ConsumeResult> {
  let lastAgentText = initialLastAgentText;
  let stopReason: StopReason | null = null;

  try {
    for await (const ev of stream as AsyncIterable<{
      type: string;
      [k: string]: unknown;
    }>) {
      const eventTs =
        typeof ev.processed_at === "string" ? ev.processed_at : new Date().toISOString();

      switch (ev.type) {
        case "agent.message": {
          const blocks = (ev.content as Array<{ type: string; text?: string }>) ?? [];
          const text = blocks
            .filter((b) => b.type === "text" && b.text)
            .map((b) => b.text!)
            .join("\n");
          if (text) {
            lastAgentText = text;
            collectors.reasoningTrace.push({
              phase: "message",
              content: text,
              timestamp: eventTs,
            });
          }
          break;
        }
        case "agent.thinking": {
          const blocks = (ev.content as Array<{ text?: string }>) ?? [];
          const text =
            blocks.map((b) => b.text ?? "").join("\n").trim() ||
            (typeof ev.thinking === "string" ? ev.thinking : "");
          if (text) {
            collectors.reasoningTrace.push({
              phase: "thinking",
              content: text,
              timestamp: eventTs,
            });
          }
          break;
        }
        case "agent.tool_use": {
          // Built-in tool. Most auto-execute, but always_ask permission lands
          // the event in stop_reason.event_ids and we respond with
          // user.tool_confirmation. Track defensively.
          // STORY-020 debug: full event dump for dispatch diagnosis.
          console.log(`[v2-debug] agent.tool_use FULL=${JSON.stringify(ev).slice(0, 800)}`);
          collectors.pendingToolUses.push({
            eventId: ev.id as string,
            name: ev.name as string,
            input: ev.input,
            kind: "builtin",
            sessionThreadId: typeof ev.session_thread_id === "string" ? ev.session_thread_id : null,
          });
          collectors.reasoningTrace.push({
            phase: `tool_use:${ev.name as string}`,
            content: safeStringify(ev.input),
            timestamp: eventTs,
          });
          // STORY-021 sandbox-block fallback: capture full untruncated content
          // from write/edit calls to /mnt/session/outputs/* — the Researcher
          // (and likely the Investigator) reliably puts its structured block
          // there even when its final agent.message is a chatty status report.
          captureSandboxBlock(collectors.sandboxBlockSources, ev.name as string, ev.input);
          break;
        }
        case "agent.custom_tool_use": {
          console.log(`[v2-debug] agent.custom_tool_use FULL=${JSON.stringify(ev).slice(0, 800)}`);
          collectors.pendingToolUses.push({
            eventId: ev.id as string,
            name: ev.name as string,
            input: ev.input,
            kind: "custom",
            sessionThreadId: typeof ev.session_thread_id === "string" ? ev.session_thread_id : null,
          });
          collectors.reasoningTrace.push({
            phase: `tool_use:${ev.name as string}`,
            content: safeStringify(ev.input),
            timestamp: eventTs,
          });
          break;
        }
        case "agent.tool_result": {
          const blocks = (ev.content as Array<{ text?: string }>) ?? [];
          const text = blocks.map((b) => b.text ?? "").join("\n").slice(0, 4000);
          if (text) {
            collectors.reasoningTrace.push({
              phase: "tool_result",
              content: text,
              timestamp: eventTs,
            });
          }
          break;
        }
        case "span.outcome_evaluation_end": {
          const grade: OutcomeGrade = {
            result: String(ev.result),
            iteration: typeof ev.iteration === "number" ? ev.iteration : 0,
          };
          if (typeof ev.explanation === "string") grade.explanation = ev.explanation;
          collectors.outcomesGrades.push(grade);
          collectors.reasoningTrace.push({
            phase: `outcome_eval:${grade.result}`,
            content: grade.explanation ?? "",
            timestamp: eventTs,
          });
          break;
        }
        case "session.status_idle": {
          stopReason =
            (ev.stop_reason as StopReason | null | undefined) ?? null;
          console.log(`[v2-debug] session.status_idle stop_reason=${JSON.stringify(stopReason)}`);
          break;
        }
        // STORY-017 multi-agent surface. The Investigator is configured as a
        // coordinator with the Researcher in its multiagent.agents roster;
        // sub-thread events cross-post to the primary thread (per Anthropic
        // multi-agent docs, "Tool permissions and custom tools" section). We
        // log lifecycle/message events to the trace and treat
        // session.thread_status_idle with requires_action the same as the
        // session-level idle — the dispatch loop responds to event_ids and
        // the server routes the reply to the originating thread.
        case "session.thread_created": {
          collectors.reasoningTrace.push({
            phase: `thread_created:${typeof ev.agent_name === "string" ? ev.agent_name : "sub"}`,
            content: typeof ev.session_thread_id === "string" ? ev.session_thread_id : "",
            timestamp: eventTs,
          });
          break;
        }
        case "session.thread_status_running": {
          console.log(`[v2-debug] session.thread_status_running FULL=${JSON.stringify(ev).slice(0, 500)}`);
          collectors.reasoningTrace.push({
            phase: `thread_running:${typeof ev.agent_name === "string" ? ev.agent_name : "sub"}`,
            content: typeof ev.session_thread_id === "string" ? ev.session_thread_id : "",
            timestamp: eventTs,
          });
          break;
        }
        case "session.thread_status_terminated": {
          collectors.reasoningTrace.push({
            phase: `thread_terminated:${typeof ev.agent_name === "string" ? ev.agent_name : "sub"}`,
            content: typeof ev.session_thread_id === "string" ? ev.session_thread_id : "",
            timestamp: eventTs,
          });
          break;
        }
        case "session.thread_status_idle": {
          // Informational only. The earlier hypothesis — that we should
          // promote thread_status_idle's stop_reason to a dispatch point —
          // turned out to be wrong: with a multi-agent-registered session,
          // thread_status_idle ALSO fires for the primary thread alongside
          // session.status_idle, and dispatching off the thread event leads
          // to "no non-archived thread is waiting on tool_use_id" 400s
          // (the request races the canonical session-level dispatch).
          // session.status_idle is the canonical break point; sub-agent
          // requires_action event_ids cross-post there too per the
          // multi-agent docs ("the event is cross-posted to the primary
          // thread with session_thread_id identifying the originating
          // session thread"). Keep this case purely as a trace breadcrumb.
          console.log(`[v2-debug] session.thread_status_idle FULL=${JSON.stringify(ev).slice(0, 500)}`);
          const subStop = (ev.stop_reason as StopReason | null | undefined) ?? null;
          // STORY-020 fix (gotcha #17): when a sub-thread idles with
          // requires_action, the agent.{tool_use,custom_tool_use} events
          // emitted on that sub-thread carry NO session_thread_id (per
          // SDK docstring: "Empty on the thread's own events"). The
          // thread-level idle event is where the routing info lives:
          // it carries `session_thread_id` AND the `event_ids` that need
          // a reply. Apply the sub-thread id to each matching pending
          // tool_use here so dispatchToolResponses can echo it on the
          // reply. Without this echo, the API rejects every reply with
          // "no non-archived thread is waiting on tool_use_id sevt_..."
          // because session-level events.send routes to the primary,
          // not the sub-thread that's actually waiting.
          const subThreadId =
            typeof ev.session_thread_id === "string" ? ev.session_thread_id : null;
          if (
            subThreadId &&
            subStop?.type === "requires_action" &&
            Array.isArray(subStop.event_ids)
          ) {
            for (const eid of subStop.event_ids) {
              const tu = collectors.pendingToolUses.find((p) => p.eventId === eid);
              if (tu && !tu.sessionThreadId) tu.sessionThreadId = subThreadId;
            }
          }
          collectors.reasoningTrace.push({
            phase: `thread_idle:${typeof ev.agent_name === "string" ? ev.agent_name : "sub"}`,
            content: subStop ? `stop_reason=${subStop.type}` : "",
            timestamp: eventTs,
          });
          break;
        }
        case "agent.thread_message_sent": {
          // Coordinator delegated to a sub-agent. The "to_agent_name" tells
          // the OODATimeline which sub-agent received the work.
          const blocks = (ev.content as Array<{ type: string; text?: string }>) ?? [];
          const text = blocks
            .filter((b) => b.type === "text" && b.text)
            .map((b) => b.text!)
            .join("\n");
          collectors.reasoningTrace.push({
            phase: `delegate_to:${typeof ev.to_agent_name === "string" ? ev.to_agent_name : "sub"}`,
            content: text.slice(0, 4000),
            timestamp: eventTs,
          });
          break;
        }
        case "agent.thread_message_received": {
          // Sub-agent delivered its result back to the coordinator.
          const blocks = (ev.content as Array<{ type: string; text?: string }>) ?? [];
          const text = blocks
            .filter((b) => b.type === "text" && b.text)
            .map((b) => b.text!)
            .join("\n");
          collectors.reasoningTrace.push({
            phase: `delegate_result:${typeof ev.from_agent_name === "string" ? ev.from_agent_name : "sub"}`,
            content: text.slice(0, 4000),
            timestamp: eventTs,
          });
          break;
        }
      }
      if (ev.type === "session.status_idle") break;
      // Note: session.thread_status_idle is intentionally NOT a break point.
      // See the case handler above for rationale.
    }
  } catch (streamErr) {
    const msg = streamErr instanceof Error ? streamErr.message : String(streamErr);
    if (/terminated|aborted|fetch failed/i.test(msg)) {
      console.warn(`[v2] stream terminated mid-cycle (treating as session end): ${msg}`);
      return { lastAgentText, stopReason, terminated: true };
    }
    throw streamErr;
  }
  return { lastAgentText, stopReason, terminated: false };
}

interface DispatchSideEffects {
  artifacts: InvestigatorOutput["artifacts"];
  escalations: InvestigatorOutput["escalations"];
  reasoningTrace: ReasoningStep[];
}

/** Reply to every event_id the API names, branching on `kind` to send
 *  user.tool_confirmation (built-in) or user.custom_tool_result (custom).
 *  Mutates `pendingToolUses[i].responded` and the side-effect collectors.
 *  Returns the count of responses actually sent this cycle — caller breaks
 *  the loop on zero to avoid spinning. */
async function dispatchToolResponses(
  client: Anthropic,
  sessionId: string,
  eventIds: string[],
  pendingToolUses: PendingToolUse[],
  handlers: Record<string, (input: unknown) => Promise<{ text: string; is_error?: boolean }>>,
  side: DispatchSideEffects,
): Promise<number> {
  let responded = 0;
  for (const id of eventIds) {
    const tu = pendingToolUses.find((p) => p.eventId === id);
    if (!tu) {
      console.warn(`[v2] no captured tool_use for event_id=${id} — skipping`);
      continue;
    }
    if (tu.responded) continue; // API re-emit; already handled

    if (tu.kind === "builtin") {
      try {
        // Echo session_thread_id when the tool_use originated on a sub-thread
        // (multiagent / sub-agent dispatch). The SDK's params type doesn't
        // declare this field but the API documents + accepts it; without the
        // echo, the API returns 400 "no non-archived thread is waiting on
        // tool_use_id". Cast through unknown to bypass the missing-field
        // strictness — runtime API ignores the extra field on primary-thread
        // tool uses (sessionThreadId === null).
        const event: Record<string, unknown> = {
          type: "user.tool_confirmation",
          tool_use_id: id,
          result: "allow",
        };
        if (tu.sessionThreadId) event.session_thread_id = tu.sessionThreadId;
        await client.beta.sessions.events.send(sessionId, {
          events: [event as unknown as Parameters<typeof client.beta.sessions.events.send>[1]["events"][number]],
        });
        tu.responded = true;
        responded++;
        side.reasoningTrace.push({
          phase: `tool_confirmation:${tu.name}`,
          content: "allow",
          timestamp: new Date().toISOString(),
        });
      } catch (e) {
        console.warn(
          `[v2] tool_confirmation rejected for ${tu.name}@${id}: ${e instanceof Error ? e.message : e}`,
        );
        tu.responded = true;
      }
      continue;
    }

    // tu.kind === "custom"
    const handler = handlers[tu.name];
    let result: { text: string; is_error?: boolean };
    if (handler) {
      try {
        result = await handler(tu.input);
      } catch (e) {
        result = {
          text: JSON.stringify({
            error: `${tu.name} handler threw: ${e instanceof Error ? e.message : String(e)}`,
          }),
          is_error: true,
        };
      }
    } else {
      result = {
        text: JSON.stringify({ error: `No handler for custom tool ${tu.name}` }),
        is_error: true,
      };
    }
    if (!result.is_error) {
      capturePostHandlerSideEffects(tu, result.text, side.artifacts, side.escalations);
    }
    side.reasoningTrace.push({
      phase: `custom_tool_result:${tu.name}`,
      content: result.text.slice(0, 4000),
      timestamp: new Date().toISOString(),
    });
    try {
      // Echo session_thread_id for sub-thread routing (see comment in builtin
      // branch above). Cast through unknown — the SDK params type omits the
      // field but the API requires it on multiagent sub-thread dispatches.
      const event: Record<string, unknown> = {
        type: "user.custom_tool_result",
        custom_tool_use_id: id,
        content: [{ type: "text", text: result.text }],
        is_error: result.is_error ?? false,
      };
      if (tu.sessionThreadId) event.session_thread_id = tu.sessionThreadId;
      console.log(`[v2-debug] sending custom_tool_result for ${tu.name}@${id}, session_thread_id=${JSON.stringify(event.session_thread_id ?? null)}`);
      await client.beta.sessions.events.send(sessionId, {
        events: [event as unknown as Parameters<typeof client.beta.sessions.events.send>[1]["events"][number]],
      });
      tu.responded = true;
      responded++;
    } catch (e) {
      console.warn(
        `[v2] custom_tool_result rejected for ${tu.name}@${id}: ${e instanceof Error ? e.message : e}`,
      );
      tu.responded = true;
    }
  }
  return responded;
}

/**
 * Dispatch one V2 leaf to the Investigator Managed Agent. Streams the session
 * to terminal idle, replying to custom-tool requests with placeholder results
 * until STORY-006 wires the real handlers. Returns a minimal
 * InvestigatorOutput; full reasoningTrace + artifacts wiring comes in
 * STORY-007/008.
 *
 * Stream lifecycle (per spike finding N1):
 * - re-streaming after `end_turn` throws TypeError: terminated. Done correctly here:
 *   we re-attach ONLY when stop_reason.type === "requires_action".
 */
export async function createInvestigatorSession(
  input: InvestigatorInput,
): Promise<InvestigatorOutput> {
  const { investigatorAgentId, environmentId } = readAgentRegistry();
  const client = anthropicClient();
  const handlers = buildToolHandlers(input);

  const session = await client.beta.sessions.create({
    agent: investigatorAgentId,
    environment_id: environmentId,
    title: input.traceId,
  });

  const rubric = buildRubric(input);
  const description =
    `Test the hypothesis: "${input.hypothesis.claim}". ` +
    `The falsifier is: ${input.falsifier}. ` +
    `Threshold: ${input.threshold.metric} = ${input.threshold.value}. ` +
    `Produce an evidence summary, calibrated confidence, and any artifacts ` +
    `that address the falsifier directly.`;

  // Open the first stream and kick off the outcome.
  let stream: AsyncIterable<unknown> = await client.beta.sessions.events.stream(
    session.id,
  );
  await client.beta.sessions.events.send(session.id, {
    events: [
      {
        type: "user.define_outcome",
        description,
        rubric: { type: "text", content: rubric },
        // 5 iterations gives the grader room to push back on the upload-
        // artifact requirement and the structured-summary requirement
        // without hitting max_iterations on the first sparse-data leaf.
        max_iterations: 5,
      },
    ],
  });

  // Stream-and-respond cycle loop. Heavy lifting in consumeStreamEvents +
  // dispatchToolResponses — see the helpers above.
  let lastAgentText = "";
  const collectors: StreamCollectors = {
    pendingToolUses: [], // persisted across cycles; entries marked responded after reply
    reasoningTrace: [],
    outcomesGrades: [],
    sandboxBlockSources: [],
  };
  const side: DispatchSideEffects = {
    artifacts: [],
    escalations: [],
    reasoningTrace: collectors.reasoningTrace,
  };
  let cycles = 0;
  const MAX_CYCLES = 12; // generous; outcomes max_iterations is the real cap

  while (cycles < MAX_CYCLES) {
    cycles++;
    const consume = await consumeStreamEvents(stream, collectors, lastAgentText);
    lastAgentText = consume.lastAgentText;
    if (consume.terminated) break;
    if (!consume.stopReason || consume.stopReason.type !== "requires_action") break;

    const eventIds = consume.stopReason.event_ids ?? [];
    const unresponded = collectors.pendingToolUses.filter((p) => !p.responded);
    console.log(
      `[v2] cycle ${cycles}: requires_action event_ids=[${eventIds.join(",")}]; ` +
        `total_pending=${collectors.pendingToolUses.length} unresponded=${unresponded.length} ` +
        `(${unresponded.map((p) => `${p.kind}:${p.name}@${p.eventId}`).join(",")})`,
    );

    // Decide what to do this cycle by intersecting the API's event_ids with
    // our pendingToolUses' responded flag. Three cases:
    //
    //   (1) Some event_ids reference unresponded tool_uses → real dispatch.
    //   (2) All event_ids reference already-responded tool_uses (or eventIds
    //       is empty) → re-emit / agent-still-thinking scenario; re-stream.
    //   (3) eventIds has IDs not in our pendingToolUses (orphan events) →
    //       informational warning, then re-stream. MAX_CYCLES is the safety
    //       net against an infinite loop.
    //
    // The previous `unresponded.length === 0 → break` early-exit (STORY-020
    // Phase B observation 2026-05-10) bailed prematurely when a leaf went
    // bash-result → idle → agent-still-thinking. With non-multiagent Haiku,
    // both tam-sam-som and investment-vs-ramp emitted `base64 -w 0 ... | cat`
    // intending to call upload_artifact next, but the cycle broke mid-thought.
    // Always re-stream when there's no new dispatch work; let MAX_CYCLES + the
    // 0-responses spin guard below catch genuine stalls.
    const eventIdsNeedingResponse = eventIds.filter((id) => {
      const tu = collectors.pendingToolUses.find((p) => p.eventId === id);
      return tu && !tu.responded;
    });

    if (eventIdsNeedingResponse.length === 0) {
      const orphan = eventIds.length > 0
        ? ` (eventIds=[${eventIds.join(",")}] all already-responded or orphan)`
        : "";
      console.log(
        `[v2] cycle ${cycles}: no new dispatch work this cycle — re-streaming to wait for next event${orphan}`,
      );
      try {
        stream = await client.beta.sessions.events.stream(session.id);
        continue;
      } catch (e) {
        const msg = e instanceof Error ? e.message : String(e);
        console.warn(`[v2] re-stream failed (treating as session end): ${msg}`);
        break;
      }
    }

    const respondedCount = await dispatchToolResponses(
      client,
      session.id,
      eventIds,
      collectors.pendingToolUses,
      handlers,
      side,
    );
    if (respondedCount === 0) {
      console.warn(`[v2] cycle ${cycles}: 0 responses sent — breaking to avoid spin`);
      break;
    }

    try {
      stream = await client.beta.sessions.events.stream(session.id);
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      console.warn(`[v2] re-stream failed (treating as session end): ${msg}`);
      break;
    }
  }

  // STORY-020 Phase B sandbox-block fallback. Mirror of the Researcher
  // post-processing pattern (createResearcherSession lines ~1078): pick the
  // source with the most parseable structured fields among lastAgentText +
  // every captured sandbox write. Phase A.5 confirmed the Investigator
  // drift mode matches the Researcher's: chatty status as final
  // agent.message, structured CONFIDENCE/EVIDENCE_SUMMARY/REJECTED_ALTERNATIVES
  // block written to /mnt/session/outputs/*.md. The parsers don't care
  // which source the text comes from; the only question is which source
  // has the most structured-field hits.
  const scoreSource = (src: string): number => {
    let score = 0;
    if (parseConfidence(src) > 0) score++;
    if (extractField(src, "EVIDENCE_SUMMARY")) score++;
    if (parseRejectedAlternatives(src).length > 0) score++;
    return score;
  };
  let blockSource = lastAgentText;
  let bestScore = scoreSource(lastAgentText);
  for (const src of collectors.sandboxBlockSources) {
    const score = scoreSource(src);
    if (score > bestScore) {
      blockSource = src;
      bestScore = score;
    }
  }

  // Final output assembly. Primary parser reads CONFIDENCE/EVIDENCE_SUMMARY/
  // REJECTED_ALTERNATIVES from the chosen block source. Fallback (when the
  // agent satisfied the outcome via tools without emitting a summary
  // block anywhere): derive confidence from outcomes grades, evidence
  // summary from any captured trace text.
  let confidence = parseConfidence(blockSource);
  let evidenceSummary =
    extractField(blockSource, "EVIDENCE_SUMMARY") ?? lastAgentText.slice(0, 800);
  const rejectedAlternatives = parseRejectedAlternatives(blockSource);

  if (confidence === 0) {
    // STORY-020 narrative fallback: try loose "Confidence: 0.6" / "**Confidence:** 0.60"
    // form before grader-derived. Recon (session 2 SH4.2 run) showed the Investigator
    // routinely writes confidence in narrative prose rather than emitting the strict
    // first-line CONFIDENCE: block. Run the loose parser on the chosen block source
    // first (which may be a sandbox file), falling back to lastAgentText.
    confidence = parseConfidenceLoose(blockSource);
    if (confidence === 0 && blockSource !== lastAgentText) {
      confidence = parseConfidenceLoose(lastAgentText);
    }
  }

  if (confidence === 0) {
    // Three-tier fallback for when the agent didn't lead with CONFIDENCE:.
    // (1) outcomes grades available — weight by grader verdict + artifacts.
    // (2) agent did substantive work but no grader (escalation / artifact /
    //     real prose) — modest default to avoid persisting "no work done."
    // (3) truly empty — confidence stays 0 (handled by the leaf as failed).
    if (collectors.outcomesGrades.length > 0) {
      confidence = deriveConfidenceFromGrades(
        collectors.outcomesGrades,
        side.artifacts.length,
      );
    } else if (side.artifacts.length > 0) {
      confidence = 0.55; // produced something defensible even sans grader
    } else if (side.escalations.length > 0 || lastAgentText.length > 200) {
      confidence = 0.4; // agent reasoned and either escalated or wrote prose
    }
    if (!evidenceSummary && collectors.outcomesGrades.length > 0) {
      const lastGrade = collectors.outcomesGrades[collectors.outcomesGrades.length - 1];
      evidenceSummary =
        lastGrade.explanation ??
        `Outcome ${lastGrade.result} on attempt ${lastGrade.iteration + 1}` +
          (side.artifacts.length > 0
            ? ` with ${side.artifacts.length} artifact(s) produced.`
            : ` (no artifact uploaded — the agent stopped without satisfying the skill's upload requirement).`);
    }
  }

  // Fetch session.usage post-idle. SDK retrieve returns the cumulative usage
  // across all turns of the session; per spike test 9 this is where token
  // counts live (event-level usage was sparse).
  const final = await client.beta.sessions.retrieve(session.id);
  const usage = {
    inputTokens: final.usage?.input_tokens ?? 0,
    outputTokens: final.usage?.output_tokens ?? 0,
    cacheReadInputTokens: final.usage?.cache_read_input_tokens ?? 0,
    cacheCreationInputTokens:
      (final.usage?.cache_creation?.ephemeral_5m_input_tokens ?? 0) +
      (final.usage?.cache_creation?.ephemeral_1h_input_tokens ?? 0),
  };

  return {
    confidence,
    evidenceSummary,
    reasoningTrace: collectors.reasoningTrace,
    rejectedAlternatives,
    artifacts: side.artifacts,
    escalations: side.escalations,
    managedAgentSessionId: session.id,
    usage,
    outcomesGrades: collectors.outcomesGrades,
    lastAgentText,
  };
}

// ─── Helpers ─────────────────────────────────────────────────────────────────

function safeStringify(value: unknown): string {
  try {
    return JSON.stringify(value).slice(0, 4000);
  } catch {
    return String(value).slice(0, 4000);
  }
}

/** STORY-021 sandbox-block fallback. When the agent calls `write` or `edit`
 *  on a file under `/mnt/session/`, capture the full content (or edit's
 *  `new_string`) into the collector. Tolerates the `path` / `file_path`
 *  schema variation across the built-in toolset. Caller filters by content
 *  (looks for `ANSWER:` / `CONFIDENCE:`) at parse time — this function is
 *  purely the capture step.
 *
 *  STORY-020 Phase B broadened the path filter from `/mnt/session/outputs/`
 *  to `/mnt/session/`: Phase A.5's Investigator wrote to `outputs/` but the
 *  agent may also use `work/` or other scratchpads. Capture content matching
 *  is the real filter — letting through extra files is harmless because the
 *  parsers anchor on `CONFIDENCE:` / `ANSWER:` regexes. */
function captureSandboxBlock(
  sink: string[],
  toolName: string,
  rawInput: unknown,
): void {
  if (toolName !== "write" && toolName !== "edit") return;
  if (rawInput === null || typeof rawInput !== "object") return;
  const input = rawInput as Record<string, unknown>;
  const path =
    (typeof input.path === "string" && input.path) ||
    (typeof input.file_path === "string" && input.file_path) ||
    "";
  if (!/\/mnt\/session\//.test(path)) return;
  // `write` carries the full file content; `edit` carries the after-edit
  // chunk. Either is parseable on its own — the parsers are anchored on
  // `ANSWER:` / `CITATIONS:` regexes that don't require surrounding context.
  const content =
    (typeof input.content === "string" && input.content) ||
    (typeof input.new_string === "string" && input.new_string) ||
    "";
  if (content) sink.push(content);
}

/** Inspect a tool-handler return value and append to session-level lists. */
function capturePostHandlerSideEffects(
  tu: PendingToolUse,
  resultText: string,
  artifacts: InvestigatorOutput["artifacts"],
  escalations: InvestigatorOutput["escalations"],
): void {
  let parsed: Record<string, unknown> = {};
  try {
    parsed = JSON.parse(resultText) as Record<string, unknown>;
  } catch {
    return;
  }
  if (
    tu.name === "upload_artifact" &&
    typeof parsed.artifact_id === "string" &&
    parsed.artifact_id !== "stub-not-persisted"
  ) {
    const inputType = (tu.input as { type?: string })?.type ?? "json";
    artifacts.push({
      artifactId: parsed.artifact_id,
      uri: typeof parsed.uri === "string" ? parsed.uri : "",
      type: inputType as ArtifactType,
      version: typeof parsed.version === "number" ? parsed.version : 1,
    });
  } else if (tu.name === "ask_user" && parsed.ok === true) {
    const q = (tu.input as { question?: string; type?: string })?.question;
    const t = (tu.input as { question?: string; type?: string })?.type;
    if (q && (t === "yes_no" || t === "yes_no_context" || t === "open")) {
      escalations.push({ question: q, type: t });
    }
  }
}

/** Parse the REJECTED_ALTERNATIVES block from the agent's final summary.
 *  Format expected by AGENT.md output schema:
 *    REJECTED_ALTERNATIVES:
 *      - method: reason
 *      - method: reason
 *  Tolerates loose formatting — bullets without colons fall back to
 *  candidate=line, reason="". */
function parseRejectedAlternatives(text: string): RejectedAlternative[] {
  const m = text.match(/REJECTED_ALTERNATIVES:\s*\n([\s\S]*?)(?=\n[A-Z_]+:|$)/i);
  if (!m) return [];
  const out: RejectedAlternative[] = [];
  for (const line of m[1].split("\n")) {
    const trimmed = line.replace(/^\s*[-*]\s*/, "").trim();
    if (!trimmed) continue;
    const colon = trimmed.indexOf(":");
    if (colon > 0) {
      out.push({
        candidate: trimmed.slice(0, colon).trim(),
        reason: trimmed.slice(colon + 1).trim(),
      });
    } else {
      out.push({ candidate: trimmed, reason: "" });
    }
  }
  return out;
}

/** Fallback when no CONFIDENCE: line is parseable. The outcomes grader's
 *  verdict is the next-best signal: `satisfied` ≈ 0.6 (calibrated to the
 *  rubric's confidence cap for a single-point estimate), `needs_revision`
 *  trails of 0.4, anything else 0.3. Bumps modestly when an artifact is
 *  produced, since "produced and uploaded" beats "tried and gave up." */
function deriveConfidenceFromGrades(
  grades: OutcomeGrade[],
  artifactCount: number,
): number {
  const last = grades[grades.length - 1];
  let base: number;
  switch (last.result) {
    case "satisfied":
      base = 0.6;
      break;
    case "needs_revision":
      base = 0.4;
      break;
    case "max_iterations_reached":
      base = 0.45;
      break;
    case "failed":
    case "interrupted":
      base = 0.3;
      break;
    default:
      base = 0.3;
  }
  if (artifactCount > 0 && base < 0.6) base = Math.min(0.6, base + 0.1);
  return Math.round(base * 100) / 100;
}

export function parseConfidence(text: string): number {
  const m = text.match(/CONFIDENCE:\s*([0-9.]+)/i);
  if (!m) return 0;
  const n = Number(m[1]);
  if (!Number.isFinite(n)) return 0;
  return Math.max(0, Math.min(1, n));
}

/** STORY-020: loose narrative-form confidence extraction. The Investigator
 *  often writes "Confidence: 0.60" or "**Confidence:** 0.60 (calibrated to
 *  single-point estimate)" in its closing prose rather than emitting the
 *  strict `CONFIDENCE: 0.6` first-line block. Used as a fallback layer ONLY
 *  when the strict parser returns 0 — strict still wins when the agent
 *  complies with the format.
 *
 *  Matches: `Confidence` (case-insensitive) followed by up to 30 non-letter
 *  non-digit chars (handles `: `, `**: **`, ` is `, ` equals `, etc.) then a
 *  number in 0..1. Caps the inter-token gap to avoid matching across
 *  paragraph breaks. */
export function parseConfidenceLoose(text: string): number {
  // Use [^A-Za-z\n]{0,30} so "Confidence is 0.6" / "**Confidence:** 0.6" /
  // "Confidence (single-point estimate) 0.6" all match, but
  // "Confidence... [another sentence with letters] 0.6" does not.
  const m = text.match(/Confidence[^A-Za-z\n]{0,30}([0-9](?:\.[0-9]+)?|\.[0-9]+)/i);
  if (!m) return 0;
  const n = Number(m[1]);
  if (!Number.isFinite(n)) return 0;
  return Math.max(0, Math.min(1, n));
}

export function extractField(text: string, name: string): string | null {
  const re = new RegExp(`${name}:\\s*([\\s\\S]*?)(?=\\n[A-Z_]+:|$)`, "i");
  const m = text.match(re);
  return m ? m[1].trim() : null;
}

// ─── createResearcherSession (STORY-017) ─────────────────────────────────────
//
// Standalone Researcher entry point. Used by direct callers (test scripts,
// future Tree Builder + Brief Parser + Micky fact-checking) — NOT by the
// Investigator's mid-investigation delegation. That path runs entirely inside
// the Investigator's session via the multiagent.agents roster (the Managed
// Agents harness routes the spawn transparently); see consumeStreamEvents
// above for how the primary thread surfaces the sub-thread activity.
//
// The loop here mirrors createInvestigatorSession: open a stream, send
// user.define_outcome, stream-and-respond until idle. The Researcher has no
// custom tool surface — only built-in web_search / web_fetch — so the
// handlers map is empty. Built-in tools that need user.tool_confirmation
// (always_ask permission) still flow through dispatchToolResponses correctly.

export async function createResearcherSession(
  input: ResearcherInput,
): Promise<ResearcherOutput> {
  const { researcherAgentId, environmentId } = readAgentRegistry({
    requireResearcher: true,
  });
  if (!researcherAgentId) {
    // readAgentRegistry would have thrown above, but TS narrowing can't see
    // it; defensive guard keeps the type system happy.
    throw new Error("RESEARCHER_AGENT_ID is required");
  }
  const client = anthropicClient();

  const stoppingDefaults = {
    confidenceTarget: 0.8,
    maxSearches: 10,
    diminishingReturnsThreshold: 3,
  };
  const resolved = {
    confidenceTarget:
      input.stoppingCriteria?.confidenceTarget ?? stoppingDefaults.confidenceTarget,
    maxSearches:
      input.stoppingCriteria?.maxSearches ?? stoppingDefaults.maxSearches,
    diminishingReturnsThreshold:
      input.stoppingCriteria?.diminishingReturnsThreshold ??
      stoppingDefaults.diminishingReturnsThreshold,
  };

  const session = await client.beta.sessions.create({
    agent: researcherAgentId,
    environment_id: environmentId,
    title: input.traceId,
  });

  const rubric = buildResearcherRubric(input, resolved);
  const description =
    `Research question: "${input.question}". ` +
    (input.contextHint ? `Context: ${input.contextHint}. ` : "") +
    `Stopping criteria — confidence target ${resolved.confidenceTarget}, ` +
    `max searches ${resolved.maxSearches}, ` +
    `diminishing returns after ${resolved.diminishingReturnsThreshold} ` +
    `consecutive empty searches. ` +
    `Return a compressed structured ANSWER block with citations.`;

  let stream: AsyncIterable<unknown> = await client.beta.sessions.events.stream(
    session.id,
  );
  await client.beta.sessions.events.send(session.id, {
    events: [
      {
        type: "user.define_outcome",
        description,
        rubric: { type: "text", content: rubric },
        // Researcher loops are tight — 3 iterations is plenty.
        max_iterations: 3,
      },
    ],
  });

  let lastAgentText = "";
  const collectors: StreamCollectors = {
    pendingToolUses: [],
    reasoningTrace: [],
    outcomesGrades: [],
    sandboxBlockSources: [],
  };
  const side: DispatchSideEffects = {
    artifacts: [],
    escalations: [],
    reasoningTrace: collectors.reasoningTrace,
  };
  // No custom tool handlers — built-in toolset only.
  const handlers: Record<
    string,
    (input: unknown) => Promise<{ text: string; is_error?: boolean }>
  > = {};

  let cycles = 0;
  // Researcher should not spin — its loop count is bounded by the agent's
  // own stopping rubric. 8 cycles is a generous safety net.
  const MAX_CYCLES = 8;

  while (cycles < MAX_CYCLES) {
    cycles++;
    const consume = await consumeStreamEvents(stream, collectors, lastAgentText);
    lastAgentText = consume.lastAgentText;
    if (consume.terminated) break;
    if (!consume.stopReason || consume.stopReason.type !== "requires_action") break;

    const eventIds = consume.stopReason.event_ids ?? [];
    // Same re-emit-vs-spin distinction as createInvestigatorSession (see
    // comment there): re-stream when event_ids only references
    // already-responded tool_uses; break only when we have unresponded
    // event_ids we couldn't service.
    const eventIdsNeedingResponse = eventIds.filter((id) => {
      const tu = collectors.pendingToolUses.find((p) => p.eventId === id);
      return tu && !tu.responded;
    });
    if (eventIdsNeedingResponse.length === 0) {
      try {
        stream = await client.beta.sessions.events.stream(session.id);
        continue;
      } catch (e) {
        const msg = e instanceof Error ? e.message : String(e);
        console.warn(`[v2] researcher re-stream failed (treating as session end): ${msg}`);
        break;
      }
    }

    const respondedCount = await dispatchToolResponses(
      client,
      session.id,
      eventIds,
      collectors.pendingToolUses,
      handlers,
      side,
    );
    if (respondedCount === 0) break;

    try {
      stream = await client.beta.sessions.events.stream(session.id);
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      console.warn(`[v2] researcher re-stream failed (treating as session end): ${msg}`);
      break;
    }
  }

  // STORY-021 sandbox-block fallback: pick the source with the most
  // parseable citations among lastAgentText + every captured sandbox write.
  // Sonnet reliably writes the structured block to /mnt/session/outputs/*
  // but emits a chatty status report as its final agent.message; the parsers
  // don't care which source the text comes from.
  let blockSource = lastAgentText;
  let bestCitationCount = parseCitations(lastAgentText).length;
  for (const src of collectors.sandboxBlockSources) {
    const n = parseCitations(src).length;
    if (n > bestCitationCount) {
      blockSource = src;
      bestCitationCount = n;
    }
  }

  const answer =
    extractField(blockSource, "ANSWER") ??
    lastAgentText.slice(0, 800);
  const confidence = parseConfidence(blockSource);
  const citations = parseCitations(blockSource);
  const searchPath = parseSearchPath(blockSource);
  const stoppedBecause = parseStoppedBecause(blockSource);

  return {
    answer,
    confidence,
    citations,
    searchPath,
    stoppedBecause,
    managedAgentSessionId: session.id,
    outcomesGrades: collectors.outcomesGrades,
    lastAgentText,
  };
}

// ─── Researcher output parsers ──────────────────────────────────────────────
//
// Exported so v2-persistence can re-use them when reading back sub-thread
// final messages (post-session enrichment for the Investigator's spawned
// Researchers — STORY-019-R).

/** Parse the CITATIONS block from the Researcher's final ANSWER message.
 *  Format expected by AGENT.md output schema:
 *
 *    CITATIONS:
 *      [1] <title> — <url>
 *          "<verbatim quote>"
 *      [2] <title> — <url>
 *          "<verbatim quote>"
 *
 *  Tolerates either em-dash or hyphen, smart-quotes or straight, and
 *  quotes either inline or on the next line. */
export function parseCitations(
  text: string,
): { url: string; title: string; quote: string }[] {
  const m = text.match(/CITATIONS:\s*\n([\s\S]*?)(?=\n[A-Z_]+:|$)/i);
  if (!m) return [];
  const out: { url: string; title: string; quote: string }[] = [];
  let pending: { url: string; title: string; quote: string } | null = null;

  const flush = () => {
    if (pending && pending.url && pending.title) {
      out.push(pending);
    }
    pending = null;
  };

  for (const raw of m[1].split("\n")) {
    const line = raw.trim();
    if (!line) continue;
    // Header line: "[N] title — url" or "[N] title - url"
    const headerMatch = line.match(/^\[\d+\]\s*(.+?)\s*[—–\-]\s*(https?:\/\/\S+)/);
    if (headerMatch) {
      flush();
      pending = {
        title: headerMatch[1].trim(),
        url: headerMatch[2].trim(),
        quote: "",
      };
      continue;
    }
    // Quote line — start with " or ".
    const quoteMatch = line.match(/^[""“"](.+?)[""”"]\s*$/);
    if (quoteMatch && pending) {
      pending.quote = quoteMatch[1].trim();
      continue;
    }
  }
  flush();
  return out;
}

/** Parse the SEARCH_PATH block. Format:
 *    SEARCH_PATH:
 *      - "query" → N results, M useful
 *      - "query" → N results, M useful
 *
 *  Falls back to capturing the query alone if the trailing counts are
 *  malformed (better to record the query diversity than nothing). */
export function parseSearchPath(
  text: string,
): { query: string; resultCount: number; usefulCount: number }[] {
  const m = text.match(/SEARCH_PATH:\s*\n([\s\S]*?)(?=\n[A-Z_]+:|$)/i);
  if (!m) return [];
  const out: { query: string; resultCount: number; usefulCount: number }[] = [];
  for (const raw of m[1].split("\n")) {
    const line = raw.replace(/^\s*[-*]\s*/, "").trim();
    if (!line) continue;
    const full = line.match(
      /^[""“"](.+?)[""”"]\s*[→\->]+\s*(\d+)\s*results?,?\s*(\d+)\s*useful/i,
    );
    if (full) {
      out.push({
        query: full[1].trim(),
        resultCount: parseInt(full[2], 10),
        usefulCount: parseInt(full[3], 10),
      });
      continue;
    }
    const queryOnly = line.match(/^[""“"](.+?)[""”"]/);
    if (queryOnly) {
      out.push({ query: queryOnly[1].trim(), resultCount: 0, usefulCount: 0 });
    }
  }
  return out;
}

/** Parse the STOPPED_BECAUSE field. Defaults to "cap_reached" when missing
 *  or malformed — the most conservative interpretation (caller treats it
 *  as "the agent ran out, not a clean answer"). */
export function parseStoppedBecause(
  text: string,
): "answered" | "diminishing_returns" | "cap_reached" {
  const m = text.match(/STOPPED_BECAUSE:\s*([a-z_]+)/i);
  if (!m) return "cap_reached";
  const v = m[1].toLowerCase();
  if (v === "answered" || v === "diminishing_returns" || v === "cap_reached") {
    return v;
  }
  return "cap_reached";
}
