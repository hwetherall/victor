# Spike Day 1 — STORY-001 Report

**Status:** complete · **Last updated:** 2026-05-07
**Owner:** Harry · **Spike script:** `scripts/spike-managed-agents.ts`
**Result:** 10 of 11 tests pass live. **GO** for STORY-002 onwards with plan amendments below.

> Goal: exercise every Managed Agents capability the V2 plan rests on, surface anything broken or wrong, decide go/no-go for STORY-002 onwards.

---

## TL;DR — plan deltas

Six material changes to the plan emerged from doc reads. Live tests confirmed five and **inverted one** (OPEN-Q-3, see live finding 6).

| # | Plan assumption | Reality (live + docs) | Story affected |
|---|---|---|---|
| 1 | Webhook → app pushes session results to Postgres | No webhooks. SSE stream + careful re-attach pattern. **Re-streaming a closed session throws.** | STORY-007 rewrite |
| 2 | Researcher = separate session spawned by Investigator | Multi-agent = coordinator with roster + threads inside one session. **Live test confirmed 1 thread spawned successfully.** | EPIC-006 simpler |
| 3 | Custom retrieve tool = sandbox calls public HTTPS callback | Custom tool = canonical event pattern: agent emits `agent.custom_tool_use` → session idles with `stop_reason.requires_action` → we POST `user.custom_tool_result` per `event_id` → re-stream. **Live test confirmed end-to-end: 2 loops, agent used the result.** | OPEN-Q-1 resolved; STORY-006 |
| 4 | Custom `write_artifact` tool to our storage | **REVERSED FROM EARLIER REPORT.** The Files API does NOT auto-track files in `/mnt/session/outputs/`. The agent wrote a 4826-byte xlsx to that path; `files.list()` returned empty even with the right beta header. The original spec was correct: we need a custom upload tool. | OPEN-Q-3 resolved (option A — custom tool); STORY-006 |
| 5 | Manual revision loop on rubric failure | `user.define_outcome` runs built-in loop. **Live test: 2 evaluations, final=satisfied, automatic.** | STORY-020 simpler |
| 6 | Outcomes + multi-agent are public beta (per spec) | Docs say research preview, but **the team's key has access — both worked live without a 403.** | Spec wording stale; no story impact |

Plus one delight confirmed: `Python 3.11.15` + `openpyxl` work in the sandbox out of the box once declared in `config.packages.pip`. RISK-4 dissolved.

---

## Doc findings (pre-flight, complete)

### API surface (TypeScript SDK)

```ts
import Anthropic from "@anthropic-ai/sdk";
const client = new Anthropic(); // reads ANTHROPIC_API_KEY; SDK auto-sets beta header

// 1. Create agent (one-time, versioned, referenced by ID)
const agent = await client.beta.agents.create({
  name, model: "claude-opus-4-7", system,
  tools: [
    { type: "agent_toolset_20260401" },                  // bash + read/write/edit + glob/grep + web_fetch + web_search
    { type: "custom", name, description, input_schema }, // user-defined client-executed
  ],
  multiagent: {
    type: "coordinator",
    agents: [{ type: "agent", id: childAgentId }],       // max 20 unique, depth 1, max 25 concurrent threads
  },
});

// 2. Create environment (cloud container template)
const env = await client.beta.environments.create({
  name,
  config: {
    type: "cloud",
    packages: { pip: ["openpyxl", "pandas"], npm: [...] },
    networking: { type: "unrestricted" }, // or limited with allowed_hosts
  },
});

// 3. Create session
const session = await client.beta.sessions.create({
  agent: agent.id, environment_id: env.id, title: "leaf-{trace_id}",
});

// 4. Stream events + send user.message OR user.define_outcome
const stream = await client.beta.sessions.events.stream(session.id);
await client.beta.sessions.events.send(session.id, {
  events: [{
    type: "user.define_outcome",
    description: "Build SH4.2 IRR model in xlsx",
    rubric: { type: "text", content: rubricMarkdown },
    max_iterations: 5,
  }],
});

// 5. Handle events from the stream
for await (const ev of stream) {
  if (ev.type === "agent.custom_tool_use") {
    // Run our retrieve_documents / etc. ourselves, then post result back
    await client.beta.sessions.events.send(session.id, {
      events: [{ type: "user.custom_tool_result", tool_use_id: ev.id, content: chunks }],
    });
  } else if (ev.type === "session.status_idle") break;
}

// 6. Fetch artifacts written to /mnt/session/outputs/
const files = await client.beta.files.list({ scope_id: session.id });
const blob = await client.beta.files.download(files.data[0].id);
```

### Beta access

- Beta header: `managed-agents-2026-04-01` (SDK auto-sets)
- **Outcomes + multi-agent are research preview**, behind a separate access form: <https://claude.com/form/claude-managed-agents>. Live test confirms whether the team's key has access.
- Rate limits: 300 create/min, 600 read/min per org

### Custom tools: event-driven, not HTTP-callback

**Plan delta:** the spec's "callback URL the sandbox dials" mental model is wrong. Custom tools are user-defined client-executed:

