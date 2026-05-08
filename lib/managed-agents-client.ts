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
          collectors.pendingToolUses.push({
            eventId: ev.id as string,
            name: ev.name as string,
            input: ev.input,
            kind: "builtin",
          });
          collectors.reasoningTrace.push({
            phase: `tool_use:${ev.name as string}`,
            content: safeStringify(ev.input),
            timestamp: eventTs,
          });
          break;
        }
        case "agent.custom_tool_use": {
          collectors.pendingToolUses.push({
            eventId: ev.id as string,
            name: ev.name as string,
            input: ev.input,
            kind: "custom",
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
          const subStop = (ev.stop_reason as StopReason | null | undefined) ?? null;
          if (subStop && subStop.type === "requires_action") {
            // Sub-agent needs a tool confirmation / custom_tool_result. Hand
            // off to the outer dispatch loop just like a session-level idle.
            stopReason = subStop;
          } else {
            // Informational — sub-agent finished its current turn; coordinator
            // may continue, or session-level idle will arrive next.
            collectors.reasoningTrace.push({
              phase: `thread_idle:${typeof ev.agent_name === "string" ? ev.agent_name : "sub"}`,
              content: subStop ? `stop_reason=${subStop.type}` : "",
              timestamp: eventTs,
            });
          }
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
      // Sub-thread idle that needs a tool reply — break and let the outer
      // dispatch loop respond. (Informational thread idles fall through and
      // the for-await continues to the next event.)
      if (
        ev.type === "session.thread_status_idle" &&
        stopReason?.type === "requires_action"
      ) {
        break;
      }
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
        await client.beta.sessions.events.send(sessionId, {
          events: [{ type: "user.tool_confirmation", tool_use_id: id, result: "allow" }],
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
      await client.beta.sessions.events.send(sessionId, {
        events: [
          {
            type: "user.custom_tool_result",
            custom_tool_use_id: id,
            content: [{ type: "text", text: result.text }],
            is_error: result.is_error ?? false,
          },
        ],
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

    if (unresponded.length === 0) {
      console.warn(
        `[v2] cycle ${cycles}: no unresponded tool_uses left but session still ` +
          `in requires_action — breaking. Session ${session.id} may have ` +
          `out-of-band pending events.`,
      );
      break;
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

  // Final output assembly. Primary parser reads CONFIDENCE/EVIDENCE_SUMMARY/
  // REJECTED_ALTERNATIVES from the last agent.message. Fallback (when the
  // agent satisfied the outcome via tools without emitting a summary
  // block): derive confidence from outcomes grades, evidence summary from
  // any captured trace text.
  let confidence = parseConfidence(lastAgentText);
  let evidenceSummary =
    extractField(lastAgentText, "EVIDENCE_SUMMARY") ?? lastAgentText.slice(0, 800);
  const rejectedAlternatives = parseRejectedAlternatives(lastAgentText);

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

function parseConfidence(text: string): number {
  const m = text.match(/CONFIDENCE:\s*([0-9.]+)/i);
  if (!m) return 0;
  const n = Number(m[1]);
  if (!Number.isFinite(n)) return 0;
  return Math.max(0, Math.min(1, n));
}

function extractField(text: string, name: string): string | null {
  const re = new RegExp(`${name}:\\s*([\\s\\S]*?)(?=\\n[A-Z_]+:|$)`, "i");
  const m = text.match(re);
  return m ? m[1].trim() : null;
}

// ─── createResearcherSession (stub — STORY-017) ──────────────────────────────

export async function createResearcherSession(
  input: ResearcherInput,
): Promise<ResearcherOutput> {
  void input;
  readAgentRegistry({ requireResearcher: true });
  throw new Error(
    "createResearcherSession not implemented (STORY-017 stub). " +
      "When the Investigator delegates to the Researcher in-session, the " +
      "Managed Agents harness handles the spawn directly via multiagent " +
      "roster — this top-level entry is for direct callers (Tree Builder, " +
      "Brief Parser, Micky fact-checking).",
  );
}
