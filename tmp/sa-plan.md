Good. I have a complete picture. Now let me produce the plan.

---

# Project: Agent Victor V2 — Agentic Leaves on Managed Agents

## Summary

V2 replaces the V1 leaf execution layer (parallel prompt chains calling Tavily/pgvector/question-generator) with two purpose-built Managed Agent definitions: an **Investigator** (Opus, workhorse) and a **Researcher** (Sonnet, compressed web research sub-agent). Everything above the leaf layer — orchestrator, tree builder, hypothesis evaluator, confidence rollup, master decision, Micky V1, the Next.js UI, and the existing Postgres+pgvector schema — ships unchanged or with minor extensions.

The architectural delta is narrow but deep: every leaf now runs an autonomous OODA loop, selects a method from a skill registry, builds an artifact, records a reasoning trace, and is graded against an outcomes rubric before returning. The demo target is a credible end-to-end run of SH4.2 (IRR hurdle leaf) with an inline xlsx artifact and OODA trace visible in the drill-down, delivered on day ~18 for Daniel.

Key technical decisions already made in spec-v2.md: Anthropic Managed Agents harness (public beta as of May 6 2026, `managed-agents-2026-04-01`), skills as a progressive-disclosure registry (SKILL.md format), feature flag to preserve V1 leaf runtime as fallback, SheetJS for xlsx inline rendering.

---

## Assumptions

1. The `managed-agents-2026-04-01` beta header is active on the team's Anthropic API keys and quota is sufficient for ~30 Opus leaf sessions per demo run. This is the most fragile assumption — see Open Questions.
2. Multi-agent orchestration (Investigator spawning Researcher) and outcomes grading are both available under the same beta header, as the spec states.
3. Artifacts are stored in our own storage (Supabase/InsForge bucket), not the Managed Agents sandbox filesystem. The Investigator writes via a custom `write_artifact` tool rather than relying on session filesystem copy-on-completion. This matches "latter is cleaner" in spec §10 and is treated as the chosen path here — see Open Questions for the decision gate.
4. The Tavily API key is already in the environment (used in V1). The Researcher uses it directly from Managed Agents tooling.
5. pgvector chunk retrieval for the Investigator is accomplished by passing pre-fetched chunks inline in the session context (not sandbox-mounting), pending confirmation in OPEN-Q-1.
6. The existing `migrations/` directory follows the timestamp-prefix naming convention already established (e.g., `20260505205632_init-schema.sql`). V2 schema migration follows that convention.
7. The feature flag is an environment variable (`LEAF_RUNTIME=v1|v2`) with a per-run override stored in the `runs` table. UI flag is a read-only label in the run monitor.
8. The outcomes grader can only reference the agent's own output plus the explicit rubric text passed at session creation. It cannot access external DB context natively. Framework slot context must be embedded in the rubric text or passed as part of the session system prompt.
9. SheetJS (`xlsx` npm package) is acceptable as a new frontend dependency. No other new major frontend dependencies are introduced.
10. "Daniel demo day ~18" maps to approximately May 25, 2026 given today's date of May 7, 2026.

---

## Open Questions / Clarifications Needed

These are hard blockers for specific early stories. Resolve before or on day 1–2.

**OPEN-Q-1 — Managed Agents sandbox and pgvector (Technical, CTO/Architect)**
The Investigator's `retrieve_documents` tool needs to return pgvector chunks. Two approaches: (A) orchestrator pre-fetches top-k chunks for the leaf's hypothesis text before launching the session, passes them inline as context; (B) the Managed Agent calls back to our API endpoint which runs pgvector and returns results. Approach A is simpler but limits retrieval to a single pre-fetch. Approach B requires a trusted callback URL the sandbox can reach.
Impact: STORY-004 (Investigator skeleton) cannot be written until this is decided — it determines whether `retrieve_documents` is a built-in tool binding or a custom API-callback tool.

**OPEN-Q-2 — Webhook delivery semantics (Technical, CTO/Architect)**
The architecture diagram (spec §2) shows a webhook path from Managed Agent sessions to our ingest handler, which writes findings and artifacts to Postgres. Does the Managed Agents harness guarantee at-least-once delivery? Is ordering guaranteed within a session? Are there idempotency keys on webhook events?
Impact: STORY-008 (Webhook ingestion handler) cannot be designed for correctness without this. If at-least-once, the handler needs idempotent upserts keyed on `managed_agent_session_id + step_index`. If ordering is not guaranteed, the handler must tolerate out-of-order step inserts into `reasoning_traces.steps`.

**OPEN-Q-3 — Artifact storage location (Technical, CTO/Architect)**
Spec §10 presents two options: (A) write directly to our storage via a custom `write_artifact` tool; (B) store in Anthropic session filesystem, copy to our storage on session completion. This plan assumes Option A (cleaner, no orphaned artifacts on session failure). Confirm.
Impact: determines the `write_artifact` tool signature in STORY-004 and whether there is a separate "copy artifacts on completion" step in STORY-008.

**OPEN-Q-4 — Outcomes grader context access (Technical, CTO/Architect)**
Can the grader receive the framework slot definition (templateClaim, falsifier, threshold) as part of the rubric text, or does the Managed Agents platform impose a structure where the rubric must be purely about output format?
Impact: changes how STORY-016 (Investigator rubric authoring) is written. If the grader can receive external context, the rubric can include "the artifact must answer the falsifier: [falsifier text]" dynamically. If not, the rubric must be generic and we embed context in the session system prompt.

**OPEN-Q-5 — API key and quota access (Team coordination)**
Spec notes the `managed-agents-2026-04-01` beta went public on May 6 2026. Confirm the team has API keys with this feature enabled, and that Opus quota is sufficient for ~30-leaf demo runs. Sonnet quota for Researcher sessions should be less of a concern.
Impact: STORY-002 (provision and confirm access) is day-1 work. If quota gating is needed, the demo must either pre-cache or reduce leaf count.

---

## Epic Overview & Dependency Map

```
EPIC-001: Foundation & Feature Flag
    └─ required by all other epics

EPIC-002: Schema Migration (artifacts + reasoning_traces)
    └─ required by EPIC-003, EPIC-004, EPIC-006

EPIC-003: Investigator Agent — Skeleton & Core Loop
    depends on EPIC-001, EPIC-002
    └─ required by EPIC-004, EPIC-005, EPIC-006, EPIC-007

EPIC-004: Wedge Demo — SH4.2 End-to-End (CRITICAL PATH)
    depends on EPIC-001, EPIC-002, EPIC-003, EPIC-005 (skill #1)
    └─ required by EPIC-009 (demo)

EPIC-005: Skills Registry (Priority Skills #1–5)
    depends on EPIC-001, EPIC-003
    └─ required by EPIC-004, EPIC-007

EPIC-006: Researcher Agent
    depends on EPIC-001, EPIC-002, EPIC-003
    └─ required by EPIC-007

EPIC-007: Full ABB Run & Outcomes Rubrics
    depends on EPIC-003, EPIC-005 (skills #2–3), EPIC-006
    └─ required by EPIC-009

EPIC-008: UI Extensions (Artifact Viewer, OODA Timeline, Version Diff)
    depends on EPIC-002, EPIC-003
    └─ required by EPIC-004 (artifact viewer must land before wedge demo), EPIC-009

EPIC-009: Daniel Demo — End-to-End Polish & Eval
    depends on EPIC-004, EPIC-007, EPIC-008
    └─ terminal

EPIC-010: Micky V2 (CUTTABLE — drop first if behind)
    depends on EPIC-003, EPIC-006, EPIC-007
    └─ not required for demo
```

Execution tracks (parallelizable after EPIC-001 + EPIC-002):