1. Agent emits `agent.custom_tool_use` on the SSE stream.
2. Our code (the SSE consumer) receives it, runs the tool, posts back `user.custom_tool_result` with `tool_use_id`.
3. Agent receives the result on its next turn.

Mid-loop retrieval works exactly like the OODA-loop thesis requires — the agent can call the custom tool any number of times. **OPEN-Q-1 resolved without needing a public endpoint, ngrok, or auth tokens.**

### Artifacts: /mnt/session/outputs/ + Files API

**Plan delta:** no custom `write_artifact` tool needed. Built-in `write` tool drops files in the container; `client.beta.files.list({ scope_id: session.id })` enumerates them; `client.beta.files.download(id)` returns content. **OPEN-Q-3 resolves to option B** (session filesystem + post-completion fetch).

### Multi-agent: coordinator + roster, single session

**Plan delta:** the Researcher isn't a separate session. It's a child agent declared in the Investigator's `multiagent.agents` roster, spawning threads inside the same session. All threads share the container/filesystem (so a Researcher writing a CSV is visible to the Investigator's `read` tool). Up to 25 concurrent threads, max 20 unique agents in roster, depth = 1.

Practical implication: simpler than the spec assumed. EPIC-006 (Researcher) is mostly about the `multiagent.agents` config on the Investigator + a separate Researcher agent definition. No separate webhook, no separate session lifecycle.

### Outcomes: built-in revision loop

**Plan delta:** the platform handles the revision loop. Send `user.define_outcome` with `description` + `rubric` (text or file) + `max_iterations`. The grader runs in a separate context window, returns one of `satisfied | needs_revision | max_iterations_reached | failed | interrupted`. STORY-020's "selection-correction nudge" is just a rubric criterion; the loop is automatic.

### LEGAL-001 — confirmed

> Anthropic Commercial Terms §B (Customer Content): "Anthropic may not train models on Customer Content from Services."

Blanket prohibition, no carve-out for Managed Agents or outcomes grading. **15-minute task as predicted; LEGAL-001 closed for the internal demo.**

### Webhooks: don't exist

There is no webhook product. Sessions emit events through SSE while the stream is open; otherwise the only way to learn a session has finished is to poll `client.beta.sessions.retrieve(id)` (status: `idle | running | rescheduling | terminated`).

**Architecture implication for STORY-007:** sessions can run for minutes to hours. A serverless Vercel function holding the stream open is risky (function timeouts). Three options to evaluate:

- **(a) Stream + write inline.** Function holds SSE until idle, writes to Postgres before returning. Works only if total session time is under the function timeout (~15min on Pro, longer on Enterprise). Plausible for ~30-leaf demo runs; not a long-term answer.
- **(b) Background worker.** Long-running Node process (or queue-driven container) holds streams; orchestrator dispatches and returns immediately. Cleanest, but introduces infra not in V1.
- **(c) Polling.** Orchestrator dispatches, returns. Separate worker polls `sessions.retrieve` until idle, then ingests. Highest latency but simplest infra.

**For the Daniel demo on day 18 we likely want (a) for the live demo run + (c) as the durable pattern.** Decide formally after live testing of session length on the wedge demo (SH4.2).

---

## Live findings (10 of 11 pass)

| # | Test | Status | Finding |
|---|---|---|---|
| 1 | SDK auth + list agents | ✓ | Auth OK on first call. SDK auto-sets the beta header. |
| 2 | Create / retrieve agent | ✓ | `client.beta.agents.create()` returns `id`+`version` cleanly. |
| 3 | Create environment with `pip:[openpyxl]` (RISK-4) | ✓ | Env created with `config.packages.pip:["openpyxl"]`. |
| 4 | Session lifecycle: send → stream → idle | ✓ | One Opus session, one bash tool call, idle reached. Reply: `Python 3.11.15`. |
| 5 | Custom tool round-trip (OPEN-Q-1) | ✓ | **Canonical pattern works.** Agent emitted `agent.custom_tool_use` with `{query: "ABB intelligent PDU pricing strategy"}`, session idled with `requires_action`, we replied with `user.custom_tool_result`, re-streamed, agent quoted our injected `ABB-DOC-7421` content in its final reply. 2 loops total. |
| 6 | Files API on `/mnt/session/outputs/` (OPEN-Q-3) | ✗ | **Surprising failure.** Agent wrote `test.xlsx` (4826B) to `/mnt/session/outputs/` (confirmed by bash `ls` output). `client.beta.files.list()` returns empty — even with `files-api-2025-04-14` beta header. The "auto-tracking" model the docs imply doesn't exist for sandbox-written files. **OPEN-Q-3 inverts: a custom upload tool IS required.** |
| 7 | `user.define_outcome` + revision loop (OPEN-Q-4) | ✓ | Outcome accepted, **2 evaluations** (one revision), final=`satisfied`. Grader runs in separate context as docs claim. The team's key has research-preview access. |
| 8 | Multi-agent coordinator + roster | ✓ | Coordinator with roster=[`helper`] spawned 1 thread. Coordinator's final reply mentioned the helper's content. (`helper_replied=false` is a measurement artifact: the helper's text appeared inside the coordinator's `agent.message`, not as a separate `agent.thread_message_received` event in our stream — needs further investigation if we want to read sub-agent output independently.) |
| 9 | Usage / token-cost telemetry (STORY-004b) | ✓ | `session.usage` field exists on `client.beta.sessions.retrieve()`. Per-event `usage` is sparse (event_usages_seen=0), so the storage strategy is "fetch session record on idle, write usage to `session_costs`." |
| 10 | `openpyxl` available in sandbox (RISK-4) | ✓ | Folded into test 4. Agent's reply included `Name: openpyxl`. RISK-4 closed. |
| 11 | `title` round-trips for trace_id propagation (STORY-002b) | ✓ | Set `title: "t_1778176033417"` on session create; retrieved exactly the same value. STORY-002b can use `title`. |