- Track A (critical): EPIC-001 → EPIC-002 → EPIC-003 → EPIC-004 + EPIC-005-STORY-001 + EPIC-008-artifact-viewer → EPIC-009
- Track B (supporting): EPIC-005 (#2–5) → EPIC-006 → EPIC-007 → EPIC-009
- Track C (optional): EPIC-010 (run in parallel with Track B if bandwidth allows; cut first)

---

## EPIC-001: Foundation, Provision & Feature Flag

**ID:** EPIC-001
**User Value:** The system can run on either V1 or V2 leaf runtime. A developer can start an Investigator session against the real Managed Agents API, and the rest of the app stays intact. Invisible to Daniel but required before any other V2 work can be tested.
**Dependencies:** None (builds on existing codebase)
**Estimated Total Effort:** 3–4 days (Stories: 1×S + 2×M)

---

### STORY-001: Confirm Managed Agents access and spike one session

**Type:** Technical Story
**Statement:** As a developer, I need to verify Managed Agents API access end-to-end — create a session, run a minimal tool call, receive a completion — so that all subsequent V2 stories have a known-working harness to build on.
**Acceptance Criteria:**
- [ ] `ANTHROPIC_API_KEY` with the `managed-agents-2026-04-01` beta header successfully creates a Managed Agent session (Opus model) via the Anthropic SDK
- [ ] Session runs a single no-op tool (e.g., `echo`) and returns a completion without error
- [ ] Multi-agent orchestration is confirmed: a parent session can spawn a child session (Sonnet) and receive its output
- [ ] Outcomes feature is confirmed: a session can be created with a rubric payload and the grader runs (even on trivial output)
- [ ] A short `scripts/spike-managed-agents.ts` script demonstrates all of the above — this is the integration test, not a production file
- [ ] Findings on OPEN-Q-1, OPEN-Q-2, OPEN-Q-3, OPEN-Q-4 are resolved or escalated in writing (these unblock later stories)
- [ ] OPEN-Q-5 (quota) is confirmed: at least one Opus session and one Sonnet session run successfully under the team's quota tier

**Complexity:** Medium
**Dependencies:** None
**Notes:** If Managed Agents API is not yet accessible, this story's failure is the drop-everything signal. Do not proceed to STORY-002 until this passes. The `spike-managed-agents.ts` script lives in `scripts/` and is not imported by the app.

---

### STORY-002: Environment wiring and SDK integration

**Type:** Technical Story
**Statement:** As a developer, I need the Managed Agents SDK wired into the existing `lib/` layer so that agent sessions can be created from server-side code without touching the V1 call sites.
**Acceptance Criteria:**
- [ ] `lib/managed-agents-client.ts` created; exports `createInvestigatorSession(input: InvestigatorInput): Promise<InvestigatorOutput>` and `createResearcherSession(input: ResearcherInput): Promise<ResearcherOutput>` (stubs that throw "not implemented" are acceptable at this story; the real implementation is STORY-004)
- [ ] All new Managed Agents env vars (`MANAGED_AGENTS_BETA_HEADER`, `INVESTIGATOR_AGENT_ID`, `RESEARCHER_AGENT_ID`) are added to `.env.example` with documentation comments
- [ ] `.env.example` retains all existing V1 vars — nothing removed
- [ ] TypeScript types for `InvestigatorInput`, `InvestigatorOutput`, `ResearcherInput`, `ResearcherOutput` are defined in `lib/schema.ts` matching the contracts in spec-v2.md §3.1 and §3.2 exactly
- [ ] `npm run build` passes with no type errors introduced by this story

**Complexity:** Small
**Dependencies:** STORY-001 (need confirmed SDK behavior before finalizing types)
**Notes:** Keep `lib/managed-agents-client.ts` as a thin adapter. No business logic here. The intent is a clean call site that the feature flag (STORY-003) can switch between.

---

### STORY-003: Feature flag for V1/V2 leaf runtime

**Type:** Technical Story
**Statement:** As a developer, I need a feature flag that switches leaf execution between the V1 prompt-chain runtime and the V2 Managed Agent runtime, so that the existing V1 demo stays runnable and V2 can be tested in isolation.
**Acceptance Criteria:**
- [ ] `LEAF_RUNTIME` environment variable accepts `v1` (default) or `v2`
- [ ] The `runs` table gets a new column `leaf_runtime text not null default 'v1' check (leaf_runtime in ('v1', 'v2'))` — added via a migration file in `migrations/` using the established timestamp-prefix naming convention
- [ ] `agents/orchestrator.ts` reads the flag at run-start: if `v1`, the existing `gatherEvidence` call path executes unchanged; if `v2`, it calls `createInvestigatorSession` from `lib/managed-agents-client.ts` for each leaf
- [ ] When `LEAF_RUNTIME=v1`, an end-to-end run of the ABB case completes successfully (existing V1 behavior is not broken)
- [ ] When `LEAF_RUNTIME=v2` and `createInvestigatorSession` is stubbed (throws "not implemented"), the orchestrator logs the error per leaf, marks the leaf `status='failed'`, and continues — no full-run crash
- [ ] The run monitor UI shows a small "V1" or "V2" label on each leaf card corresponding to the runtime used for that run (read from the `leaf_runtime` column)
- [ ] Non-negotiable verified: V1 stays runnable — with `LEAF_RUNTIME=v1`, the existing click path produces a complete drill-down

**Complexity:** Medium
**Dependencies:** STORY-002
**Notes:** The orchestrator switch must be at the per-leaf dispatch level, not the run level, so that a future mixed-runtime run (some V1 fallback leaves during partial outage) is possible. The UI label is small — one badge on the run monitor leaf card, no design work needed.

---

## EPIC-002: Schema Migration — artifacts and reasoning_traces

**ID:** EPIC-002
**User Value:** The database can store the artifacts and OODA reasoning traces that the V2 agents produce. Without this, no V2 leaf output can be persisted or displayed. Not user-visible directly, but it unlocks artifact viewer and OODA timeline (EPIC-008).
**Dependencies:** EPIC-001 (migration tooling and naming convention confirmed)
**Estimated Total Effort:** 1 day (1×S)

---

### STORY-004: Add artifacts and reasoning_traces tables

**Type:** Technical Story
**Statement:** As a developer, I need the `artifacts` and `reasoning_traces` tables in Postgres so that Investigator and Researcher sessions can persist their outputs.
**Acceptance Criteria:**
- [ ] Migration file `migrations/YYYYMMDDHHMMSS_v2-artifacts-reasoning-traces.sql` created with timestamp matching the day of work
- [ ] `artifacts` table created exactly as specified in spec-v2.md §8: `id`, `case_id` (FK to `cases`), `evidence_node_id` (FK to `tree_nodes`, nullable), `type` (check constraint: xlsx/csv/png/md/json/model_lineage), `uri`, `version`, `parent_artifact_id` (self-referential FK), `metadata jsonb`, `created_at`; indexes on `evidence_node_id` and `parent_artifact_id`
- [ ] `reasoning_traces` table created exactly as specified in spec-v2.md §8: `id`, `node_id` (FK to `tree_nodes`), `agent_type` (check constraint: investigator/researcher/micky), `managed_agent_session_id`, `steps jsonb`, `rejected_alternatives jsonb`, `outcomes_grades jsonb`, `created_at`; index on `node_id`
- [ ] TypeScript types `Artifact` and `ReasoningTrace` added to `lib/schema.ts` matching the table shapes
- [ ] Migration applied to the development database and confirmed with `\d artifacts` and `\d reasoning_traces` (or equivalent InsForge/Supabase introspection)
- [ ] Rollback: a corresponding `_down` migration or a comment block with the drop statements is included

**Complexity:** Small
**Dependencies:** STORY-003 (migration naming convention and tooling confirmed; `runs` table extension in STORY-003 migration validates the workflow)
**Notes:** `evidence_node_id` is nullable in the `artifacts` table because a future skill might produce a case-level artifact not tied to a single leaf. The `uri` field stores a storage bucket path (e.g., `artifacts/{case_id}/{node_id}/{filename}`). Do not hardcode a storage provider prefix — keep it relative.

---

## EPIC-003: Investigator Agent — Skeleton and Core Loop

**ID:** EPIC-003
**User Value:** The system has a working Investigator agent that can take a hypothesis + falsifier + threshold, run an OODA loop, and return a confidence score with a reasoning trace — even without skills loaded. This is the foundational V2 capability; every other V2 epic builds on it.
**Dependencies:** EPIC-001 (feature flag wiring), EPIC-002 (schema for trace/artifact persistence)
**Estimated Total Effort:** 4–5 days (Stories: 2×M + 2×M)

---

### STORY-005: Register Investigator agent definition with Anthropic

**Type:** Technical Story
**Statement:** As a developer, I need the Investigator agent definition (system prompt, tools, model, token budget) registered with Anthropic's Managed Agents platform so that it can be instantiated per leaf.
**Acceptance Criteria:**
- [ ] Investigator agent definition file at `agents/managed/investigator/AGENT.md` (or equivalent registration format per Anthropic's API) containing: the system prompt from spec-v2.md §3.1, tool declarations for `retrieve_documents`, `execute_code`, `spawn_researcher`, `ask_user`, `read_sibling_leaf` (stubs — implementations in STORY-006), and `write_artifact`
- [ ] Outcomes rubric for the Investigator (spec-v2.md §3.1 pass conditions) attached to the agent definition as a separate rubric file at `agents/managed/investigator/RUBRIC.md`
- [ ] Agent registered via the Anthropic API and the resulting `INVESTIGATOR_AGENT_ID` stored in `.env.example` and the local `.env`
- [ ] A call to `createInvestigatorSession` with a minimal `InvestigatorInput` (SH4.2 hypothesis, no documents) completes without API error — the agent may produce a low-quality result, that is acceptable
- [ ] The `managed_agent_session_id` returned by the session is logged to confirm it is a real Anthropic session ID

**Complexity:** Medium
**Dependencies:** STORY-002 (SDK wiring and type definitions)
**Notes:** The Investigator system prompt in spec-v2.md §3.1 is the starting point, not final. Expect to iterate on it during STORY-009 (eval). Tool stubs can return hardcoded fixtures for now — full implementations in STORY-006.

---

### STORY-006: Implement Investigator tool bindings

**Type:** Technical Story
**Statement:** As a developer, I need the five Investigator tool bindings implemented as real functions so that the OODA loop can actually retrieve documents, run code, spawn a Researcher, write artifacts, and ask users.
**Acceptance Criteria:**
- [ ] `retrieve_documents(query: string, documentIds: string[]): Promise<Chunk[]>` — runs pgvector similarity search over the supplied document IDs; returns top-k (default 8) chunks with `source_id`, `quote`, `page_number`; resolves OPEN-Q-1 design choice (inline pre-fetch or callback URL)
- [ ] `execute_code(code: string): Promise<{ stdout: string; stderr: string; files: string[] }>` — calls Managed Agents native code execution; returns stdout/stderr and a list of output file paths in the sandbox
- [ ] `spawn_researcher(question: string, stoppingCriteria?: object): Promise<ResearcherOutput>` — calls `createResearcherSession` (STORY-011); returns the Researcher's structured output
- [ ] `ask_user(question: string, type: 'yes_no' | 'open', options?: string[]): Promise<void>` — writes a row to `user_questions` table; does not block the agent (the agent proceeds with `confidence: null` on the affected claim, flagged as HITL pending)
- [ ] `read_sibling_leaf(leafId: string): Promise<{ finding: string; confidence: number } | null>` — reads `tree_nodes.content` for the given node ID within the current `case_id`; returns null if not yet complete
- [ ] `write_artifact(filename: string, content: Buffer, type: string, metadata: object): Promise<{ uri: string; artifactId: string }>` — writes the file to the storage bucket at `artifacts/{case_id}/{node_id}/{filename}`, inserts a row into the `artifacts` table, returns the URI and ID
- [ ] All tool bindings are registered in the Investigator agent definition (updating STORY-005 registration if needed)
- [ ] Integration test: `scripts/test-investigator-tools.ts` calls each tool binding against the development database and asserts it returns the correct shape (can use ABB case fixtures)

**Complexity:** Medium
**Dependencies:** STORY-005 (agent definition), STORY-004 (artifacts/reasoning_traces tables exist)
**Notes:** `execute_code` relies on Managed Agents native sandbox — verify the sandbox is available under the beta header before implementing (STORY-001 spike). `write_artifact` is the critical path item for EPIC-004. If storage tooling has issues, the artifact can temporarily be stored as a `data:` URI in the `uri` field (not for production, but keeps the demo unblocked).

---

### STORY-007: Wire Investigator output back to Postgres via webhook ingestion handler

**Type:** Technical Story
**Statement:** As a developer, I need a webhook ingestion handler that receives session completion events from the Managed Agents harness and writes the Investigator's output (confidence, evidence summary, reasoning trace, artifact references) to the correct tree node in Postgres.
**Acceptance Criteria:**
- [ ] `app/api/webhooks/managed-agents/route.ts` created; handles POST requests from the Managed Agents harness
- [ ] Handler is idempotent: if the same `managed_agent_session_id` is received twice, the second write is a no-op (upsert on `reasoning_traces.managed_agent_session_id`)
- [ ] On receipt of a session completion event: updates the corresponding `tree_nodes` row (`confidence`, `status='complete'`, `model_used='investigator-v2'`); inserts a `reasoning_traces` row with `steps`, `rejected_alternatives`, `outcomes_grades` from the session output
- [ ] On receipt of an artifact-produced event: verifies the artifact row already exists in `artifacts` (written by `write_artifact` tool during the session); if not, inserts it (handles the case where the tool call succeeded but the callback was missed)
- [ ] Webhook signature verification: if Anthropic provides a signing secret for webhook events, it is verified; if not yet available in the beta, a TODO is left and the handler logs a warning
- [ ] Out-of-order events are handled: if a `step` event arrives after the `completion` event, it is inserted into `reasoning_traces.steps` array with its timestamp (not dropped)
- [ ] Handler returns HTTP 200 for all processable events; HTTP 400 for unrecognized event shapes with error detail logged
- [ ] Manual test: trigger a Managed Agent session from `scripts/spike-managed-agents.ts`, confirm the webhook fires and the tree node is updated in the database

**Complexity:** Medium
**Dependencies:** STORY-005 (Investigator registered; session IDs known), STORY-006 (tool bindings write artifacts), STORY-004 (tables exist)
**Notes:** Resolves OPEN-Q-2 (webhook semantics) in implementation. If at-least-once is confirmed, the idempotency upsert pattern covers it. If ordering is not guaranteed, the `steps` array must be sorted by `timestamp` at read time, not at write time. Document this decision in a code comment.

---

### STORY-008: Integrate Investigator into orchestrator and verify one leaf end-to-end

**Type:** Technical Story
**Statement:** As a developer, I need the orchestrator to successfully dispatch one V2 leaf (SH4.2) through the Investigator agent and receive a complete output in Postgres, so that I can verify the full V1→V2 call path works before adding skills.
**Acceptance Criteria:**
- [ ] With `LEAF_RUNTIME=v2`, the orchestrator dispatches the SH4.2 leaf (hypothesis: "Investment vs revenue ramp clears IRR hurdle") to the Investigator
- [ ] The Investigator runs its OODA loop without skills (will produce a low-confidence result), returns a `confidence` value and an `evidenceSummary`
- [ ] A `reasoning_traces` row is written for the SH4.2 node with at least one OODA step populated in `steps`
- [ ] The SH4.2 `tree_nodes` row is updated: `status='complete'`, `confidence` set, `model_used='investigator-v2'`
- [ ] The existing drill-down click path works for this leaf: Decision → H4 → SH4.2 → the leaf's evidence summary is visible (even without an artifact at this stage)
- [ ] With `LEAF_RUNTIME=v1`, the same run produces the V1 result unchanged — regression test passes
- [ ] Cost of one Investigator session (no skills, no Researcher spawn) is logged to the `runs` table or console for budget tracking

**Complexity:** Medium
**Dependencies:** STORY-007 (webhook writes to Postgres), STORY-003 (feature flag routes to V2 path)
**Notes:** This is the end-of-EPIC-003 integration gate. If this story passes, the Investigator skeleton is real. EPIC-004 (wedge demo) starts here. The SH4.2 leaf is chosen because it is the wedge demo target — early validation of that specific leaf path is high value.

---

## EPIC-004: Wedge Demo — SH4.2 End-to-End

**ID:** EPIC-004
**User Value:** A user drilling down to the SH4.2 leaf ("Investment vs revenue ramp clears IRR hurdle") sees the Investigator's OODA trace, an actual `model.xlsx` artifact with Inputs/Scenarios/NPV bridge/Conclusion tabs opening inline in the existing source modal, a v1→v2 version diff, and an escalated HITL question about the year-3 channel ramp. This is the "unlock" — if this leaf works, the pattern generalizes. CRITICAL PATH to the Daniel demo.
**Dependencies:** EPIC-001, EPIC-002, EPIC-003, EPIC-005 (STORY-009 — skill #1 must exist), EPIC-008 (STORY-019 — artifact viewer must exist)
**Estimated Total Effort:** 3 days (1×M + 1×M + 1×S)

---

### STORY-009: Author bottoms-up-financial-model skill (Skill #1 — CRITICAL PATH)

**Type:** Technical Story
**Statement:** As a developer, I need the `bottoms-up-financial-model` skill authored and loadable by the Investigator so that the SH4.2 leaf can build an IRR model as an artifact.
**Acceptance Criteria:**
- [ ] `skills/bottoms-up-financial-model/SKILL.md` created with YAML frontmatter: `name`, `description` (routing signal — must distinguish this skill from sensitivity analysis and competitor teardown; must name the trigger conditions: NPV/IRR/revenue threshold, quantitative, qualitative search won't move the answer), full instructions for the model-building loop
- [ ] Skill instructions specify: multi-tab xlsx structure (Inputs / Scenarios / NPV bridge / Conclusion), ABB color coding (blue inputs, black formulas, green internal links, red external links), how to handle missing inputs (use industry averages, flag as low-confidence), when to spawn a Researcher for benchmarks
- [ ] `skills/bottoms-up-financial-model/scripts/build-model.py` created — Python template that produces a valid `.xlsx` using `openpyxl`; takes JSON inputs (revenue_ramp, capex, opex, wacc, irr_hurdle, terminal_growth) and writes the four-tab structure
- [ ] `skills/bottoms-up-financial-model/examples/reference.xlsx` included — a pre-built ABB example (can be created manually or by running `build-model.py` with sample inputs)
- [ ] The Investigator can load the skill description (routing signal) and, when selected, receives the full skill instructions in its context
- [ ] Skill description is tested against the 5-skill eval set (STORY-021): when SH4.2's falsifier is presented alongside all 5 skill descriptions, the Investigator selects `bottoms-up-financial-model` at least 8/10 times (>=0.80 selection accuracy at this stage; tighten to 0.85 in STORY-021)
- [ ] The `build-model.py` script runs successfully in the Managed Agents code execution sandbox

**Complexity:** Medium
**Dependencies:** STORY-005 (Investigator agent definition, so skill loading mechanism is known), STORY-001 (sandbox code execution confirmed)
**Notes:** This is the highest-impact single story in the project. Invest in the skill description — it is the routing signal. Per spec-v2.md §11 ("Writing effective tools for AI agents"), the description must name what problem the skill solves, what it produces, and what conditions make it the right choice. Rejected conditions (when NOT to use this skill) are as important as trigger conditions.

---

### STORY-010: Run SH4.2 leaf with skill, verify artifact and OODA trace

**Type:** Technical Story / User Story
**Statement:** As a developer, I need to run the SH4.2 leaf with the `bottoms-up-financial-model` skill loaded and verify that the Investigator produces a real `model.xlsx` artifact with a multi-loop OODA trace (including a Researcher spawn for margin benchmarks and a HITL escalation for year-3 ramp), so that the wedge demo path is complete.
**Acceptance Criteria:**
- [ ] With `LEAF_RUNTIME=v2`, the orchestrator dispatches SH4.2; the Investigator selects the `bottoms-up-financial-model` skill
- [ ] The Investigator spawns a Researcher session to fetch industry-segment margin benchmarks; the Researcher returns a structured result with at least one citation
- [ ] `build-model.py` is executed in the sandbox; a `model.xlsx` artifact is produced with all four tabs (Inputs / Scenarios / NPV bridge / Conclusion)
- [ ] The artifact is written to storage via `write_artifact`; an `artifacts` row exists in Postgres with `type='xlsx'`, `version=1`, `metadata` containing `skill_name: 'bottoms-up-financial-model'`
- [ ] After a second loop (incorporating ABB segment data from `retrieve_documents`), a second artifact version is produced: `artifacts` row with `version=2`, `parent_artifact_id` pointing to the v1 row
- [ ] An `ask_user` escalation is written to `user_questions`: question is about year-3 channel ramp (bear/base/bull), `question_type='yes_no'` or `'yes_no_context'`
- [ ] `reasoning_traces.steps` contains at least 5 OODA steps matching the narrative in spec-v2.md §6 (Observe/Orient/Decide/Act/Self-critique)
- [ ] `reasoning_traces.rejected_alternatives` contains at least: "comparable-transactions analog" and "top-down sizing" with reasons
- [ ] The SH4.2 leaf `confidence` is between 0.4 and 0.75 (low confidence is expected given the missing year-3 ramp input — this is the correct behavior)
- [ ] Non-negotiable verified: `reasoning_traces` row exists and is not null (no black-box leaf)
- [ ] Non-negotiable verified: `artifacts` row exists and is not null (no prose-only output)

**Complexity:** Medium
**Dependencies:** STORY-009 (skill #1 authored), STORY-008 (Investigator integrated into orchestrator), STORY-007 (webhook writes artifacts and traces)
**Notes:** This story may require iteration on the Investigator system prompt and/or the skill instructions to get the multi-loop behavior. Budget half a day for prompt iteration. The key acceptance criterion is the version lineage (v1→v2 artifact) and the HITL escalation — these are the demo moments.

---

### STORY-011: Verify wedge demo click path end-to-end

**Type:** User Story
**Statement:** As a demo presenter, I want to click through the SH4.2 drill-down path and see the artifact, OODA trace, version diff, and HITL escalation so that I can rehearse the demo narrative.
**Acceptance Criteria:**
- [ ] Click path works without error: Decision → H4 (Unit Economics) → SH4.2 → Evidence leaf
- [ ] Evidence leaf shows: confidence meter, evidence summary, link/button to open the reasoning trace, link/button to open the artifact
- [ ] Artifact viewer (from STORY-019) renders the `model.xlsx` inline via SheetJS — all four tabs are navigable
- [ ] Version diff is visible: a "v1 → v2" indicator shows what input changed between artifact versions and the confidence delta
- [ ] The HITL question card for year-3 ramp is visible in the question list with the three options (bear/base/bull)
- [ ] Micky V1's narration on the H4 card still works (not broken by V2 changes)
- [ ] The drill-down path does not break for any V1 leaves in the same run (mixed V1/V2 run is stable)

**Complexity:** Small
**Dependencies:** STORY-010 (SH4.2 run complete with artifact), STORY-019 (artifact viewer renders xlsx), STORY-020 (OODA timeline view renders traces)
**Notes:** This is the demo rehearsal acceptance story. If it passes, EPIC-004 is done. Keep it as a manual verification — no automated test needed. Write a short click path script (5 steps, printed to terminal) that the presenter uses.

---

## EPIC-005: Skills Registry (Priority Skills #1–5)

**ID:** EPIC-005
**User Value:** The Investigator has a repertoire of methods beyond the wedge skill. Skills #2 and #3 are needed for the full ABB run (EPIC-007); skills #4–5 are cuttable per the spec's cut order.
**Dependencies:** EPIC-001 (feature flag), EPIC-003 (Investigator agent definition and skill loading mechanism)
**Estimated Total Effort:** 5–6 days (STORY-009 already in EPIC-004; Stories here: 2×M + 2×M + 1×S)

Note: Skill #1 (`bottoms-up-financial-model`) is STORY-009 in EPIC-004. It is listed there because it is on the critical path to the wedge demo. The skills registry infrastructure (how skills are loaded, described, and routed) is established by STORY-009.

---

### STORY-012: Author competitor-teardown skill (Skill #2)

**Type:** Technical Story
**Statement:** As a developer, I need the `competitor-teardown` skill authored so that the Investigator can apply it to SH2.1 (capability gap is closeable) and SH2.2 (brand permission in target segments), as well as SH3.1 (channel insufficiency).
**Acceptance Criteria:**
- [ ] `skills/competitor-teardown/SKILL.md` created with description (routing signal: when the hypothesis requires understanding a competitor's product, capability, or market position; produces a structured comparison artifact)
- [ ] Skill instructions specify: artifact structure (markdown table or xlsx with competitor columns: product specs, pricing, channel, segment coverage, moat), how to use the Researcher to fill gaps, how to cite sources
- [ ] Skill produces an artifact of type `md` or `xlsx` (developer's choice; `md` is acceptable here since table rendering is simpler than financial modeling)
- [ ] Tested on SH2.1: Investigator selects this skill when presented with the SH2.1 falsifier ("ABB lacks intelligent PDU firmware capability and cannot close the gap within 3 years")
- [ ] Selection accuracy tested: when SH2.1's falsifier is presented alongside all 5 skill descriptions, the Investigator selects `competitor-teardown` at least 7/10 times

**Complexity:** Medium
**Dependencies:** STORY-009 (skill loading mechanism established), STORY-005 (Investigator agent definition)
**Notes:** This skill has the broadest reuse across the ABB tree (hits SH2.1, SH2.2, SH3.1). Invest in the description routing signal. The artifact can be markdown — it does not need an xlsx for this skill.

---

### STORY-013: Author sensitivity-analysis skill (Skill #3)

**Type:** Technical Story
**Statement:** As a developer, I need the `sensitivity-analysis` skill authored so that the Investigator can apply it to compound quantitative leaves (primarily as a follow-on to the financial model).
**Acceptance Criteria:**
- [ ] `skills/sensitivity-analysis/SKILL.md` created with description (routing signal: when a quantitative finding has a dominant assumption that, if wrong, would flip the conclusion; produces a sensitivity table artifact)
- [ ] Skill instructions specify: how to identify the dominant assumption, how to build a 3-point range (bear/base/bull), how to output as a csv or xlsx sensitivity table, how to state the finding in terms of "the conclusion holds unless [assumption] falls below [X]"
- [ ] Skill produces an artifact of type `csv` or `xlsx`
- [ ] Tested on SH4.1: Investigator selects this skill when presented with the SH4.1 falsifier ("ABB's 25-30% margin claim is not achievable in the intelligent PDU segment") — this is an assumption-sensitivity question
- [ ] The skill can reference an existing artifact (the financial model from skill #1) as an input — the instructions explain how to read an existing artifact path from context and extract the dominant assumption

**Complexity:** Medium
**Dependencies:** STORY-009 (skill loading mechanism), STORY-012 (skill #2 pattern established — skill #3 follows same format)
**Notes:** This skill compounds with skill #1. The description must make clear it is a follow-on method (not a replacement for the financial model). The "cut" scenario in spec §7 cuts this skill third, after Micky V2 and skills 4–5 — so it is lower priority than skills #1–2 but higher than #4–5.

---

### STORY-014: Author analog-case-retrieval skill (Skill #4 — CUTTABLE)

**Type:** Technical Story
**Statement:** As a developer, I need the `analog-case-retrieval` skill authored so that the Investigator can ground quantitative estimates in historical base rates from comparable situations.
**Acceptance Criteria:**
- [ ] `skills/analog-case-retrieval/SKILL.md` created with description (routing signal: when a hypothesis requires a base rate or historical precedent; the question is "how often does X happen in situations like this?")
- [ ] Skill instructions specify: how to query the Researcher for historical analogs, how to structure the analog comparison (dimensions: market, timing, company profile, outcome), what artifact to produce (markdown with analog table and base rate estimate)
- [ ] Artifact type: `md`
- [ ] Tested on at least one ABB leaf (SH5.1 or SH3.2 are good fits)
- [ ] Cut criteria: if the team is behind on day 10, this story is dropped without affecting the demo

**Complexity:** Medium
**Dependencies:** STORY-012 (skill #2 pattern, Researcher spawn from a skill is established)
**Notes:** This is the first cuttable skill. Flag clearly in code with `// V2-CUTTABLE: skill #4` comment in SKILL.md frontmatter. The cut does not affect the Investigator's core demo.

---

### STORY-015: Author pre-mortem-redteam skill (Skill #5 — CUTTABLE)

**Type:** Technical Story
**Statement:** As a developer, I need the `pre-mortem-redteam` skill authored so that the Investigator can generate a structured failure-mode analysis for a given hypothesis.
**Acceptance Criteria:**
- [ ] `skills/pre-mortem-redteam/SKILL.md` created with description (routing signal: when the hypothesis is being supported and the question is "what would have to be true for this to fail?"; produces a ranked failure mode list)
- [ ] Skill instructions specify: how to generate 5–10 failure modes, how to rank by likelihood × impact, what artifact to produce (markdown table: failure mode / likelihood / impact / mitigation)
- [ ] Artifact type: `md`
- [ ] Tested on the Decision node (as a cross-cutting pre-mortem over the whole recommendation)
- [ ] Cut criteria: if the team is behind on day 10, this story is dropped without affecting the demo

**Complexity:** Medium
**Dependencies:** STORY-014 (establishes the pattern for "generates-a-list" skills; not a hard dependency — can run in parallel)
**Notes:** This skill is the bridge to V3's adversarial red team tree (spec §9). Keep the artifact format extensible. Cut first after skill #4.

---

### STORY-016: Skill description eval set (>0.85 selection accuracy)

**Type:** Technical Story
**Statement:** As a developer, I need to measure and iterate on skill descriptions until the Investigator selects the correct skill for 85%+ of a 20-scenario eval set, so that the routing is reliable enough for the demo.
**Acceptance Criteria:**
- [ ] `scripts/eval-skill-selection.ts` created: defines 20 leaf scenarios (falsifier text + hypothesis context), each with a ground-truth skill label; runs the Investigator's skill selection step for each scenario; reports selection accuracy per skill and overall
- [ ] At least 20 eval scenarios defined, covering: 5 financial model scenarios, 4 competitor teardown scenarios, 3 sensitivity scenarios, 3 analog retrieval scenarios, 3 pre-mortem scenarios, 2 "no skill needed — use Researcher only" scenarios
- [ ] Overall selection accuracy >= 0.85 on the 20-scenario set before this story is marked complete
- [ ] Per-skill accuracy >= 0.80 for skills #1–3 (the non-cuttable ones)
- [ ] Skill descriptions that fail the accuracy threshold are iterated (with the change logged as a comment in SKILL.md so the reasoning is traceable)
- [ ] Eval script is re-runnable (deterministic seed where possible; if not, run 3 times and take the median)

**Complexity:** Medium
**Dependencies:** STORY-009, STORY-012, STORY-013 (skills #1–3 authored — minimum needed for the non-cuttable eval), STORY-014, STORY-015 (if not cut)
**Notes:** This is the accuracy gate for the whole skill system. Per spec §10, this is called out as "High initially" risk. The eval set is the mitigation. Do not skip this story — a demo where the Investigator picks the wrong method is worse than no demo. The 20-scenario set should include the ABB leaves plus synthetic leaves from other hypothetical cases to test generalization.

---

## EPIC-006: Researcher Agent

**ID:** EPIC-006
**User Value:** The Investigator can delegate web research to a Researcher sub-agent, keeping the Investigator's context clean. The Researcher runs its own OODA loop, respects explicit stopping criteria, and returns a compressed structured finding with citations. Visible to Daniel as "I spawned a researcher for margin benchmarks" in the OODA trace.
**Dependencies:** EPIC-001 (feature flag), EPIC-002 (schema for reasoning traces), EPIC-003 (Investigator calls `spawn_researcher`)
**Estimated Total Effort:** 3–4 days (Stories: 1×M + 1×M + 1×S)

---

### STORY-017: Register Researcher agent definition with Anthropic

**Type:** Technical Story
**Statement:** As a developer, I need the Researcher agent definition registered with Anthropic so that the Investigator can spawn it via the `spawn_researcher` tool.
**Acceptance Criteria:**
- [ ] Researcher agent definition file at `agents/managed/researcher/AGENT.md` containing: the system prompt from spec-v2.md §3.2 (OODA loop with Tavily, three stopping criteria), Tavily tool declaration, model set to Sonnet
- [ ] Outcomes rubric for the Researcher authored at `agents/managed/researcher/RUBRIC.md`: "answer cites at least one source; `stoppedBecause` is one of the three valid options; `searchPath` shows query diversity (no two queries share >3 words)"
- [ ] Agent registered via Anthropic API; `RESEARCHER_AGENT_ID` stored in `.env.example` and local `.env`
- [ ] `createResearcherSession` in `lib/managed-agents-client.ts` is implemented (not a stub); can be called with a `ResearcherInput` and returns a `ResearcherOutput`
- [ ] The Researcher's stopping criteria defaults are confirmed in the registration: `confidenceTarget: 0.8`, `maxSearches: 10`, `diminishingReturnsThreshold: 3`

**Complexity:** Medium
**Dependencies:** STORY-002 (SDK wiring, types defined), STORY-005 (Investigator registered — establishes the registration pattern)
**Notes:** The Researcher is simpler to register than the Investigator (one tool: Tavily). The system prompt skeleton in spec §3.2 is close to final — the main iteration surface is the stopping criteria rubric wording.

---

### STORY-018: Test Researcher standalone and via Investigator spawn

**Type:** Technical Story
**Statement:** As a developer, I need to verify that the Researcher runs correctly both standalone and when spawned by the Investigator, so that margin-benchmark and channel-research queries return useful compressed results.
**Acceptance Criteria:**
- [ ] `scripts/test-researcher.ts` runs a standalone Researcher session on two queries: (a) "intelligent PDU segment gross margins for data center hardware vendors" and (b) "IT channel distribution penetration rates for electrical equipment vendors"
- [ ] Both sessions return `ResearcherOutput` with `answer`, `confidence >= 0.7`, at least 2 citations, `searchPath` showing at least 2 distinct queries, `stoppedBecause` is one of the three valid options
- [ ] Researcher's outcomes rubric fires: at least one session demonstrates a rubric-pass grade in `reasoning_traces.outcomes_grades` (requires STORY-004 Researcher traces to also be stored — add `agent_type='researcher'` rows)
- [ ] Investigator spawn tested: on the SH4.2 leaf run (STORY-010 foundation), the Investigator spawns a Researcher for margin benchmarks; the Researcher result is incorporated into the Investigator's reasoning trace
- [ ] `reasoning_traces` row for the Researcher session is written with `agent_type='researcher'`; `node_id` references the same tree node as the parent Investigator session
- [ ] Non-negotiable verified: Researcher stopping criteria are explicit — `stoppedBecause` field is populated on every Researcher session, never null

**Complexity:** Medium
**Dependencies:** STORY-017 (Researcher registered), STORY-006 (Investigator tool bindings — `spawn_researcher` implemented), STORY-007 (webhook handler writes Researcher traces)
**Notes:** The two test queries above are chosen for ABB relevance — they will produce real data useful for the demo. Run and cache the results for the demo pre-run.

---

### STORY-019-R: Extend webhook handler for Researcher traces

**Type:** Technical Story
**Statement:** As a developer, I need the webhook ingestion handler extended to write Researcher session traces and link them to the correct tree node.
**Acceptance Criteria:**
- [ ] Webhook handler processes Researcher session completion events (distinct from Investigator events by `agent_type` field)
- [ ] Researcher `reasoning_traces` row written with `agent_type='researcher'`, `node_id` set to the leaf node that spawned the session, `steps` populated with the OODA steps
- [ ] `outcomes_grades` field populated from the Researcher rubric grading result
- [ ] No double-write: if the Investigator and Researcher complete in the same tick, both rows are written correctly without conflict
- [ ] Handler is tested by running a full SH4.2 V2 session and confirming two `reasoning_traces` rows exist: one investigator, one researcher, both referencing the SH4.2 node

**Complexity:** Small
**Dependencies:** STORY-007 (webhook handler base), STORY-017 (Researcher registered)
**Notes:** This is a targeted extension of STORY-007. Keep it small — the handler pattern is established, this is an `agent_type` branch.

---

## EPIC-007: Full ABB Run and Outcomes Rubrics

**ID:** EPIC-007
**User Value:** The complete ABB case runs end-to-end on the V2 leaf runtime. Every leaf has an Investigator session, a reasoning trace, and at least an attempt at an artifact. The Investigator and Researcher rubrics are live. Confidence scores are meaningfully different from V1 (or defensibly similar with richer evidence). This is the demo's full-run pre-bake.
**Dependencies:** EPIC-003, EPIC-005 (skills #1–3 at minimum), EPIC-006 (Researcher working)
**Estimated Total Effort:** 4–5 days (Stories: 1×M + 1×M + 1×M + 1×S)

---

### STORY-020: Author Investigator outcomes rubric (final version)

**Type:** Technical Story
**Statement:** As a developer, I need the Investigator's outcomes rubric finalized and confirmed to improve leaf quality on the ABB eval set, so that grading actively catches and corrects weak Investigator outputs.
**Acceptance Criteria:**
- [ ] The rubric in `agents/managed/investigator/RUBRIC.md` is finalized with the five pass conditions from spec-v2.md §3.1: (1) artifact/finding directly addresses the falsifier, (2) threshold question is answered, (3) all quantitative claims have source or computed lineage, (4) confidence is consistent with evidence strength, (5) at least one rejected alternative is named
- [ ] Rubric is tested on 10 ABB leaves: overall pass rate on first attempt is measured and logged; target is >= 0.60 pass rate (i.e., grader catches at least 40% of weak first-pass outputs and triggers revision)
- [ ] At least 3 leaves demonstrate the revision loop: the grader fails the first output, the Investigator revises, the grader passes the second output
- [ ] `outcomes_grades` jsonb in `reasoning_traces` is populated for all 10 tested leaves with at least `{pass: boolean, failedConditions: string[]}`
- [ ] Non-negotiable verified: every agent definition ships with an outcomes rubric — the rubric is attached at session creation, not optional

**Complexity:** Medium
**Dependencies:** STORY-005 (Investigator registered with rubric stub), STORY-008 (full leaf run works)
**Notes:** The rubric wording matters as much as the agent system prompt. If the rubric is too lenient, everything passes on first try and there is no improvement lift. If too strict, the Investigator loops forever. Calibrate on the 10-leaf set. Per spec §5, failed-then-passed transitions are training data — log them.

---

### STORY-021: Author Researcher outcomes rubric (final version)

**Type:** Technical Story
**Statement:** As a developer, I need the Researcher's outcomes rubric finalized so that web research loops converge to cited, diverse, high-confidence answers.
**Acceptance Criteria:**
- [ ] The rubric in `agents/managed/researcher/RUBRIC.md` is finalized: (1) answer cites at least one source with a quote, (2) `stoppedBecause` is one of the three valid values, (3) `searchPath` shows query diversity (no two queries share >3 consecutive words), (4) confidence is >= 0.6 when `stoppedBecause = 'answered'`
- [ ] Rubric tested on 5 standalone Researcher runs (different research questions); all 5 pass condition (2); at least 3 pass all four conditions
- [ ] `outcomes_grades` populated for all 5 test runs

**Complexity:** Small
**Dependencies:** STORY-017 (Researcher registered with rubric stub), STORY-018 (standalone Researcher tested)
**Notes:** The Researcher rubric is simpler than the Investigator's — four conditions, all checkable mechanically. The diversity check (condition 3) is the most important: without it, the Researcher gets stuck rephrasing the same query.

---

### STORY-022: Run full ABB case on V2 leaf runtime

**Type:** Technical Story
**Statement:** As a developer, I need to run the complete 11-leaf ABB case with `LEAF_RUNTIME=v2` and produce a passing run (all leaves reach `status='complete'` or `status='failed'` with a logged reason — no hung leaves, no orchestrator crash).
**Acceptance Criteria:**
- [ ] Full ABB run with `LEAF_RUNTIME=v2` completes (all 11 sub-hypothesis leaves dispatched, orchestrator reaches the decision step)
- [ ] At least 8 of 11 leaves have `status='complete'` with a `reasoning_traces` row
- [ ] At least 6 of 11 leaves have an `artifacts` row (leaves where no method-driven skill is selected may have prose-only output — flag these as technical debt, not failures)
- [ ] Non-negotiable verified for each complete leaf: `reasoning_traces` row exists; `reasoning_traces.steps` is not empty; `confidence` is set
- [ ] The hypothesis evaluator and confidence rollup run on the V2 leaf outputs and produce a valid `master_decision` node
- [ ] V2 vs V1 confidence comparison: for at least 3 leaves, V2 confidence differs from V1 by > 0.05 (in either direction) — this is the signal that V2 is actually doing something different
- [ ] Total session cost for the full run is logged; if it exceeds $5 USD equivalent, log a warning and surface to the developer (not blocking, but track)
- [ ] The drill-down click path works end-to-end for the complete V2 run: Decision → any hypothesis → any sub-hypothesis → evidence → artifact or reasoning trace

**Complexity:** Medium
**Dependencies:** STORY-020 (Investigator rubric live), STORY-021 (Researcher rubric live), STORY-012 and STORY-013 (skills #2–3 for broader leaf coverage)
**Notes:** This is the full integration test before the UI polish sprint. Expect some leaves to fail on first run — triage by category: (a) skill selection failures (fix descriptions), (b) code execution errors (fix `build-model.py`), (c) webhook timing issues (add retry). Budget 1 day for triage. The goal is not perfection — it is a complete run that tells the story.

---

### STORY-023: Pre-bake ABB run for demo (cache and verify)

**Type:** Technical Story
**Statement:** As a developer, I need a pre-baked (cached) V2 ABB run stored in the database so that the demo can load instantly and does not depend on live Managed Agents latency.
**Acceptance Criteria:**
- [ ] A complete ABB V2 run is executed, all outputs verified (per STORY-022 criteria), and the run is marked as the "demo run" (a flag in the `runs` table, e.g., `is_demo boolean default false`)
- [ ] The demo run loads in < 2 seconds on the case view page (no live API calls on page load)
- [ ] All artifact URIs in the demo run resolve (storage files exist, not expired)
- [ ] The SH4.2 leaf in the demo run passes all STORY-011 click-path acceptance criteria
- [ ] A `scripts/prebake-demo.ts` script exists that automates the full-run + verification + demo-flag-set sequence

**Complexity:** Small
**Dependencies:** STORY-022 (full ABB run working), STORY-011 (wedge demo click path verified)
**Notes:** The pre-bake is the demo insurance policy. If Managed Agents has an outage on day 18, the demo still runs. The `is_demo` flag in the `runs` table is also used by the UI to surface "Demo run" prominently.

---

## EPIC-008: UI Extensions — Artifact Viewer, OODA Timeline, Version Diff

**ID:** EPIC-008
**User Value:** A user drilling into a V2 leaf sees three new elements in the existing drill-down modal: (1) an inline artifact viewer that renders xlsx/csv/png without download, (2) an OODA timeline showing the agent's reasoning steps, (3) a version diff showing what changed between artifact versions. The existing drill-down click path is extended, not replaced.
**Dependencies:** EPIC-002 (schema for artifacts and reasoning_traces), EPIC-003 (data exists to display — at minimum one leaf run)
**Estimated Total Effort:** 4–5 days (Stories: 1×M + 1×M + 1×S + 1×S)

---

### STORY-024: Artifact viewer component (xlsx inline via SheetJS, csv, png)

**Type:** User Story
**Statement:** As a user drilling down to an evidence leaf, I want to see the artifact (xlsx, csv, or png) rendered inline in the source modal so that I do not need to download the file to understand the evidence.
**Acceptance Criteria:**
- [ ] `components/ArtifactViewer.tsx` created; accepts `artifact: Artifact` prop
- [ ] For `type='xlsx'`: renders using SheetJS (`xlsx` npm package); all tabs are displayed as navigable tab headers; cells render with correct values (not raw cell objects); the component handles multi-tab workbooks
- [ ] For `type='csv'`: renders as an HTML table with header row; handles up to 200 rows without performance issues
- [ ] For `type='png'`: renders as a responsive `<img>` with a "download" button
- [ ] For `type='md'`: renders as sanitized HTML (use existing markdown renderer if one exists in the codebase; otherwise `react-markdown`)
- [ ] For `type='json'` and `type='model_lineage'`: renders as formatted JSON (collapsible, syntax highlighted)
- [ ] The existing `EvidenceModal.tsx` is extended to show an "Artifact" tab when `artifacts.length > 0` for the current leaf; no existing modal behavior is broken
- [ ] Version selector: if multiple artifact versions exist (v1, v2, ...), a version dropdown renders; selecting a version loads that artifact
- [ ] SheetJS is added to `package.json` dependencies; `npm run build` passes

**Complexity:** Medium
**Dependencies:** STORY-004 (artifacts table and schema types), STORY-010 (at least one xlsx artifact exists in the database for testing)
**Notes:** SheetJS client-side rendering of xlsx is the spec-mandated approach (spec §10, "xlsx → SheetJS in the browser"). Do not attempt server-side rendering. The version selector is part of the version diff story (STORY-026), but the version dropdown in this component is its visual anchor.

---

### STORY-025: OODA timeline view component

**Type:** User Story
**Statement:** As a user drilling into a V2 leaf, I want to see the agent's OODA reasoning steps as a timeline so that I can understand how the Investigator arrived at its conclusion.
**Acceptance Criteria:**
- [ ] `components/OODATimeline.tsx` created; accepts `trace: ReasoningTrace` prop
- [ ] Renders `reasoning_traces.steps` as a vertical timeline; each step shows: phase label (OBSERVE / ORIENT / DECIDE / ACT / SELF-CRITIQUE), content text, timestamp, and `skill_used` badge if present
- [ ] Renders `reasoning_traces.rejected_alternatives` as a collapsed "Rejected methods" section at the top of the timeline (expandable)
- [ ] Renders `reasoning_traces.outcomes_grades` as a pass/fail history at the bottom (e.g., "Pass on attempt 2")
- [ ] If the `agent_type` is `'researcher'`, a "Researcher" badge distinguishes it from an Investigator trace; the Researcher's `searchPath` (from the output stored in steps) is rendered as a mini list of queries
- [ ] The existing `EvidenceModal.tsx` or `HypothesisDrilldown.tsx` is extended with a "Reasoning" tab that renders the timeline; no existing tabs are removed
- [ ] Empty state: if no trace exists (V1 leaf), the "Reasoning" tab is hidden, not shown as empty

**Complexity:** Medium
**Dependencies:** STORY-004 (reasoning_traces schema types), STORY-008 (at least one reasoning trace exists for SH4.2)
**Notes:** The OODA timeline is the "auditability story" per spec §12 non-negotiable #2. It must be readable by a non-technical demo audience — use plain English phase labels, not JSON dumps. The "Rejected methods" section is what Daniel will find most interesting ("the AI considered and rejected X because Y").

---

### STORY-026: Version diff indicator

**Type:** User Story
**Statement:** As a user viewing a multi-version artifact, I want to see a concise diff showing what input changed between versions and the resulting confidence delta, so that I understand why the model was revised.
**Acceptance Criteria:**
- [ ] Within `ArtifactViewer.tsx` (STORY-024), when `artifacts.length > 1`, a "v1 → v2" diff panel renders below the version dropdown
- [ ] Diff content is derived from `artifacts.metadata` on each version: displays changed fields (e.g., "Margin assumption: industry avg → ABB 10-K segment data"), the source of the change, and the confidence delta (e.g., "+0.12")
- [ ] For xlsx artifacts specifically: if the `Inputs` tab values differ between versions, a row-level diff is shown ("Row 5 [Gross Margin]: 28% → 31%")
- [ ] If the metadata does not contain structured diff information, the diff panel shows a prose summary from `metadata.change_reason` (a field the skill author must populate in `write_artifact` calls)
- [ ] The diff panel is collapsed by default; expanded on click

**Complexity:** Small
**Dependencies:** STORY-024 (ArtifactViewer component), STORY-010 (v1→v2 artifact lineage exists in Postgres for testing)
**Notes:** The diff panel relies on `metadata` being populated by the `write_artifact` tool call. The skill author (STORY-009) must include `change_reason` in the metadata. Add this as an acceptance criterion retroactively to STORY-009 or document it as a skill authoring convention.

---

### STORY-027: Drill-down regression test

**Type:** Technical Story
**Statement:** As a developer, I need to verify that all existing V1 drill-down paths still work after the V2 UI extensions are added, so that the non-negotiable drill-down click path is guaranteed.
**Acceptance Criteria:**
- [ ] Manual click-path test script (5 steps, same format as STORY-011) executed for a V1 run: Decision → H1 → SH1.1 → Evidence → Source modal — all steps open without error
- [ ] The "Reasoning" tab is hidden (not shown as broken) on V1 leaves
- [ ] The "Artifact" tab is hidden on V1 leaves
- [ ] All existing components (`KanbanBoard`, `HypothesisDrilldown`, `EvidenceModal`, `SourceViewer`, `MickyAnnotation`) render without console errors after the V2 UI changes
- [ ] `npm run build` passes

**Complexity:** Small
**Dependencies:** STORY-024, STORY-025, STORY-026 (all UI extensions complete)
**Notes:** This is the non-negotiable verification story for spec §12.6. It must pass before EPIC-009. Keep it as a manual test — automated E2E tests are out of scope for V2's timeline.

---

## EPIC-009: Daniel Demo — End-to-End Polish and Eval

**ID:** EPIC-009
**User Value:** Daniel sees the V2 demo: ABB case, SH4.2 drill-down with artifact and OODA trace, full tree with V2 confidence scores, and a clear narrative of "the agent reasoned about which method to use, built a model, got a Researcher to fill gaps, self-critiqued, and escalated the one thing it couldn't answer alone."
**Dependencies:** EPIC-004 (wedge demo), EPIC-007 (full ABB run), EPIC-008 (UI extensions)
**Estimated Total Effort:** 2 days (1×M + 1×S)

---

### STORY-028: Final eval and regression sweep

**Type:** Technical Story
**Statement:** As a developer, I need to run the full eval suite (skill selection accuracy, V1 regression, V2 leaf quality) and address any blocking issues before the demo.
**Acceptance Criteria:**
- [ ] Skill selection eval (STORY-016): >= 0.85 accuracy on the 20-scenario set — confirmed passing
- [ ] V1 regression: ABB case with `LEAF_RUNTIME=v1` produces a complete run with the correct drill-down (no regressions introduced by V2 changes)
- [ ] V2 full run (STORY-022) passes: all 11 leaves dispatched, >= 8 complete, decision node produced
- [ ] SH4.2 wedge demo click path (STORY-011) passes: artifact renders, OODA trace visible, HITL question visible
- [ ] Drill-down regression test (STORY-027) passes
- [ ] No open P0/P1 bugs in the drill-down click path
- [ ] Cost-per-run estimate is logged and within acceptable bounds (< $10 per full run as a soft ceiling — flag to Harry if exceeded)

**Complexity:** Medium
**Dependencies:** STORY-016, STORY-022, STORY-011, STORY-027, STORY-023
**Notes:** This story is the go/no-go gate. If it fails, apply the spec's cut order: (1) drop Micky V2 (EPIC-010 — already separate), (2) drop skills #4–5 (STORY-014, STORY-015), (3) drop skill #3 (STORY-013). Cannot drop: Investigator + skill #1 + Researcher + artifact viewer.

---

### STORY-029: Demo rehearsal and click-path script

**Type:** User Story
**Statement:** As a demo presenter, I want a written 10-step click-path script and a pre-baked run loaded in the UI so that I can rehearse the demo and deliver it without live-agent latency surprises.
**Acceptance Criteria:**
- [ ] `docs/demo-script-v2.md` created (or updated from V1 equivalent) with: 10 numbered steps, each with the exact UI element to click, the expected visual outcome, and the narrative line to say
- [ ] The pre-baked demo run (STORY-023) is loaded in the staging/production environment and confirmed accessible at the demo URL
- [ ] The presenter has rehearsed the click path at least once and confirmed it takes < 8 minutes end-to-end
- [ ] Fallback plan is documented: if the live run fails during the demo, the pre-baked run is available and how to switch to it is noted in the script
- [ ] Micky V1 narration is confirmed working on the demo run (not broken by V2 changes)

**Complexity:** Small
**Dependencies:** STORY-023 (pre-baked run), STORY-028 (all evals passing)
**Notes:** The demo script is the handoff artifact. It should be written by the developer who built the system, not as an afterthought.

---

## EPIC-010: Micky V2 — Reasoning Trace Narration (CUTTABLE — drop first)

**ID:** EPIC-010
**User Value:** Micky reads the Investigator's OODA reasoning trace and narrates "why this method" at the leaf level — not just the conclusion (V1) but the method selection rationale. This makes the demo richer but is not required if time is short.
**Dependencies:** EPIC-003, EPIC-006, EPIC-007 (full run with traces populated)
**Estimated Total Effort:** 2–3 days (Stories: 1×M + 1×S)
**Cut criteria:** Drop this epic entirely if the team reaches day 14 without completing EPIC-007. V1 Micky narration is sufficient for the demo.

---

### STORY-030: Extend Micky to read reasoning traces

**Type:** Technical Story
**Statement:** As a developer, I need Micky to read the Investigator's reasoning trace (not just the final finding) and generate a leaf-level narration of method selection, so that the OODA trace has a human-readable interpretation above the raw steps.
**Acceptance Criteria:**
- [ ] `agents/micky.ts` extended with a new `narrateLeaf(traceId: string): Promise<string>` function
- [ ] `narrateLeaf` reads the `reasoning_traces` row for the given node, extracts `steps`, `rejected_alternatives`, and the selected skill, then calls Sonnet to generate a 2–3 sentence narration: "I considered X and Y but chose Z because [reason from ORIENT step]. [Key finding]. [Confidence caveat if any]."
- [ ] A new `reasoning_traces` row with `agent_type='micky'` is written for the Micky narration (so it is auditable)
- [ ] The existing Micky V1 narration (tree-level summary) is not modified
- [ ] The narration is stored in the `tree_nodes.content.mickyLeafNarration` field (extend the `EvidenceContent` type)
- [ ] The OODA timeline component (STORY-025) displays the Micky leaf narration as a highlighted callout at the top of the timeline

**Complexity:** Medium
**Dependencies:** STORY-025 (OODA timeline component), STORY-022 (full run with traces), STORY-008 (Micky V1 pattern in `agents/micky.ts`)
**Notes:** CUT FIRST. If EPIC-010 is cut, the OODA timeline shows raw steps without a Micky narration. The timeline is still useful — the narration is a polish layer.

---

### STORY-031: Test Micky V2 narration on SH4.2 and one other leaf

**Type:** User Story
**Statement:** As a demo presenter, I want to see Micky's leaf-level narration displayed for the SH4.2 leaf so that I can decide whether it improves the demo narrative.
**Acceptance Criteria:**
- [ ] Micky V2 narration is displayed for SH4.2 in the OODA timeline: a highlighted 2–3 sentence callout above the raw steps
- [ ] Narration is tested on one additional leaf (developer's choice) and produces a coherent result
- [ ] V1 Micky tree-level memo is still visible on the hypothesis card (not replaced by V2)
- [ ] Cut criteria confirmed: if this story is cut, all existing demo acceptance criteria still pass

**Complexity:** Small
**Dependencies:** STORY-030
**Notes:** CUT SECOND. This story is the visible verification of STORY-030. Both can be cut together.

---

## Recommended Execution Order

Day-by-day guide (18 working days, targeting Daniel demo on day 18):

```
Days 1–2   EPIC-001 (foundation + feature flag)
           STORY-001: Spike Managed Agents access — MUST PASS before proceeding
           STORY-002: SDK wiring + types
           STORY-003: Feature flag (V1/V2 switch in orchestrator)

Day 2–3    EPIC-002 (schema migration)
           STORY-004: Add artifacts + reasoning_traces tables
           [Start EPIC-003 in parallel once STORY-002 is done]

Days 3–5   EPIC-003 (Investigator skeleton)
           STORY-005: Register Investigator agent definition
           STORY-006: Implement all 5 tool bindings
           STORY-007: Webhook ingestion handler

Day 5      STORY-008: Wire Investigator into orchestrator; run SH4.2 skeleton (gate check)

Days 5–6   EPIC-004 + EPIC-005 (wedge demo track, critical path) — START PARALLEL
           STORY-009: bottoms-up-financial-model skill (CRITICAL PATH — start as soon as STORY-005 done)
           EPIC-008 start: STORY-024 + STORY-025 (artifact viewer + OODA timeline)
           [These can run in parallel: skill authoring vs UI components]

Days 6–7   STORY-010: Run SH4.2 with skill; verify artifact and multi-loop trace
           STORY-019 (artifact viewer component near-complete by now)
           STORY-025 (OODA timeline component)

Day 7      STORY-011: Wedge demo click path verification (gate check — EPIC-004 complete if passes)

Days 7–10  EPIC-005 (remaining skills) + EPIC-006 (Researcher) — PARALLEL TRACKS
           Track A: STORY-012 (competitor-teardown), STORY-013 (sensitivity-analysis)
           Track B: STORY-017 (register Researcher), STORY-018 (test Researcher)
           Track C: STORY-019-R (extend webhook for Researcher traces)

Day 10     CUT DECISION: If behind, drop STORY-014 (skill #4) and STORY-015 (skill #5)

Days 10–12 EPIC-007 (full ABB run + rubrics)
           STORY-020: Investigator rubric final version
           STORY-021: Researcher rubric final version
           STORY-022: Full ABB V2 run

Days 12–13 EPIC-008 completion
           STORY-026: Version diff component
           STORY-027: Drill-down regression test

Day 13     STORY-023: Pre-bake demo run

Days 14–16 EPIC-005 (STORY-014, STORY-015 if not cut) + STORY-016 (skill eval)

Days 16–17 EPIC-009 polish
           STORY-028: Final eval sweep
           STORY-029: Demo script and rehearsal

Day 17–18  EPIC-010 (Micky V2) — only if ahead
           STORY-030 + STORY-031: Micky narration (cut if any eval is still red)

Day 18     DANIEL DEMO
```

Parallelization notes:
- STORY-009 (skill authoring) and STORY-024 (artifact viewer UI) can run in parallel from day 5 — they share no code-level dependency, only a data dependency (the UI needs an artifact to test against, but can be developed with a fixture).
- EPIC-006 (Researcher) runs in parallel with EPIC-005 skills #2–5 from day 7.
- EPIC-008 UI work can be spread across the full week 2, as long as STORY-024 lands before STORY-010 is tested (the wedge demo needs the viewer).

---

## Risk & Dependency Summary

### Critical Path

```
STORY-001 → STORY-002 → STORY-005 → STORY-009 → STORY-010 → STORY-011
    (spike)    (SDK)    (Inv. reg.)  (skill #1)  (SH4.2 run)  (demo path)
```

Break anywhere on this chain and the wedge demo (STORY-011) does not happen. STORY-011 is the minimum viable demo.

### Highest-Risk Items

**RISK-1 (HIGH): Managed Agents API behavior**
If the beta header behaves differently than spec-v2.md assumes (multi-agent orchestration not working, outcomes not available, code execution sandbox restricted), the entire architecture collapses. Mitigation: STORY-001 is a pure spike with no downstream work starting until it passes. If it fails, escalate immediately — do not start STORY-002.

**RISK-2 (HIGH): Skill description routing accuracy**
STORY-016 targets >=0.85. If skill descriptions are weak, the Investigator will pick the wrong method and produce wrong artifacts. This will not be caught until the full eval. Mitigation: start testing skill descriptions against the SH4.2 falsifier in STORY-009 (single-skill test) and expand to multi-skill testing as each skill is added.

**RISK-3 (MEDIUM): Webhook delivery timing**
The orchestrator currently uses a fire-and-wait pattern. If Managed Agent sessions are long (5–15 minutes per leaf), the orchestrator needs to be async — webhook-driven rather than await-driven. This may require a change to `agents/orchestrator.ts` beyond the feature-flag switch. Mitigation: prototype the webhook timing in STORY-007 and add a polling fallback (poll session status every 30s) if webhooks are unreliable.

**RISK-4 (MEDIUM): Code execution sandbox (build-model.py)**
The `bottoms-up-financial-model` skill depends on `openpyxl` being available in the Managed Agents sandbox. If the sandbox has a restricted package list, the skill fails. Mitigation: confirm `openpyxl` availability in STORY-001 spike. If unavailable, the fallback is generating CSV (not xlsx) — the artifact viewer handles csv — with reduced visual impact.

**RISK-5 (MEDIUM): Full-run latency / cost**
A 30-leaf run with Opus Investigators + Sonnet Researchers may take 30–60 minutes and cost $10–30 per run. This is acceptable for pre-baking but means live demo runs are not feasible. Mitigation: STORY-023 (pre-bake) is the demo strategy; the live run is only used for development iteration.

**RISK-6 (LOW): Open questions unresolved**
OPEN-Q-1 through OPEN-Q-5 must be resolved before their dependent stories start. If OPEN-Q-1 (pgvector inline vs callback) is unresolved at STORY-006 start, default to inline pre-fetch (simpler) and document the limitation.

### Dependency Chain at Risk of Circular Resolution

No circular dependencies detected. The dependency graph is a strict DAG:
- EPIC-001 has no dependencies
- EPIC-002 depends only on EPIC-001
- EPIC-003 depends on EPIC-001 and EPIC-002
- All subsequent epics depend on EPIC-003 but not on each other (except EPIC-009 depending on all)

### Cut Order (from spec, encoded here)

If behind schedule on day 10:
1. Cut EPIC-010 (Micky V2) entirely — V1 narration is sufficient
2. Cut STORY-014 (skill #4) and STORY-015 (skill #5)
3. Cut STORY-013 (skill #3 — sensitivity analysis)

Minimum viable demo (cannot cut): STORY-008 + STORY-009 + STORY-010 + STORY-011 (Investigator + skill #1) + STORY-017 + STORY-018 (Researcher) + STORY-024 (artifact viewer). This is the core demo and represents the "unlock" described in spec-v2.md §6.