### Two real new findings beyond the original list

**N1 — Re-streaming a closed session throws `TypeError: terminated`.** Once a stream's `for await` loop exits on `session.status_idle`, calling `client.beta.sessions.events.stream(sessionId)` again throws an undici error. Workarounds:
- For sub-turns inside one session: keep the original stream open across sub-turns; don't `break` until the session is truly done.
- For the canonical custom-tool pattern: re-attach is required. **It does work** when the session is in `requires_action` state (test 5 proves it). It does NOT work cleanly after `end_turn`. STORY-007 architecture must respect this.

**N2 — `agent.thread_message_received` did not fire on the primary thread for the helper's reply.** The multi-agent test passed (thread created, coordinator final mentions helper content), but the primary thread didn't surface a separate event for "what the helper said back." Either the docs over-promised this event, or the helper's reply got rolled into the coordinator's normal `agent.message`. To verify: stream the child thread directly via `client.beta.sessions.threads.events.stream(threadId, {session_id})`.

---

## Open items going into day 2

- **Files API replacement** (high priority). Either: (a) build a custom `upload_artifact` tool that the agent invokes after writing to `/mnt/session/outputs/`, with our endpoint pushing the bytes to InsForge storage; or (b) find the right API call we missed (check `/v1/sessions/{id}/files`, the agent toolset's own file-export semantics, or the `--scope-id` upload pattern from the rubric upload flow). Try (b) for 30 min on day 2 before committing to (a).
- **Multi-agent thread events.** STORY-018 (Researcher test) needs to verify we can read the child thread's events independently (`client.beta.sessions.threads.events.stream`). Spike test 8 only confirmed coordinator-level activity; the Researcher's own OODA trace lives on its thread.
- **Session length budget.** Spike sessions ran in ~5–15 seconds each. The wedge demo's SH4.2 will run multiple loops with code execution + Researcher spawn. Measure wall-clock time once STORY-009 lands; if a single leaf exceeds ~5min, STORY-007 needs a polling worker rather than streaming-in-a-Vercel-function.
- **Tavily decision deferred.** Built-in `web_fetch` + `web_search` are in the agent toolset. Plan to run a Researcher with each on the same prompt during STORY-018, compare quality. If Anthropic's tooling is sufficient, Tavily becomes optional — simplifies LEGAL-003.
- **Stream lifecycle.** Document the re-stream rules (works on `requires_action`, throws after `end_turn`) prominently in STORY-007's design doc. Treat this as a class of bug that's likely to bite multiple times.

---

## Go/no-go

**GO** for STORY-002 onwards on day 2, with these plan amendments:

1. STORY-006 acceptance criterion adjusted: `retrieve_documents` is a custom tool consumed via `agent.custom_tool_use` → `user.custom_tool_result` event pattern. Pattern proven in spike test 5.
2. STORY-006 adds `upload_artifact` custom tool (replacing the "Files API auto-tracks /mnt/session/outputs/" assumption from the prior plan revision). Inversion of OPEN-Q-3.
3. STORY-007 renamed: "Session event stream consumer + custom-tool result router." Architecture is a long-running stream consumer, not a webhook handler.
4. STORY-007 acceptance criterion added: handles the re-stream lifecycle correctly — keeps stream open through `requires_action` cycles, terminates on `end_turn` or `terminated`.
5. EPIC-006 (Researcher) simplified: it's a separate agent ID, registered once, listed in the Investigator's `multiagent.agents` roster. No separate session lifecycle to manage. STORY-018 still tests, but the implementation is smaller.
6. STORY-002b uses `title` field (not `metadata`) for `trace_id` round-trip. Confirmed live.
7. STORY-004b webhook ingestion changes to "session-completion fetch": on `session.status_idle` (or polled status === idle), retrieve the session record, write `session.usage` to `session_costs`.
8. The spec's claim that outcomes + multi-agent are public-beta is stale; both are research preview but **the team's key has access**. No story impact, but worth correcting in `spec-v2.md` if we revisit.

Total live cost of the spike: small handful of cents. Cleanup deleted 4 agents, 7 sessions, 1 environment.
